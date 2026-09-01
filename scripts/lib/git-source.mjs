import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SHA_REFERENCE_PATTERN = /^[0-9a-f]{40}$/i;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

export class GitReferenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitReferenceError';
  }
}

export class GitCloneError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'GitCloneError';
    this.cause = cause;
  }
}

/**
 * Returns true when a manifest reference is a bare 40-hex commit SHA.
 *
 * The registry deliberately refuses SHA references: shallow clones must target
 * a named branch or tag so the resolved commit is auditable and reproducible.
 */
export function isShaReference(reference) {
  return SHA_REFERENCE_PATTERN.test(String(reference).trim());
}

/**
 * Normalizes a manifest reference into a clone-ready short branch or tag name.
 *
 * `refs/heads/main` becomes `main` and `refs/tags/v1` becomes `v1`; any other
 * value is returned verbatim. Commit SHA references are rejected here so the
 * failure surfaces with a targeted, actionable message.
 */
export function resolveCloneRef(reference) {
  const trimmed = String(reference).trim();

  if (isShaReference(trimmed)) {
    throw new GitReferenceError(
      `Reference must be a branch or tag, not a commit SHA: ${trimmed}`,
    );
  }

  if (trimmed.startsWith('refs/heads/')) {
    return trimmed.slice('refs/heads/'.length);
  }

  if (trimmed.startsWith('refs/tags/')) {
    return trimmed.slice('refs/tags/'.length);
  }

  return trimmed;
}

/**
 * Resolves a manifest `repository` value into a clone URL.
 *
 * Values that already carry a URL scheme (https://, file://, ssh://) are used
 * as-is; bare `owner/name` shorthands expand to the canonical GitHub HTTPS URL.
 */
export function resolveRepositoryUrl(repository) {
  const trimmed = String(repository).trim();

  if (SCHEME_PATTERN.test(trimmed)) {
    return trimmed;
  }

  return `https://github.com/${trimmed.replace(/\.git$/, '')}.git`;
}

export function repositoryWebUrl(repository) {
  const cloneUrl = resolveRepositoryUrl(repository);
  const match = cloneUrl.match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i,
  );
  if (!match) {
    throw new Error(
      `Changelog commit links require a GitHub repository: ${repository}.`,
    );
  }
  return `https://github.com/${match[1]}`;
}

async function defaultRunGit(args) {
  const { stdout } = await execFileAsync('git', args, {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Performs a single shallow clone of the exact declared branch or tag.
 *
 * Git is always invoked with an argument array (never a shell string) so the
 * repository URL and reference cannot be interpreted as shell metacharacters.
 * `core.autocrlf=false` keeps checked-out bytes identical across Windows and
 * Linux so downstream content hashes are deterministic. Returns the clone
 * directory, the resolved `ref`, and the concrete `commit` it points at.
 */
export async function cloneUpstream({
  repository,
  reference,
  destination,
  runGit = defaultRunGit,
}) {
  const ref = resolveCloneRef(reference);
  const url = resolveRepositoryUrl(repository);

  try {
    await runGit([
      'clone',
      '--depth',
      '1',
      '--branch',
      ref,
      '--config',
      'core.autocrlf=false',
      '--config',
      'core.longpaths=true',
      '--',
      url,
      destination,
    ]);
  } catch (error) {
    throw new GitCloneError(
      `Failed to clone ${url} at ${ref}: ${error.message}`,
      error,
    );
  }

  const commit = (await runGit(['-C', destination, 'rev-parse', 'HEAD'])).trim();
  return { dir: destination, ref, commit };
}
