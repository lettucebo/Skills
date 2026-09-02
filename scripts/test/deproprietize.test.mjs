import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as syncModule from '../sync.mjs';
import * as baselineModule from '../lib/baseline.mjs';
import { renderReadme } from '../catalog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.join(__dirname, '.runtime');
const REMOVED_PATHS = [
  'skills/claude/docx',
  'skills/claude/pdf',
  'skills/claude/pptx',
  'skills/claude/xlsx',
];

async function writeFileEnsured(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function skillDoc(name) {
  return `---\nname: ${name}\ndescription: Fixture skill ${name}\n---\n\n# ${name}\n`;
}

async function buildMigrationFixture(prefix) {
  await mkdir(runtimeRoot, { recursive: true });
  const workspace = await mkdtemp(path.join(runtimeRoot, `${prefix}-`));
  const repoRoot = path.join(workspace, 'repo');
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-q', '-b', 'main']);

  const activePaths = Array.from(
    { length: 13 },
    (_, index) => `skills/claude/active-${String(index + 1).padStart(2, '0')}`,
  );
  const allPaths = [...activePaths, ...REMOVED_PATHS];

  for (const skillPath of allPaths) {
    const name = skillPath.split('/').at(-1);
    await writeFileEnsured(path.join(repoRoot, ...skillPath.split('/'), 'SKILL.md'), skillDoc(name));
    await writeFileEnsured(
      path.join(repoRoot, 'catalog', 'history', `${skillPath.replaceAll('/', '__')}.json`),
      `${JSON.stringify({
        path: skillPath,
        name,
        category: 'mapped',
        entries: [{
          release: '1.1.0',
          kind: 'baseline-verified',
          version: '1.1.0',
          upstreamCommit: 'a'.repeat(40),
          diffUrl: null,
          contentHash: `sha256:upstream-${name}`,
        }],
      }, null, 2)}\n`,
    );
  }

  const manifestText = [
    'upstreams:',
    '  anthropics:',
    '    repository: anthropics/skills',
    '    reference: refs/heads/main',
    'mappings:',
    ...allPaths.flatMap((skillPath) => [
      `  - path: ${skillPath}`,
      '    upstream: anthropics',
      `    source: skills/${skillPath.split('/').at(-1)}`,
    ]),
    'orphans: []',
    'local: []',
    'overrides: []',
    'linkExceptions: []',
    '',
  ].join('\n');
  await writeFileEnsured(path.join(repoRoot, 'catalog', 'sources.yml'), manifestText);

  const skills = allPaths.map((skillPath) => {
    const name = skillPath.split('/').at(-1);
    const restricted = REMOVED_PATHS.includes(skillPath);
    return {
      path: skillPath,
      name,
      category: 'mapped',
      version: '1.1.0',
      baseline: 'verified',
      license: restricted ? 'Proprietary' : 'Unknown',
      redistributable: !restricted,
      snapshotHash: `sha256:snapshot-${name}`,
      contentHash: `sha256:upstream-${name}`,
      upstream: {
        repository: 'anthropics/skills',
        reference: 'refs/heads/main',
        source: `skills/${name}`,
        commit: 'a'.repeat(40),
      },
    };
  }).sort((left, right) => left.path.localeCompare(right.path));

  await writeFileEnsured(
    path.join(repoRoot, 'catalog', 'skills.lock.json'),
    `${JSON.stringify({
      release: '1.1.0',
      generatedAt: '2026-01-01T00:00:00Z',
      counts: { total: 17, mapped: 17, orphan: 0, local: 0 },
      skills,
    }, null, 2)}\n`,
  );
  await writeFileEnsured(path.join(repoRoot, 'NOTICE'), 'old notice\n');
  await writeFileEnsured(
    path.join(repoRoot, 'catalog', 'licenses', 'index.json'),
    '{"release":"1.1.0","licenses":[]}\n',
  );
  await writeFileEnsured(
    path.join(repoRoot, 'README.md'),
    [
      '# Fixture',
      '<!-- CATALOG:START -->',
      'old catalog',
      '<!-- CATALOG:END -->',
      '<!-- INSTALL:START -->',
      'old install',
      '<!-- INSTALL:END -->',
      '',
    ].join('\n'),
  );

  return { workspace, repoRoot, manifestText };
}

function restrictedSkill(skillPath) {
  return {
    path: skillPath,
    name: skillPath.split('/').at(-1),
    category: 'mapped',
    version: '1.1.0',
    baseline: 'verified',
    license: 'Proprietary',
    redistributable: false,
    snapshotHash: `sha256:${skillPath}`,
    contentHash: `sha256:upstream-${skillPath}`,
    upstream: {
      repository: 'anthropics/skills',
      reference: 'refs/heads/main',
      source: `skills/${skillPath.split('/').at(-1)}`,
      commit: 'a'.repeat(40),
    },
  };
}

function migrationLock(overrides = {}) {
  const skills = REMOVED_PATHS.map(restrictedSkill);
  return {
    release: '1.1.0',
    generatedAt: '2026-01-01T00:00:00Z',
    counts: { total: skills.length, mapped: skills.length, orphan: 0, local: 0 },
    skills,
    ...overrides,
  };
}

function migrationManifest(overrides = {}) {
  return {
    upstreams: {
      anthropics: {
        repository: 'anthropics/skills',
        reference: 'refs/heads/main',
      },
    },
    mappings: REMOVED_PATHS.map((skillPath) => ({
      path: skillPath,
      upstream: 'anthropics',
      source: `skills/${skillPath.split('/').at(-1)}`,
    })),
    orphans: [],
    local: [],
    localSkillPaths: [],
    overrides: [],
    linkExceptions: [],
    ...overrides,
  };
}

test('parseArgs recognizes the one-time --deproprietize mode', () => {
  assert.equal(typeof syncModule.parseArgs, 'function');
  assert.deepEqual(syncModule.parseArgs(['--deproprietize']), {
    dryRun: false,
    baseline: false,
    apply: false,
    deproprietize: true,
  });
});

test('--deproprietize rejects every other execution mode but accepts --output', () => {
  assert.equal(typeof syncModule.validateModeOptions, 'function');

  for (const conflicting of ['--apply', '--baseline', '--dry-run']) {
    const options = syncModule.parseArgs(['--deproprietize', conflicting]);
    assert.throws(
      () => syncModule.validateModeOptions(options),
      new RegExp(`--deproprietize cannot be combined with ${conflicting.replace('-', '\\-')}`),
    );
  }

  assert.doesNotThrow(() =>
    syncModule.validateModeOptions(
      syncModule.parseArgs(['--deproprietize', '--output', 'report.json']),
    ),
  );
});

test('parseArgs rejects missing or option-valued --output arguments', () => {
  assert.throws(() => syncModule.parseArgs(['--deproprietize', '--output']), /--output requires a value/);
  assert.throws(
    () => syncModule.parseArgs(['--deproprietize', '--output', '--apply']),
    /--output requires a value/,
  );
  assert.throws(() => syncModule.parseArgs(['--output=']), /--output requires a value/);
});

test('writeApplyResult writes identical deproprietize JSON to --output and stdout', async () => {
  assert.equal(typeof syncModule.writeApplyResult, 'function');
  await mkdir(runtimeRoot, { recursive: true });
  const workspace = await mkdtemp(path.join(runtimeRoot, 'deproprietize-output-'));
  const output = path.join(workspace, 'nested', 'result.json');
  let stdout = '';
  const result = { release: '2.0.0', nextTag: 'v2.0.0', applied: true };

  try {
    const json = await syncModule.writeApplyResult(result, {
      output,
      writeStdout: (value) => {
        stdout += value;
      },
    });
    assert.equal(await readFile(output, 'utf8'), json);
    assert.equal(stdout, json);
    assert.deepEqual(JSON.parse(json), result);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('deproprietize preconditions require the exact unpublished 1.1.0 restricted inventory', () => {
  assert.equal(typeof baselineModule.assertDeproprietizePreconditions, 'function');
  assert.doesNotThrow(() =>
    baselineModule.assertDeproprietizePreconditions({
      lock: migrationLock(),
      manifest: migrationManifest(),
    }),
  );

  for (const [label, lock] of [
    ['release', migrationLock({ release: '2.0.0' })],
    [
      'category',
      migrationLock({
        skills: REMOVED_PATHS.map((skillPath, index) =>
          index === 0 ? { ...restrictedSkill(skillPath), category: 'removed' } : restrictedSkill(skillPath),
        ),
      }),
    ],
    [
      'redistributable',
      migrationLock({
        skills: REMOVED_PATHS.map((skillPath, index) =>
          index === 0 ? { ...restrictedSkill(skillPath), redistributable: true } : restrictedSkill(skillPath),
        ),
      }),
    ],
    [
      'license',
      migrationLock({
        skills: REMOVED_PATHS.map((skillPath, index) =>
          index === 0 ? { ...restrictedSkill(skillPath), license: 'Unknown' } : restrictedSkill(skillPath),
        ),
      }),
    ],
    [
      'upstream',
      migrationLock({
        skills: REMOVED_PATHS.map((skillPath, index) =>
          index === 0
            ? {
                ...restrictedSkill(skillPath),
                upstream: {
                  ...restrictedSkill(skillPath).upstream,
                  repository: 'unexpected/repository',
                },
              }
            : restrictedSkill(skillPath),
        ),
      }),
    ],
    [
      'version',
      migrationLock({
        skills: REMOVED_PATHS.map((skillPath, index) =>
          index === 0 ? { ...restrictedSkill(skillPath), version: '0.9.0' } : restrictedSkill(skillPath),
        ),
      }),
    ],
    [
      'baseline',
      migrationLock({
        skills: REMOVED_PATHS.map((skillPath, index) =>
          index === 0 ? { ...restrictedSkill(skillPath), baseline: 'unverified' } : restrictedSkill(skillPath),
        ),
      }),
    ],
    [
      'contentHash',
      migrationLock({
        skills: REMOVED_PATHS.map((skillPath, index) =>
          index === 0 ? { ...restrictedSkill(skillPath), contentHash: null } : restrictedSkill(skillPath),
        ),
      }),
    ],
    [
      'snapshotHash',
      migrationLock({
        skills: REMOVED_PATHS.map((skillPath, index) =>
          index === 0 ? { ...restrictedSkill(skillPath), snapshotHash: null } : restrictedSkill(skillPath),
        ),
      }),
    ],
    [
      'commit',
      migrationLock({
        skills: REMOVED_PATHS.map((skillPath, index) =>
          index === 0
            ? {
                ...restrictedSkill(skillPath),
                upstream: { ...restrictedSkill(skillPath).upstream, commit: null },
              }
            : restrictedSkill(skillPath),
        ),
      }),
    ],
  ]) {
    assert.throws(
      () =>
        baselineModule.assertDeproprietizePreconditions({
          lock,
          manifest: migrationManifest(),
        }),
      new RegExp(label, 'i'),
    );
  }

  assert.throws(
    () =>
      baselineModule.assertDeproprietizePreconditions({
        lock: migrationLock(),
        manifest: migrationManifest({ mappings: migrationManifest().mappings.slice(1) }),
      }),
    /mapping.*skills\/claude\/docx/i,
  );
});

test('applyDeproprietize rejects history that does not match the verified lock provenance', async () => {
  const { workspace, repoRoot } = await buildMigrationFixture('deproprietize-history-guard');
  const historyPath = path.join(
    repoRoot,
    'catalog',
    'history',
    'skills__claude__docx.json',
  );

  try {
    const history = JSON.parse(await readFile(historyPath, 'utf8'));
    history.entries.at(-1).contentHash = 'sha256:mismatch';
    await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`);

    await assert.rejects(
      baselineModule.applyDeproprietize({
        repoRoot,
        deproprietize: true,
        readGitStatus: async () => '',
      }),
      /history.*skills\/claude\/docx.*contentHash/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('buildDeproprietizedLock preserves four tombstones while counting only active skills', () => {
  assert.equal(typeof baselineModule.buildDeproprietizedLock, 'function');
  const active = {
    ...restrictedSkill('skills/claude/active'),
    name: 'active',
    license: 'Unknown',
    redistributable: true,
  };
  const lock = migrationLock({
    counts: { total: 5, mapped: 5, orphan: 0, local: 0 },
    skills: [active, ...REMOVED_PATHS.map(restrictedSkill)],
  });

  const next = baselineModule.buildDeproprietizedLock({
    lock,
    generatedAt: '2026-09-02T00:00:00Z',
  });

  assert.equal(next.release, '2.0.0');
  assert.equal(next.generatedAt, '2026-09-02T00:00:00Z');
  assert.deepEqual(next.counts, { total: 1, mapped: 1, orphan: 0, local: 0 });
  assert.equal(next.skills.length, 5);
  assert.deepEqual(
    next.skills.filter((skill) => skill.category === 'removed').map((skill) => skill.path),
    REMOVED_PATHS,
  );
  for (const tombstone of next.skills.filter((skill) => skill.category === 'removed')) {
    assert.equal(tombstone.license, 'Proprietary');
    assert.equal(tombstone.redistributable, false);
    assert.equal(tombstone.removedIn, '2.0.0');
    assert.match(tombstone.removalReason, /proprietary redistribution/i);
  }
});

test('the regenerated claude source description does not advertise removed document formats', () => {
  const readme = renderReadme(
    [
      '<!-- CATALOG:START -->',
      'old',
      '<!-- CATALOG:END -->',
      '',
    ].join('\n'),
    {
      release: '2.0.0',
      generatedAt: '2026-09-02T00:00:00Z',
      counts: { total: 1, mapped: 1, orphan: 0, local: 0 },
      skills: [{
        ...restrictedSkill('skills/claude/active'),
        name: 'active',
        license: 'Unknown',
        redistributable: true,
      }],
    },
  );

  assert.match(readme, /Claude API、協作寫作、前端與創意工具/);
  assert.doesNotMatch(readme, /PDF\/PPTX\/XLSX/);
});

test('removeDeproprietizedMappings removes only the four exact anthropics mapping blocks', () => {
  assert.equal(typeof baselineModule.removeDeproprietizedMappings, 'function');
  const text = [
    'mappings:',
    '  - path: skills/claude/active',
    '    upstream: anthropics',
    '    source: skills/active',
    ...REMOVED_PATHS.flatMap((skillPath) => [
      `  - path: ${skillPath}`,
      '    upstream: anthropics',
      `    source: skills/${skillPath.split('/').at(-1)}`,
    ]),
    'orphans: []',
    '',
  ].join('\n');

  const next = baselineModule.removeDeproprietizedMappings(text);

  assert.match(next, /path: skills\/claude\/active/);
  for (const skillPath of REMOVED_PATHS) {
    assert.doesNotMatch(next, new RegExp(`path: ${skillPath.replaceAll('/', '\\/')}`));
  }
  assert.match(next, /orphans: \[\]/);
});

test('removeDeproprietizedMappings preserves CRLF manifests while removing exact blocks', () => {
  const text = [
    'mappings:',
    ...REMOVED_PATHS.flatMap((skillPath) => [
      `  - path: ${skillPath}`,
      '    upstream: anthropics',
      `    source: skills/${skillPath.split('/').at(-1)}`,
    ]),
    'orphans: []',
    '',
  ].join('\r\n');

  const next = baselineModule.removeDeproprietizedMappings(text);

  assert.equal(next, 'mappings:\r\norphans: []\r\n');
});

test('catalog/sources.yml is protected by the shared transaction target set', () => {
  assert.deepEqual(
    baselineModule.SWAP_TARGETS.filter((target) => target.rel === 'catalog/sources.yml'),
    [{ rel: 'catalog/sources.yml', kind: 'file' }],
  );
});

test('repository ignores deproprietize staging work roots', async () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.deproprietize-work-\*\/\r?$/m);
});

test('applyDeproprietize succeeds without tags and atomically creates the 2.0.0 audit state', async () => {
  assert.equal(typeof baselineModule.applyDeproprietize, 'function');
  const { workspace, repoRoot } = await buildMigrationFixture('deproprietize-success');
  let gitCalls = 0;

  try {
    const result = await baselineModule.applyDeproprietize({
      repoRoot,
      deproprietize: true,
      readGitStatus: async () => '',
      now: () => '2026-09-02T00:00:00Z',
      runGit: async () => {
        gitCalls += 1;
        throw new Error('deproprietize must not inspect tags');
      },
      validate: async () => {},
    });

    assert.equal(gitCalls, 0);
    assert.equal(result.applied, true);
    assert.deepEqual(result.removed, REMOVED_PATHS);
    assert.equal(result.release, '2.0.0');
    assert.equal(result.nextTag, 'v2.0.0');
    assert.equal(result.commitMessage, 'feat(skills)!: remove proprietary skill mirrors');
    assert.deepEqual(result.guardrail, {
      upstream: 'anthropics',
      declared: 17,
      removed: 4,
      available: true,
      ratio: 4 / 17,
      blocked: false,
      status: 'ok',
    });

    const manifest = await readFile(path.join(repoRoot, 'catalog', 'sources.yml'), 'utf8');
    const lock = JSON.parse(await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'));
    for (const skillPath of REMOVED_PATHS) {
      assert.doesNotMatch(manifest, new RegExp(`path: ${skillPath.replaceAll('/', '\\/')}`));
      assert.equal(existsSync(path.join(repoRoot, ...skillPath.split('/'))), false);
      const tombstone = lock.skills.find((skill) => skill.path === skillPath);
      assert.equal(tombstone.category, 'removed');
      const history = JSON.parse(await readFile(
        path.join(repoRoot, 'catalog', 'history', `${skillPath.replaceAll('/', '__')}.json`),
        'utf8',
      ));
      const entry = history.entries.at(-1);
      assert.equal(entry.release, '2.0.0');
      assert.equal(entry.kind, 'mapping-removed');
      assert.match(entry.reason, /proprietary redistribution/i);
    }
    assert.deepEqual(lock.counts, { total: 13, mapped: 13, orphan: 0, local: 0 });
    const notice = await readFile(path.join(repoRoot, 'NOTICE'), 'utf8');
    assert.match(notice, /\| anthropics\/skills \| refs\/heads\/main \| 13 \|/);
    assert.match(notice, /## Restricted skills[\s\S]*_None\._/);
    for (const skillPath of REMOVED_PATHS) {
      assert.doesNotMatch(notice, new RegExp(skillPath.replaceAll('/', '\\/')));
    }
    assert.match(await readFile(path.join(repoRoot, 'README.md'), 'utf8'), /v2\.0\.0/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyDeproprietize rolls back manifest and materialized targets together on an injected swap failure', async () => {
  const { workspace, repoRoot } = await buildMigrationFixture('deproprietize-rollback');
  const before = new Map();

  try {
    for (const target of baselineModule.SWAP_TARGETS) {
      const targetPath = path.join(repoRoot, ...target.rel.split('/'));
      before.set(
        target.rel,
        target.kind === 'file'
          ? await readFile(targetPath, 'utf8')
          : await baselineModule.snapshotSwapTarget(targetPath, 'dir'),
      );
    }

    await assert.rejects(
      baselineModule.applyDeproprietize({
        repoRoot,
        deproprietize: true,
        readGitStatus: async () => '',
        validate: async () => {},
        afterBackupMove: ({ rel }) => {
          if (rel === 'catalog/sources.yml') {
            throw new Error('injected manifest swap failure');
          }
        },
      }),
      /injected manifest swap failure/,
    );

    for (const target of baselineModule.SWAP_TARGETS) {
      const targetPath = path.join(repoRoot, ...target.rel.split('/'));
      const actual = target.kind === 'file'
        ? await readFile(targetPath, 'utf8')
        : await baselineModule.snapshotSwapTarget(targetPath, 'dir');
      assert.deepEqual(actual, before.get(target.rel), `${target.rel} must roll back`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
