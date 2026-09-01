import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { hashDirectory } from '../lib/hash.mjs';
import * as baselineModule from '../lib/baseline.mjs';
import {
  applyBaseline,
  appendBaselineHistoryEntry,
  BaselineError,
  buildVerifiedLock,
  swapInCandidate,
  SWAP_TARGETS,
} from '../lib/baseline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.join(__dirname, '.runtime');

async function makeTempDir(prefix) {
  await mkdir(runtimeRoot, { recursive: true });
  return mkdtemp(path.join(runtimeRoot, `${prefix}-`));
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

async function writeFileEnsured(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

function skillDoc(name, body = `Body for ${name}.`) {
  return `---\nname: ${name}\ndescription: Fixture skill ${name}\n---\n\n# ${name}\n\n${body}\n`;
}

async function initUpstreamRepo(root, files) {
  await mkdir(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@example.com']);
  git(root, ['config', 'user.name', 'Fixture']);

  for (const [relativePath, content] of Object.entries(files)) {
    await writeFileEnsured(path.join(root, relativePath), content);
  }

  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial']);

  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  return { url: pathToFileURL(root).href, commit };
}

test('writeAtomicJson syncs the journal parent after the atomic rename', async () => {
  const workspace = await makeTempDir('journal-directory-sync');
  try {
    const journalPath = path.join(workspace, '.skills-sync-transaction.json');
    const syncedDirectories = [];
    const renameCalls = [];

    assert.equal(
      typeof baselineModule.writeAtomicJson,
      'function',
      'atomic journal writes must expose their directory-sync boundary for verification',
    );
    await baselineModule.writeAtomicJson(
      journalPath,
      { version: 1, status: 'swapping' },
      {
        syncDirectory: async (directoryPath) => {
          syncedDirectories.push(directoryPath);
        },
        renameOp: async (sourcePath, destinationPath) => {
          renameCalls.push({ sourcePath, destinationPath });
          await rename(sourcePath, destinationPath);
        },
      },
    );

    assert.deepEqual(syncedDirectories, [workspace]);
    assert.equal(renameCalls.length, 1);
    assert.equal(renameCalls[0].destinationPath, journalPath);
    assert.match(renameCalls[0].sourcePath, /\.skills-sync-transaction\.json\.\d+\.\d+\.tmp$/);
    assert.deepEqual(
      JSON.parse(await readFile(journalPath, 'utf8')),
      { version: 1, status: 'swapping' },
    );

    const defaultJournalPath = path.join(workspace, '.skills-sync-default-transaction.json');
    await baselineModule.writeAtomicJson(defaultJournalPath, { version: 1, status: 'validated' });
    assert.deepEqual(
      JSON.parse(await readFile(defaultJournalPath, 'utf8')),
      { version: 1, status: 'validated' },
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('snapshotSwapTarget ordering is independent of host locale collation', async () => {
  const workspace = await makeTempDir('snapshot-order');
  try {
    await writeFileEnsured(path.join(workspace, 'alpha.txt'), 'alpha');
    await writeFileEnsured(path.join(workspace, 'zeta.txt'), 'zeta');
    const expected = await baselineModule.snapshotSwapTarget(workspace, 'dir');
    const originalLocaleCompare = String.prototype.localeCompare;

    try {
      String.prototype.localeCompare = function reverseCodeUnitOrder(other) {
        const left = String(this);
        const right = String(other);
        return left < right ? 1 : left > right ? -1 : 0;
      };
      const actual = await baselineModule.snapshotSwapTarget(workspace, 'dir');
      assert.equal(actual.hash, expected.hash);
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('snapshotSwapTarget length-prefixes file bytes so tree framing cannot collide', async () => {
  const workspace = await makeTempDir('snapshot-framing');
  try {
    const treeA = path.join(workspace, 'tree-a');
    const treeB = path.join(workspace, 'tree-b');
    await writeFileEnsured(path.join(treeA, 'x'), 'a');
    await writeFileEnsured(path.join(treeA, 'y'), 'b');
    await writeFileEnsured(path.join(treeB, 'x'), '');

    const xMode = String((await stat(path.join(treeA, 'x'))).mode & 0o7777);
    const yMode = String((await stat(path.join(treeA, 'y'))).mode & 0o7777);
    await writeFile(
      path.join(treeB, 'x'),
      Buffer.from(`a\0file\0y\0${yMode}\0b`, 'utf8'),
    );
    await chmod(path.join(treeB, 'x'), Number.parseInt(xMode, 10));

    const snapshotA = await baselineModule.snapshotSwapTarget(treeA, 'dir');
    const snapshotB = await baselineModule.snapshotSwapTarget(treeB, 'dir');
    assert.notEqual(
      snapshotA.hash,
      snapshotB.hash,
      'different tree topology and bytes must not share an exact snapshot hash',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('createApplyWorkRoot places swap trees in the checkout filesystem', async () => {
  const workspace = await makeTempDir('apply-work-root');
  try {
    const repoRoot = path.join(workspace, 'checkout');
    await mkdir(repoRoot, { recursive: true });

    assert.equal(
      typeof baselineModule.createApplyWorkRoot,
      'function',
      'apply work roots must be created independently of Git metadata paths',
    );
    const workRoot = await baselineModule.createApplyWorkRoot(repoRoot, 'baseline');

    assert.equal(path.dirname(workRoot), repoRoot);
    assert.match(path.basename(workRoot), /^\.baseline-work-/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildVerifiedLock (pure)
// ---------------------------------------------------------------------------

function baseLock() {
  return {
    release: '1.0.0',
    generatedAt: '2026-01-01T00:00:00Z',
    counts: { total: 3, mapped: 2, orphan: 1, local: 0 },
    skills: [
      {
        path: 'skills/demo/alpha',
        name: 'alpha',
        category: 'mapped',
        version: '1.0.0',
        baseline: 'unverified',
        license: 'Unknown',
        redistributable: true,
        snapshotHash: 'sha256:old-alpha',
        upstream: {
          repository: 'demo/upstream',
          reference: 'refs/heads/main',
          source: 'skills/alpha',
          commit: null,
        },
      },
      {
        path: 'skills/demo/beta',
        name: 'beta',
        category: 'mapped',
        version: '1.0.0',
        baseline: 'unverified',
        license: 'Unknown',
        redistributable: true,
        snapshotHash: 'sha256:old-beta',
        upstream: {
          repository: 'demo/upstream',
          reference: 'refs/heads/main',
          source: 'skills/beta',
          commit: null,
        },
      },
      {
        path: 'skills/demo/gamma',
        name: 'gamma',
        category: 'orphan',
        version: '1.0.0',
        baseline: null,
        license: 'Unknown',
        redistributable: true,
        snapshotHash: 'sha256:old-gamma',
        upstream: null,
      },
    ],
  };
}

test('buildVerifiedLock stamps mapped entries as verified and retains orphan upstream:null', () => {
  const staged = new Map([
    ['skills/demo/alpha', {
      commit: 'a'.repeat(40),
      contentHash: 'sha256:up-alpha',
      snapshotHash: 'sha256:new-alpha',
      repository: 'demo/upstream',
      reference: 'refs/heads/main',
      source: 'skills/alpha',
    }],
    ['skills/demo/beta', {
      commit: 'b'.repeat(40),
      contentHash: 'sha256:up-beta',
      snapshotHash: 'sha256:new-beta',
      repository: 'demo/upstream',
      reference: 'refs/heads/main',
      source: 'skills/beta',
    }],
  ]);

  const lock = buildVerifiedLock({
    lock: baseLock(),
    staged,
    release: '1.1.0',
    generatedAt: '2026-02-02T00:00:00Z',
  });

  assert.equal(lock.release, '1.1.0');
  assert.equal(lock.generatedAt, '2026-02-02T00:00:00Z');
  assert.deepEqual(lock.counts, { total: 3, mapped: 2, orphan: 1, local: 0 });

  const alpha = lock.skills.find((skill) => skill.path === 'skills/demo/alpha');
  assert.equal(alpha.baseline, 'verified');
  assert.equal(alpha.version, '1.1.0');
  assert.equal(alpha.contentHash, 'sha256:up-alpha');
  assert.equal(alpha.snapshotHash, 'sha256:new-alpha');
  assert.equal(alpha.upstream.commit, 'a'.repeat(40));

  const gamma = lock.skills.find((skill) => skill.path === 'skills/demo/gamma');
  assert.equal(gamma.baseline, null);
  assert.equal(gamma.version, '1.0.0');
  assert.equal(gamma.upstream, null);
  assert.ok(!('contentHash' in gamma));
});

test('buildVerifiedLock uses the full staged upstream tuple after a bootstrap migration', () => {
  const staged = new Map([
    [
      'skills/demo/alpha',
      {
        commit: 'c'.repeat(40),
        contentHash: 'sha256:up-alpha',
        snapshotHash: 'sha256:new-alpha',
        repository: 'migrated/upstream',
        reference: 'refs/tags/v2',
        source: 'new-layout/alpha',
      },
    ],
    [
      'skills/demo/beta',
      {
        commit: 'd'.repeat(40),
        contentHash: 'sha256:up-beta',
        snapshotHash: 'sha256:new-beta',
        repository: 'migrated/upstream',
        reference: 'refs/tags/v2',
        source: 'new-layout/beta',
      },
    ],
  ]);

  const lock = buildVerifiedLock({
    lock: baseLock(),
    staged,
    release: '1.1.0',
    generatedAt: '2026-02-02T00:00:00Z',
  });

  assert.deepEqual(
    lock.skills.find((skill) => skill.path === 'skills/demo/alpha').upstream,
    {
      repository: 'migrated/upstream',
      reference: 'refs/tags/v2',
      source: 'new-layout/alpha',
      commit: 'c'.repeat(40),
    },
  );
});

test('buildVerifiedLock refuses when a mapped skill is not staged', () => {
  const staged = new Map([
    ['skills/demo/alpha', {
      commit: 'a'.repeat(40),
      contentHash: 'sha256:up-alpha',
      snapshotHash: 'sha256:new-alpha',
      repository: 'demo/upstream',
      reference: 'refs/heads/main',
      source: 'skills/alpha',
    }],
  ]);

  assert.throws(
    () => buildVerifiedLock({ lock: baseLock(), staged, release: '1.1.0', generatedAt: 'x' }),
    (error) => error instanceof BaselineError && /skills\/demo\/beta/.test(error.message),
  );
});

test('buildVerifiedLock refuses when staged contains an unmapped path', () => {
  const staged = new Map([
    ['skills/demo/alpha', {
      commit: 'a'.repeat(40),
      contentHash: 'sha256:up-alpha',
      snapshotHash: 'sha256:new-alpha',
      repository: 'demo/upstream',
      reference: 'refs/heads/main',
      source: 'skills/alpha',
    }],
    ['skills/demo/beta', {
      commit: 'b'.repeat(40),
      contentHash: 'sha256:up-beta',
      snapshotHash: 'sha256:new-beta',
      repository: 'demo/upstream',
      reference: 'refs/heads/main',
      source: 'skills/beta',
    }],
    ['skills/demo/ghost', {
      commit: 'c'.repeat(40),
      contentHash: 'sha256:x',
      snapshotHash: 'sha256:y',
      repository: 'demo/upstream',
      reference: 'refs/heads/main',
      source: 'skills/ghost',
    }],
  ]);

  assert.throws(
    () => buildVerifiedLock({ lock: baseLock(), staged, release: '1.1.0', generatedAt: 'x' }),
    (error) => error instanceof BaselineError && /skills\/demo\/ghost/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// appendBaselineHistoryEntry (pure)
// ---------------------------------------------------------------------------

function bootstrapHistory() {
  return {
    path: 'skills/demo/alpha',
    name: 'alpha',
    category: 'mapped',
    entries: [
      {
        release: '1.0.0',
        kind: 'bootstrap',
        version: '1.0.0',
        firstSeen: '2026-01-01T00:00:00Z',
        upstreamCommit: null,
        diffUrl: null,
        snapshotHash: 'sha256:old-alpha',
      },
    ],
  };
}

test('appendBaselineHistoryEntry appends a verification entry preserving bootstrap', () => {
  const next = appendBaselineHistoryEntry(bootstrapHistory(), {
    release: '1.1.0',
    version: '1.1.0',
    upstreamCommit: 'a'.repeat(40),
    contentHash: 'sha256:up-alpha',
  });

  assert.equal(next.entries.length, 2);
  assert.equal(next.entries[0].kind, 'bootstrap');
  assert.deepEqual(next.entries[1], {
    release: '1.1.0',
    kind: 'baseline-verified',
    version: '1.1.0',
    upstreamCommit: 'a'.repeat(40),
    diffUrl: null,
    contentHash: 'sha256:up-alpha',
  });
});

test('appendBaselineHistoryEntry is idempotent for an identical verification', () => {
  const once = appendBaselineHistoryEntry(bootstrapHistory(), {
    release: '1.1.0',
    version: '1.1.0',
    upstreamCommit: 'a'.repeat(40),
    contentHash: 'sha256:up-alpha',
  });
  const twice = appendBaselineHistoryEntry(once, {
    release: '1.1.0',
    version: '1.1.0',
    upstreamCommit: 'a'.repeat(40),
    contentHash: 'sha256:up-alpha',
  });

  assert.equal(JSON.stringify(twice), JSON.stringify(once));
});

test('appendBaselineHistoryEntry refuses history without a bootstrap entry', () => {
  assert.throws(
    () => appendBaselineHistoryEntry({ path: 'x', entries: [] }, {
      release: '1.1.0',
      version: '1.1.0',
      upstreamCommit: 'a'.repeat(40),
      contentHash: 'sha256:up-alpha',
    }),
    (error) => error instanceof BaselineError,
  );
});

// ---------------------------------------------------------------------------
// applyBaseline (fixture integration)
// ---------------------------------------------------------------------------

async function buildBaselineFixture(workspace, { alphaUpstreamBody, upstreamExtraFiles = {} } = {}) {
  const upstream = await initUpstreamRepo(path.join(workspace, 'upstream'), {
    'skills/alpha/SKILL.md': skillDoc('alpha', alphaUpstreamBody ?? 'Upstream alpha body.'),
    'skills/alpha/references/notes.md': '# alpha notes\n',
    'skills/beta/SKILL.md': skillDoc('beta', 'Upstream beta body.'),
    ...upstreamExtraFiles,
  });

  const repoRoot = path.join(workspace, 'repo');

  // Mapped skills (vendored, deliberately stale vs upstream).
  await writeFileEnsured(
    path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md'),
    skillDoc('alpha', 'Stale vendored alpha body.'),
  );
  await writeFileEnsured(
    path.join(repoRoot, 'skills', 'demo', 'alpha', 'references', 'notes.md'),
    '# stale notes\n',
  );
  await writeFileEnsured(
    path.join(repoRoot, 'skills', 'demo', 'beta', 'SKILL.md'),
    skillDoc('beta', 'Stale vendored beta body.'),
  );

  // Orphan + local skills must never change.
  await writeFileEnsured(
    path.join(repoRoot, 'skills', 'orphans', 'gamma', 'SKILL.md'),
    skillDoc('gamma'),
  );
  await writeFileEnsured(
    path.join(repoRoot, 'skills', 'lettucebo', 'local-skill', 'SKILL.md'),
    skillDoc('local-skill'),
  );

  await writeFileEnsured(
    path.join(repoRoot, 'catalog', 'sources.yml'),
    [
      'upstreams:',
      '  demo:',
      `    repository: "${upstream.url}"`,
      '    reference: refs/heads/main',
      'mappings:',
      '  - path: skills/demo/alpha',
      '    upstream: demo',
      '    source: skills/alpha',
      '  - path: skills/demo/beta',
      '    upstream: demo',
      '    source: skills/beta',
      'orphans:',
      '  - path: skills/orphans/gamma',
      'local:',
      '  - root: skills/lettucebo',
      'overrides: []',
      'linkExceptions: []',
      '',
    ].join('\n'),
  );

  const alphaHash = await hashDirectory(path.join(repoRoot, 'skills', 'demo', 'alpha'));
  const betaHash = await hashDirectory(path.join(repoRoot, 'skills', 'demo', 'beta'));
  const gammaHash = await hashDirectory(path.join(repoRoot, 'skills', 'orphans', 'gamma'));
  const localHash = await hashDirectory(
    path.join(repoRoot, 'skills', 'lettucebo', 'local-skill'),
  );

  const skills = [
    mappedLockEntry('skills/demo/alpha', 'alpha', 'skills/alpha', alphaHash, upstream.url),
    mappedLockEntry('skills/demo/beta', 'beta', 'skills/beta', betaHash, upstream.url),
    {
      path: 'skills/lettucebo/local-skill',
      name: 'local-skill',
      category: 'local',
      version: '1.0.0',
      baseline: null,
      license: 'Unknown',
      redistributable: true,
      snapshotHash: localHash,
      upstream: null,
    },
    {
      path: 'skills/orphans/gamma',
      name: 'gamma',
      category: 'orphan',
      version: '1.0.0',
      baseline: null,
      license: 'Unknown',
      redistributable: true,
      snapshotHash: gammaHash,
      upstream: null,
    },
  ].sort((left, right) => (left.path < right.path ? -1 : 1));

  await writeFileEnsured(
    path.join(repoRoot, 'catalog', 'skills.lock.json'),
    `${JSON.stringify(
      {
        release: '1.0.0',
        generatedAt: '2026-01-01T00:00:00Z',
        counts: { total: 4, mapped: 2, orphan: 1, local: 1 },
        skills,
      },
      null,
      2,
    )}\n`,
  );

  for (const skill of skills) {
    await writeFileEnsured(
      path.join(repoRoot, 'catalog', 'history', `${skill.path.replace(/\//g, '__')}.json`),
      `${JSON.stringify(
        {
          path: skill.path,
          name: skill.name,
          category: skill.category,
          entries: [
            {
              release: '1.0.0',
              kind: 'bootstrap',
              version: '1.0.0',
              firstSeen: '2026-01-01T00:00:00Z',
              upstreamCommit: null,
              diffUrl: null,
              snapshotHash: skill.snapshotHash,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
  }

  await writeFileEnsured(path.join(repoRoot, 'NOTICE'), '# NOTICE\n\nplaceholder\n');
  await writeFileEnsured(
    path.join(repoRoot, 'README.md'),
    ['# Fixture', '', '<!-- CATALOG:START -->', 'old', '<!-- CATALOG:END -->', ''].join('\n'),
  );

  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'fixture@example.com']);
  git(repoRoot, ['config', 'user.name', 'Fixture']);

  return { upstream, upstreamRoot: path.join(workspace, 'upstream'), repoRoot };
}

function mappedLockEntry(skillPath, name, source, snapshotHash, repository) {
  return {
    path: skillPath,
    name,
    category: 'mapped',
    version: '1.0.0',
    baseline: 'unverified',
    license: 'Unknown',
    redistributable: true,
    snapshotHash,
    upstream: { repository, reference: 'refs/heads/main', source, commit: null },
  };
}

const cleanTree = async () => '';

test('applyBaseline requires explicit baseline mode', async () => {
  const workspace = await makeTempDir('baseline-mode');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);
    await assert.rejects(
      applyBaseline({ repoRoot, baseline: false, readGitStatus: cleanTree }),
      (error) => error instanceof BaselineError && /baseline mode/i.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline refuses a dirty working tree without touching the repo', async () => {
  const workspace = await makeTempDir('baseline-dirty');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);
    const before = await hashDirectory(path.join(repoRoot, 'skills'));

    await assert.rejects(
      applyBaseline({
        repoRoot,
        baseline: true,
        readGitStatus: async () => ' M skills/demo/alpha/SKILL.md\n',
      }),
      (error) => error instanceof BaselineError && /clean/i.test(error.message),
    );

    assert.equal(await hashDirectory(path.join(repoRoot, 'skills')), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline transitions lock and history to verified baseline', async () => {
  const workspace = await makeTempDir('baseline-ok');
  try {
    const { upstream, repoRoot } = await buildBaselineFixture(workspace);

    const orphanBefore = await hashDirectory(path.join(repoRoot, 'skills', 'orphans', 'gamma'));
    const localBefore = await hashDirectory(
      path.join(repoRoot, 'skills', 'lettucebo', 'local-skill'),
    );

    const upstreamAlphaHash = await hashDirectory(
      path.join(workspace, 'upstream', 'skills', 'alpha'),
    );

    const result = await applyBaseline({
      repoRoot,
      baseline: true,
      readGitStatus: cleanTree,
      now: () => '2026-02-02T00:00:00Z',
    });

    assert.equal(result.release, '1.1.0');

    const lock = JSON.parse(
      await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
    );
    assert.equal(lock.release, '1.1.0');
    assert.equal(lock.counts.total, 4);

    const alpha = lock.skills.find((skill) => skill.path === 'skills/demo/alpha');
    assert.equal(alpha.baseline, 'verified');
    assert.equal(alpha.version, '1.1.0');
    assert.equal(alpha.upstream.commit, upstream.commit);
    // contentHash is the upstream pre-stamp hash (verified content identity).
    assert.equal(alpha.contentHash, upstreamAlphaHash);

    // Orphan + local skills are byte-for-byte unchanged.
    assert.equal(
      await hashDirectory(path.join(repoRoot, 'skills', 'orphans', 'gamma')),
      orphanBefore,
    );
    assert.equal(
      await hashDirectory(path.join(repoRoot, 'skills', 'lettucebo', 'local-skill')),
      localBefore,
    );
    const gamma = lock.skills.find((skill) => skill.path === 'skills/orphans/gamma');
    assert.equal(gamma.upstream, null);
    assert.equal(gamma.baseline, null);

    // Applied SKILL.md contains upstream body and a provenance stamp.
    const appliedAlpha = await readFile(
      path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md'),
      'utf8',
    );
    assert.match(appliedAlpha, /Upstream alpha body\./);
    assert.match(appliedAlpha, new RegExp(`x-source-commit: ${upstream.commit}`));

    // History keeps the bootstrap entry and appends a verification entry.
    const history = JSON.parse(
      await readFile(
        path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'),
        'utf8',
      ),
    );
    assert.equal(history.entries.length, 2);
    assert.equal(history.entries[0].kind, 'bootstrap');
    assert.equal(history.entries[1].kind, 'baseline-verified');
    assert.equal(history.entries[1].upstreamCommit, upstream.commit);
    assert.equal(history.entries[1].contentHash, upstreamAlphaHash);

    // Orphan history is untouched.
    const gammaHistory = JSON.parse(
      await readFile(
        path.join(repoRoot, 'catalog', 'history', 'skills__orphans__gamma.json'),
        'utf8',
      ),
    );
    assert.equal(gammaHistory.entries.length, 1);

    // NOTICE + README regenerated.
    const notice = await readFile(path.join(repoRoot, 'NOTICE'), 'utf8');
    assert.match(notice, /# NOTICE/);
    const readme = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
    assert.match(readme, /<!-- CATALOG:START -->/);
    assert.doesNotMatch(readme, /\nold\n/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline records migrated repository, reference, source, stamp, and history provenance', async () => {
  const workspace = await makeTempDir('baseline-tuple-migration');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);
    const migrated = await initUpstreamRepo(path.join(workspace, 'migrated-upstream'), {
      'new-layout/alpha/SKILL.md': skillDoc('alpha', 'Upstream alpha body.'),
      'new-layout/alpha/references/notes.md': '# alpha notes\n',
      'new-layout/beta/SKILL.md': skillDoc('beta', 'Upstream beta body.'),
    });
    git(path.join(workspace, 'migrated-upstream'), ['tag', '-a', 'v2', '-m', 'fixture']);

    await writeFile(
      path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md'),
      skillDoc('alpha', 'Upstream alpha body.'),
    );
    await writeFile(
      path.join(repoRoot, 'skills', 'demo', 'alpha', 'references', 'notes.md'),
      '# alpha notes\n',
    );

    const oldLock = JSON.parse(
      await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
    );
    assert.equal(
      await hashDirectory(path.join(workspace, 'migrated-upstream', 'new-layout', 'alpha')),
      await hashDirectory(path.join(repoRoot, 'skills', 'demo', 'alpha')),
      'the migration must retain identical upstream and bootstrap content bytes',
    );

    const sourcesPath = path.join(repoRoot, 'catalog', 'sources.yml');
    const sources = await readFile(sourcesPath, 'utf8');
    await writeFile(
      sourcesPath,
      sources
        .replace(/repository: ".*"/, `repository: "${migrated.url}"`)
        .replace('reference: refs/heads/main', 'reference: refs/tags/v2')
        .replace('source: skills/alpha', 'source: new-layout/alpha')
        .replace('source: skills/beta', 'source: new-layout/beta'),
    );

    await applyBaseline({
      repoRoot,
      baseline: true,
      readGitStatus: cleanTree,
      now: () => '2026-02-02T00:00:00Z',
    });

    const lock = JSON.parse(
      await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
    );
    const alpha = lock.skills.find((skill) => skill.path === 'skills/demo/alpha');
    assert.deepEqual(alpha.upstream, {
      repository: migrated.url,
      reference: 'refs/tags/v2',
      source: 'new-layout/alpha',
      commit: migrated.commit,
    });
    assert.notDeepEqual(alpha.upstream, oldLock.skills.find((skill) => skill.path === alpha.path).upstream);

    const stamped = await readFile(path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md'), 'utf8');
    assert.match(stamped, new RegExp(`x-source: ${migrated.url}`));
    assert.match(stamped, /x-source-ref: refs\/tags\/v2/);
    assert.match(stamped, /x-source-path: new-layout\/alpha/);
    assert.match(stamped, new RegExp(`x-source-commit: ${migrated.commit}`));

    const history = JSON.parse(
      await readFile(path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'), 'utf8'),
    );
    assert.equal(history.entries.at(-1).upstreamCommit, migrated.commit);
    assert.equal(history.entries.at(-1).diffUrl, null);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline never vendors an upstream node_modules tree', async () => {
  const workspace = await makeTempDir('baseline-node-modules');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace, {
      upstreamExtraFiles: {
        'skills/alpha/node_modules/left-pad/index.js': 'module.exports = () => {};\n',
        'skills/alpha/node_modules/left-pad/package.json': '{"name":"left-pad"}\n',
        'skills/alpha/assets/node_modules/nested/index.js': 'nested\n',
      },
    });

    await applyBaseline({
      repoRoot,
      baseline: true,
      readGitStatus: cleanTree,
      now: () => '2026-02-02T00:00:00Z',
    });

    const alphaDir = path.join(repoRoot, 'skills', 'demo', 'alpha');

    assert.equal(
      existsSync(path.join(alphaDir, 'node_modules')),
      false,
      'git ignores node_modules everywhere, so staging must not vendor bytes the commit ' +
        'can never contain',
    );
    assert.equal(existsSync(path.join(alphaDir, 'assets', 'node_modules')), false);

    // The rest of the upstream content is vendored normally.
    assert.ok(existsSync(path.join(alphaDir, 'SKILL.md')));
    assert.ok(existsSync(path.join(alphaDir, 'references', 'notes.md')));

    const lock = JSON.parse(
      await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
    );
    const alpha = lock.skills.find((skill) => skill.path === 'skills/demo/alpha');
    assert.equal(
      alpha.snapshotHash,
      await hashDirectory(alphaDir),
      'the recorded snapshot must describe exactly the vendored tree',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline rejects upstream symbolic links without mutating the repository', async (t) => {
  const workspace = await makeTempDir('baseline-symbolic-link');
  try {
    const { repoRoot, upstreamRoot } = await buildBaselineFixture(workspace);
    const linkPath = path.join(upstreamRoot, 'skills', 'alpha', 'linked-skill.md');

    try {
      await symlink('SKILL.md', linkPath);
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`symbolic links cannot be created on this host: ${error.code}`);
        return;
      }
      throw error;
    }
    git(upstreamRoot, ['add', '-A']);
    git(upstreamRoot, ['commit', '-q', '-m', 'add symbolic link']);

    const skillsBefore = await hashDirectory(path.join(repoRoot, 'skills'));
    const lockBefore = await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8');

    await assert.rejects(
      applyBaseline({ repoRoot, baseline: true, readGitStatus: cleanTree }),
      /symbolic link.*linked-skill\.md/i,
    );

    assert.equal(await hashDirectory(path.join(repoRoot, 'skills')), skillsBefore);
    assert.equal(await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'), lockBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline identifies a symbolic-link mapping source before staging', async (t) => {
  const workspace = await makeTempDir('baseline-symbolic-source');
  try {
    const { repoRoot, upstreamRoot } = await buildBaselineFixture(workspace);
    const linkPath = path.join(upstreamRoot, 'skills', 'linked-alpha');

    try {
      await symlink('alpha', linkPath, 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`symbolic links cannot be created on this host: ${error.code}`);
        return;
      }
      throw error;
    }
    git(upstreamRoot, ['add', '-A']);
    git(upstreamRoot, ['commit', '-q', '-m', 'add symbolic source link']);

    const sourcesPath = path.join(repoRoot, 'catalog', 'sources.yml');
    const sources = await readFile(sourcesPath, 'utf8');
    await writeFile(sourcesPath, sources.replace('source: skills/alpha', 'source: skills/linked-alpha'));

    const skillsBefore = await hashDirectory(path.join(repoRoot, 'skills'));
    const lockBefore = await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8');

    await assert.rejects(
      applyBaseline({ repoRoot, baseline: true, readGitStatus: cleanTree }),
      /symbolic link.*linked-alpha/i,
    );

    assert.equal(await hashDirectory(path.join(repoRoot, 'skills')), skillsBefore);
    assert.equal(await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'), lockBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline rejects an ancestor link that escapes the clone root without mutation', async (t) => {
  const workspace = await makeTempDir('baseline-ancestor-link');
  try {
    const { repoRoot, upstreamRoot } = await buildBaselineFixture(workspace);
    const outsideRoot = path.join(workspace, 'outside');
    await writeFileEnsured(
      path.join(outsideRoot, 'skill', 'SKILL.md'),
      skillDoc('alpha', 'Escaped content.'),
    );
    const linkPath = path.join(upstreamRoot, 'linked-dir');

    try {
      await symlink(outsideRoot, linkPath, 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`symbolic links cannot be created on this host: ${error.code}`);
        return;
      }
      throw error;
    }
    git(upstreamRoot, ['add', '-A']);
    git(upstreamRoot, ['commit', '-q', '-m', 'add escaping ancestor link']);

    const sourcesPath = path.join(repoRoot, 'catalog', 'sources.yml');
    const sources = await readFile(sourcesPath, 'utf8');
    await writeFile(
      sourcesPath,
      sources.replace('source: skills/alpha', 'source: linked-dir/skill'),
    );

    const skillsBefore = await hashDirectory(path.join(repoRoot, 'skills'));
    const lockBefore = await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8');
    const historyBefore = await readFile(
      path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'),
      'utf8',
    );

    await assert.rejects(
      applyBaseline({ repoRoot, baseline: true, readGitStatus: cleanTree }),
      /(?:path boundary|symbolic link).*linked-dir/i,
    );

    assert.equal(await hashDirectory(path.join(repoRoot, 'skills')), skillsBefore);
    assert.equal(await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'), lockBefore);
    assert.equal(
      await readFile(path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'), 'utf8'),
      historyBefore,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline refuses when an upstream is unavailable and leaves repo intact', async () => {
  const workspace = await makeTempDir('baseline-unavail');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);

    // Point the manifest at a non-existent upstream repository.
    const bogus = pathToFileURL(path.join(workspace, 'nope', 'missing')).href;
    const sourcesPath = path.join(repoRoot, 'catalog', 'sources.yml');
    const sources = await readFile(sourcesPath, 'utf8');
    await writeFile(
      sourcesPath,
      sources.replace(/repository: ".*"/, `repository: "${bogus}"`),
    );

    const before = await hashDirectory(path.join(repoRoot, 'skills'));
    const lockBefore = await readFile(
      path.join(repoRoot, 'catalog', 'skills.lock.json'),
      'utf8',
    );

    await assert.rejects(
      applyBaseline({ repoRoot, baseline: true, readGitStatus: cleanTree }),
      (error) => error instanceof BaselineError && /unavailable|blocking/i.test(error.message),
    );

    assert.equal(await hashDirectory(path.join(repoRoot, 'skills')), before);
    assert.equal(
      await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
      lockBefore,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline refuses when a mapped source is missing upstream', async () => {
  const workspace = await makeTempDir('baseline-missing');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);

    const sourcesPath = path.join(repoRoot, 'catalog', 'sources.yml');
    const sources = await readFile(sourcesPath, 'utf8');
    await writeFile(sourcesPath, sources.replace('source: skills/beta', 'source: skills/does-not-exist'));

    const before = await hashDirectory(path.join(repoRoot, 'skills'));

    await assert.rejects(
      applyBaseline({ repoRoot, baseline: true, readGitStatus: cleanTree }),
      (error) => error instanceof BaselineError,
    );

    assert.equal(await hashDirectory(path.join(repoRoot, 'skills')), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline refuses a non-directory (command-to-skill) source and leaves repo intact', async () => {
  const workspace = await makeTempDir('baseline-filesrc');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);

    // Point a mapping at a single upstream file (analog of a command-to-skill
    // `.md` source) which the directory pipeline cannot stage.
    const sourcesPath = path.join(repoRoot, 'catalog', 'sources.yml');
    const sources = await readFile(sourcesPath, 'utf8');
    await writeFile(
      sourcesPath,
      sources.replace('source: skills/beta', 'source: skills/beta/SKILL.md'),
    );

    const before = await hashDirectory(path.join(repoRoot, 'skills'));
    const lockBefore = await readFile(
      path.join(repoRoot, 'catalog', 'skills.lock.json'),
      'utf8',
    );

    await assert.rejects(
      applyBaseline({ repoRoot, baseline: true, readGitStatus: cleanTree }),
      (error) => error instanceof BaselineError && /unavailable|blocking/i.test(error.message),
    );

    // No crash, no partial mutation: repo bytes and lock are untouched.
    assert.equal(await hashDirectory(path.join(repoRoot, 'skills')), before);
    assert.equal(
      await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
      lockBefore,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline rolls back completely when post-apply validation fails', async () => {
  const workspace = await makeTempDir('baseline-rollback');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);

    const skillsBefore = await hashDirectory(path.join(repoRoot, 'skills'));
    const lockBefore = await readFile(
      path.join(repoRoot, 'catalog', 'skills.lock.json'),
      'utf8',
    );
    const historyBefore = await readFile(
      path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'),
      'utf8',
    );
    const noticeBefore = await readFile(path.join(repoRoot, 'NOTICE'), 'utf8');
    const readmeBefore = await readFile(path.join(repoRoot, 'README.md'), 'utf8');

    await assert.rejects(
      applyBaseline({
        repoRoot,
        baseline: true,
        readGitStatus: cleanTree,
        validate: async () => {
          throw new Error('injected validation failure');
        },
      }),
      (error) => error instanceof BaselineError && /validation/i.test(error.message),
    );

    // Everything restored byte-for-byte.
    assert.equal(await hashDirectory(path.join(repoRoot, 'skills')), skillsBefore);
    assert.equal(
      await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
      lockBefore,
    );
    assert.equal(
      await readFile(
        path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'),
        'utf8',
      ),
      historyBefore,
    );
    assert.equal(await readFile(path.join(repoRoot, 'NOTICE'), 'utf8'), noticeBefore);
    assert.equal(await readFile(path.join(repoRoot, 'README.md'), 'utf8'), readmeBefore);

    // No stray work directories left behind under the repo.
    const repoEntries = await readdir(repoRoot);
    assert.ok(!repoEntries.some((name) => name.startsWith('.baseline')));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline defaults repoRoot to the repository so the CLI cannot omit it', async () => {
  // The CLI invokes applyBaseline without an explicit repoRoot. Every other
  // parameter already defaults, so a missing default here surfaced only as an
  // opaque path error at real apply time.
  await assert.rejects(
    () =>
      applyBaseline({
        baseline: true,
        readGitStatus: async () => ' M some-file\n',
      }),
    (error) =>
      error instanceof BaselineError && /working tree is not clean/.test(error.message),
  );
});

test('buildVerifiedLock adopts the staged frontmatter name when upstream renamed a skill', () => {
  // The bootstrap lock derives names from the stale vendored copy. Once the
  // baseline replaces that copy with real upstream content, the authoritative
  // name is whatever the staged SKILL.md declares after transforms.
  const staged = new Map([
    [
      'skills/demo/alpha',
      {
        commit: 'a'.repeat(40),
        contentHash: 'sha256:up-alpha',
        snapshotHash: 'sha256:new-alpha',
        name: 'alpha-renamed-upstream',
        repository: 'demo/upstream',
        reference: 'refs/heads/main',
        source: 'skills/alpha',
      },
    ],
    [
      'skills/demo/beta',
      {
        commit: 'b'.repeat(40),
        contentHash: 'sha256:up-beta',
        snapshotHash: 'sha256:new-beta',
        repository: 'demo/upstream',
        reference: 'refs/heads/main',
        source: 'skills/beta',
      },
    ],
  ]);

  const lock = buildVerifiedLock({
    lock: baseLock(),
    staged,
    release: '1.1.0',
    generatedAt: '2026-02-02T00:00:00Z',
  });

  const alpha = lock.skills.find((skill) => skill.path === 'skills/demo/alpha');
  assert.equal(alpha.name, 'alpha-renamed-upstream');

  // Without a staged name the previous lock name is preserved.
  const beta = lock.skills.find((skill) => skill.path === 'skills/demo/beta');
  assert.equal(beta.name, 'beta');
});

// ---------------------------------------------------------------------------
// Defect 1: swapInCandidate rollback data-loss window
// ---------------------------------------------------------------------------

/**
 * Builds a minimal swap fixture: a repo root, a candidate root, and a backup
 * root, each with the SWAP_TARGETS populated so swapInCandidate can operate.
 */
async function buildSwapFixture(workspace) {
  const repoRoot = path.join(workspace, 'repo');
  const candidateRoot = path.join(workspace, 'candidate');
  const backupRoot = path.join(workspace, 'backup');

  // Create the original files in the repo root.
  await writeFileEnsured(path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md'), skillDoc('alpha'));
  await writeFileEnsured(path.join(repoRoot, 'catalog', 'history', 'alpha.json'), '{"path":"alpha"}');
  await writeFileEnsured(path.join(repoRoot, 'catalog', 'sources.yml'), 'mappings: []\n');
  await writeFileEnsured(path.join(repoRoot, 'catalog', 'skills.lock.json'), '{"release":"1.0.0"}');
  await writeFileEnsured(path.join(repoRoot, 'NOTICE'), '# NOTICE\noriginal\n');
  await writeFileEnsured(path.join(repoRoot, 'README.md'), '# README\noriginal\n');

  // Create the candidate files (different content).
  await writeFileEnsured(path.join(candidateRoot, 'skills', 'demo', 'alpha', 'SKILL.md'), skillDoc('alpha-candidate'));
  await writeFileEnsured(path.join(candidateRoot, 'catalog', 'history', 'alpha.json'), '{"path":"alpha-candidate"}');
  await writeFileEnsured(path.join(candidateRoot, 'catalog', 'sources.yml'), 'mappings:\n  - candidate\n');
  await writeFileEnsured(path.join(candidateRoot, 'catalog', 'skills.lock.json'), '{"release":"1.1.0"}');
  await writeFileEnsured(path.join(candidateRoot, 'NOTICE'), '# NOTICE\ncandidate\n');
  await writeFileEnsured(path.join(candidateRoot, 'README.md'), '# README\ncandidate\n');

  // Capture original hashes for each SWAP_TARGET.
  const originalHashes = new Map();
  for (const target of SWAP_TARGETS) {
    const targetPath = path.join(repoRoot, ...target.rel.split('/'));
    if (target.kind === 'dir') {
      originalHashes.set(target.rel, await hashDirectory(targetPath));
    } else {
      originalHashes.set(target.rel, await readFile(targetPath, 'utf8'));
    }
  }

  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'fixture@example.com']);
  git(repoRoot, ['config', 'user.name', 'Fixture']);

  return { repoRoot, candidateRoot, backupRoot, originalHashes };
}

const SWAP_PHASES = [
  'moving-to-backup',
  'backed-up',
  'placing-candidate',
  'placed',
];

async function buildInterruptedSwap(workspace, targetIndex, phase) {
  const fixture = await buildSwapFixture(workspace);
  const { repoRoot, candidateRoot, backupRoot } = fixture;
  const targets = SWAP_TARGETS.map((target, index) => ({
    ...target,
    live: path.join(repoRoot, ...target.rel.split('/')),
    backup: path.join(backupRoot, ...target.rel.split('/')),
    candidate: path.join(candidateRoot, ...target.rel.split('/')),
    phase: index < targetIndex ? 'placed' : index === targetIndex ? phase : 'live',
  }));

  for (const target of targets.slice(0, targetIndex)) {
    await mkdir(path.dirname(target.backup), { recursive: true });
    await rename(target.live, target.backup);
    await rename(target.candidate, target.live);
  }

  const target = targets[targetIndex];
  if (phase !== 'moving-to-backup') {
    await mkdir(path.dirname(target.backup), { recursive: true });
    await rename(target.live, target.backup);
  }
  if (phase === 'placed') {
    await rename(target.candidate, target.live);
  }

  const journalPath = path.join(repoRoot, '.git', '.skills-sync-transaction.json');
  await writeFile(
    journalPath,
    `${JSON.stringify({
      version: 1,
      status: 'swapping',
      repoRoot,
      candidateRoot,
      backupRoot,
      workRoot: path.dirname(candidateRoot),
      targets,
    }, null, 2)}\n`,
  );

  return { ...fixture, journalPath };
}

for (const [targetIndex, target] of SWAP_TARGETS.entries()) {
  for (const phase of SWAP_PHASES) {
    test(`applyBaseline recovers ${target.rel} interrupted at ${phase}`, async () => {
      const workspace = await makeTempDir(`baseline-crash-${targetIndex}-${phase}`);
      try {
        const { repoRoot, candidateRoot, backupRoot, journalPath, originalHashes } =
          await buildInterruptedSwap(workspace, targetIndex, phase);

        await assert.rejects(
          applyBaseline({
            repoRoot,
            baseline: true,
            readGitStatus: async () => ' M skills/demo/alpha/SKILL.md\n',
          }),
          (error) => error instanceof BaselineError && /clean/i.test(error.message),
        );

        for (const swapTarget of SWAP_TARGETS) {
          const live = path.join(repoRoot, ...swapTarget.rel.split('/'));
          if (swapTarget.kind === 'dir') {
            assert.equal(await hashDirectory(live), originalHashes.get(swapTarget.rel));
          } else {
            assert.equal(await readFile(live, 'utf8'), originalHashes.get(swapTarget.rel));
          }
        }

        assert.equal(existsSync(journalPath), false, 'the recovered journal must be removed');
        assert.equal(existsSync(backupRoot), false, 'the recovered backup must be removed');
        assert.equal(existsSync(candidateRoot), false, 'the recovered candidate must be removed');
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }
}

test('applyBaseline preserves recovery artifacts instead of restoring a partial validated backup', async () => {
  const workspace = await makeTempDir('baseline-validated-partial-backup');
  try {
    const { repoRoot, candidateRoot, backupRoot } = await buildSwapFixture(workspace);
    const targets = [];
    for (const target of SWAP_TARGETS) {
      const live = path.join(repoRoot, ...target.rel.split('/'));
      targets.push({
        ...target,
        live,
        backup: path.join(backupRoot, ...target.rel.split('/')),
        candidate: path.join(candidateRoot, ...target.rel.split('/')),
        expectedSnapshot: await baselineModule.snapshotSwapTarget(live, target.kind),
        phase: 'placed',
      });
    }

    for (const target of targets) {
      await mkdir(path.dirname(target.backup), { recursive: true });
      await rename(target.live, target.backup);
      await rename(target.candidate, target.live);
    }
    await rm(path.join(backupRoot, 'skills', 'demo', 'alpha', 'SKILL.md'));

    const journalPath = path.join(repoRoot, '.git', '.skills-sync-transaction.json');
    await writeFile(
      journalPath,
      `${JSON.stringify({
        version: 2,
        status: 'validated',
        repoRoot,
        candidateRoot,
        backupRoot,
        workRoot: workspace,
        targets,
      }, null, 2)}\n`,
    );

    await assert.rejects(
      applyBaseline({
        repoRoot,
        baseline: true,
        readGitStatus: async () => ' M skills/demo/alpha/SKILL.md\n',
      }),
      (error) =>
        error instanceof BaselineError &&
        /validated transaction.*changed backup/i.test(error.message),
    );

    assert.match(
      await readFile(path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md'), 'utf8'),
      /alpha-candidate/,
      'the complete candidate must remain live instead of being overwritten by the partial backup',
    );
    assert.equal(
      existsSync(path.join(backupRoot, 'skills', 'demo', 'alpha', 'SKILL.md')),
      false,
      'the partial backup must remain available for manual recovery',
    );
    assert.equal(existsSync(journalPath), true, 'the journal must remain for operator recovery');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline preserves a snapshot-less validated journal for manual recovery', async () => {
  const workspace = await makeTempDir('baseline-legacy-validated-journal');
  try {
    const { repoRoot, candidateRoot, backupRoot } = await buildSwapFixture(workspace);
    const targets = SWAP_TARGETS.map((target) => ({
      ...target,
      live: path.join(repoRoot, ...target.rel.split('/')),
      backup: path.join(backupRoot, ...target.rel.split('/')),
      candidate: path.join(candidateRoot, ...target.rel.split('/')),
      phase: 'placed',
    }));

    for (const target of targets) {
      await mkdir(path.dirname(target.backup), { recursive: true });
      await rename(target.live, target.backup);
      await rename(target.candidate, target.live);
    }
    await rm(path.join(backupRoot, 'skills', 'demo', 'alpha', 'SKILL.md'));

    const journalPath = path.join(repoRoot, '.git', '.skills-sync-transaction.json');
    await writeFile(
      journalPath,
      `${JSON.stringify({
        version: 1,
        status: 'validated',
        repoRoot,
        candidateRoot,
        backupRoot,
        workRoot: workspace,
        targets,
      }, null, 2)}\n`,
    );

    await assert.rejects(
      applyBaseline({
        repoRoot,
        baseline: true,
        readGitStatus: async () => ' M skills/demo/alpha/SKILL.md\n',
      }),
      (error) =>
        error instanceof BaselineError &&
        /validated transaction.*expected snapshots|inspect.*backup/i.test(error.message),
    );

    assert.match(
      await readFile(path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md'), 'utf8'),
      /alpha-candidate/,
    );
    assert.equal(existsSync(journalPath), true);
    assert.equal(existsSync(backupRoot), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('swapInCandidate restores all originals when placement fails after first backup', async () => {
  const workspace = await makeTempDir('swap-fault-first');
  try {
    const { repoRoot, candidateRoot, backupRoot, originalHashes } = await buildSwapFixture(workspace);

    let backupCount = 0;
    const faultyRename = async (src, dest) => {
      // Allow backup renames (original -> backup), count them.
      // Fail on the FIRST placement rename (candidate -> original).
      // During rollback, always succeed.
      const isBackup = dest.startsWith(backupRoot);
      if (isBackup) {
        backupCount++;
        return rename(src, dest);
      }
      // Check if this is a rollback rename (src is from backup).
      if (src.startsWith(backupRoot)) {
        return rename(src, dest);
      }
      // This is a placement rename; fail on the first one.
      throw new Error('injected placement failure');
    };

    await assert.rejects(
      swapInCandidate(repoRoot, candidateRoot, backupRoot, { renameOp: faultyRename }),
      /injected placement failure/,
    );

    // The first target should have been backed up.
    assert.ok(backupCount >= 1, 'at least one backup should have succeeded');

    // Every original target must be restored byte-identically.
    for (const target of SWAP_TARGETS) {
      const targetPath = path.join(repoRoot, ...target.rel.split('/'));
      if (target.kind === 'dir') {
        assert.equal(
          await hashDirectory(targetPath),
          originalHashes.get(target.rel),
          `${target.rel} should be restored byte-identically`,
        );
      } else {
        assert.equal(
          await readFile(targetPath, 'utf8'),
          originalHashes.get(target.rel),
          `${target.rel} should be restored byte-identically`,
        );
      }
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('swapInCandidate restores all originals when placement fails after a later backup', async () => {
  const workspace = await makeTempDir('swap-fault-later');
  try {
    const { repoRoot, candidateRoot, backupRoot, originalHashes } = await buildSwapFixture(workspace);

    let placementCount = 0;
    let inRollback = false;
    const faultyRename = async (src, dest) => {
      // During rollback, always succeed.
      if (inRollback) return rename(src, dest);
      const isBackup = dest.startsWith(backupRoot);
      if (isBackup) {
        return rename(src, dest);
      }
      // Allow the first placement, fail on the second.
      placementCount++;
      if (placementCount > 1) {
        inRollback = true;
        throw new Error('injected later placement failure');
      }
      return rename(src, dest);
    };

    await assert.rejects(
      swapInCandidate(repoRoot, candidateRoot, backupRoot, { renameOp: faultyRename }),
      /injected later placement failure/,
    );

    // Every original target must be restored byte-identically.
    for (const target of SWAP_TARGETS) {
      const targetPath = path.join(repoRoot, ...target.rel.split('/'));
      if (target.kind === 'dir') {
        assert.equal(
          await hashDirectory(targetPath),
          originalHashes.get(target.rel),
          `${target.rel} should be restored byte-identically`,
        );
      } else {
        assert.equal(
          await readFile(targetPath, 'utf8'),
          originalHashes.get(target.rel),
          `${target.rel} should be restored byte-identically`,
        );
      }
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('swapInCandidate preserves backup and surfaces both errors when rollback itself fails', async () => {
  const workspace = await makeTempDir('swap-rollback-fail');
  try {
    const { repoRoot, candidateRoot, backupRoot } = await buildSwapFixture(workspace);

    let placementAttempts = 0;
    const faultyRename = async (src, dest) => {
      const isBackup = dest.startsWith(backupRoot);
      if (isBackup) {
        return rename(src, dest);
      }
      placementAttempts++;
      if (placementAttempts === 1) {
        // First placement fails, triggering rollback.
        throw new Error('injected placement failure');
      }
      // Rollback renames also fail (backup -> original is not a backup path).
      throw new Error('injected rollback failure');
    };

    await assert.rejects(
      swapInCandidate(repoRoot, candidateRoot, backupRoot, { renameOp: faultyRename }),
      (err) => {
        assert.ok(err instanceof BaselineError, 'must be BaselineError');
        assert.equal(err.rollbackFailed, true, 'rollbackFailed must be true');
        assert.ok(err.backupPath, 'error must include backupPath');
        assert.match(err.message, /rollback/i, 'message must mention rollback');
        assert.match(err.message, /placement failure/i, 'message must include original error');
        return true;
      },
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline preserves a mapped user edit that appears before the destructive swap', async () => {
  const workspace = await makeTempDir('baseline-toctou');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);
    const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
    const lockBefore = await readFile(lockPath, 'utf8');
    const historyBefore = await readFile(
      path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'),
      'utf8',
    );
    const editedSkill = path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md');
    let statusReads = 0;

    await assert.rejects(
      applyBaseline({
        repoRoot,
        baseline: true,
        readGitStatus: async () => {
          statusReads += 1;
          if (statusReads === 2) {
            const transaction = JSON.parse(
              await readFile(
                path.join(repoRoot, '.git', '.skills-sync-transaction.json'),
                'utf8',
              ),
            );
            assert.equal(
              transaction.targets[0].phase,
              'moving-to-backup',
              'the final status check must run after durable swap intent and before the rename',
            );
            await writeFile(editedSkill, `${skillDoc('alpha', 'User edit during staging.')}\n`);
            return ' M skills/demo/alpha/SKILL.md\n';
          }
          return '';
        },
      }),
      (error) => error instanceof BaselineError && /changed while.*staging|clean/i.test(error.message),
    );

    assert.equal(statusReads, 2, 'the clean state must be checked again before swapping');
    assert.match(await readFile(editedSkill, 'utf8'), /User edit during staging\./);
    assert.equal(await readFile(lockPath, 'utf8'), lockBefore);
    assert.equal(
      await readFile(path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'), 'utf8'),
      historyBefore,
    );
    assert.equal(existsSync(path.join(repoRoot, '.git', '.skills-sync-apply.lock')), false);
    assert.equal(existsSync(path.join(repoRoot, '.git', '.skills-sync-transaction.json')), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline restores a user edit injected after the clean check and before candidate placement', async () => {
  const workspace = await makeTempDir('baseline-post-clean-check-edit');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);
    const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
    const historyPath = path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json');
    const editedSkill = path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md');
    const lockBefore = await readFile(lockPath, 'utf8');
    const historyBefore = await readFile(historyPath, 'utf8');

    await assert.rejects(
      applyBaseline({
        repoRoot,
        baseline: true,
        readGitStatus: cleanTree,
        afterCleanCheck: async () => {
          const transaction = JSON.parse(
            await readFile(path.join(repoRoot, '.git', '.skills-sync-transaction.json'), 'utf8'),
          );
          assert.match(
            transaction.targets[0].expectedSnapshot?.hash ?? '',
            /^sha256:/,
            'the durable journal must record the pre-swap expected snapshot',
          );
          await writeFile(editedSkill, skillDoc('alpha', 'Edit after the clean check.'));
        },
      }),
      (error) => error instanceof BaselineError && /backup.*(?:changed|expected|snapshot)/i.test(error.message),
    );

    assert.match(await readFile(editedSkill, 'utf8'), /Edit after the clean check\./);
    assert.equal(await readFile(lockPath, 'utf8'), lockBefore);
    assert.equal(await readFile(historyPath, 'utf8'), historyBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline restores a permission-only user edit injected after the clean check', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX mode bits are not a portable Windows permission signal');
    return;
  }

  const workspace = await makeTempDir('baseline-post-clean-check-mode');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);
    const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
    const editedSkill = path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md');
    const lockBefore = await readFile(lockPath, 'utf8');

    await assert.rejects(
      applyBaseline({
        repoRoot,
        baseline: true,
        readGitStatus: cleanTree,
        afterCleanCheck: async () => {
          await chmod(editedSkill, 0o755);
        },
      }),
      (error) => error instanceof BaselineError && /backup.*(?:changed|expected|snapshot)/i.test(error.message),
    );

    assert.equal((await stat(editedSkill)).mode & 0o777, 0o755);
    assert.equal(await readFile(lockPath, 'utf8'), lockBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline restores a user edit injected into the moved backup before candidate placement', async () => {
  const workspace = await makeTempDir('baseline-post-backup-edit');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);
    const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
    const historyPath = path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json');
    const lockBefore = await readFile(lockPath, 'utf8');
    const historyBefore = await readFile(historyPath, 'utf8');

    await assert.rejects(
      applyBaseline({
        repoRoot,
        baseline: true,
        readGitStatus: cleanTree,
        afterBackupMove: async (target) => {
          if (target.rel !== 'skills') return;
          await writeFile(
            path.join(target.backup, 'demo', 'alpha', 'SKILL.md'),
            skillDoc('alpha', 'Edit after backup rename.'),
          );
        },
      }),
      (error) => error instanceof BaselineError && /backup.*(?:changed|expected|snapshot)/i.test(error.message),
    );

    assert.match(
      await readFile(path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md'), 'utf8'),
      /Edit after backup rename\./,
    );
    assert.equal(await readFile(lockPath, 'utf8'), lockBefore);
    assert.equal(await readFile(historyPath, 'utf8'), historyBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline fails closed for a definitively stale same-host apply lock', async () => {
  const workspace = await makeTempDir('baseline-stale-lock');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);
    const lockPath = path.join(repoRoot, '.git', '.skills-sync-apply.lock');
    await writeFile(
      lockPath,
      `${JSON.stringify({
        version: 1,
        pid: 2147483647,
        hostname: hostname(),
        startedAt: '2026-02-02T00:00:00Z',
      })}\n`,
    );

    await assert.rejects(
      applyBaseline({
        repoRoot,
        baseline: true,
        readGitStatus: async () => ' M skills/demo/alpha/SKILL.md\n',
      }),
      (error) =>
        error instanceof BaselineError &&
        /another sync apply|remove the stale lock manually/i.test(error.message),
    );

    assert.equal(existsSync(lockPath), true, 'a stale lock must be reclaimed manually');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline refuses an active apply lock with recovery guidance', async () => {
  const workspace = await makeTempDir('baseline-active-lock');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);
    const lockPath = path.join(repoRoot, '.git', '.skills-sync-apply.lock');
    await writeFile(
      lockPath,
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        hostname: hostname(),
        startedAt: '2026-02-02T00:00:00Z',
      })}\n`,
    );

    await assert.rejects(
      applyBaseline({ repoRoot, baseline: true, readGitStatus: cleanTree }),
      (error) => error instanceof BaselineError && /another sync apply|stale lock/i.test(error.message),
    );
    assert.equal(existsSync(lockPath), true, 'an active lock must never be removed');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Defect 2: one-time baseline guards
// ---------------------------------------------------------------------------

test('applyBaseline refuses when lock.release is not 1.0.0 (already past bootstrap)', async () => {
  const workspace = await makeTempDir('baseline-noboot');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);

    // Tamper with the lock to simulate a post-baseline state.
    const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    lock.release = '1.1.0';
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    await assert.rejects(
      applyBaseline({ repoRoot, baseline: true, readGitStatus: cleanTree }),
      (error) => error instanceof BaselineError && /already|one-time|established/i.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline refuses when any mapped skill is already verified', async () => {
  const workspace = await makeTempDir('baseline-verified');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);

    const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const alpha = lock.skills.find((s) => s.path === 'skills/demo/alpha');
    alpha.baseline = 'verified';
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    await assert.rejects(
      applyBaseline({ repoRoot, baseline: true, readGitStatus: cleanTree }),
      (error) => error instanceof BaselineError && /already|verified/i.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline refuses when history already contains a baseline-verified entry', async () => {
  const workspace = await makeTempDir('baseline-hist');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);

    // Add a baseline-verified entry to one history file.
    const historyPath = path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json');
    const history = JSON.parse(await readFile(historyPath, 'utf8'));
    history.entries.push({
      release: '1.1.0',
      kind: 'baseline-verified',
      version: '1.1.0',
      upstreamCommit: 'a'.repeat(40),
      diffUrl: null,
      contentHash: 'sha256:up-alpha',
    });
    await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`);

    await assert.rejects(
      applyBaseline({ repoRoot, baseline: true, readGitStatus: cleanTree }),
      (error) => error instanceof BaselineError && /already|established/i.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline refuses when target tag v1.1.0 already exists', async () => {
  const workspace = await makeTempDir('baseline-tag');
  try {
    const { repoRoot } = await buildBaselineFixture(workspace);

    // runGit that reports v1.1.0 tag exists.
    const fakeRunGit = async (args) => {
      if (args[0] === 'tag' && args[1] === '--list') {
        return 'v1.1.0\n';
      }
      return '';
    };

    await assert.rejects(
      applyBaseline({ repoRoot, baseline: true, readGitStatus: cleanTree, runGit: fakeRunGit }),
      (error) => error instanceof BaselineError && /already|tag|exist/i.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Finding 4: protected-root guard must also run in the APPLY engine
//
// The lock-based `local` defense is inert when the manifest drops its `local`
// declaration and the lock carries no local entry (the real repository has
// zero local skills today), so the guard must be derived from the manifest
// plus the always-protected root and run before any clone or write.
// ---------------------------------------------------------------------------

async function makeMaliciousBaselineFixture(workspace) {
  const { upstream, repoRoot } = await buildBaselineFixture(workspace);

  // Re-declare the existing local skill as a MAPPED destination and drop the
  // `local:` declaration entirely.
  await writeFileEnsured(
    path.join(repoRoot, 'catalog', 'sources.yml'),
    [
      'upstreams:',
      '  demo:',
      `    repository: "${upstream.url}"`,
      '    reference: refs/heads/main',
      'mappings:',
      '  - path: skills/demo/alpha',
      '    upstream: demo',
      '    source: skills/alpha',
      '  - path: skills/demo/beta',
      '    upstream: demo',
      '    source: skills/beta',
      '  - path: skills/lettucebo/local-skill',
      '    upstream: demo',
      '    source: skills/alpha',
      'orphans:',
      '  - path: skills/orphans/gamma',
      'local: []',
      'overrides: []',
      'linkExceptions: []',
      '',
    ].join('\n'),
  );

  // Drop the local lock entry so the lock-based defense cannot fire either.
  const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.skills = lock.skills.filter((skill) => skill.category !== 'local');
  lock.counts = { total: 3, mapped: 2, orphan: 1, local: 0 };
  await writeFileEnsured(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  return { upstream, repoRoot };
}

test('applyBaseline refuses a mapping into the reserved local root before any clone or write', async () => {
  const workspace = await makeTempDir('baseline-protected');
  try {
    const { repoRoot } = await makeMaliciousBaselineFixture(workspace);

    const skillsBefore = await hashDirectory(path.join(repoRoot, 'skills'));
    const localBefore = await hashDirectory(
      path.join(repoRoot, 'skills', 'lettucebo', 'local-skill'),
    );
    const lockBefore = await readFile(
      path.join(repoRoot, 'catalog', 'skills.lock.json'),
      'utf8',
    );

    const gitCalls = [];
    const runGit = async (args) => {
      gitCalls.push(args);
      return '';
    };

    await assert.rejects(
      applyBaseline({ repoRoot, baseline: true, readGitStatus: cleanTree, runGit }),
      (error) => /protected root/i.test(error.message) && /lettucebo/.test(error.message),
    );

    assert.equal(
      gitCalls.some((args) => args[0] === 'clone'),
      false,
      'the baseline must fail before any upstream clone',
    );
    assert.equal(await hashDirectory(path.join(repoRoot, 'skills')), skillsBefore);
    assert.equal(
      await hashDirectory(path.join(repoRoot, 'skills', 'lettucebo', 'local-skill')),
      localBefore,
    );
    assert.equal(
      await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
      lockBefore,
    );
    assert.deepEqual(
      (await readdir(repoRoot)).filter((name) => name.startsWith('.baseline-work-')),
      [],
      'no staging work directory may be left behind',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyBaseline refuses a mapping onto the reserved root itself', async () => {
  const workspace = await makeTempDir('baseline-protected-root');
  try {
    const { upstream, repoRoot } = await buildBaselineFixture(workspace);

    // The reserved root becomes a skill of its own and the local declaration
    // plus the local lock entry are both removed.
    await rm(path.join(repoRoot, 'skills', 'lettucebo', 'local-skill'), {
      recursive: true,
      force: true,
    });
    await writeFileEnsured(
      path.join(repoRoot, 'skills', 'lettucebo', 'SKILL.md'),
      skillDoc('lettucebo-root'),
    );
    await writeFileEnsured(
      path.join(repoRoot, 'catalog', 'sources.yml'),
      [
        'upstreams:',
        '  demo:',
        `    repository: "${upstream.url}"`,
        '    reference: refs/heads/main',
        'mappings:',
        '  - path: skills/demo/alpha',
        '    upstream: demo',
        '    source: skills/alpha',
        '  - path: skills/demo/beta',
        '    upstream: demo',
        '    source: skills/beta',
        '  - path: skills/lettucebo',
        '    upstream: demo',
        '    source: skills/alpha',
        'orphans:',
        '  - path: skills/orphans/gamma',
        'local: []',
        'overrides: []',
        'linkExceptions: []',
        '',
      ].join('\n'),
    );

    const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    lock.skills = lock.skills.filter((skill) => skill.category !== 'local');
    lock.counts = { total: 3, mapped: 2, orphan: 1, local: 0 };
    await writeFileEnsured(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const rootBefore = await hashDirectory(path.join(repoRoot, 'skills', 'lettucebo'));

    await assert.rejects(
      applyBaseline({ repoRoot, baseline: true, readGitStatus: cleanTree }),
      (error) => /protected root/i.test(error.message) && /lettucebo/.test(error.message),
    );

    assert.equal(
      await hashDirectory(path.join(repoRoot, 'skills', 'lettucebo')),
      rootBefore,
      'the reserved root must be byte-for-byte unchanged',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
