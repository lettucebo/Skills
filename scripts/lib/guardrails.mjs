/**
 * Update-safety guardrails and upstream diff classification.
 *
 * These helpers are deliberately pure (no filesystem, no git): they turn an
 * already-computed change set into a release decision, and they harden the
 * manifest against path-traversal and destination-overwrite attacks before any
 * future live write. Keeping them side-effect free makes every rule directly
 * unit-testable.
 */

export class GuardrailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardrailError';
  }
}

export class SyncProtectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SyncProtectionError';
  }
}

/**
 * Registry roots that must never be written by sync, regardless of manifest
 * contents. `skills/lettucebo` is reserved for local/original skills.
 *
 * This is deliberately independent of the lockfile: the lock's `local`
 * category is empty whenever no local skill exists yet, and a hostile manifest
 * can simply drop its `local:` declaration, so neither can be the only defense.
 */
export const ALWAYS_PROTECTED_ROOTS = Object.freeze(['skills/lettucebo']);

/**
 * Fails fast when a destination path falls inside a protected or local root.
 *
 * This runs before any staging or repo write so a bad mapping can never adopt
 * content into a reserved location.
 */
export function assertWritableSkillPath(skillPath, protectedRoots) {
  for (const root of protectedRoots) {
    if (skillPath === root || skillPath.startsWith(`${root}/`)) {
      throw new SyncProtectionError(
        `Refusing to write skill path inside protected root "${root}": ${skillPath}`,
      );
    }
  }

  return skillPath;
}

/**
 * Derives the protected roots for a manifest: the always-protected registry
 * roots plus every declared local root.
 */
export function buildProtectedRoots(manifest) {
  const roots = new Set(ALWAYS_PROTECTED_ROOTS);

  for (const entry of manifest?.local ?? []) {
    roots.add(entry.root);
  }

  return [...roots];
}

/**
 * Asserts that every manifest mapping destination is writable.
 *
 * Shared by dry-run planning and by both apply engines so plan and apply can
 * never diverge on which destinations are legal.
 */
export function assertMappingsWritable(manifest) {
  const protectedRoots = buildProtectedRoots(manifest);

  for (const mapping of manifest?.mappings ?? []) {
    assertWritableSkillPath(mapping.path, protectedRoots);
  }

  return protectedRoots;
}

/**
 * Deletion guard threshold for a declared group of ten or more skills. A group
 * may lose up to (and including) this fraction of its members; anything
 * strictly greater is blocked.
 */
export const DELETION_RATIO_THRESHOLD = 0.3;

/**
 * Below this declared size the percentage threshold is meaningless, so any
 * removal at all is blocked.
 */
export const SMALL_GROUP_SIZE = 10;

/**
 * Exact conventional-commit subjects generated for each diff class.
 *
 * `none` maps to `null`: a no-op sync must not produce a commit.
 */
export const COMMIT_MESSAGES = Object.freeze({
  major: 'feat(skills)!: sync upstream changes',
  minor: 'feat(skills): sync new upstream skills',
  patch: 'fix(skills): sync upstream updates',
  none: null,
});

function countOf(value) {
  if (Array.isArray(value)) {
    return value.length;
  }

  if (value === undefined || value === null) {
    return 0;
  }

  const numeric = Number(value);

  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new GuardrailError(`Change count must be a non-negative number: ${value}`);
  }

  return numeric;
}

/**
 * Classifies an upstream diff into a SemVer bump class using strict precedence.
 *
 * Any removal, rename, or structural move is breaking (`major`); otherwise a
 * pure addition is `minor`; otherwise an in-place change is `patch`; an empty
 * diff is `none`. Each field accepts either an array (its length is used) or a
 * numeric count.
 */
export function classifyDiff(changes = {}) {
  const removed = countOf(changes.removed);
  const renamed = countOf(changes.renamed);
  const restructured = countOf(changes.restructured);
  const added = countOf(changes.added);
  const changed = countOf(changes.changed);

  if (removed > 0 || renamed > 0 || restructured > 0) {
    return 'major';
  }

  if (added > 0) {
    return 'minor';
  }

  if (changed > 0) {
    return 'patch';
  }

  return 'none';
}

/**
 * Returns the exact commit subject for a diff class, or `null` for `none`.
 */
export function commitMessageForDiffClass(diffClass) {
  if (!Object.prototype.hasOwnProperty.call(COMMIT_MESSAGES, diffClass)) {
    throw new GuardrailError(`Unknown diff class: ${diffClass}`);
  }

  return COMMIT_MESSAGES[diffClass];
}

/**
 * Evaluates the deletion guard for a single declared mapping/adoption group.
 *
 * An unavailable (clone-failed) upstream is NEVER translated into a removal:
 * its removed count is forced to zero and it is blocked with a distinct
 * `upstream-unavailable` status so a transient outage can never masquerade as a
 * mass deletion. For available groups, a declared size of ten or more may lose
 * up to exactly {@link DELETION_RATIO_THRESHOLD}; a smaller group blocks on any
 * removal at all.
 */
export function evaluateDeletionGuard(group = {}) {
  const upstream = group.upstream ?? null;
  const available = group.available ?? true;

  if (!Number.isInteger(group.declared) || group.declared < 0) {
    throw new GuardrailError(
      `Deletion guard requires a non-negative declared count for upstream ${upstream}`,
    );
  }

  const declared = group.declared;
  const removed = group.removed ?? 0;

  if (!Number.isInteger(removed) || removed < 0) {
    throw new GuardrailError(
      `Deletion guard requires a non-negative removed count for upstream ${upstream}`,
    );
  }

  if (!available) {
    return {
      upstream,
      declared,
      removed: 0,
      available: false,
      ratio: null,
      blocked: true,
      status: 'upstream-unavailable',
    };
  }

  if (removed > declared) {
    throw new GuardrailError(
      `Deletion guard removed count (${removed}) exceeds declared size (${declared}) for upstream ${upstream}`,
    );
  }

  if (removed === 0) {
    return { upstream, declared, removed, available: true, ratio: 0, blocked: false, status: 'ok' };
  }

  if (declared < SMALL_GROUP_SIZE) {
    return {
      upstream,
      declared,
      removed,
      available: true,
      ratio: removed / declared,
      blocked: true,
      status: 'small-group-removal',
    };
  }

  const ratio = removed / declared;

  if (ratio > DELETION_RATIO_THRESHOLD) {
    return {
      upstream,
      declared,
      removed,
      available: true,
      ratio,
      blocked: true,
      status: 'deletion-threshold-exceeded',
    };
  }

  return { upstream, declared, removed, available: true, ratio, blocked: false, status: 'ok' };
}

/**
 * Evaluates the deletion guard across every declared group and folds the
 * per-group verdicts into a single blocked flag.
 */
export function evaluateDeletionGuards(groups = []) {
  const evaluated = groups.map((group) => evaluateDeletionGuard(group));
  return { blocked: evaluated.some((group) => group.blocked), groups: evaluated };
}

/**
 * Canonical identity of an upstream for deletion-guard grouping.
 *
 * An upstream is a (repository, reference) PAIR, never a bare repository: the
 * same repository may legitimately be mapped at two references (e.g. `main` and
 * a frozen tag), and those are independent populations. Collapsing them would
 * double the denominator of the removal ratio and let a mass deletion of one
 * reference slip under the threshold.
 */
export function upstreamGroupKey(repository, reference) {
  return `${repository}\u0000${reference}`;
}

/**
 * Builds the deletion-guard groups from a manifest and a lockfile.
 *
 * This is the single implementation shared by the dry-run planner and the daily
 * apply, so a removal that the plan blocks can never be applied:
 *
 *  - `declared` is the baseline population of the (repository, reference) pair
 *    recorded in the lock, so a removal ratio is always well defined.
 *  - `removed` counts mapped lock paths the manifest no longer declares.
 *  - each group is named after the manifest upstream that owns the pair, so the
 *    plan report and the apply error speak the same language. A lock entry with
 *    no matching manifest upstream (an upstream that was renamed or dropped
 *    outright) degrades to its repository, then to the raw key.
 *
 * `availableByName` marks clone-failed upstreams so the guard can block them
 * distinctly instead of ever inferring a removal from an outage.
 * `includeUnmappedUpstreams` additionally emits an empty group for a manifest
 * upstream that has no lock entries yet, which the planner needs so an
 * unavailable clone is still reported with no baseline.
 */
export function buildDeletionGroups({
  manifest,
  lock,
  availableByName = new Map(),
  includeUnmappedUpstreams = false,
} = {}) {
  const nameByKey = new Map();
  for (const [name, definition] of Object.entries(manifest?.upstreams ?? {})) {
    nameByKey.set(upstreamGroupKey(definition.repository, definition.reference), name);
  }

  const mappings = manifest?.mappings ?? [];
  const mappingPaths = new Set(mappings.map((mapping) => mapping.path));

  const declaredByGroup = new Map();
  const removedByGroup = new Map();

  for (const skill of lock?.skills ?? []) {
    if (skill.category !== 'mapped') {
      continue;
    }

    const key = upstreamGroupKey(skill.upstream?.repository, skill.upstream?.reference);
    const group = nameByKey.get(key) ?? skill.upstream?.repository ?? key;

    declaredByGroup.set(group, (declaredByGroup.get(group) ?? 0) + 1);

    if (!mappingPaths.has(skill.path)) {
      removedByGroup.set(group, (removedByGroup.get(group) ?? 0) + 1);
    }
  }

  if (includeUnmappedUpstreams) {
    for (const mapping of mappings) {
      if (!declaredByGroup.has(mapping.upstream)) {
        declaredByGroup.set(mapping.upstream, 0);
      }
    }
  }

  return [...declaredByGroup.keys()]
    .sort()
    .map((group) => ({
      upstream: group,
      declared: declaredByGroup.get(group) ?? 0,
      removed: removedByGroup.get(group) ?? 0,
      available: availableByName.get(group) ?? true,
    }));
}

/**
 * Rejects any value that resolves to a `..` path segment after percent-decoding
 * and separator normalization.
 *
 * Defense in depth for manifest destination/source paths: encoded (`%2e%2e`),
 * backslash, and mixed-separator traversal all collapse to the same posix form
 * before the check, and invalid percent-encoding is rejected outright. Returns
 * the normalized posix path when it is safe.
 */
export function assertNoPathTraversal(value, field = 'path') {
  let decoded;

  try {
    decoded = decodeURIComponent(String(value));
  } catch {
    throw new GuardrailError(`${field} contains invalid percent-encoding: ${value}`);
  }

  const posixified = decoded.replace(/\\/g, '/');

  if (posixified.split('/').some((segment) => segment === '..')) {
    throw new GuardrailError(`${field} must not contain ".." path segments: ${value}`);
  }

  return posixified;
}

/**
 * Rejects destination collisions among mapping paths.
 *
 * Two mappings must never write the same destination, and no destination may be
 * a parent directory of another (a recursive copy of the parent would silently
 * overwrite the child). Legitimately nested but distinct roots — e.g.
 * `skills/tampermonkey/tampermonkey` with no `skills/tampermonkey` mapping — are
 * preserved.
 */
export function assertNoDestinationCollisions(paths) {
  const seen = new Set();

  for (const skillPath of paths) {
    if (seen.has(skillPath)) {
      throw new GuardrailError(`Duplicate destination mapping: ${skillPath}`);
    }

    seen.add(skillPath);
  }

  for (const skillPath of paths) {
    const segments = skillPath.split('/');

    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join('/');

      if (seen.has(ancestor)) {
        throw new GuardrailError(
          `Overlapping destination roots: "${ancestor}" would overwrite "${skillPath}"`,
        );
      }
    }
  }
}
