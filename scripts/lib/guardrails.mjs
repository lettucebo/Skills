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
