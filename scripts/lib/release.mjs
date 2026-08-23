/**
 * SemVer release planning for the skills registry.
 *
 * The current baseline is discovered from the repository's git tags (query
 * only, never mutated). The git runner is injectable so the logic is fully
 * testable without a real repository, and the default runner always passes
 * arguments as an array (never a shell string) so tag values can never be
 * interpreted as shell metacharacters.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { commitMessageForDiffClass } from './guardrails.mjs';

const execFileAsync = promisify(execFile);

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

const BUMP_BY_DIFF_CLASS = Object.freeze({
  major: 'major',
  minor: 'minor',
  patch: 'patch',
  none: null,
});

export class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseError';
  }
}

async function defaultRunGit(args) {
  const { stdout } = await execFileAsync('git', args, {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Parses a semantic version, tolerating a single leading `v`.
 *
 * Anything that is not exactly `MAJOR.MINOR.PATCH` (three non-negative
 * integers) is rejected so a malformed tag can never seed a release.
 */
export function parseVersion(value) {
  const raw = String(value).trim().replace(/^v/, '');
  const match = raw.match(VERSION_PATTERN);

  if (!match) {
    throw new ReleaseError(`Invalid semantic version: ${value}`);
  }

  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Renders a parsed version back into its canonical `MAJOR.MINOR.PATCH` string.
 */
export function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

/**
 * Computes the next version for a diff class, resetting lower components on a
 * higher bump. A `none` diff class returns `null` (no release).
 */
export function nextVersion(current, diffClass) {
  if (!Object.prototype.hasOwnProperty.call(BUMP_BY_DIFF_CLASS, diffClass)) {
    throw new ReleaseError(`Unknown diff class: ${diffClass}`);
  }

  const bump = BUMP_BY_DIFF_CLASS[diffClass];

  if (bump === null) {
    return null;
  }

  const { major, minor, patch } = parseVersion(current);

  if (bump === 'major') {
    return formatVersion({ major: major + 1, minor: 0, patch: 0 });
  }

  if (bump === 'minor') {
    return formatVersion({ major, minor: minor + 1, patch: 0 });
  }

  return formatVersion({ major, minor, patch: patch + 1 });
}

/**
 * Reads the highest semantic-version tag (`vMAJOR.MINOR.PATCH`) from the
 * repository. Non-semver tags are ignored; the ordering is computed here rather
 * than trusting a git sort flag so the result is deterministic across git
 * versions.
 */
export async function readCurrentVersion({ runGit = defaultRunGit } = {}) {
  const stdout = await runGit(['tag', '--list', 'v*']);
  const versions = [];

  for (const line of stdout.split('\n')) {
    const tag = line.trim();

    if (!tag) {
      continue;
    }

    try {
      versions.push(parseVersion(tag));
    } catch {
      // Ignore tags that are not semantic versions.
    }
  }

  if (versions.length === 0) {
    throw new ReleaseError('No semantic version tag found in repository.');
  }

  versions.sort(
    (left, right) =>
      right.major - left.major || right.minor - left.minor || right.patch - left.patch,
  );

  return formatVersion(versions[0]);
}

/**
 * Reports whether an exact tag already exists in the repository.
 */
export async function tagExists(tag, { runGit = defaultRunGit } = {}) {
  const stdout = await runGit(['tag', '--list', tag]);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .includes(tag);
}

/**
 * Plans a release without mutating git.
 *
 * Discovers the current version (unless one is supplied), computes the next
 * version and its `v`-prefixed tag, and refuses when that tag already exists so
 * a release can never clobber history. A `none` diff class yields a no-op plan
 * with a `null` next version, tag, and commit message.
 */
export async function planRelease({ diffClass, currentVersion, runGit = defaultRunGit } = {}) {
  const commitMessage = commitMessageForDiffClass(diffClass);
  const current = currentVersion ?? (await readCurrentVersion({ runGit }));

  parseVersion(current);

  const next = nextVersion(current, diffClass);

  if (next === null) {
    return {
      diffClass,
      currentVersion: current,
      nextVersion: null,
      nextTag: null,
      commitMessage: null,
    };
  }

  const nextTag = `v${next}`;

  if (await tagExists(nextTag, { runGit })) {
    throw new ReleaseError(`Refusing to reuse an existing release tag: ${nextTag}`);
  }

  return { diffClass, currentVersion: current, nextVersion: next, nextTag, commitMessage };
}
