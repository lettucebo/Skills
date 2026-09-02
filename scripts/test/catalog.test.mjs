import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadManifest } from '../lib/manifest.mjs';
import { hashDirectory } from '../lib/hash.mjs';
import { historyFileName } from '../lib/history.mjs';
import {
  buildCatalog,
  detectLicenseText,
  LicensePolicyError,
  renderReadme,
  resolveLicense,
} from '../catalog.mjs';

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

function runCommand(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' });
}

async function copyCatalogRuntime(fixtureRoot) {
  const sourceScriptsRoot = path.resolve(__dirname, '..');
  const libSourceRoot = path.join(sourceScriptsRoot, 'lib');
  const libEntries = await readdir(libSourceRoot, { withFileTypes: true });
  const filesToCopy = [
    ['catalog.mjs', 'scripts/catalog.mjs'],
    ...libEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
      .map((entry) => [`lib/${entry.name}`, `scripts/lib/${entry.name}`]),
  ];

  for (const [sourceRelativePath, targetRelativePath] of filesToCopy) {
    const sourcePath = path.join(sourceScriptsRoot, sourceRelativePath);
    const targetPath = path.join(fixtureRoot, targetRelativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, await readFile(sourcePath, 'utf8'));
  }
}

async function initializeFixtureRepo(fixtureRoot) {
  await writeFile(
    path.join(fixtureRoot, 'README.md'),
    '# Fixture README\n\n<!-- CATALOG:START -->\nold\n<!-- CATALOG:END -->\n',
  );

  runCommand('git', ['init'], fixtureRoot);
  runCommand('git', ['config', 'core.autocrlf', 'false'], fixtureRoot);
  runCommand('git', ['config', 'user.name', 'Fixture Tester'], fixtureRoot);
  runCommand('git', ['config', 'user.email', 'fixture@example.test'], fixtureRoot);
  runCommand('git', ['add', '.'], fixtureRoot);
  runCommand(
    'git',
    ['commit', '-m', 'fixture bootstrap', '--date', '2020-01-01T00:00:00Z'],
    fixtureRoot,
  );
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

async function setupDoubleUnderscoreFixture(fixtureRoot) {
  await createSkill(
    fixtureRoot,
    path.join('skills', 'azure', 'foo__bar'),
    'foo__bar',
  );

  const manifest = await writeManifest(
    fixtureRoot,
    `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/foo__bar
    upstream: awesome-copilot
    source: skills/foo__bar
orphans: []
local: []
overrides: []
`,
  );

  return loadManifest(manifest);
}

async function setupHistoryCollisionFixture(fixtureRoot) {
  await createSkill(
    fixtureRoot,
    path.join('skills', 'azure', 'foo__bar'),
    'foo__bar',
  );
  await createSkill(
    fixtureRoot,
    path.join('skills', 'azure', 'foo', 'bar'),
    'foo-bar',
  );

  const manifest = await writeManifest(
    fixtureRoot,
    `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/foo__bar
    upstream: awesome-copilot
    source: skills/foo__bar
  - path: skills/azure/foo/bar
    upstream: awesome-copilot
    source: skills/foo/bar
orphans: []
local: []
overrides: []
`,
  );

  return loadManifest(manifest);
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
    assert.equal(alpha.licenseEvidence.source, 'skill-license-file');
    assert.equal(alpha.licenseEvidence.path, 'skills/azure/alpha/LICENSE.txt');
    assert.match(alpha.licenseEvidence.hash, /^sha256:[0-9a-f]{64}$/);
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
    assert.deepEqual(docx.licenseEvidence, { source: 'restricted-policy' });
  });
});

test('resolveLicense checks every supported skill-local license filename variant', async () => {
  await withFixture('license-candidates', async (fixtureRoot) => {
    const candidates = [
      'LICENSE.txt',
      'LICENSE',
      'LICENSE.md',
      'LICENCE.txt',
      'LICENCE',
      'LICENCE.md',
      'COPYING',
    ];

    for (const [index, candidate] of candidates.entries()) {
      const skillPath = `skills/demo/skill-${index}`;
      await createSkill(fixtureRoot, skillPath, `skill-${index}`, {
        [candidate]: 'MIT License\n\nCopyright (c) Fixture\n',
      });

      const result = await resolveLicense(fixtureRoot, skillPath, {
        license: 'Apache-2.0',
      });

      assert.equal(result.license, 'MIT', candidate);
      assert.equal(result.licenseEvidence.source, 'skill-license-file', candidate);
      assert.equal(result.licenseEvidence.path, `${skillPath}/${candidate}`, candidate);
    }
  });
});

test('resolveLicense uses restricted, skill file, frontmatter, root, then unresolved priority', async () => {
  await withFixture('license-priority', async (fixtureRoot) => {
    const upstream = {
      repository: 'example/upstream',
      reference: 'refs/heads/main',
      commit: 'a'.repeat(40),
    };
    const rootLicense = {
      license: 'Apache-2.0',
      filename: 'LICENSE',
      path: 'LICENSE',
      hash: `sha256:${'b'.repeat(64)}`,
      ...upstream,
    };

    await createSkill(fixtureRoot, 'skills/demo/local-wins', 'local-wins', {
      LICENSE: 'MIT License\n\nCopyright (c) Fixture\n',
    });
    const local = await resolveLicense(
      fixtureRoot,
      'skills/demo/local-wins',
      { license: 'Apache-2.0' },
      { upstream, rootLicense },
    );
    assert.equal(local.license, 'MIT');
    assert.equal(local.licenseEvidence.source, 'skill-license-file');
    assert.equal(local.licenseEvidence.commit, upstream.commit);

    await createSkill(fixtureRoot, 'skills/demo/frontmatter-wins', 'frontmatter-wins');
    const frontmatter = await resolveLicense(
      fixtureRoot,
      'skills/demo/frontmatter-wins',
      { license: 'MIT' },
      { upstream, rootLicense },
    );
    assert.equal(frontmatter.license, 'MIT');
    assert.equal(frontmatter.licenseEvidence.source, 'frontmatter');
    assert.equal(frontmatter.licenseEvidence.commit, upstream.commit);

    await createSkill(fixtureRoot, 'skills/demo/root-wins', 'root-wins');
    const root = await resolveLicense(
      fixtureRoot,
      'skills/demo/root-wins',
      {},
      { upstream, rootLicense },
    );
    assert.equal(root.license, 'Apache-2.0');
    assert.deepEqual(root.licenseEvidence, {
      source: 'upstream-root:LICENSE',
      repository: upstream.repository,
      reference: upstream.reference,
      commit: upstream.commit,
      path: 'LICENSE',
      hash: rootLicense.hash,
    });

    const unresolved = await resolveLicense(
      fixtureRoot,
      'skills/demo/root-wins',
      {},
    );
    assert.equal(unresolved.license, 'Unknown');
    assert.deepEqual(unresolved.licenseEvidence, { source: 'unresolved' });
  });
});

test('detectLicenseText recognizes exact MIT and Apache texts and fails closed otherwise', () => {
  assert.equal(
    detectLicenseText('MIT License\n\nPermission is hereby granted, free of charge'),
    'MIT',
  );
  assert.equal(
    detectLicenseText('Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/'),
    'Apache-2.0',
  );
  assert.equal(detectLicenseText('MIT-like terms from a README'), null);
  assert.equal(detectLicenseText('Apache-compatible package metadata'), null);
});

test('resolveLicense applies restricted policy to the registry path while reading an upstream source path', async () => {
  await withFixture('restricted-policy-path', async (fixtureRoot) => {
    await createSkill(fixtureRoot, 'skills/docx', 'docx', {
      LICENSE: 'MIT License\n',
    });
    const result = await resolveLicense(
      fixtureRoot,
      'skills/docx',
      { license: 'MIT' },
      { policyPath: 'skills/claude/docx' },
    );
    assert.deepEqual(result, {
      license: 'Proprietary',
      redistributable: false,
      licenseEvidence: { source: 'restricted-policy' },
    });
  });
});

test('an unrecognized explicit skill license stays Unknown instead of falling through', async () => {
  await withFixture('unrecognized-explicit-license', async (fixtureRoot) => {
    await createSkill(fixtureRoot, 'skills/demo/custom', 'custom', {
      LICENSE: 'Custom terms that are not recognized.\n',
    });

    const result = await resolveLicense(
      fixtureRoot,
      'skills/demo/custom',
      { license: 'MIT' },
      {
        rootLicense: {
          license: 'Apache-2.0',
          filename: 'LICENSE',
          path: 'LICENSE',
          hash: `sha256:${'a'.repeat(64)}`,
          repository: 'example/repo',
          reference: 'refs/heads/main',
          commit: 'b'.repeat(40),
        },
      },
    );
    assert.equal(result.license, 'Unknown');
    assert.equal(result.licenseEvidence.source, 'unresolved');
    assert.equal(result.licenseEvidence.scope, 'skill-license-file');
    assert.equal(result.licenseEvidence.path, 'skills/demo/custom/LICENSE');
    assert.match(result.licenseEvidence.hash, /^sha256:[0-9a-f]{64}$/);
  });
});

test('proprietary evidence outside the permanent denylist fails closed', async () => {
  await withFixture('proprietary-policy', async (fixtureRoot) => {
    await createSkill(fixtureRoot, 'skills/demo/proprietary', 'proprietary', {
      LICENSE: 'Copyright Anthropic PBC. All rights reserved.\n',
    });
    await assert.rejects(
      resolveLicense(fixtureRoot, 'skills/demo/proprietary', {}),
      (error) =>
        error instanceof LicensePolicyError &&
        /add it to RESTRICTED_SKILL_PATHS/.test(error.message),
    );
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

test('buildCatalog keeps a one-entry bootstrap history byte-identical on second bootstrap', async () => {
  await withFixture('history-bootstrap-idempotent', async (fixtureRoot) => {
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

    assert.deepEqual(second.historyFiles, first.historyFiles);
    assert.equal(
      second.historyFiles.find((file) => file.path === 'skills/azure/alpha')?.content.entries[0]
        ?.firstSeen,
      '2020-01-01T00:00:00Z',
    );
  });
});

test('buildCatalog refuses to overwrite previous release history during bootstrap', async () => {
  await withFixture('history-release-guard', async (fixtureRoot) => {
    const manifest = await setupFixture(fixtureRoot);

    await assert.rejects(
      buildCatalog({
        manifest,
        repoRoot: fixtureRoot,
        commitTimestamp: '2099-12-31T23:59:59Z',
        previous: {
          historyByPath: new Map([
            [
              'skills/azure/alpha',
              {
                path: 'skills/azure/alpha',
                name: 'alpha',
                category: 'mapped',
                entries: [
                  {
                    release: '1.0.0',
                    kind: 'bootstrap',
                    version: '1.0.0',
                    firstSeen: '2020-01-01T00:00:00Z',
                    upstreamCommit: null,
                    diffUrl: null,
                    snapshotHash: 'sha256:first',
                  },
                  {
                    release: '1.1.0',
                    kind: 'release',
                    version: '1.1.0',
                    firstSeen: '2020-02-01T00:00:00Z',
                    upstreamCommit: 'abc123',
                    diffUrl: 'https://example.test/diff',
                    snapshotHash: 'sha256:second',
                  },
                ],
              },
            ],
          ]),
        },
      }),
      /Refusing to overwrite release history for skills\/azure\/alpha: existing history already contains 2 entries; rerun bootstrap only on a single bootstrap entry\./,
    );
  });
});

test('buildCatalog refuses bootstrap histories whose only entry is not bootstrap', async () => {
  await withFixture('history-kind-guard', async (fixtureRoot) => {
    const manifest = await setupFixture(fixtureRoot);

    await assert.rejects(
      buildCatalog({
        manifest,
        repoRoot: fixtureRoot,
        commitTimestamp: '2099-12-31T23:59:59Z',
        previous: {
          historyByPath: new Map([
            [
              'skills/azure/alpha',
              {
                path: 'skills/azure/alpha',
                name: 'alpha',
                category: 'mapped',
                entries: [
                  {
                    release: '1.1.0',
                    kind: 'release',
                    version: '1.1.0',
                    firstSeen: '2020-02-01T00:00:00Z',
                    upstreamCommit: 'abc123',
                    diffUrl: 'https://example.test/diff',
                    snapshotHash: 'sha256:second',
                  },
                ],
              },
            ],
          ]),
        },
      }),
      /Refusing to overwrite release history for skills\/azure\/alpha: existing history entry kind must remain bootstrap, found "release"\./,
    );
  });
});

test('buildCatalog refuses malformed previous bootstrap history entries', async () => {
  await withFixture('history-malformed-guard', async (fixtureRoot) => {
    const manifest = await setupFixture(fixtureRoot);

    await assert.rejects(
      buildCatalog({
        manifest,
        repoRoot: fixtureRoot,
        commitTimestamp: '2099-12-31T23:59:59Z',
        previous: {
          historyByPath: new Map([
            [
              'skills/azure/alpha',
              {
                path: 'skills/azure/alpha',
                name: 'alpha',
                category: 'mapped',
                entries: [],
              },
            ],
          ]),
        },
      }),
      /Refusing to overwrite release history for skills\/azure\/alpha: existing history must contain exactly one bootstrap entry\./,
    );

    await assert.rejects(
      buildCatalog({
        manifest,
        repoRoot: fixtureRoot,
        commitTimestamp: '2099-12-31T23:59:59Z',
        previous: {
          historyByPath: new Map([
            [
              'skills/azure/alpha',
              {
                path: 'skills/azure/alpha',
                name: 'alpha',
                category: 'mapped',
                entries: null,
              },
            ],
          ]),
        },
      }),
      /Refusing to overwrite release history for skills\/azure\/alpha: existing history entries must be an array with exactly one bootstrap entry\./,
    );
  });
});

test('catalog bootstrap refuses malformed on-disk history files instead of silently resetting them', async () => {
  await withFixture('history-invalid-json-guard', async (fixtureRoot) => {
    await setupFixture(fixtureRoot);
    await copyCatalogRuntime(fixtureRoot);
    await initializeFixtureRepo(fixtureRoot);

    const historyPath = path.join(
      fixtureRoot,
      'catalog',
      'history',
      historyFileName('skills/azure/alpha'),
    );
    await mkdir(path.dirname(historyPath), { recursive: true });
    await writeFile(historyPath, '{not valid json');

    assert.throws(
      () => runCommand('node', ['scripts/catalog.mjs', '--bootstrap'], fixtureRoot),
      /Refusing to load malformed history file .*skills__azure__alpha\.json/,
    );
  });
});

test('catalog bootstrap refuses on-disk history files without a path', async () => {
  await withFixture('history-missing-path-guard', async (fixtureRoot) => {
    await setupFixture(fixtureRoot);
    await copyCatalogRuntime(fixtureRoot);
    await initializeFixtureRepo(fixtureRoot);

    const historyPath = path.join(
      fixtureRoot,
      'catalog',
      'history',
      historyFileName('skills/azure/alpha'),
    );
    await mkdir(path.dirname(historyPath), { recursive: true });
    await writeFile(
      historyPath,
      JSON.stringify({
        name: 'alpha',
        category: 'mapped',
        entries: [],
      }),
    );

    assert.throws(
      () => runCommand('node', ['scripts/catalog.mjs', '--bootstrap'], fixtureRoot),
      /Refusing to load malformed history file .*skills__azure__alpha\.json: expected a string path\./,
    );
  });
});

test('catalog bootstrap refuses on-disk history files whose path mismatches the filename', async () => {
  await withFixture('history-path-mismatch-guard', async (fixtureRoot) => {
    await setupFixture(fixtureRoot);
    await copyCatalogRuntime(fixtureRoot);
    await initializeFixtureRepo(fixtureRoot);

    const historyPath = path.join(
      fixtureRoot,
      'catalog',
      'history',
      historyFileName('skills/azure/alpha'),
    );
    await mkdir(path.dirname(historyPath), { recursive: true });
    await writeFile(
      historyPath,
      JSON.stringify({
        path: 'skills/not-the-same',
        name: 'alpha',
        category: 'mapped',
        entries: [
          {
            release: '1.0.0',
            kind: 'bootstrap',
            version: '1.0.0',
            firstSeen: '1999-12-31T00:00:00Z',
            upstreamCommit: null,
            diffUrl: null,
            snapshotHash: 'sha256:first',
          },
        ],
      }),
    );

    assert.throws(
      () => runCommand('node', ['scripts/catalog.mjs', '--bootstrap'], fixtureRoot),
      /Refusing to load malformed history file .*skills__azure__alpha\.json: expected path "skills\/not-the-same" to encode to "skills__azure__alpha\.json"\./,
    );
  });
});

test('catalog bootstrap accepts generated histories for skill paths containing double underscores', async () => {
  await withFixture('history-double-underscore', async (fixtureRoot) => {
    const manifest = await setupDoubleUnderscoreFixture(fixtureRoot);
    await copyCatalogRuntime(fixtureRoot);
    await initializeFixtureRepo(fixtureRoot);

    const { historyFiles } = await buildCatalog({
      manifest,
      repoRoot: fixtureRoot,
      commitTimestamp: '2020-01-01T00:00:00Z',
    });
    const [historyFile] = historyFiles;
    const historyPath = path.join(fixtureRoot, 'catalog', 'history', historyFile.filename);
    await mkdir(path.dirname(historyPath), { recursive: true });
    await writeFile(historyPath, JSON.stringify(historyFile.content, null, 2));

    runCommand('node', ['scripts/catalog.mjs', '--bootstrap'], fixtureRoot);

    const writtenHistory = JSON.parse(await readFile(historyPath, 'utf8'));
    assert.equal(writtenHistory.path, 'skills/azure/foo__bar');
    assert.equal(writtenHistory.entries[0].firstSeen, '2020-01-01T00:00:00Z');
  });
});

test('buildCatalog refuses ambiguous history filenames for distinct skill paths', async () => {
  await withFixture('history-filename-collision', async (fixtureRoot) => {
    const manifest = await setupHistoryCollisionFixture(fixtureRoot);

    await assert.rejects(
      buildCatalog({
        manifest,
        repoRoot: fixtureRoot,
        commitTimestamp: '2020-01-01T00:00:00Z',
      }),
      /Refusing to generate ambiguous history filename "skills__azure__foo__bar\.json" for both "(skills\/azure\/foo__bar|skills\/azure\/foo\/bar)" and "(skills\/azure\/foo__bar|skills\/azure\/foo\/bar)"\./,
    );
  });
});

test('catalog bootstrap refuses to delete stale release history for removed skills', async () => {
  await withFixture('history-stale-release-guard', async (fixtureRoot) => {
    await setupFixture(fixtureRoot);
    await copyCatalogRuntime(fixtureRoot);
    await initializeFixtureRepo(fixtureRoot);

    const staleHistoryPath = path.join(
      fixtureRoot,
      'catalog',
      'history',
      historyFileName('skills/github/removed-skill'),
    );
    await mkdir(path.dirname(staleHistoryPath), { recursive: true });
    await writeFile(
      staleHistoryPath,
      JSON.stringify({
        path: 'skills/github/removed-skill',
        name: 'removed-skill',
        category: 'mapped',
        entries: [
          {
            release: '1.0.0',
            kind: 'bootstrap',
            version: '1.0.0',
            firstSeen: '2020-01-01T00:00:00Z',
            upstreamCommit: null,
            diffUrl: null,
            snapshotHash: 'sha256:first',
          },
          {
            release: '1.1.0',
            kind: 'release',
            version: '1.1.0',
            firstSeen: '2020-02-01T00:00:00Z',
            upstreamCommit: 'abc123',
            diffUrl: 'https://example.test/diff',
            snapshotHash: 'sha256:second',
          },
        ],
      }),
    );

    assert.throws(
      () => runCommand('node', ['scripts/catalog.mjs', '--bootstrap'], fixtureRoot),
      /Refusing to overwrite release history for skills\/github\/removed-skill: existing history already contains 2 entries; rerun bootstrap only on a single bootstrap entry\./,
    );
  });
});

test('catalog bootstrap refuses stale release history whose filename collides with a current skill', async () => {
  await withFixture('history-stale-collision-guard', async (fixtureRoot) => {
    await setupDoubleUnderscoreFixture(fixtureRoot);
    await copyCatalogRuntime(fixtureRoot);
    await initializeFixtureRepo(fixtureRoot);

    const staleHistoryPath = path.join(
      fixtureRoot,
      'catalog',
      'history',
      historyFileName('skills/azure/foo/bar'),
    );
    await mkdir(path.dirname(staleHistoryPath), { recursive: true });
    await writeFile(
      staleHistoryPath,
      JSON.stringify({
        path: 'skills/azure/foo/bar',
        name: 'foo-bar',
        category: 'mapped',
        entries: [
          {
            release: '1.0.0',
            kind: 'bootstrap',
            version: '1.0.0',
            firstSeen: '2020-01-01T00:00:00Z',
            upstreamCommit: null,
            diffUrl: null,
            snapshotHash: 'sha256:first',
          },
          {
            release: '1.1.0',
            kind: 'release',
            version: '1.1.0',
            firstSeen: '2020-02-01T00:00:00Z',
            upstreamCommit: 'abc123',
            diffUrl: 'https://example.test/diff',
            snapshotHash: 'sha256:second',
          },
        ],
      }),
    );

    assert.throws(
      () => runCommand('node', ['scripts/catalog.mjs', '--bootstrap'], fixtureRoot),
      /Refusing to overwrite release history file catalog\/history\/skills__azure__foo__bar\.json: existing path "skills\/azure\/foo\/bar" conflicts with generated path "skills\/azure\/foo__bar"\./,
    );
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

// ---------------------------------------------------------------------------
// Defect 4: renderReadme should render actual lock status, not hardcoded
// ---------------------------------------------------------------------------

function readmeTemplate() {
  return '# Skills\n\n<!-- CATALOG:START -->\nold\n<!-- CATALOG:END -->\n';
}

function lockWithStatus(baselineStatus) {
  return {
    release: baselineStatus === 'verified' ? '1.1.0' : '1.0.0',
    generatedAt: '2026-01-01T00:00:00Z',
    counts: { total: 3, mapped: 2, orphan: 1, local: 0 },
    skills: [
      {
        path: 'skills/demo/alpha',
        name: 'alpha',
        category: 'mapped',
        version: '1.0.0',
        baseline: baselineStatus,
        license: 'MIT',
        redistributable: true,
        snapshotHash: 'sha256:aaa',
        upstream: { repository: 'demo/upstream', reference: 'refs/heads/main', source: 'skills/alpha', commit: null },
      },
      {
        path: 'skills/demo/beta',
        name: 'beta',
        category: 'mapped',
        version: '1.0.0',
        baseline: baselineStatus,
        license: 'MIT',
        redistributable: true,
        snapshotHash: 'sha256:bbb',
        upstream: { repository: 'demo/upstream', reference: 'refs/heads/main', source: 'skills/beta', commit: null },
      },
      {
        path: 'skills/orphans/gamma',
        name: 'gamma',
        category: 'orphan',
        version: '1.0.0',
        baseline: null,
        license: 'Unknown',
        redistributable: true,
        snapshotHash: 'sha256:ccc',
        upstream: null,
      },
    ],
  };
}

test('renderReadme shows verified status when all mapped skills are verified', () => {
  const lock = lockWithStatus('verified');
  const result = renderReadme(readmeTemplate(), lock);
  assert.match(result, /verified/i);
  assert.doesNotMatch(result, /unverified/i);
});

test('renderReadme shows unverified status when all mapped skills are unverified', () => {
  const lock = lockWithStatus('unverified');
  const result = renderReadme(readmeTemplate(), lock);
  assert.match(result, /unverified/i);
});

test('renderReadme shows mixed status when some mapped skills are verified and some not', () => {
  const lock = lockWithStatus('verified');
  lock.skills[1] = { ...lock.skills[1], baseline: 'unverified' };
  const result = renderReadme(readmeTemplate(), lock);
  assert.match(result, /1.*verified/i);
  assert.match(result, /1.*unverified/i);
});
