import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { REPO_OWNER, REPO_NAME, findRepoRoot } from './catalog.ts';

/**
 * Build-time provenance for the static site: when it was generated and from
 * which commit. Everything is resolved once, at module load, during the Astro
 * build. The site performs no runtime network access, so these values are baked
 * into the rendered HTML.
 *
 * Fail-soft is a hard requirement: building from a tarball with no `.git`, or on
 * a machine without `git`, must degrade to `null` rather than break the build.
 */

// GitHub commit identity is exact: a full 40-character hex SHA. Both the CI
// contract (`git rev-parse HEAD` piped through the workflow) and the local git
// fallback emit the full 40 characters. Anything shorter/longer or non-hex —
// including a hostile environment variable or an abbreviated SHA — is rejected
// to `null` so it can neither misidentify the commit nor inject markup into the
// commit URL. The UI still displays only the first 7 characters.
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function sanitizeSha(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return SHA_PATTERN.test(trimmed) ? trimmed : null;
}

// The workflow stamps the build time with `date -u +%Y-%m-%dT%H:%M:%SZ`, and
// `new Date().toISOString()` adds exactly three fractional digits. Accept only
// those two RFC3339 UTC shapes (seconds required, optional `.sss`, `Z` suffix);
// everything else — bare years, epoch integers, local offsets — is rejected.
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/**
 * Structural + calendar validation of an RFC3339 UTC timestamp. `new Date`
 * happily normalises impossible dates such as `2026-02-30T…` by rolling them
 * forward, so a canonical round-trip is required to reject them: the parsed
 * instant, re-serialised, must equal the input (with an absent fractional part
 * treated as `.000`). Returns the canonical `.sss`-form ISO string, or `null`.
 */
function canonicalizeBuildTime(value: string): string | null {
  if (!RFC3339_UTC.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const expected = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  return parsed.toISOString() === expected ? parsed.toISOString() : null;
}

function resolveBuildTime(): string {
  const fromEnv = process.env.SITE_BUILD_TIME;
  if (fromEnv) {
    const canonical = canonicalizeBuildTime(fromEnv);
    if (canonical) return canonical;
  }
  return new Date().toISOString();
}

/**
 * True when two filesystem paths refer to the same directory, after resolving
 * to absolute form. `git rev-parse --show-toplevel` prints a forward-slash path
 * even on Windows, so both sides are normalised; the comparison is
 * case-insensitive on Windows to match its case-preserving-but-insensitive FS.
 */
function pathsEqual(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32'
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}

/**
 * Resolves the built commit from local git, but only when git's working-tree
 * root is EXACTLY the expected registry root (the directory containing
 * `catalog/skills.lock.json`). This guards the nested-tarball case: a source
 * export with no `.git` unpacked inside an unrelated parent repository would
 * otherwise inherit that parent's HEAD. On any failure or mismatch => `null`.
 */
function resolveCommitFromGit(): string | null {
  let expectedRoot: string;
  try {
    expectedRoot = findRepoRoot();
  } catch {
    return null;
  }
  try {
    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: expectedRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!topLevel || !pathsEqual(topLevel, expectedRoot)) return null;

    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: expectedRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return sanitizeSha(head);
  } catch {
    return null;
  }
}

function resolveBuildCommit(): string | null {
  if (process.env.SITE_BUILD_COMMIT !== undefined) {
    // An explicit env var is authoritative: CI resolves the real built commit
    // after checkout and passes it in. If it is malformed, fail soft to null
    // rather than shelling out to a possibly-unrelated worktree.
    return sanitizeSha(process.env.SITE_BUILD_COMMIT);
  }
  return resolveCommitFromGit();
}

export const BUILD_TIME: string = resolveBuildTime();

export const BUILD_COMMIT: string | null = resolveBuildCommit();

export const BUILD_COMMIT_SHORT: string | null = BUILD_COMMIT
  ? BUILD_COMMIT.slice(0, 7)
  : null;

export const BUILD_COMMIT_URL: string | null = BUILD_COMMIT
  ? `https://github.com/${REPO_OWNER}/${REPO_NAME}/commit/${BUILD_COMMIT}`
  : null;

/**
 * Formats an ISO timestamp as a deterministic UTC string, e.g.
 * `2026-08-30 09:35 UTC`. Rendered server-side so the label does not depend on
 * the build machine's local timezone or on client-side JavaScript.
 */
export function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}
