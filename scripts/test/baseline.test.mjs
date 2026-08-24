import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { hashDirectory } from '../lib/hash.mjs';
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
    ['skills/demo/alpha', { commit: 'a'.repeat(40), contentHash: 'sha256:up-alpha', snapshotHash: 'sha256:new-alpha' }],
    ['skills/demo/beta', { commit: 'b'.repeat(40), contentHash: 'sha256:up-beta', snapshotHash: 'sha256:new-beta' }],
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

test('buildVerifiedLock refuses when a mapped skill is not staged', () => {
  const staged = new Map([
    ['skills/demo/alpha', { commit: 'a'.repeat(40), contentHash: 'sha256:up-alpha', snapshotHash: 'sha256:new-alpha' }],
  ]);

  assert.throws(
    () => buildVerifiedLock({ lock: baseLock(), staged, release: '1.1.0', generatedAt: 'x' }),
    (error) => error instanceof BaselineError && /skills\/demo\/beta/.test(error.message),
  );
});

test('buildVerifiedLock refuses when staged contains an unmapped path', () => {
  const staged = new Map([
    ['skills/demo/alpha', { commit: 'a'.repeat(40), contentHash: 'sha256:up-alpha', snapshotHash: 'sha256:new-alpha' }],
    ['skills/demo/beta', { commit: 'b'.repeat(40), contentHash: 'sha256:up-beta', snapshotHash: 'sha256:new-beta' }],
    ['skills/demo/ghost', { commit: 'c'.repeat(40), contentHash: 'sha256:x', snapshotHash: 'sha256:y' }],
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

async function buildBaselineFixture(workspace, { alphaUpstreamBody } = {}) {
  const upstream = await initUpstreamRepo(path.join(workspace, 'upstream'), {
    'skills/alpha/SKILL.md': skillDoc('alpha', alphaUpstreamBody ?? 'Upstream alpha body.'),
    'skills/alpha/references/notes.md': '# alpha notes\n',
    'skills/beta/SKILL.md': skillDoc('beta', 'Upstream beta body.'),
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

  return { upstream, repoRoot };
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
      },
    ],
    [
      'skills/demo/beta',
      {
        commit: 'b'.repeat(40),
        contentHash: 'sha256:up-beta',
        snapshotHash: 'sha256:new-beta',
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
  await writeFileEnsured(path.join(repoRoot, 'catalog', 'skills.lock.json'), '{"release":"1.0.0"}');
  await writeFileEnsured(path.join(repoRoot, 'NOTICE'), '# NOTICE\noriginal\n');
  await writeFileEnsured(path.join(repoRoot, 'README.md'), '# README\noriginal\n');

  // Create the candidate files (different content).
  await writeFileEnsured(path.join(candidateRoot, 'skills', 'demo', 'alpha', 'SKILL.md'), skillDoc('alpha-candidate'));
  await writeFileEnsured(path.join(candidateRoot, 'catalog', 'history', 'alpha.json'), '{"path":"alpha-candidate"}');
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

  return { repoRoot, candidateRoot, backupRoot, originalHashes };
}

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
