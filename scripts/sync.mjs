import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashDirectory } from './lib/hash.mjs';
import { loadManifest } from './lib/manifest.mjs';
import { cloneUpstream, GitCloneError } from './lib/git-source.mjs';
import { transformStaged } from './transform.mjs';

const { posix } = path;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, '..');

/**
 * Registry root that must never be written by sync, regardless of manifest
 * contents. `skills/lettucebo` is reserved for local/original skills.
 */
const ALWAYS_PROTECTED_ROOTS = ['skills/lettucebo'];

export class SyncProtectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SyncProtectionError';
  }
}

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
}

function buildProtectedRoots(manifest) {
  const roots = new Set(ALWAYS_PROTECTED_ROOTS);

  for (const entry of manifest.local ?? []) {
    roots.add(entry.root);
  }

  return [...roots];
}

async function readLock(repoRoot) {
  const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');

  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { skills: [] };
    }

    throw error;
  }
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

async function pathIsFile(targetPath) {
  const info = await statOrNull(targetPath);
  return Boolean(info?.isFile());
}

function sortByKey(entries, key) {
  entries.sort((left, right) => String(left[key]).localeCompare(String(right[key])));
  return entries;
}

/**
 * Computes the deterministic dry-run change set.
 *
 * Each unique upstream is cloned exactly once into the run workspace. Mapped
 * sources are staged, hashed BEFORE any transform (so the pre-stamp hash is the
 * future verified `contentHash`), and only then stamped. Because the current
 * lock baseline is `unverified`, mapped skills that already exist in the lock
 * are reported as `baselineRequired` rather than being force-labelled
 * changed/unchanged.
 */
async function planSync({ repoRoot, manifest, lock, workspace, runGit }) {
  const clonesDir = path.join(workspace, 'clones');
  const stagingDir = path.join(workspace, 'staging');
  await mkdir(clonesDir, { recursive: true });
  await mkdir(stagingDir, { recursive: true });

  const lockByPath = new Map((lock?.skills ?? []).map((skill) => [skill.path, skill]));
  const mappingPaths = new Set(manifest.mappings.map((mapping) => mapping.path));

  const mappingsByUpstream = new Map();
  for (const mapping of manifest.mappings) {
    if (!mappingsByUpstream.has(mapping.upstream)) {
      mappingsByUpstream.set(mapping.upstream, []);
    }
    mappingsByUpstream.get(mapping.upstream).push(mapping);
  }

  const sources = [];
  const added = [];
  const changed = [];
  const removed = [];
  const renamed = [];
  const unavailable = [];
  const unadopted = [];
  const baselineRequired = [];

  const upstreamNames = [...mappingsByUpstream.keys()].sort();

  for (const upstreamName of upstreamNames) {
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

      sources.push({
        upstream: upstreamName,
        repository: upstream.repository,
        reference: upstream.reference,
        commit: null,
        available: false,
      });

      for (const mapping of mappings) {
        unavailable.push({
          path: mapping.path,
          upstream: upstreamName,
          reason: 'upstream-unavailable',
        });
      }

      continue;
    }

    sources.push({
      upstream: upstreamName,
      repository: upstream.repository,
      reference: upstream.reference,
      commit: clone.commit,
      available: true,
    });

    const sourceSet = new Set(mappings.map((mapping) => mapping.source));

    // Unadopted discovery is scoped to the container directories that the
    // manifest actually declares, so unrelated upstream folders never produce
    // false positives.
    const containerDirs = new Set();
    for (const mapping of mappings) {
      const parent = posix.dirname(mapping.source);
      if (parent && parent !== '.') {
        containerDirs.add(parent);
      }
    }

    for (const container of containerDirs) {
      const containerAbs = path.join(cloneDir, ...container.split('/'));
      let entries;
      try {
        entries = await readdir(containerAbs, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const childSource = `${container}/${entry.name}`;
        if (sourceSet.has(childSource)) {
          continue;
        }

        if (await pathIsFile(path.join(containerAbs, entry.name, 'SKILL.md'))) {
          unadopted.push({
            upstream: upstreamName,
            source: childSource,
            skillFile: `${childSource}/SKILL.md`,
          });
        }
      }
    }

    for (const mapping of mappings) {
      const sourceAbs = path.join(cloneDir, ...mapping.source.split('/'));
      const sourceStat = await statOrNull(sourceAbs);

      if (!sourceStat) {
        unavailable.push({
          path: mapping.path,
          upstream: upstreamName,
          reason: 'missing-source',
        });
        continue;
      }

      const stagePath = path.join(stagingDir, ...mapping.path.split('/'));
      await mkdir(path.dirname(stagePath), { recursive: true });
      await cp(sourceAbs, stagePath, { recursive: true });

      // Hash BEFORE transform/stamp: this is the future verified contentHash.
      const preStampHash = await hashDirectory(stagePath);
      const override = manifest.overrides.find((entry) => entry.path === mapping.path);
      const lockEntry = lockByPath.get(mapping.path);

      await transformStaged({
        skillDir: stagePath,
        skillPath: mapping.path,
        override,
        upstream,
        source: mapping.source,
        commit: clone.commit,
        version: lockEntry?.version ?? '1.0.0',
      });

      if (!lockEntry) {
        added.push({ path: mapping.path, preStampHash, upstreamCommit: clone.commit });
        continue;
      }

      if (lockEntry.baseline === 'unverified') {
        baselineRequired.push({
          path: mapping.path,
          preStampHash,
          snapshotHash: lockEntry.snapshotHash ?? null,
          upstreamCommit: clone.commit,
        });
        continue;
      }

      if (lockEntry.contentHash && lockEntry.contentHash === preStampHash) {
        // Verified baseline that still matches upstream: nothing to report.
        continue;
      }

      changed.push({
        path: mapping.path,
        preStampHash,
        contentHash: lockEntry.contentHash ?? null,
        upstreamCommit: clone.commit,
      });
    }
  }

  for (const skill of lock?.skills ?? []) {
    if (skill.category === 'mapped' && !mappingPaths.has(skill.path)) {
      removed.push({ path: skill.path });
    }
  }

  sortByKey(added, 'path');
  sortByKey(changed, 'path');
  sortByKey(removed, 'path');
  sortByKey(renamed, 'to');
  sortByKey(baselineRequired, 'path');
  sortByKey(unavailable, 'path');
  unadopted.sort((left, right) =>
    `${left.upstream}/${left.source}`.localeCompare(`${right.upstream}/${right.source}`),
  );
  sources.sort((left, right) => left.upstream.localeCompare(right.upstream));

  return {
    sources,
    added,
    changed,
    removed,
    renamed,
    unavailable,
    unadopted,
    baselineRequired,
  };
}

function serializeChangeSet(changeSet) {
  return `${JSON.stringify(changeSet, null, 2)}\n`;
}

/**
 * Plans an upstream sync and returns the deterministic dry-run change set.
 *
 * A fresh workspace is created under the OS temp dir (or `workspaceRoot` when
 * provided) and always removed afterwards, on success or failure. Destination
 * paths are guarded against protected roots before any clone or stage happens.
 */
export async function runSync(options = {}) {
  const {
    repoRoot = defaultRepoRoot,
    dryRun = true,
    output,
    workspaceRoot,
    runGit,
  } = options;

  const absoluteRepoRoot = path.resolve(repoRoot);
  const manifest = await loadManifest(
    path.join(absoluteRepoRoot, 'catalog', 'sources.yml'),
  );
  const lock = await readLock(absoluteRepoRoot);
  const protectedRoots = buildProtectedRoots(manifest);

  const baseWorkspace = workspaceRoot ?? os.tmpdir();
  await mkdir(baseWorkspace, { recursive: true });
  const workspace = await mkdtemp(path.join(baseWorkspace, 'skills-sync-'));

  try {
    for (const mapping of manifest.mappings) {
      assertWritableSkillPath(mapping.path, protectedRoots);
    }

    const plan = await planSync({
      repoRoot: absoluteRepoRoot,
      manifest,
      lock,
      workspace,
      runGit,
    });

    const changeSet = { dryRun, ...plan };
    const json = serializeChangeSet(changeSet);

    if (output) {
      await writeFile(output, json);
    }

    return { changeSet, json };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = { dryRun: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--output') {
      options.output = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  try {
    const { json } = await runSync({
      dryRun: options.dryRun,
      output: options.output,
    });

    if (!options.output) {
      process.stdout.write(json);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
