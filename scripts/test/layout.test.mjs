import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const skillsRoot = path.join(repoRoot, 'skills');

test('all skill frontmatter names are globally unique', async () => {
  const skillDirs = await collectSkillDirectories(skillsRoot);
  const namesToPaths = new Map();

  for (const skillDir of skillDirs) {
    const skillPath = path.join(skillDir, 'SKILL.md');
    const frontmatter = await readFrontmatter(skillPath);
    const relativeSkillPath = toPosixPath(path.relative(repoRoot, skillDir));
    const paths = namesToPaths.get(frontmatter.name) ?? [];
    paths.push(relativeSkillPath);
    namesToPaths.set(frontmatter.name, paths);
  }

  const duplicates = Array.from(namesToPaths.entries())
    .filter(([, paths]) => paths.length > 1)
    .map(([name, paths]) => `${name}: ${paths.sort().join(', ')}`)
    .sort();

  assert.deepEqual(
    duplicates,
    [],
    `Expected globally unique skill names, found duplicates:\n${duplicates.join('\n')}`,
  );
});

test('source roots do not expose installable SKILL.md files at the collection root', async () => {
  const sourceEntries = await readdir(skillsRoot, { withFileTypes: true });
  const sourceRootSkills = [];

  for (const entry of sourceEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourceRoot = path.join(skillsRoot, entry.name);
    const sourceSkillPath = path.join(sourceRoot, 'SKILL.md');

    if (await pathExists(sourceSkillPath)) {
      sourceRootSkills.push(toPosixPath(path.relative(repoRoot, sourceRoot)));
    }
  }

  assert.deepEqual(
    sourceRootSkills,
    [],
    `Expected source roots to remain collection-only directories:\n${sourceRootSkills.join('\n')}`,
  );
});

test('manifest-covered skill paths exist on disk', async () => {
  const manifest = parse(
    await readFile(path.join(repoRoot, 'catalog', 'sources.yml'), 'utf8'),
  );
  const missingPaths = [];

  for (const entry of [...manifest.mappings, ...manifest.orphans, ...manifest.overrides]) {
    const skillPath = path.join(repoRoot, entry.path, 'SKILL.md');

    if (!(await pathExists(skillPath))) {
      missingPaths.push(`${entry.path} -> ${toPosixPath(path.relative(repoRoot, skillPath))}`);
    }
  }

  assert.deepEqual(
    missingPaths,
    [],
    `Expected manifest-covered skill paths to exist:\n${missingPaths.join('\n')}`,
  );
});

async function collectSkillDirectories(root) {
  const collectedPaths = [];
  await walkSkillTree(root, collectedPaths);
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

async function readFrontmatter(skillPath) {
  const skillText = await readFile(skillPath, 'utf8');
  const frontmatterMatch = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  assert.ok(frontmatterMatch, `Expected frontmatter in ${toPosixPath(path.relative(repoRoot, skillPath))}`);

  const frontmatter = parse(frontmatterMatch[1]);
  assert.equal(
    typeof frontmatter?.name,
    'string',
    `Expected frontmatter name in ${toPosixPath(path.relative(repoRoot, skillPath))}`,
  );

  return frontmatter;
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
