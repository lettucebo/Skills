import { access, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSkillFrontmatter } from './lib/frontmatter.mjs';
import { collectManagedRelativeLinks, createLinkExceptionKey } from './lib/links.mjs';
import { loadManifest, ManifestValidationError } from './lib/manifest.mjs';
import {
  detectLicenseText,
  normalizeFrontmatterLicense,
  RESTRICTED_SKILL_PATHS,
} from './catalog.mjs';
import { validateLicenseBundle } from './lib/license.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, '..');

export class ValidationError extends Error {
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

const LICENSE_EVIDENCE_SOURCE_PATTERN =
  /^(restricted-policy|skill-license-file|frontmatter|upstream-root:[^/\\]+|unresolved)$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function sha256(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

async function collectStoredLicenseEvidenceErrors({
  skill,
  skillDirectory,
  frontmatter,
}) {
  const evidence = skill?.licenseEvidence;
  if (!evidence) {
    return [];
  }
  const prefix = `Lock entry ${skill.path}:`;

  if (evidence.source === 'frontmatter') {
    const normalized = normalizeFrontmatterLicense(frontmatter.license);
    const hash = sha256(Buffer.from(String(frontmatter.license ?? '').trim(), 'utf8'));
    const errors = [];
    if (hash !== evidence.hash) {
      errors.push(`${prefix} frontmatter license evidence hash mismatch.`);
    }
    if (normalized !== skill.license) {
      errors.push(`${prefix} frontmatter license evidence classification mismatch.`);
    }
    return errors;
  }

  const skillFileEvidence =
    evidence.source === 'skill-license-file' ||
    (evidence.source === 'unresolved' &&
      evidence.scope === 'skill-license-file');
  if (!skillFileEvidence) {
    return [];
  }

  const filename = path.posix.basename(evidence.path ?? '');
  let content;
  try {
    content = await readFile(path.join(skillDirectory, filename));
  } catch {
    return [`${prefix} skill license evidence file is missing: ${filename}.`];
  }

  const rawHash = sha256(content);
  const lfHash = sha256(
    Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'),
  );
  const errors = [];
  if (evidence.hash !== rawHash && evidence.hash !== lfHash) {
    errors.push(`${prefix} skill license evidence hash mismatch.`);
  }
  const detected = detectLicenseText(content.toString('utf8')) ?? 'Unknown';
  if (detected !== skill.license) {
    errors.push(`${prefix} skill license evidence classification mismatch.`);
  }
  return errors;
}

export function collectLicenseEvidenceErrors(skill) {
  const errors = [];
  const prefix = `Lock entry ${skill?.path ?? '<unknown>'}:`;
  const evidence = skill?.licenseEvidence;

  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return [`${prefix} licenseEvidence must be an object.`];
  }

  if (
    typeof evidence.source !== 'string' ||
    !LICENSE_EVIDENCE_SOURCE_PATTERN.test(evidence.source)
  ) {
    errors.push(`${prefix} invalid license evidence source ${JSON.stringify(evidence.source)}.`);
    return errors;
  }

  if (skill.redistributable === false && skill.license !== 'Proprietary') {
    errors.push(`${prefix} redistributable false requires Proprietary license.`);
  }
  if (
    skill.redistributable === false &&
    evidence.source !== 'restricted-policy'
  ) {
    errors.push(`${prefix} redistributable false requires restricted-policy evidence.`);
  }
  if (
    evidence.source === 'restricted-policy' &&
    (skill.license !== 'Proprietary' || skill.redistributable !== false)
  ) {
    errors.push(`${prefix} restricted-policy evidence requires Proprietary/non-redistributable metadata.`);
  }
  if (evidence.source === 'unresolved' && skill.license !== 'Unknown') {
    errors.push(`${prefix} unresolved evidence requires license Unknown.`);
  }
  if (skill.license === 'Unknown' && evidence.source !== 'unresolved') {
    errors.push(`${prefix} Unknown license must use unresolved evidence.`);
  }

  const fileBacked =
    evidence.source === 'skill-license-file' ||
    evidence.source === 'frontmatter' ||
    evidence.source.startsWith('upstream-root:') ||
    (evidence.source === 'unresolved' &&
      (evidence.path !== undefined || evidence.hash !== undefined));
  if (fileBacked) {
    if (typeof evidence.path !== 'string' || evidence.path.trim() === '') {
      errors.push(`${prefix} file-backed license evidence requires a relative path.`);
    } else if (
      path.posix.isAbsolute(evidence.path) ||
      evidence.path.split('/').includes('..')
    ) {
      errors.push(`${prefix} license evidence path must remain relative.`);
    }
    if (!SHA256_PATTERN.test(evidence.hash ?? '')) {
      errors.push(`${prefix} file-backed license evidence requires a SHA-256 hash.`);
    }
  }

  if (evidence.source.startsWith('upstream-root:')) {
    const sourceFilename = evidence.source.slice('upstream-root:'.length);
    if (sourceFilename !== path.posix.basename(evidence.path ?? '')) {
      errors.push(`${prefix} upstream-root source filename must match evidence path.`);
    }
    if (!skill.upstream) {
      errors.push(`${prefix} upstream-root evidence requires upstream provenance.`);
    } else {
      if (evidence.repository !== skill.upstream.repository) {
        errors.push(`${prefix} evidence repository must equal pinned upstream repository.`);
      }
      if (evidence.reference !== skill.upstream.reference) {
        errors.push(`${prefix} evidence reference must equal pinned upstream reference.`);
      }
      if (evidence.commit !== skill.upstream.commit) {
        errors.push(`${prefix} evidence commit must equal pinned upstream commit.`);
      }
    }
  }

  if (
    (evidence.source === 'skill-license-file' ||
      evidence.source === 'frontmatter' ||
      (evidence.source === 'unresolved' && evidence.repository)) &&
    skill.upstream
  ) {
    if (
      evidence.repository !== skill.upstream.repository ||
      evidence.reference !== skill.upstream.reference ||
      evidence.commit !== skill.upstream.commit
    ) {
      errors.push(`${prefix} mapped file evidence must match pinned upstream provenance.`);
    }
  }

  return errors;
}

export async function validateRepository(repoRoot = defaultRepoRoot) {
  const absoluteRepoRoot = path.resolve(repoRoot);
  const skillsRoot = path.join(absoluteRepoRoot, 'skills');
  const errors = [];
  let manifest;

  try {
    manifest = await loadManifest(path.join(absoluteRepoRoot, 'catalog', 'sources.yml'));
  } catch (error) {
    errors.push(error.message);
    manifest = error instanceof ManifestValidationError ? error.partialManifest : undefined;
  }

  const skillDirectories = await collectSkillDirectories(skillsRoot);
  const sourceRootErrors = await collectSourceRootErrors(skillsRoot, absoluteRepoRoot);
  const skillNames = new Map();
  const warnings = [];
  let linkCount = 0;
  const linkExceptionsByKey = new Map(
    (manifest?.linkExceptions ?? []).map((entry) => [createLinkExceptionKey(entry.sourcePath, entry.target), entry]),
  );
  const matchedLinkExceptionKeys = new Set();

  errors.push(...sourceRootErrors);

  let lock;
  try {
    lock = JSON.parse(
      await readFile(
        path.join(absoluteRepoRoot, 'catalog', 'skills.lock.json'),
        'utf8',
      ),
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      errors.push(`Unable to read catalog/skills.lock.json: ${error.message}`);
    }
  }

  const releaseMajor = Number.parseInt(String(lock?.release ?? '').split('.')[0], 10);
  if (
    releaseMajor >= 2 &&
    lock?.release !== '2.0.0' &&
    lock?.licenseEvidenceVersion !== 1
  ) {
    errors.push(
      `Lock release ${lock?.release} requires licenseEvidenceVersion 1.`,
    );
  }
  if (
    lock?.licenseEvidenceVersion !== undefined &&
    lock.licenseEvidenceVersion !== 1
  ) {
    errors.push(
      `Unsupported licenseEvidenceVersion: ${JSON.stringify(lock.licenseEvidenceVersion)}.`,
    );
  }
  const requiresLicenseEvidence = lock?.licenseEvidenceVersion === 1;
  const lockByPath = new Map(
    (lock?.skills ?? []).map((skill) => [skill.path, skill]),
  );

  if (requiresLicenseEvidence) {
    for (const skill of lock?.skills ?? []) {
      errors.push(...collectLicenseEvidenceErrors(skill));
    }
    try {
      await validateLicenseBundle(absoluteRepoRoot, lock);
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (releaseMajor >= 2) {
    const skillPathSet = new Set(
      skillDirectories.map((directory) =>
        toPosixPath(path.relative(absoluteRepoRoot, directory))),
    );
    const mappingPathSet = new Set(
      (manifest?.mappings ?? []).map((mapping) => mapping.path),
    );
    const activeLockPathSet = new Set(
      (lock?.skills ?? [])
        .filter((skill) => skill.category !== 'removed')
        .map((skill) => skill.path),
    );

    for (const denylistedPath of RESTRICTED_SKILL_PATHS) {
      if (skillPathSet.has(denylistedPath)) {
        errors.push(
          `Denylisted skill ${denylistedPath} must not exist on disk after release 2.0.0.`,
        );
      }
      if (mappingPathSet.has(denylistedPath)) {
        errors.push(
          `Denylisted skill ${denylistedPath} must not remain an active mapping after release 2.0.0.`,
        );
      }
      if (activeLockPathSet.has(denylistedPath)) {
        errors.push(
          `Denylisted skill ${denylistedPath} must not remain an active lock entry after release 2.0.0.`,
        );
      }
    }
  }

  for (const skillDirectory of skillDirectories) {
    const skillPath = toPosixPath(path.relative(absoluteRepoRoot, skillDirectory));
    const skillFilePath = path.join(skillDirectory, 'SKILL.md');
    const skillDocumentPath = `${skillPath}/SKILL.md`;
    let skillText;

    try {
      skillText = await readFile(skillFilePath, 'utf8');
    } catch (error) {
      errors.push(error.message);
      continue;
    }

    try {
      const frontmatter = parseSkillFrontmatter(skillText, skillDocumentPath);
      const existingPaths = skillNames.get(frontmatter.name) ?? [];
      existingPaths.push(skillDocumentPath);
      skillNames.set(frontmatter.name, existingPaths);
      if (requiresLicenseEvidence) {
        errors.push(
          ...(await collectStoredLicenseEvidenceErrors({
            skill: lockByPath.get(skillPath),
            skillDirectory,
            frontmatter,
          })),
        );
      }
    } catch (error) {
      errors.push(error.message);
    }

    const markdownFiles = await collectMarkdownFiles(skillDirectory);

    for (const markdownFile of markdownFiles) {
      const markdownPath = toPosixPath(path.relative(absoluteRepoRoot, markdownFile));
      const markdownText = await readFile(markdownFile, 'utf8');
      const managedLinks = collectManagedRelativeLinks(markdownText, {
        markdownPath,
        skillPath,
      });

      linkCount += managedLinks.length;

      for (const link of managedLinks) {
        const linkExceptionKey = createLinkExceptionKey(markdownPath, link.originalTarget);
        const linkException = linkExceptionsByKey.get(linkExceptionKey);
        const targetExists = await pathExists(
          path.join(absoluteRepoRoot, ...link.resolvedPath.split('/')),
        );

        if (linkException) {
          matchedLinkExceptionKeys.add(linkExceptionKey);

          if (targetExists) {
            errors.push(
              `Stale link exception in ${link.markdownPath}: ${link.originalTarget} now resolves to ${link.resolvedPath}`,
            );
            continue;
          }

          warnings.push(
            `Known upstream broken link in ${link.markdownPath}: ${link.originalTarget} -> ${link.resolvedPath}`,
          );
          continue;
        }

        if (!targetExists) {
          errors.push(
            `Broken relative link in ${link.markdownPath}: ${link.originalTarget} -> ${link.resolvedPath}`,
          );
        }
      }
    }
  }

  for (const [name, skillPaths] of skillNames.entries()) {
    if (skillPaths.length < 2) {
      continue;
    }

    errors.push(`Duplicate skill name "${name}": ${skillPaths.sort().join(', ')}`);
  }

  for (const linkException of manifest?.linkExceptions ?? []) {
    const linkExceptionKey = createLinkExceptionKey(linkException.sourcePath, linkException.target);

    if (matchedLinkExceptionKeys.has(linkExceptionKey)) {
      continue;
    }

    errors.push(
      `Stale link exception in ${linkException.sourcePath}: ${linkException.target} no longer exists in the source file`,
    );
  }

  const sortedErrors = errors.sort((left, right) => left.localeCompare(right));

  if (sortedErrors.length > 0) {
    throw new ValidationError(sortedErrors);
  }

  return {
    skillCount: skillDirectories.length,
    linkCount,
    knownBrokenLinkCount: warnings.length,
    warnings,
  };
}

async function collectSkillDirectories(skillsRoot) {
  const collectedPaths = [];
  await walkSkillTree(skillsRoot, collectedPaths);
  return collectedPaths.sort();
}

async function walkSkillTree(currentPath, collectedPaths) {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const containsSkillFile = entries.some(
    (entry) => entry.isFile() && entry.name === 'SKILL.md',
  );

  if (containsSkillFile) {
    collectedPaths.push(currentPath);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    await walkSkillTree(path.join(currentPath, entry.name), collectedPaths);
  }
}

async function collectMarkdownFiles(root) {
  const collectedPaths = [];
  await walkMarkdownTree(root, collectedPaths);
  return collectedPaths.sort();
}

async function walkMarkdownTree(currentPath, collectedPaths) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentPath, entry.name);

    if (entry.isDirectory()) {
      await walkMarkdownTree(absolutePath, collectedPaths);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.md')) {
      collectedPaths.push(absolutePath);
    }
  }
}

async function collectSourceRootErrors(skillsRoot, repoRoot) {
  const sourceRootErrors = [];
  const entries = await readdir(skillsRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourceSkillPath = path.join(skillsRoot, entry.name, 'SKILL.md');

    if (await pathExists(sourceSkillPath)) {
      sourceRootErrors.push(
        `Source root contains installable SKILL.md: ${toPosixPath(path.relative(repoRoot, sourceSkillPath))}`,
      );
    }
  }

  return sourceRootErrors;
}

async function pathExists(targetPath) {
  // Uses fs.access, so this resolves true for either files or directories;
  // directory targets are intentionally accepted (e.g. links to reference folders).
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function toPosixPath(value) {
  return value.replace(/\\/g, '/');
}

async function main() {
  try {
    const result = await validateRepository(defaultRepoRoot);
    for (const warning of result.warnings) {
      console.warn(warning);
    }
    console.log(`Validated ${result.skillCount} skills`);
    console.log(
      `${result.knownBrokenLinkCount} known upstream broken link${result.knownBrokenLinkCount === 1 ? '' : 's'}`,
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      for (const validationError of error.errors) {
        console.error(validationError);
      }
    } else {
      console.error(error.message);
    }

    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
