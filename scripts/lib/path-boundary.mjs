import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export class PathBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathBoundaryError';
  }
}

function isWithinRoot(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sourceSegments(sourcePath) {
  if (typeof sourcePath !== 'string') {
    throw new PathBoundaryError('Refusing mapped source: source path must be a string.');
  }

  return sourcePath.split('/').filter(Boolean);
}

/**
 * Returns the final lstat result for a source beneath a trusted clone root.
 *
 * Every component is lstat'd before it can be traversed. Node reports Windows
 * junctions and symbolic links through `isSymbolicLink()`, so this rejects
 * both link forms without following either. Each existing component is also
 * realpath-checked to keep the canonical path under the canonical clone root.
 * A missing final component is returned as `stat: null` so callers can retain
 * their normal missing-source reporting.
 */
export async function assertClonePathBoundary(cloneRoot, sourcePath) {
  const rootPath = path.resolve(cloneRoot);
  const rootStat = await lstat(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new PathBoundaryError(`Refusing mapped source path boundary: invalid clone root ${rootPath}.`);
  }

  const canonicalRoot = await realpath(rootPath);
  const candidatePath = path.resolve(rootPath, ...sourceSegments(sourcePath));
  if (!isWithinRoot(rootPath, candidatePath)) {
    throw new PathBoundaryError(
      `Refusing mapped source path boundary: ${sourcePath} escapes clone root ${rootPath}.`,
    );
  }

  let currentPath = rootPath;
  for (const segment of sourceSegments(sourcePath)) {
    currentPath = path.join(currentPath, segment);
    let currentStat;
    try {
      currentStat = await lstat(currentPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { path: candidatePath, stat: null };
      }
      throw error;
    }

    if (currentStat.isSymbolicLink()) {
      throw new PathBoundaryError(
        `Refusing mapped source path boundary: symbolic link or junction at ${currentPath}.`,
      );
    }

    const canonicalCurrent = await realpath(currentPath);
    if (!isWithinRoot(canonicalRoot, canonicalCurrent)) {
      throw new PathBoundaryError(
        `Refusing mapped source path boundary: ${currentPath} resolves outside clone root ${canonicalRoot}.`,
      );
    }
  }

  return { path: candidatePath, stat: await lstat(candidatePath) };
}
