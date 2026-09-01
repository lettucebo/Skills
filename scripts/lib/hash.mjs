import { createHash } from 'node:crypto';
import { cp, lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Directory names that are excluded from both staging and hashing.
 *
 * The lockfile claims provenance over the bytes a commit actually carries, so
 * the hash may only cover files git is willing to track. `node_modules` is
 * ignored repository-wide — deliberately, because a dependency tree is never
 * legitimate vendored content — and `.git` is repository metadata, never
 * content. Hashing either would record bytes the committed tree cannot
 * reproduce, so the same rule is enforced on both sides of the pipeline: the
 * staging copy skips them and the digest never sees them.
 *
 * Vendored build output, logs, and `.env` files are explicitly re-included
 * under `skills/**`, so they stay both tracked and hashed. OS/editor caches
 * remain ignored and are excluded below from both staging and hashing.
 */
export const HASH_EXCLUDED_DIRECTORIES = Object.freeze(
  new Set([
    'node_modules',
    '.git',
    '.vscode',
    '.idea',
    '__pycache__',
    '.venv',
    'venv',
    '.astro',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
    'sync-report',
  ]),
);

/**
 * True when a directory entry must never be staged or hashed.
 */
export function isExcludedDirectoryName(name) {
  const normalizedName = name.toLowerCase();
  return (
    HASH_EXCLUDED_DIRECTORIES.has(normalizedName) ||
    normalizedName.endsWith('.egg-info') ||
    normalizedName.startsWith('.baseline-work-') ||
    normalizedName.startsWith('.baseline-backup-') ||
    normalizedName.startsWith('.update-work-')
  );
}

/**
 * True when a file is ignored by git and therefore cannot be part of a
 * reproducible provenance hash.
 */
export function isExcludedFileName(name) {
  const normalizedName = name.toLowerCase();
  return (
    normalizedName === '.ds_store' ||
    normalizedName === 'thumbs.db' ||
    normalizedName === 'desktop.ini' ||
    normalizedName.endsWith('.pyc') ||
    normalizedName.endsWith('.pyo') ||
    normalizedName.endsWith('.whl') ||
    normalizedName.endsWith('.user') ||
    normalizedName.endsWith('.suo') ||
    normalizedName.endsWith('.swp') ||
    normalizedName.endsWith('.swo') ||
    normalizedName.endsWith('~')
  );
}

/**
 * Copies only the bytes represented by {@link hashDirectory}.
 *
 * The `lstat` happens before an exclusion decision so a hostile symbolic link
 * cannot hide behind an ignored artifact name such as `node_modules`.
 */
export async function copyHashableDirectory(sourceDirectory, destinationDirectory) {
  await cp(sourceDirectory, destinationDirectory, {
    recursive: true,
    filter: async (source) => {
      const sourceStat = await lstat(source);
      const sourceName = path.basename(source);

      if (sourceStat.isSymbolicLink()) {
        throw new Error(`Refusing to stage symbolic link: ${source}`);
      }

      if (sourceStat.isDirectory()) {
        return !isExcludedDirectoryName(sourceName);
      }

      return !isExcludedFileName(sourceName);
    },
  });
}

/**
 * Lists every file the hash covers, as repository-relative POSIX paths sorted
 * lexicographically.
 *
 * Exported so the ignore-scope tests can assert the exact invariant that
 * matters: everything hashed is something git will track.
 */
export async function collectHashableFiles(absoluteDirectory) {
  const files = [];
  await collectFiles(absoluteDirectory, absoluteDirectory, files);
  files.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
  return files.map((file) => file.relativePath);
}

/**
 * Computes a deterministic content hash for a skill folder.
 *
 * The hash is derived from every file inside the folder, keyed by its
 * repository-relative POSIX path sorted lexicographically, so the digest is
 * stable regardless of filesystem traversal order or host platform. Directories
 * listed in {@link HASH_EXCLUDED_DIRECTORIES} are skipped at any depth so the
 * digest describes exactly the bytes a commit can carry. For mapped skills this
 * is the *current* unverified snapshot hash — it intentionally describes the
 * bytes on disk today, not a verified upstream commit.
 */
export async function hashDirectory(absoluteDirectory) {
  const files = [];
  await collectFiles(absoluteDirectory, absoluteDirectory, files);
  files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));

  const digest = createHash('sha256');

  for (const file of files) {
    const bytes = await readFile(file.absolutePath);
    digest.update(file.relativePath, 'utf8');
    digest.update('\0');
    digest.update(bytes);
    digest.update('\0');
  }

  return `sha256:${digest.digest('hex')}`;
}

/**
 * Computes the repository's canonical sha256-prefixed hash for text inputs.
 */
export function hashText(value) {
  if (typeof value !== 'string') {
    throw new TypeError('hashText requires a string value.');
  }

  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/**
 * Hashes a JSON value after sorting object keys recursively.
 */
export function hashJson(value) {
  return hashText(serializeCanonicalJson(value));
}

function serializeCanonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('hashJson does not accept non-finite numbers.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeCanonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('hashJson accepts only plain JSON objects.');
    }
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        if (value[key] === undefined) {
          throw new TypeError('hashJson does not accept undefined object values.');
        }
        return `${JSON.stringify(key)}:${serializeCanonicalJson(value[key])}`;
      })
      .join(',')}}`;
  }
  throw new TypeError(`hashJson does not accept values of type ${typeof value}.`);
}

async function collectFiles(rootDirectory, currentDirectory, files) {
  const entries = await readdir(currentDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);
    const relativePath = toPosixPath(path.relative(rootDirectory, absolutePath));

    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to hash symbolic link: ${relativePath}`);
    }

    if (entry.isDirectory()) {
      if (isExcludedDirectoryName(entry.name)) {
        continue;
      }
      await collectFiles(rootDirectory, absolutePath, files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (isExcludedFileName(entry.name)) {
      continue;
    }

    files.push({
      absolutePath,
      relativePath,
    });
  }
}

function toPosixPath(value) {
  return value.replace(/\\/g, '/');
}
