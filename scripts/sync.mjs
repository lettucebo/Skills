import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { copyHashableDirectory, hashDirectory } from './lib/hash.mjs';
import { assertClonePathBoundary } from './lib/path-boundary.mjs';
import { loadManifest } from './lib/manifest.mjs';
import { cloneUpstream, GitCloneError } from './lib/git-source.mjs';
import {
  assertMappingsWritable,
  assertWritableSkillPath,
  buildDeletionGroups,
  buildProtectedRoots,
  classifyDiff,
  commitMessageForDiffClass,
  evaluateDeletionGuards,
  SyncProtectionError,
} from './lib/guardrails.mjs';
import { transformStaged } from './transform.mjs';
import { applyBaseline, applyUpdate } from './lib/baseline.mjs';

const { posix } = path;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, '..');

// Re-exported so existing sync consumers keep a single, shared implementation.
export { assertWritableSkillPath, buildProtectedRoots, SyncProtectionError };

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

async function lstatOrNull(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function pathIsFile(targetPath) {
  const info = await lstatOrNull(targetPath);
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
      const { path: containerAbs, stat: containerStat } = await assertClonePathBoundary(
        cloneDir,
        container,
      );
      if (!containerStat?.isDirectory()) {
        continue;
      }
      const entries = await readdir(containerAbs, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const childSource = `${container}/${entry.name}`;
        const { path: childAbs, stat: childStat } = await assertClonePathBoundary(
          cloneDir,
          childSource,
        );
        if (!childStat?.isDirectory()) {
          continue;
        }

        if (sourceSet.has(childSource)) {
          continue;
        }

        if (await pathIsFile(path.join(childAbs, 'SKILL.md'))) {
          unadopted.push({
            upstream: upstreamName,
            source: childSource,
            skillFile: `${childSource}/SKILL.md`,
          });
        }
      }
    }

    for (const mapping of mappings) {
      const { path: sourceAbs, stat: sourceStat } = await assertClonePathBoundary(
        cloneDir,
        mapping.source,
      );

      if (!sourceStat) {
        unavailable.push({
          path: mapping.path,
          upstream: upstreamName,
          reason: 'missing-source',
        });
        continue;
      }

      if (!sourceStat.isDirectory()) {
        // A non-directory upstream source (e.g. a single command markdown file
        // consumed by an unimplemented `command-to-skill` transform) cannot be
        // staged by the directory-based pipeline. Record it as a blocker rather
        // than crashing so the dry-run diff/artifact stays deterministic.
        unavailable.push({
          path: mapping.path,
          upstream: upstreamName,
          reason: 'source-not-directory',
        });
        continue;
      }

      const stagePath = path.join(stagingDir, ...mapping.path.split('/'));
      await mkdir(path.dirname(stagePath), { recursive: true });
      // Same fail-closed exclusion and symlink policy as the apply path and
      // hash, so the planned contentHash is exactly the applied contentHash.
      await copyHashableDirectory(sourceAbs, stagePath);

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
        added.push({
          path: mapping.path,
          category: 'mapped',
          preStampHash,
          upstreamCommit: clone.commit,
        });
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

      const provenance = {
        repository: {
          from: lockEntry.upstream?.repository ?? null,
          to: upstream.repository,
        },
        reference: {
          from: lockEntry.upstream?.reference ?? null,
          to: upstream.reference,
        },
        source: {
          from: lockEntry.upstream?.source ?? null,
          to: mapping.source,
        },
      };
      const provenanceChanged = Object.values(provenance).some(
        ({ from, to }) => from !== to,
      );

      if (lockEntry.contentHash && lockEntry.contentHash === preStampHash && !provenanceChanged) {
        // Verified baseline that still matches upstream: nothing to report.
        continue;
      }

      changed.push({
        path: mapping.path,
        preStampHash,
        contentHash: lockEntry.contentHash ?? null,
        upstreamCommit: clone.commit,
        ...(provenanceChanged
          ? { reason: 'provenance-change', provenance }
          : {}),
      });
    }
  }

  for (const orphan of manifest.orphans) {
    if (lockByPath.has(orphan.path)) {
      continue;
    }

    added.push({
      path: orphan.path,
      category: 'orphan',
      snapshotHash: await hashDirectory(
        path.join(repoRoot, ...orphan.path.split('/')),
      ),
      upstreamCommit: null,
    });
  }

  for (const skillPath of manifest.localSkillPaths) {
    if (lockByPath.has(skillPath)) {
      continue;
    }

    added.push({
      path: skillPath,
      category: 'local',
      snapshotHash: await hashDirectory(
        path.join(repoRoot, ...skillPath.split('/')),
      ),
      upstreamCommit: null,
    });
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
 * Builds one deletion-guard group per upstream from the manifest, lock, and
 * plan.
 *
 * The grouping itself lives in `lib/guardrails.mjs` and is shared verbatim with
 * `applyUpdate`, so the dry-run verdict and the apply verdict cannot diverge.
 * The planner additionally passes clone availability and asks for manifest
 * upstreams that have no lock entries yet, so an unavailable clone is reported
 * even with no baseline.
 */
function buildPlanDeletionGroups({ manifest, lock, sources }) {
  return buildDeletionGroups({
    manifest,
    lock,
    availableByName: new Map(
      (sources ?? []).map((source) => [source.upstream, source.available]),
    ),
    includeUnmappedUpstreams: true,
  });
}

/**
 * Classifies the planned diff into a SemVer bump and its exact commit message.
 *
 * The unverified-baseline bucket (`baselineRequired`) is deliberately excluded
 * from the change signal so an unverified snapshot is never mistaken for an
 * ordinary in-place change; its size is surfaced separately as
 * `pendingBaseline` so consumers know the classification is provisional.
 */
function buildClassification(plan) {
  const diffClass = classifyDiff({
    added: plan.added,
    changed: plan.changed,
    removed: plan.removed,
    renamed: plan.renamed,
  });

  return {
    diffClass,
    commitMessage: commitMessageForDiffClass(diffClass),
    pendingBaseline: plan.baselineRequired.length,
  };
}

/**
 * Summarizes whether a verified baseline can be established from this plan.
 *
 * Any unavailable upstream or missing mapped source is a hard blocker so a
 * transient outage (e.g. an upstream requiring SAML/SSO) is recorded as
 * blocking the baseline rather than being silently misread as a deletion. A
 * blocked deletion guardrail or an unexpected mapped removal also block. The
 * summary is deterministic: blockers are sorted by (type, path).
 */
function buildBaselineSummary(plan, guardrail) {
  const blockers = [];

  for (const entry of plan.unavailable) {
    blockers.push({ type: entry.reason, path: entry.path, upstream: entry.upstream });
  }

  for (const entry of plan.removed) {
    blockers.push({ type: 'unexpected-removal', path: entry.path });
  }

  if (guardrail.blocked) {
    blockers.push({ type: 'deletion-guardrail-blocked' });
  }

  blockers.sort((left, right) => {
    const byType = String(left.type).localeCompare(String(right.type));
    if (byType !== 0) {
      return byType;
    }
    return String(left.path ?? '').localeCompare(String(right.path ?? ''));
  });

  return { ready: blockers.length === 0, blockers };
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

  const baseWorkspace = workspaceRoot ?? os.tmpdir();
  await mkdir(baseWorkspace, { recursive: true });
  const workspace = await mkdtemp(path.join(baseWorkspace, 'skills-sync-'));

  try {
    assertMappingsWritable(manifest);

    const plan = await planSync({
      repoRoot: absoluteRepoRoot,
      manifest,
      lock,
      workspace,
      runGit,
    });

    const classification = buildClassification(plan);
    const guardrail = evaluateDeletionGuards(
      buildPlanDeletionGroups({ manifest, lock, sources: plan.sources }),
    );
    const baseline = buildBaselineSummary(plan, guardrail);

    const changeSet = { dryRun, ...plan, classification, guardrail, baseline };
    const json = serializeChangeSet(changeSet);

    if (output) {
      const outputDir = path.dirname(path.resolve(output));
      await mkdir(outputDir, { recursive: true });
      await writeFile(output, json);
    }

    return { changeSet, json };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = { dryRun: false, baseline: false, apply: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--baseline') {
      options.baseline = true;
    } else if (arg === '--apply') {
      options.apply = true;
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
    if (options.apply) {
      if (options.dryRun) {
        throw new Error('--apply cannot be combined with --dry-run: apply performs a real update.');
      }
      if (options.baseline) {
        throw new Error('--apply cannot be combined with --baseline: use one or the other.');
      }

      const result = await applyUpdate();
      const json = `${JSON.stringify(result, null, 2)}\n`;

      if (options.output) {
        const { mkdir: mkdirFs, writeFile: writeFileFs } = await import('node:fs/promises');
        const outputPath = path.resolve(options.output);
        await mkdirFs(path.dirname(outputPath), { recursive: true });
        await writeFileFs(outputPath, json);
      }

      process.stdout.write(json);
      return;
    }

    if (options.baseline) {
      if (options.dryRun) {
        throw new Error('--baseline cannot be combined with --dry-run: baseline performs a real apply.');
      }

      const result = await applyBaseline({ baseline: true });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

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
