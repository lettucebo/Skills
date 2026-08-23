import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadManifest } from '../lib/manifest.mjs';
import { hashDirectory } from '../lib/hash.mjs';
import { historyFileName } from '../lib/history.mjs';
import { buildCatalog } from '../catalog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

async function createSkill(fixtureRoot, relativeSkillPath, name, extraFiles = {}) {
  const skillDir = path.join(fixtureRoot, relativeSkillPath);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Fixture skill ${name}\n---\n`,
  );

  for (const [relativeFile, content] of Object.entries(extraFiles)) {
    const filePath = path.join(skillDir, relativeFile);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
}

const FIXTURE_MANIFEST = `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
  anthropics:
    repository: anthropics/skills
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: awesome-copilot
    source: skills/alpha
  - path: skills/claude/docx
    upstream: anthropics
    source: skills/docx
orphans:
  - path: skills/github/orphan-one
    note: Intentional orphan.
local:
  - root: skills/lettucebo
    note: Reserved for future local skills.
overrides: []
`;

async function setupFixture(fixtureRoot) {
  await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'), 'alpha', {
    'LICENSE.txt': 'MIT License\n\nCopyright 2025 (c) Example.\n',
  });
  await createSkill(fixtureRoot, path.join('skills', 'claude', 'docx'), 'docx');
  await createSkill(
    fixtureRoot,
    path.join('skills', 'github', 'orphan-one'),
    'orphan-one',
  );

  const manifestPath = await writeManifest(fixtureRoot, FIXTURE_MANIFEST);
  const manifest = await loadManifest(manifestPath);
  return manifest;
}

function findSkill(lock, skillPath) {
  return lock.skills.find((entry) => entry.path === skillPath);
}

function indexHistory(historyFiles) {
  return new Map(historyFiles.map((file) => [file.path, file.content]));
}

test('hashDirectory produces a stable sha256 for identical content regardless of call order', async () => {
  await withFixture('hash-stability', async (fixtureRoot) => {
    const skillDir = path.join(fixtureRoot, 'skills', 'azure', 'alpha');
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'), 'alpha', {
      'references/a.md': 'alpha\n',
      'references/b.md': 'beta\n',
    });

    const first = await hashDirectory(skillDir);
    const second = await hashDirectory(skillDir);

    assert.match(first, /^sha256:[0-9a-f]{64}$/);
    assert.equal(first, second);
  });
});

test('buildCatalog marks mapped skills with null upstream commit and unverified baseline', async () => {
  await withFixture('mapped-baseline', async (fixtureRoot) => {
    const manifest = await setupFixture(fixtureRoot);
    const { lock } = await buildCatalog({
      manifest,
      repoRoot: fixtureRoot,
      commitTimestamp: '2026-08-23T22:44:23+08:00',
    });

    const alpha = findSkill(lock, 'skills/azure/alpha');
    assert.equal(alpha.category, 'mapped');
    assert.equal(alpha.baseline, 'unverified');
    assert.equal(alpha.upstream.commit, null);
    assert.equal(alpha.upstream.repository, 'github/awesome-copilot');
    assert.equal(alpha.upstream.source, 'skills/alpha');
    assert.equal(alpha.version, '1.0.0');
    assert.match(alpha.snapshotHash, /^sha256:[0-9a-f]{64}$/);
  });
});

test('buildCatalog resolves MIT license from local LICENSE.txt', async () => {
  await withFixture('mit-license', async (fixtureRoot) => {
    const manifest = await setupFixture(fixtureRoot);
    const { lock } = await buildCatalog({
      manifest,
      repoRoot: fixtureRoot,
      commitTimestamp: '2026-08-23T22:44:23+08:00',
    });

    const alpha = findSkill(lock, 'skills/azure/alpha');
    assert.equal(alpha.license, 'MIT');
    assert.equal(alpha.redistributable, true);
  });
});

test('buildCatalog marks restricted skills as non-redistributable and proprietary', async () => {
  await withFixture('restricted-license', async (fixtureRoot) => {
    const manifest = await setupFixture(fixtureRoot);
    const { lock } = await buildCatalog({
      manifest,
      repoRoot: fixtureRoot,
      commitTimestamp: '2026-08-23T22:44:23+08:00',
    });

    const docx = findSkill(lock, 'skills/claude/docx');
    assert.equal(docx.license, 'Proprietary');
    assert.equal(docx.redistributable, false);
  });
});

test('buildCatalog marks orphan skills with null upstream and orphan category', async () => {
  await withFixture('orphan-entry', async (fixtureRoot) => {
    const manifest = await setupFixture(fixtureRoot);
    const { lock } = await buildCatalog({
      manifest,
      repoRoot: fixtureRoot,
      commitTimestamp: '2026-08-23T22:44:23+08:00',
    });

    const orphan = findSkill(lock, 'skills/github/orphan-one');
    assert.equal(orphan.category, 'orphan');
    assert.equal(orphan.upstream, null);
    assert.equal(orphan.baseline, null);
  });
});

test('buildCatalog counts only physically existing skills and never the empty local root', async () => {
  await withFixture('counts', async (fixtureRoot) => {
    const manifest = await setupFixture(fixtureRoot);
    const { lock } = await buildCatalog({
      manifest,
      repoRoot: fixtureRoot,
      commitTimestamp: '2026-08-23T22:44:23+08:00',
    });

    assert.deepEqual(lock.counts, { total: 3, mapped: 2, orphan: 1, local: 0 });
    assert.equal(lock.skills.length, 3);
  });
});

test('buildCatalog sorts skills deterministically by path', async () => {
  await withFixture('sorted', async (fixtureRoot) => {
    const manifest = await setupFixture(fixtureRoot);
    const { lock } = await buildCatalog({
      manifest,
      repoRoot: fixtureRoot,
      commitTimestamp: '2026-08-23T22:44:23+08:00',
    });

    const paths = lock.skills.map((entry) => entry.path);
    assert.deepEqual(paths, [...paths].sort());
  });
});

test('buildCatalog first bootstrap history entry uses bootstrap kind with null diffUrl and commit', async () => {
  await withFixture('history-bootstrap', async (fixtureRoot) => {
    const manifest = await setupFixture(fixtureRoot);
    const { historyFiles } = await buildCatalog({
      manifest,
      repoRoot: fixtureRoot,
      commitTimestamp: '2026-08-23T22:44:23+08:00',
    });

    const alphaHistory = historyFiles.find(
      (file) => file.path === 'skills/azure/alpha',
    );
    assert.ok(alphaHistory, 'expected history for skills/azure/alpha');
    assert.equal(alphaHistory.filename, historyFileName('skills/azure/alpha'));

    const [firstEntry] = alphaHistory.content.entries;
    assert.equal(firstEntry.release, '1.0.0');
    assert.equal(firstEntry.kind, 'bootstrap');
    assert.equal(firstEntry.version, '1.0.0');
    assert.equal(firstEntry.upstreamCommit, null);
    assert.equal(firstEntry.diffUrl, null);
    assert.equal(firstEntry.firstSeen, '2026-08-23T22:44:23+08:00');
  });
});

test('buildCatalog uses the provided commit timestamp rather than wall-clock now on first bootstrap', async () => {
  await withFixture('generated-at-first', async (fixtureRoot) => {
    const manifest = await setupFixture(fixtureRoot);
    const { lock } = await buildCatalog({
      manifest,
      repoRoot: fixtureRoot,
      commitTimestamp: '2020-01-01T00:00:00Z',
    });

    assert.equal(lock.generatedAt, '2020-01-01T00:00:00Z');
  });
});

test('buildCatalog preserves the existing generatedAt when semantic output is unchanged', async () => {
  await withFixture('generated-at-preserve', async (fixtureRoot) => {
    const manifest = await setupFixture(fixtureRoot);
    const first = await buildCatalog({
      manifest,
      repoRoot: fixtureRoot,
      commitTimestamp: '2020-01-01T00:00:00Z',
    });

    const second = await buildCatalog({
      manifest,
      repoRoot: fixtureRoot,
      commitTimestamp: '2099-12-31T23:59:59Z',
      previous: {
        lock: first.lock,
        historyByPath: indexHistory(first.historyFiles),
      },
    });

    assert.equal(second.lock.generatedAt, first.lock.generatedAt);
    assert.deepEqual(second.lock, first.lock);
    assert.deepEqual(second.historyFiles, first.historyFiles);
  });
});

test('buildCatalog output is byte-identical across repeated runs with no previous state', async () => {
  await withFixture('deterministic', async (fixtureRoot) => {
    const manifest = await setupFixture(fixtureRoot);
    const first = await buildCatalog({
      manifest,
      repoRoot: fixtureRoot,
      commitTimestamp: '2026-08-23T22:44:23+08:00',
    });
    const second = await buildCatalog({
      manifest,
      repoRoot: fixtureRoot,
      commitTimestamp: '2026-08-23T22:44:23+08:00',
    });

    assert.deepEqual(second.lock, first.lock);
    assert.deepEqual(second.historyFiles, first.historyFiles);
  });
});
