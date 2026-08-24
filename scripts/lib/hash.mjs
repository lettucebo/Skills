import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
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
 * Every other artifact the repository `.gitignore` would normally hide (build
 * output, logs, `.env`) is explicitly re-included under `skills/**`, so it stays
 * both tracked and hashed.
 */
export const HASH_EXCLUDED_DIRECTORIES = Object.freeze(new Set(['node_modules', '.git']));

/**
 * True when a directory entry must never be staged or hashed.
 */
export function isExcludedDirectoryName(name) {
  return HASH_EXCLUDED_DIRECTORIES.has(name);
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

async function collectFiles(rootDirectory, currentDirectory, files) {
  const entries = await readdir(currentDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);

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

    files.push({
      absolutePath,
      relativePath: toPosixPath(path.relative(rootDirectory, absolutePath)),
    });
  }
}

function toPosixPath(value) {
  return value.replace(/\\/g, '/');
}
