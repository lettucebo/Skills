import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  RESTRICTED_SKILL_PATHS,
  detectLicenseText,
  resolveLicense,
  SKILL_LICENSE_CANDIDATES,
} from '../catalog.mjs';
import { parseSkillFrontmatter } from './frontmatter.mjs';
import { cloneUpstream, GitCloneError } from './git-source.mjs';
import { assertClonePathBoundary } from './path-boundary.mjs';

const execFileAsync = promisify(execFile);

async function defaultRunGit(args) {
  const { stdout } = await execFileAsync('git', args, {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hashBytes(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function groupKey(repository, reference) {
  return `${repository}\u0000${reference}`;
}

function evidenceKey(evidence) {
  return [
    evidence.repository,
    evidence.reference,
    evidence.commit,
    evidence.path ?? evidence.sourcePath,
    evidence.hash,
  ].join('\u0000');
}

export class LicenseEvidenceError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'LicenseEvidenceError';
    this.cause = cause;
  }
}

async function fetchDeclaredRefHistory(clone, reference, runGit) {
  const shallow = (
    await runGit(['-C', clone.dir, 'rev-parse', '--is-shallow-repository'])
  ).trim() === 'true';

  if (shallow) {
    await runGit(['-C', clone.dir, 'fetch', '--unshallow', 'origin', clone.ref]);
  } else {
    await runGit(['-C', clone.dir, 'fetch', 'origin', clone.ref]);
  }

  return clone.commit;
}

async function assertPinnedCommitReachable({
  clone,
  reference,
  pinnedCommit,
  refCommit,
  runGit,
}) {
  try {
    await runGit(['-C', clone.dir, 'fetch', 'origin', pinnedCommit]);
    await runGit(['-C', clone.dir, 'cat-file', '-e', `${pinnedCommit}^{commit}`]);
  } catch (error) {
    throw new LicenseEvidenceError(
      `Pinned commit ${pinnedCommit} is unavailable for ${reference}.`,
      error,
    );
  }

  try {
    await runGit([
      '-C',
      clone.dir,
      'merge-base',
      '--is-ancestor',
      pinnedCommit,
      refCommit,
    ]);
  } catch (error) {
    throw new LicenseEvidenceError(
      `Pinned commit ${pinnedCommit} is not reachable from declared ref ${reference}.`,
      error,
    );
  }
}

export async function readRootLicenseEvidence(cloneDir, upstream) {
  const rootEntries = await readdir(cloneDir, { withFileTypes: true });
  const filesByFoldedName = new Map();

  for (const entry of rootEntries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }
    const folded = entry.name.toLowerCase();
    const names = filesByFoldedName.get(folded) ?? [];
    names.push(entry.name);
    names.sort(compareStrings);
    filesByFoldedName.set(folded, names);
  }

  for (const candidate of SKILL_LICENSE_CANDIDATES) {
    const matchingNames = filesByFoldedName.get(candidate.toLowerCase()) ?? [];
    for (const filename of matchingNames) {
      const { path: absolutePath, stat } = await assertClonePathBoundary(
        cloneDir,
        filename,
      );
      if (!stat?.isFile()) {
        continue;
      }

      const content = await readFile(absolutePath);
      const license = detectLicenseText(content.toString('utf8'));
      return {
        license,
        filename,
        path: filename,
        hash: hashBytes(content),
        content,
        ...upstream,
      };
    }
  }

  return null;
}

function findManifestUpstream(manifest, repository, reference) {
  return Object.entries(manifest.upstreams ?? {}).find(
    ([, upstream]) =>
      upstream.repository === repository && upstream.reference === reference,
  );
}

/**
 * Resolves mapped entries from their exact lock-pinned commits.
 *
 * Each repository/reference pair is cloned once and fully fetches the declared
 * ref before any pinned commit is accepted. Every pinned commit must be an
 * ancestor of the cloned ref tip. The checkout is then detached at that exact
 * commit before skill and root license files are read.
 */
export async function resolvePinnedMappedLicenses({
  manifest,
  lock,
  workspace,
  runGit = defaultRunGit,
}) {
  await mkdir(workspace, { recursive: true });

  const resolvedByPath = new Map();
  for (const skill of lock.skills ?? []) {
    if (skill.category === 'removed' && RESTRICTED_SKILL_PATHS.has(skill.path)) {
      resolvedByPath.set(skill.path, {
        license: 'Proprietary',
        redistributable: false,
        licenseEvidence: { source: 'restricted-policy' },
      });
    }
  }

  const entries = (lock.skills ?? [])
    .filter((skill) => skill.upstream && !resolvedByPath.has(skill.path))
    .sort((left, right) => compareStrings(left.path, right.path));
  const groups = new Map();

  for (const skill of entries) {
    const { repository, reference } = skill.upstream;
    if (!findManifestUpstream(manifest, repository, reference)) {
      throw new LicenseEvidenceError(
        `Lock entry ${skill.path} has no declared upstream matching ${repository} at ${reference}.`,
      );
    }

    const key = groupKey(repository, reference);
    const group = groups.get(key) ?? { repository, reference, skills: [] };
    group.skills.push(skill);
    groups.set(key, group);
  }

  const rootLicensesByKey = new Map();
  let distinctPinnedCommits = 0;

  for (const [groupIndex, group] of [...groups.values()]
    .sort((left, right) =>
      compareStrings(
        groupKey(left.repository, left.reference),
        groupKey(right.repository, right.reference),
      ),
    )
    .entries()) {
    const cloneDir = path.join(workspace, `upstream-${String(groupIndex + 1).padStart(2, '0')}`);
    let clone;
    try {
      clone = await cloneUpstream({
        repository: group.repository,
        reference: group.reference,
        destination: cloneDir,
        runGit,
      });
      const refCommit = await fetchDeclaredRefHistory(clone, group.reference, runGit);
      const skillsByCommit = new Map();
      for (const skill of group.skills) {
        const pinnedCommit = skill.upstream.commit;
        if (!/^[0-9a-f]{40}$/i.test(pinnedCommit ?? '')) {
          throw new LicenseEvidenceError(
            `Lock entry ${skill.path} has an invalid pinned upstream commit.`,
          );
        }
        const list = skillsByCommit.get(pinnedCommit) ?? [];
        list.push(skill);
        skillsByCommit.set(pinnedCommit, list);
      }

      for (const pinnedCommit of [...skillsByCommit.keys()].sort(compareStrings)) {
        distinctPinnedCommits += 1;
        await assertPinnedCommitReachable({
          clone,
          reference: group.reference,
          pinnedCommit,
          refCommit,
          runGit,
        });
        await runGit(['-C', clone.dir, 'checkout', '--detach', '--force', pinnedCommit]);

        const upstreamEvidence = {
          repository: group.repository,
          reference: group.reference,
          commit: pinnedCommit,
        };
        const rootLicense = await readRootLicenseEvidence(clone.dir, upstreamEvidence);

        for (const skill of skillsByCommit.get(pinnedCommit)) {
          if (RESTRICTED_SKILL_PATHS.has(skill.path)) {
            resolvedByPath.set(skill.path, {
              license: 'Proprietary',
              redistributable: false,
              licenseEvidence: { source: 'restricted-policy' },
            });
            continue;
          }

          const sourcePath = skill.upstream.source;
          const { path: sourceDir, stat } = await assertClonePathBoundary(
            clone.dir,
            sourcePath,
          );
          if (!stat?.isDirectory()) {
            throw new LicenseEvidenceError(
              `Pinned skill source ${sourcePath} is unavailable at ${pinnedCommit}.`,
            );
          }

          const skillFile = path.join(sourceDir, 'SKILL.md');
          const frontmatter = parseSkillFrontmatter(
            await readFile(skillFile, 'utf8'),
            `${sourcePath}/SKILL.md`,
          );
          const resolved = await resolveLicense(
            clone.dir,
            sourcePath,
            frontmatter,
            { upstream: upstreamEvidence, rootLicense },
          );
          resolvedByPath.set(skill.path, resolved);

          if (
            rootLicense &&
            resolved.licenseEvidence.path === rootLicense.path &&
            resolved.licenseEvidence.hash === rootLicense.hash
          ) {
            rootLicensesByKey.set(evidenceKey(rootLicense), rootLicense);
          }
        }
      }
    } catch (error) {
      if (error instanceof LicenseEvidenceError) {
        throw error;
      }
      const detail = error instanceof GitCloneError ? error.message : String(error.message ?? error);
      throw new LicenseEvidenceError(
        `Unable to resolve pinned license evidence for ${group.repository} at ${group.reference}: ${detail}`,
        error,
      );
    }
  }

  return {
    resolvedByPath,
    rootLicenses: [...rootLicensesByKey.values()].sort((left, right) =>
      compareStrings(evidenceKey(left), evidenceKey(right)),
    ),
    summary: {
      fetchedGroups: groups.size,
      distinctPinnedCommits,
      resolvedSkills: resolvedByPath.size,
      rootLicenseFiles: rootLicensesByKey.size,
    },
  };
}

function bundleFileName(evidence) {
  if (!/^[0-9a-f]{40}$/i.test(evidence.commit ?? '')) {
    throw new LicenseEvidenceError(
      `License evidence commit must be a 40-character SHA: ${JSON.stringify(evidence.commit)}.`,
    );
  }
  const repositoryLabel = evidence.repository
    .replace(/\.git$/i, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .slice(-2)
    .join('--')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .slice(0, 48) || 'upstream';
  const repositoryKey = createHash('sha256')
    .update(`${evidence.repository}\0${evidence.reference}`)
    .digest('hex')
    .slice(0, 16);
  const sourceName = path.posix.basename(evidence.path).replace(/[^a-z0-9._-]+/gi, '-');
  return `${repositoryLabel}--${repositoryKey}--${evidence.commit}--${sourceName}`;
}

export async function writeLicenseBundle(destination, rootLicenses, { release }) {
  const deduplicated = new Map();
  for (const evidence of rootLicenses) {
    deduplicated.set(evidenceKey(evidence), evidence);
  }

  const licenses = [];
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  for (const evidence of [...deduplicated.values()].sort((left, right) =>
    compareStrings(evidenceKey(left), evidenceKey(right)),
  )) {
    const bundlePath = bundleFileName(evidence);
    await writeFile(path.join(destination, bundlePath), evidence.content);
    licenses.push({
      repository: evidence.repository,
      reference: evidence.reference,
      commit: evidence.commit,
      license: evidence.license ?? 'Unknown',
      sourcePath: evidence.path,
      hash: evidence.hash,
      bundlePath,
    });
  }

  const metadata = { release, licenses };
  await writeFile(
    path.join(destination, 'index.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  return metadata;
}

export async function validateLicenseBundle(repoRoot, lock) {
  const directory = path.join(repoRoot, 'catalog', 'licenses');
  let metadata;
  try {
    metadata = JSON.parse(
      await readFile(path.join(directory, 'index.json'), 'utf8'),
    );
  } catch (error) {
    throw new LicenseEvidenceError(
      `Unable to read catalog/licenses/index.json: ${error.message}`,
      error,
    );
  }

  if (metadata.release !== lock.release || !Array.isArray(metadata.licenses)) {
    throw new LicenseEvidenceError(
      'License bundle metadata must match lock release and contain a licenses array.',
    );
  }

  const required = new Map();
  for (const skill of lock.skills ?? []) {
    const evidence = skill.licenseEvidence;
    if (
      evidence?.source?.startsWith('upstream-root:') ||
      (evidence?.source === 'unresolved' &&
        evidence.scope === 'upstream-root' &&
        evidence.repository &&
        evidence.path &&
        evidence.hash)
    ) {
      required.set(evidenceKey(evidence), evidence);
    }
  }

  const indexed = new Map();
  const expectedFiles = new Set(['index.json']);
  for (const entry of metadata.licenses) {
    if (!/^[0-9a-f]{40}$/i.test(entry.commit ?? '')) {
      throw new LicenseEvidenceError(
        `License evidence commit must be a 40-character SHA: ${JSON.stringify(entry.commit)}.`,
      );
    }
    if (
      typeof entry.bundlePath !== 'string' ||
      entry.bundlePath !== path.basename(entry.bundlePath) ||
      entry.bundlePath === '.' ||
      entry.bundlePath === '..' ||
      entry.bundlePath.includes('/') ||
      entry.bundlePath.includes('\\')
    ) {
      throw new LicenseEvidenceError(
        `License bundlePath must be a filename: ${JSON.stringify(entry.bundlePath)}.`,
      );
    }
    if (indexed.has(evidenceKey(entry))) {
      throw new LicenseEvidenceError('License bundle contains duplicate evidence metadata.');
    }

    const content = await readFile(path.join(directory, entry.bundlePath));
    const actualHash = hashBytes(content);
    if (actualHash !== entry.hash) {
      throw new LicenseEvidenceError(
        `License bundle hash mismatch for ${entry.bundlePath}: expected ${entry.hash}, got ${actualHash}.`,
      );
    }
    indexed.set(evidenceKey(entry), entry);
    expectedFiles.add(entry.bundlePath);
  }

  for (const key of required.keys()) {
    if (!indexed.has(key)) {
      throw new LicenseEvidenceError(
        'License bundle is missing root evidence required by the lock.',
      );
    }
  }
  for (const key of indexed.keys()) {
    if (!required.has(key)) {
      throw new LicenseEvidenceError(
        'License bundle contains root evidence not referenced by the lock.',
      );
    }
  }

  const actualFiles = (await readdir(directory)).sort(compareStrings);
  const declaredFiles = [...expectedFiles].sort(compareStrings);
  if (JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)) {
    throw new LicenseEvidenceError(
      'License bundle directory contains missing or undeclared files.',
    );
  }

  return metadata;
}
