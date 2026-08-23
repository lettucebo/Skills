import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Computes a deterministic content hash for a skill folder.
 *
 * The hash is derived from every file inside the folder, keyed by its
 * repository-relative POSIX path sorted lexicographically, so the digest is
 * stable regardless of filesystem traversal order or host platform. For mapped
 * skills this is the *current* unverified snapshot hash — it intentionally
 * describes the bytes on disk today, not a verified upstream commit.
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
