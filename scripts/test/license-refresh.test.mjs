import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  applyLicenseRefresh,
  appendLicenseRefreshHistory,
  assertLicenseEvidenceMigrationComplete,
  BaselineError,
  buildLicenseRefreshLock,
  LICENSE_REFRESH_COMMIT_MESSAGE,
  LICENSE_REFRESH_RELEASE,
} from '../lib/baseline.mjs';
import { parseArgs, validateModeOptions } from '../sync.mjs';
import { hashDirectory } from '../lib/hash.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.join(__dirname, '.runtime');

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function makeRunGit(repoRoot) {
  return (args) =>
    execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
}

async function writeFileEnsured(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function buildRefreshFixture({ unavailable = false } = {}) {
  await mkdir(runtimeRoot, { recursive: true });
  const workspace = await mkdtemp(path.join(runtimeRoot, 'refresh-apply-'));
  const upstreamRoot = path.join(workspace, 'upstream');
  await mkdir(upstreamRoot, { recursive: true });
  git(upstreamRoot, ['init', '-q', '-b', 'main']);
  git(upstreamRoot, ['config', 'user.email', 'fixture@example.com']);
  git(upstreamRoot, ['config', 'user.name', 'Fixture']);
  const licenseBytes = Buffer.from(
    'MIT License\n\nCopyright (c) Refresh Fixture\n\nPermission is hereby granted.\n',
  );
  await writeFileEnsured(path.join(upstreamRoot, 'LICENSE'), licenseBytes);
  const skillText = '---\nname: alpha\ndescription: Fixture alpha\n---\n\n# Alpha\n';
  await writeFileEnsured(
    path.join(upstreamRoot, 'skills', 'alpha', 'SKILL.md'),
    skillText,
  );
  git(upstreamRoot, ['add', '-A']);
  git(upstreamRoot, ['commit', '-q', '-m', 'upstream']);
  const upstreamCommit = git(upstreamRoot, ['rev-parse', 'HEAD']);
  const upstreamUrl = unavailable
    ? pathToFileURL(path.join(workspace, 'missing-upstream')).href
    : pathToFileURL(upstreamRoot).href;

  const repoRoot = path.join(workspace, 'repo');
  await writeFileEnsured(path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md'), skillText);
  const snapshotHash = await hashDirectory(path.join(repoRoot, 'skills', 'demo', 'alpha'));
  await writeFileEnsured(
    path.join(repoRoot, 'catalog', 'sources.yml'),
    [
      'upstreams:',
      '  demo:',
      `    repository: "${upstreamUrl}"`,
      '    reference: refs/heads/main',
      'mappings:',
      '  - path: skills/demo/alpha',
      '    upstream: demo',
      '    source: skills/alpha',
      'orphans: []',
      'local: []',
      'overrides: []',
      'linkExceptions: []',
      '',
    ].join('\n'),
  );
  const lock = {
    release: '2.0.0',
    generatedAt: '2026-09-01T00:00:00Z',
    counts: { total: 1, mapped: 1, orphan: 0, local: 0 },
    skills: [
      {
        path: 'skills/demo/alpha',
        name: 'alpha',
        category: 'mapped',
        version: '1.3.7',
        baseline: 'verified',
        license: 'Unknown',
        redistributable: true,
        snapshotHash,
        contentHash: snapshotHash,
        upstream: {
          repository: upstreamUrl,
          reference: 'refs/heads/main',
          source: 'skills/alpha',
          commit: upstreamCommit,
        },
      },
    ],
  };
  await writeFileEnsured(
    path.join(repoRoot, 'catalog', 'skills.lock.json'),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  await writeFileEnsured(
    path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'),
    `${JSON.stringify({
      path: 'skills/demo/alpha',
      name: 'alpha',
      category: 'mapped',
      entries: [
        {
          release: '2.0.0',
          kind: 'baseline-verified',
          version: '1.3.7',
          upstreamCommit,
          diffUrl: null,
          contentHash: snapshotHash,
        },
      ],
    }, null, 2)}\n`,
  );
  await writeFileEnsured(
    path.join(repoRoot, 'catalog', 'licenses', 'index.json'),
    '{"release":"2.0.0","licenses":[]}\n',
  );
  await writeFileEnsured(path.join(repoRoot, 'NOTICE'), '# NOTICE\n\nold\n');
  await writeFileEnsured(
    path.join(repoRoot, 'README.md'),
    [
      '# Fixture',
      '',
      '<!-- CATALOG:START -->',
      'old',
      '<!-- CATALOG:END -->',
      '',
      '<!-- INSTALL:START -->',
      'old',
      '<!-- INSTALL:END -->',
      '',
    ].join('\n'),
  );
  await writeFileEnsured(path.join(repoRoot, '.gitignore'), '.license-refresh-work-*/\n');
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'fixture@example.com']);
  git(repoRoot, ['config', 'user.name', 'Fixture']);
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-q', '-m', 'v2']);
  git(repoRoot, ['tag', 'v2.0.0']);
  return { workspace, repoRoot, licenseBytes, lock };
}

function mappedSkill(overrides = {}) {
  return {
    path: 'skills/demo/alpha',
    name: 'alpha',
    category: 'mapped',
    version: '1.4.2',
    baseline: 'verified',
    license: 'Unknown',
    redistributable: true,
    snapshotHash: `sha256:${'1'.repeat(64)}`,
    contentHash: `sha256:${'2'.repeat(64)}`,
    upstream: {
      repository: 'example/repo',
      reference: 'refs/heads/main',
      source: 'skills/alpha',
      commit: 'a'.repeat(40),
    },
    ...overrides,
  };
}

function rootEvidence(commit = 'a'.repeat(40)) {
  return {
    source: 'upstream-root:LICENSE',
    repository: 'example/repo',
    reference: 'refs/heads/main',
    commit,
    path: 'LICENSE',
    hash: `sha256:${'b'.repeat(64)}`,
  };
}

test('license refresh changes only license metadata and classifies release 2.0.1', () => {
  const before = mappedSkill();
  const original = structuredClone(before);
  const result = buildLicenseRefreshLock({
    lock: {
      release: '2.0.0',
      generatedAt: '2026-09-01T00:00:00Z',
      counts: { total: 1, mapped: 1, orphan: 0, local: 0 },
      skills: [before],
    },
    resolvedByPath: new Map([
      [
        before.path,
        {
          license: 'MIT',
          redistributable: true,
          licenseEvidence: rootEvidence(),
        },
      ],
    ]),
    release: LICENSE_REFRESH_RELEASE,
    generatedAt: '2026-09-02T00:00:00Z',
  });

  assert.equal(LICENSE_REFRESH_RELEASE, '2.0.1');
  assert.equal(
    LICENSE_REFRESH_COMMIT_MESSAGE,
    'fix(catalog): refresh upstream license metadata',
  );
  assert.deepEqual(result.changedPaths, [before.path]);
  assert.equal(result.lock.release, '2.0.1');
  assert.equal(result.lock.licenseEvidenceVersion, 1);
  assert.equal(result.lock.generatedAt, '2026-09-02T00:00:00Z');
  assert.equal(result.lock.skills[0].license, 'MIT');
  assert.deepEqual(result.lock.skills[0].licenseEvidence, rootEvidence());
  for (const field of [
    'path',
    'name',
    'category',
    'version',
    'baseline',
    'snapshotHash',
    'contentHash',
    'upstream',
  ]) {
    assert.deepEqual(result.lock.skills[0][field], original[field], field);
  }
  assert.deepEqual(result.lock.counts, {
    total: 1,
    mapped: 1,
    orphan: 0,
    local: 0,
  });
});

test('license refresh rejects known to Unknown downgrade at the same pinned tuple', () => {
  const before = mappedSkill({
    license: 'MIT',
    licenseEvidence: rootEvidence(),
  });

  assert.throws(
    () =>
      buildLicenseRefreshLock({
        lock: {
          release: '2.0.0',
          generatedAt: '2026-09-01T00:00:00Z',
          counts: { total: 1, mapped: 1, orphan: 0, local: 0 },
          skills: [before],
        },
        resolvedByPath: new Map([
          [
            before.path,
            {
              license: 'Unknown',
              redistributable: true,
              licenseEvidence: { source: 'unresolved' },
            },
          ],
        ]),
        release: LICENSE_REFRESH_RELEASE,
        generatedAt: '2026-09-02T00:00:00Z',
      }),
    (error) =>
      error instanceof BaselineError &&
      /known license MIT to Unknown/.test(error.message),
  );
});

test('license refresh history records old and new values and evidence', () => {
  const before = mappedSkill();
  const after = {
    ...before,
    license: 'MIT',
    licenseEvidence: rootEvidence(),
  };
  const history = {
    path: before.path,
    name: before.name,
    category: before.category,
    entries: [{ release: '2.0.0', kind: 'baseline-verified', version: before.version }],
  };

  const next = appendLicenseRefreshHistory(history, {
    release: LICENSE_REFRESH_RELEASE,
    before,
    after,
  });

  assert.deepEqual(next.entries.at(-1), {
    release: '2.0.1',
    kind: 'license-refresh',
    version: before.version,
    upstreamCommit: before.upstream.commit,
    diffUrl: null,
    oldLicense: 'Unknown',
    newLicense: 'MIT',
    oldRedistributable: true,
    newRedistributable: true,
    oldEvidence: null,
    newEvidence: rootEvidence(),
    evidenceCommit: before.upstream.commit,
    evidenceHash: rootEvidence().hash,
  });
});

test('--refresh-licenses is exclusive, accepts output, and unknown arguments fail', () => {
  assert.deepEqual(parseArgs(['--refresh-licenses', '--output', 'report.json']), {
    dryRun: false,
    baseline: false,
    apply: false,
    deproprietize: false,
    refreshLicenses: true,
    output: 'report.json',
  });

  for (const conflict of ['--apply', '--baseline', '--dry-run', '--deproprietize']) {
    assert.throws(
      () => validateModeOptions(parseArgs(['--refresh-licenses', conflict])),
      /--refresh-licenses cannot be combined/,
    );
  }
  assert.throws(() => parseArgs(['--refresh-license']), /Unknown argument/);
});

test('ordinary sync is blocked after 2.0.0 until license evidence migration completes', () => {
  assert.throws(
    () =>
      assertLicenseEvidenceMigrationComplete({
        release: '2.0.0',
        skills: [mappedSkill()],
      }),
    /run --refresh-licenses first/,
  );
  assert.doesNotThrow(() =>
    assertLicenseEvidenceMigrationComplete({
      release: '2.0.1',
      licenseEvidenceVersion: 1,
      skills: [
        mappedSkill({
          licenseEvidence: rootEvidence(),
        }),
      ],
    }),
  );
});

test('applyLicenseRefresh atomically generates 2.0.1 without changing skill bytes or versions', async () => {
  const fixture = await buildRefreshFixture();
  try {
    const skillHashBefore = await hashDirectory(path.join(fixture.repoRoot, 'skills'));
    const movedTargets = [];
    const result = await applyLicenseRefresh({
      repoRoot: fixture.repoRoot,
      runGit: makeRunGit(fixture.repoRoot),
      now: () => '2026-09-02T00:00:00Z',
      afterBackupMove: (target) => movedTargets.push(target.rel),
    });

    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.metadataChanged, ['skills/demo/alpha']);
    assert.equal(result.metadataChangedCount, 1);
    assert.equal(result.release, '2.0.1');
    assert.equal(result.nextTag, 'v2.0.1');
    assert.equal(result.commitMessage, LICENSE_REFRESH_COMMIT_MESSAGE);
    assert.equal(result.applied, true);
    assert.deepEqual(movedTargets, [
      'catalog/history',
      'catalog/licenses',
      'catalog/skills.lock.json',
      'NOTICE',
      'README.md',
    ]);
    assert.equal(
      await hashDirectory(path.join(fixture.repoRoot, 'skills')),
      skillHashBefore,
    );

    const lock = JSON.parse(
      await readFile(path.join(fixture.repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
    );
    assert.equal(lock.skills[0].version, fixture.lock.skills[0].version);
    assert.equal(lock.skills[0].snapshotHash, fixture.lock.skills[0].snapshotHash);
    assert.equal(lock.skills[0].contentHash, fixture.lock.skills[0].contentHash);
    assert.deepEqual(lock.skills[0].upstream, fixture.lock.skills[0].upstream);
    assert.equal(lock.skills[0].license, 'MIT');

    const bundle = JSON.parse(
      await readFile(path.join(fixture.repoRoot, 'catalog', 'licenses', 'index.json'), 'utf8'),
    );
    assert.equal(bundle.licenses.length, 1);
    assert.equal(
      (
        await readFile(
          path.join(fixture.repoRoot, 'catalog', 'licenses', bundle.licenses[0].bundlePath),
        )
      ).compare(fixture.licenseBytes),
      0,
    );
    const history = JSON.parse(
      await readFile(
        path.join(fixture.repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'),
        'utf8',
      ),
    );
    assert.equal(history.entries.at(-1).kind, 'license-refresh');
    assert.equal(history.entries.at(-1).oldLicense, 'Unknown');
    assert.equal(history.entries.at(-1).newLicense, 'MIT');
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test('applyLicenseRefresh aborts before mutation when an upstream is unavailable', async () => {
  const fixture = await buildRefreshFixture({ unavailable: true });
  try {
    const lockBefore = await readFile(
      path.join(fixture.repoRoot, 'catalog', 'skills.lock.json'),
      'utf8',
    );
    const skillsBefore = await hashDirectory(path.join(fixture.repoRoot, 'skills'));

    await assert.rejects(
      applyLicenseRefresh({
        repoRoot: fixture.repoRoot,
        runGit: makeRunGit(fixture.repoRoot),
      }),
      (error) =>
        error instanceof BaselineError &&
        /Unable to resolve pinned license evidence/.test(error.message),
    );

    assert.equal(
      await readFile(path.join(fixture.repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
      lockBefore,
    );
    assert.equal(await hashDirectory(path.join(fixture.repoRoot, 'skills')), skillsBefore);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test('applyLicenseRefresh revalidates pinned evidence and returns no-op after publication', async () => {
  const fixture = await buildRefreshFixture();
  try {
    await applyLicenseRefresh({
      repoRoot: fixture.repoRoot,
      runGit: makeRunGit(fixture.repoRoot),
      now: () => '2026-09-02T00:00:00Z',
    });
    git(fixture.repoRoot, ['add', '-A']);
    git(fixture.repoRoot, ['commit', '-q', '-m', 'refresh licenses']);
    git(fixture.repoRoot, ['tag', 'v2.0.1']);
    const lockBefore = await readFile(
      path.join(fixture.repoRoot, 'catalog', 'skills.lock.json'),
      'utf8',
    );

    const result = await applyLicenseRefresh({
      repoRoot: fixture.repoRoot,
      runGit: makeRunGit(fixture.repoRoot),
    });

    assert.equal(result.applied, false);
    assert.equal(result.release, '2.0.1');
    assert.deepEqual(result.metadataChanged, []);
    assert.equal(result.evidence.fetchedGroups, 1);
    assert.equal(
      await readFile(path.join(fixture.repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
      lockBefore,
    );
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});
