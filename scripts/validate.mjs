import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSkillFrontmatter } from './lib/frontmatter.mjs';
import { collectManagedRelativeLinks, createLinkExceptionKey } from './lib/links.mjs';
import { loadManifest, ManifestValidationError } from './lib/manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, '..');

export class ValidationError extends Error {
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'ValidationError';
    this.errors = errors;
  }
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
