import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadManifest } from '../lib/manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const runtimeRoot = path.join(__dirname, '.runtime');

async function withFixture(name, run) {
  const fixtureRoot = path.join(
    runtimeRoot,
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  await mkdir(fixtureRoot, { recursive: true });

  try {
    return await run(fixtureRoot);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function writeManifest(fixtureRoot, content) {
  const manifestPath = path.join(fixtureRoot, 'catalog', 'sources.yml');
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, content);
  return manifestPath;
}

async function createSkill(fixtureRoot, relativeSkillPath) {
  const skillDir = path.join(fixtureRoot, relativeSkillPath);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: fixture-skill\ndescription: Fixture skill\n---\n',
  );
}

async function countExistingLocalSkills(root, localEntries) {
  let total = 0;

  for (const entry of localEntries) {
    const absoluteRoot = path.join(root, entry.root);

    try {
      total += await countSkillMarkdownFiles(absoluteRoot);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return total;
}

async function countSkillMarkdownFiles(root) {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      total += await countSkillMarkdownFiles(absolutePath);
      continue;
    }

    if (entry.isFile() && entry.name === 'SKILL.md') {
      total += 1;
    }
  }

  return total;
}

test('loadManifest rejects mappings that reference unknown upstreams', async () => {
  await withFixture('missing-upstream', async (fixtureRoot) => {
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'));

    const manifestPath = await writeManifest(
      fixtureRoot,
      `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: missing-upstream
    source: skills/alpha
orphans: []
local: []
overrides: []
`,
    );

    await assert.rejects(
      loadManifest(manifestPath),
      /Unknown upstream "missing-upstream"/,
    );
  });
});

test('loadManifest rejects duplicate coverage in mappings', async () => {
  await withFixture('duplicate-mapping', async (fixtureRoot) => {
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'));

    const manifestPath = await writeManifest(
      fixtureRoot,
      `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: awesome-copilot
    source: skills/alpha
  - path: skills/azure/alpha
    upstream: awesome-copilot
    source: skills/alpha-copy
orphans: []
local: []
overrides: []
`,
    );

    await assert.rejects(
      loadManifest(manifestPath),
      /covered more than once: skills\/azure\/alpha/,
    );
  });
});

test('loadManifest rejects the same skill path across categories', async () => {
  await withFixture('multi-category', async (fixtureRoot) => {
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'));

    const manifestPath = await writeManifest(
      fixtureRoot,
      `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: awesome-copilot
    source: skills/alpha
orphans:
  - path: skills/azure/alpha
    note: Intentional orphan
local: []
overrides: []
`,
    );

    await assert.rejects(
      loadManifest(manifestPath),
      /covered more than once: skills\/azure\/alpha/,
    );
  });
});

test('loadManifest rejects uncovered skills', async () => {
  await withFixture('uncovered-skill', async (fixtureRoot) => {
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'));
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'beta'));

    const manifestPath = await writeManifest(
      fixtureRoot,
      `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: awesome-copilot
    source: skills/alpha
orphans: []
local: []
overrides: []
`,
    );

    await assert.rejects(
      loadManifest(manifestPath),
      /Uncovered skill paths: skills\/azure\/beta/,
    );
  });
});

test('loadManifest accepts the repository manifest with exact 99-skill coverage', async () => {
  const manifestPath = path.join(repoRoot, 'catalog', 'sources.yml');
  const manifest = await loadManifest(manifestPath);
  const localCoverage = await countExistingLocalSkills(repoRoot, manifest.local);
  const coveredSkills =
    manifest.mappings.length + manifest.orphans.length + localCoverage;

  assert.equal(manifest.mappings.length, 96);
  assert.equal(manifest.orphans.length, 3);
  assert.equal(localCoverage, 0);
  assert.equal(coveredSkills, 99);
  assert.equal(
    manifest.local.map((entry) => entry.root).join(','),
    'skills/lettucebo',
  );

  const manifestText = await readFile(manifestPath, 'utf8');
  assert.match(manifestText, /path: skills\/vscode\/code-review/);
});
