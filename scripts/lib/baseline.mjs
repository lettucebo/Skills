/**
 * Manual upstream baseline apply engine.
 *
 * This module turns the current `unverified` bootstrap registry into a
 * `verified` upstream baseline. It is deliberately conservative: it refuses
 * unless the working tree is clean, every mapped upstream is available, and
 * every mapped skill can be staged. All work happens in a staging area first,
 * and the live repository is only mutated through an all-or-nothing directory
 * swap that is rolled back on any post-apply failure. Orphan and local skills
 * are never modified.
 *
 * The engine never creates git commits or tags — that is the workflow's job.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloneUpstream, GitCloneError } from './git-source.mjs';
import { evaluateDeletionGuards } from './guardrails.mjs';
import { hashDirectory } from './hash.mjs';
import { loadManifest } from './manifest.mjs';
import { parseSkillFrontmatter } from './frontmatter.mjs';
import { transformStaged } from '../transform.mjs';
import { renderNotice, renderReadme, serialize } from '../catalog.mjs';
import { validateRepository } from '../validate.mjs';

const execFileAsync = promisify(execFile);

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The baseline turns the unverified `v1.0.0` bootstrap snapshot into a verified
 * upstream baseline and completes the Cloudflare full mirror.
 *
 * `1.1.0` is a deliberate, user-approved one-time SemVer exception: the mirror
 * drops two obsolete command-derived skills, which would normally force a major
 * bump, but `v1.0.0` was explicitly published as an unverified snapshot rather
 * than a provenance claim. From `v1.1.0` onward the normal rule resumes and any
 * skill removal increments the major version. The existing `v1.0.0` tag is never
 * moved; the tag for this release is created by a later task after the commit
 * lands.
 */
export const BASELINE_RELEASE = '1.1.0';
export const BASELINE_VERSION = '1.1.0';
export const BASELINE_HISTORY_KIND = 'baseline-verified';

/**
 * Files and directories the swap replaces atomically. Order is irrelevant to
 * correctness because backups are taken before any placement.
 */
const SWAP_TARGETS = [
  { rel: 'skills', kind: 'dir' },
  { rel: 'catalog/history', kind: 'dir' },
  { rel: 'catalog/skills.lock.json', kind: 'file' },
  { rel: 'NOTICE', kind: 'file' },
  { rel: 'README.md', kind: 'file' },
];

export class BaselineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BaselineError';
  }
}

/**
 * Rebuilds the lockfile with every mapped skill promoted to a verified
 * baseline.
 *
 * Mapped entries gain the resolved upstream `commit`, the pre-stamp
 * `contentHash` (the verified upstream content identity), the post-stamp
 * `snapshotHash` (the vendored bytes), and the baseline `version`. Orphan and
 * local entries pass through untouched so an orphan keeps `upstream: null`.
 * Refuses if a mapped skill is missing from `staged`, or if `staged` names a
 * path that is not a mapped skill, so the transition can never be partial.
 */
export function buildVerifiedLock({ lock, staged, release = BASELINE_RELEASE, generatedAt }) {
  const stagedMap = staged instanceof Map ? staged : new Map(Object.entries(staged));
  const mappedPaths = new Set(
    lock.skills.filter((skill) => skill.category === 'mapped').map((skill) => skill.path),
  );

  for (const stagedPath of stagedMap.keys()) {
    if (!mappedPaths.has(stagedPath)) {
      throw new BaselineError(
        `Refusing to verify a path that is not a mapped skill: ${stagedPath}`,
      );
    }
  }

  const skills = lock.skills.map((skill) => {
    if (skill.category !== 'mapped') {
      return skill;
    }

    const stagedEntry = stagedMap.get(skill.path);

    if (!stagedEntry) {
      throw new BaselineError(`Mapped skill was not staged for baseline: ${skill.path}`);
    }

    return {
      path: skill.path,
      name: skill.name,
      category: skill.category,
      version: release,
      baseline: 'verified',
      license: skill.license,
      redistributable: skill.redistributable,
      snapshotHash: stagedEntry.snapshotHash,
      contentHash: stagedEntry.contentHash,
      upstream: { ...skill.upstream, commit: stagedEntry.commit },
    };
  });

  return { release, generatedAt, counts: lock.counts, skills };
}

/**
 * Appends a baseline-verification entry to a skill's history without erasing
 * its bootstrap entry.
 *
 * Returns a new document (the input is never mutated). The append is idempotent:
 * re-verifying against the same upstream commit and content hash returns the
 * document unchanged so repeated runs do not accumulate duplicate entries.
 */
export function appendBaselineHistoryEntry(history, { release, version, upstreamCommit, contentHash }) {
  if (!Array.isArray(history?.entries) || history.entries.length === 0) {
    throw new BaselineError(
      `Refusing to append baseline history to ${history?.path ?? 'unknown skill'}: no bootstrap entry present.`,
    );
  }

  if (history.entries[0].kind !== 'bootstrap') {
    throw new BaselineError(
      `Refusing to append baseline history to ${history.path}: first entry must remain bootstrap.`,
    );
  }

  const entry = {
    release,
    kind: BASELINE_HISTORY_KIND,
    version,
    upstreamCommit,
    diffUrl: null,
    contentHash,
  };

  const last = history.entries[history.entries.length - 1];

  if (
    last.kind === BASELINE_HISTORY_KIND &&
    last.upstreamCommit === upstreamCommit &&
    last.contentHash === contentHash
  ) {
    return { ...history, entries: [...history.entries] };
  }

  return { ...history, entries: [...history.entries, entry] };
}

async function defaultReadGitStatus(repoRoot) {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'status', '--porcelain'], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function statOrNull(targetPath) {
  try {
    return await stat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Clones each upstream once, stages every mapped skill, and records the verified
 * content hash before stamping plus the vendored hash after stamping.
 */
async function stageMappedSkills({ manifest, workRoot, runGit }) {
  const clonesDir = path.join(workRoot, 'clones');
  const stagingDir = path.join(workRoot, 'staging');
  await mkdir(clonesDir, { recursive: true });
  await mkdir(stagingDir, { recursive: true });

  const mappingsByUpstream = new Map();
  for (const mapping of manifest.mappings) {
    if (!mappingsByUpstream.has(mapping.upstream)) {
      mappingsByUpstream.set(mapping.upstream, []);
    }
    mappingsByUpstream.get(mapping.upstream).push(mapping);
  }

  const staged = new Map();
  const unavailable = [];
  const sources = [];

  for (const upstreamName of [...mappingsByUpstream.keys()].sort()) {
    const mappings = mappingsByUpstream.get(upstreamName);
    const upstream = manifest.upstreams[upstreamName];
    const cloneDir = path.join(clonesDir, upstreamName);

    let clone;
    try {
      clone = await cloneUpstream({
        repository: upstream.repository,
        reference: upstream.reference,
        destination: cloneDir,
        runGit,
      });
    } catch (error) {
      if (!(error instanceof GitCloneError)) {
        throw error;
      }
      sources.push({ upstream: upstreamName, available: false, commit: null });
      for (const mapping of mappings) {
        unavailable.push({ path: mapping.path, upstream: upstreamName, reason: 'upstream-unavailable' });
      }
      continue;
    }

    sources.push({ upstream: upstreamName, available: true, commit: clone.commit });

    for (const mapping of mappings) {
      const sourceAbs = path.join(cloneDir, ...mapping.source.split('/'));
      const sourceStat = await statOrNull(sourceAbs);

      if (!sourceStat) {
        unavailable.push({ path: mapping.path, upstream: upstreamName, reason: 'missing-source' });
        continue;
      }

      if (!sourceStat.isDirectory()) {
        // Non-directory upstream sources (e.g. a single command markdown file
        // requiring an unimplemented `command-to-skill` transform) cannot be
        // staged by the directory pipeline. Refuse cleanly so the baseline is
        // all-or-nothing rather than crashing mid-stage.
        unavailable.push({ path: mapping.path, upstream: upstreamName, reason: 'source-not-directory' });
        continue;
      }

      const stageDir = path.join(stagingDir, ...mapping.path.split('/'));
      await mkdir(path.dirname(stageDir), { recursive: true });
      await cp(sourceAbs, stageDir, { recursive: true });

      // Hash BEFORE transform: this is the verified upstream content identity.
      const contentHash = await hashDirectory(stageDir);
      const override = manifest.overrides.find((entry) => entry.path === mapping.path);

      await transformStaged({
        skillDir: stageDir,
        skillPath: mapping.path,
        override,
        upstream,
        source: mapping.source,
        commit: clone.commit,
        version: BASELINE_VERSION,
      });

      const snapshotHash = await hashDirectory(stageDir);
      staged.set(mapping.path, { commit: clone.commit, contentHash, snapshotHash, stageDir });
    }
  }

  return { staged, unavailable, sources };
}

/**
 * Verifies the lock and the on-disk skill tree agree: counts are internally
 * consistent, names are unique, and every declared skill exists with matching
 * frontmatter. This is the deterministic structural analog of the npx install
 * smoke, run without any network access.
 */
export async function assertStructuralIntegrity(repoRoot, lock) {
  if (lock.counts.total !== lock.skills.length) {
    throw new BaselineError(
      `Structural smoke failed: lock counts.total ${lock.counts.total} != ${lock.skills.length} skills.`,
    );
  }

  const tallies = { mapped: 0, orphan: 0, local: 0 };
  const names = new Set();

  for (const skill of lock.skills) {
    tallies[skill.category] += 1;

    if (names.has(skill.name)) {
      throw new BaselineError(`Structural smoke failed: duplicate skill name ${skill.name}.`);
    }
    names.add(skill.name);

    const skillFile = path.join(repoRoot, ...skill.path.split('/'), 'SKILL.md');
    let text;
    try {
      text = await readFile(skillFile, 'utf8');
    } catch {
      throw new BaselineError(`Structural smoke failed: missing SKILL.md for ${skill.path}.`);
    }

    const frontmatter = parseSkillFrontmatter(text, `${skill.path}/SKILL.md`);
    if (frontmatter.name !== skill.name) {
      throw new BaselineError(
        `Structural smoke failed: ${skill.path} frontmatter name ${frontmatter.name} != lock ${skill.name}.`,
      );
    }
  }

  for (const category of ['mapped', 'orphan', 'local']) {
    if ((lock.counts[category] ?? 0) !== tallies[category]) {
      throw new BaselineError(
        `Structural smoke failed: lock counts.${category} ${lock.counts[category]} != ${tallies[category]}.`,
      );
    }
  }
}

async function readLock(repoRoot) {
  const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
  return JSON.parse(await readFile(lockPath, 'utf8'));
}

async function readHistoryDoc(repoRoot, skillPath) {
  const fileName = `${skillPath.replace(/\//g, '__')}.json`;
  const filePath = path.join(repoRoot, 'catalog', 'history', fileName);
  return { fileName, content: JSON.parse(await readFile(filePath, 'utf8')) };
}

/**
 * Builds the complete candidate tree in the staging area: a full copy of the
 * live skills tree and history with the mapped skills replaced, plus the
 * regenerated lock, NOTICE, and README.
 */
async function buildCandidate({ repoRoot, candidateRoot, manifest, lock, staged, generatedAt }) {
  await cp(path.join(repoRoot, 'skills'), path.join(candidateRoot, 'skills'), { recursive: true });
  await cp(
    path.join(repoRoot, 'catalog', 'history'),
    path.join(candidateRoot, 'catalog', 'history'),
    { recursive: true },
  );

  for (const [skillPath, stagedEntry] of staged) {
    const dest = path.join(candidateRoot, ...skillPath.split('/'));
    await rm(dest, { recursive: true, force: true });
    await cp(stagedEntry.stageDir, dest, { recursive: true });
  }

  const nextLock = buildVerifiedLock({ lock, staged, release: BASELINE_RELEASE, generatedAt });

  await writeFile(
    path.join(candidateRoot, 'catalog', 'skills.lock.json'),
    serialize(nextLock),
  );

  for (const [skillPath, stagedEntry] of staged) {
    const { fileName, content } = await readHistoryDoc(repoRoot, skillPath);
    const next = appendBaselineHistoryEntry(content, {
      release: BASELINE_RELEASE,
      version: BASELINE_VERSION,
      upstreamCommit: stagedEntry.commit,
      contentHash: stagedEntry.contentHash,
    });
    await writeFile(path.join(candidateRoot, 'catalog', 'history', fileName), serialize(next));
  }

  await writeFile(path.join(candidateRoot, 'NOTICE'), renderNotice(nextLock));

  const readmeText = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
  await writeFile(path.join(candidateRoot, 'README.md'), renderReadme(readmeText, nextLock));

  return nextLock;
}

async function assertUnchanged(repoRoot, candidateRoot, relativePath, label) {
  const original = await hashDirectory(path.join(repoRoot, ...relativePath.split('/')));
  const candidate = await hashDirectory(path.join(candidateRoot, ...relativePath.split('/')));

  if (original !== candidate) {
    throw new BaselineError(`Refusing baseline: ${label} changed unexpectedly (${relativePath}).`);
  }
}

async function swapInCandidate(repoRoot, candidateRoot, backupRoot) {
  const placed = [];

  try {
    for (const target of SWAP_TARGETS) {
      const original = path.join(repoRoot, ...target.rel.split('/'));
      const backup = path.join(backupRoot, ...target.rel.split('/'));
      const candidate = path.join(candidateRoot, ...target.rel.split('/'));

      await mkdir(path.dirname(backup), { recursive: true });
      await rename(original, backup);
      await mkdir(path.dirname(original), { recursive: true });
      await rename(candidate, original);
      placed.push(target);
    }
  } catch (error) {
    await rollbackSwap(repoRoot, backupRoot, placed);
    throw error;
  }

  return placed;
}

async function rollbackSwap(repoRoot, backupRoot, placed) {
  for (const target of [...placed].reverse()) {
    const original = path.join(repoRoot, ...target.rel.split('/'));
    const backup = path.join(backupRoot, ...target.rel.split('/'));
    await rm(original, { recursive: true, force: true });
    await rename(backup, original);
  }
}

/**
 * Establishes the verified upstream baseline.
 *
 * Refuses unless `baseline` is explicitly true and the working tree is clean.
 * Stages every mapped skill from a fresh upstream clone; refuses if any upstream
 * is unavailable, any mapped source is missing, or the staged count does not
 * match the manifest. Applies the change through an all-or-nothing directory
 * swap and rolls the swap back if post-apply validation or the structural smoke
 * fails. Never creates commits or tags.
 */
export async function applyBaseline({
  repoRoot = defaultRepoRoot,
  baseline = false,
  readGitStatus = defaultReadGitStatus,
  now = () => new Date().toISOString(),
  runGit,
  validate = validateRepository,
} = {}) {
  if (baseline !== true) {
    throw new BaselineError('Refusing to apply: baseline mode must be explicitly enabled.');
  }

  const absoluteRepoRoot = path.resolve(repoRoot);

  const status = await readGitStatus(absoluteRepoRoot);
  if (status.trim() !== '') {
    throw new BaselineError(
      'Refusing to apply baseline: the git working tree is not clean. Commit or stash changes first.',
    );
  }

  const manifest = await loadManifest(
    path.join(absoluteRepoRoot, 'catalog', 'sources.yml'),
  );
  const lock = await readLock(absoluteRepoRoot);

  const workRoot = await mkdtemp(path.join(absoluteRepoRoot, '.baseline-work-'));
  const backupRoot = path.join(workRoot, 'backup');
  const candidateRoot = path.join(workRoot, 'candidate');
  await mkdir(candidateRoot, { recursive: true });

  try {
    const { staged, unavailable, sources } = await stageMappedSkills({
      manifest,
      workRoot,
      runGit,
    });

    if (unavailable.length > 0) {
      const detail = unavailable
        .map((entry) => `${entry.path} (${entry.reason})`)
        .join(', ');
      throw new BaselineError(
        `Refusing baseline: ${unavailable.length} mapped skill(s) are unavailable and block the baseline: ${detail}.`,
      );
    }

    if (staged.size !== manifest.mappings.length) {
      throw new BaselineError(
        `Refusing baseline: staged ${staged.size} of ${manifest.mappings.length} mapped skills.`,
      );
    }

    const guard = evaluateDeletionGuards(
      sources.map((source) => ({
        upstream: source.upstream,
        declared: manifest.mappings.filter((mapping) => mapping.upstream === source.upstream).length,
        removed: 0,
        available: source.available,
      })),
    );

    if (guard.blocked) {
      throw new BaselineError('Refusing baseline: deletion guardrail is blocked.');
    }

    const generatedAt = now();
    const nextLock = await buildCandidate({
      repoRoot: absoluteRepoRoot,
      candidateRoot,
      manifest,
      lock,
      staged,
      generatedAt,
    });

    // Orphan and local skills must never be touched by the baseline.
    for (const skill of lock.skills) {
      if (skill.category === 'orphan' || skill.category === 'local') {
        await assertUnchanged(absoluteRepoRoot, candidateRoot, skill.path, `${skill.category} skill`);
      }
    }

    const placed = await swapInCandidate(absoluteRepoRoot, candidateRoot, backupRoot);

    try {
      await validate(absoluteRepoRoot);
      await assertStructuralIntegrity(absoluteRepoRoot, nextLock);
    } catch (error) {
      await rollbackSwap(absoluteRepoRoot, backupRoot, placed);
      throw new BaselineError(`Baseline post-apply validation failed; rolled back. ${error.message}`);
    }

    return {
      release: BASELINE_RELEASE,
      applied: [...staged.keys()].sort(),
      counts: nextLock.counts,
      sources,
    };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}
