import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { hashDirectory } from '../lib/hash.mjs';
import {
  applyUpdate,
  buildUpdateLock,
  BaselineError,
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

async function updateUpstreamRepo(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    await writeFileEnsured(path.join(root, relativePath), content);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'update']);
  return git(root, ['rev-parse', 'HEAD']).trim();
}

const cleanTree = async () => '';

/**
 * Builds a fixture where the lock is already at a verified baseline state
 * (as required by applyUpdate).
 *
 * `extraSkills` adds N additional mapped skills to the same upstream group so
 * deletion-guard thresholds (which only bite at a declared size of ten or more)
 * can be exercised.
 */
async function buildUpdateFixture(workspace, { alphaBody, betaBody, extraSkills = 0 } = {}) {
  const extraNames = Array.from({ length: extraSkills }, (_, index) =>
    `extra${String(index + 1).padStart(2, '0')}`,
  );

  const upstreamRoot = path.join(workspace, 'upstream');
  const upstream = await initUpstreamRepo(upstreamRoot, {
    'skills/alpha/SKILL.md': skillDoc('alpha', alphaBody ?? 'Alpha upstream body.'),
    'skills/alpha/references/notes.md': '# alpha notes\n',
    'skills/beta/SKILL.md': skillDoc('beta', betaBody ?? 'Beta upstream body.'),
    ...Object.fromEntries(
      extraNames.map((name) => [`skills/${name}/SKILL.md`, skillDoc(name)]),
    ),
  });

  const repoRoot = path.join(workspace, 'repo');

  // Create a repo with git and a v1.1.0 tag so planRelease can find it.
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'fixture@example.com']);
  git(repoRoot, ['config', 'user.name', 'Fixture']);

  // Mapped skills (vendored content matching upstream — verified baseline).
  await writeFileEnsured(
    path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md'),
    skillDoc('alpha', alphaBody ?? 'Alpha upstream body.'),
  );
  await writeFileEnsured(
    path.join(repoRoot, 'skills', 'demo', 'alpha', 'references', 'notes.md'),
    '# alpha notes\n',
  );
  await writeFileEnsured(
    path.join(repoRoot, 'skills', 'demo', 'beta', 'SKILL.md'),
    skillDoc('beta', betaBody ?? 'Beta upstream body.'),
  );

  for (const name of extraNames) {
    await writeFileEnsured(
      path.join(repoRoot, 'skills', 'demo', name, 'SKILL.md'),
      skillDoc(name),
    );
  }

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
      ...extraNames.flatMap((name) => [
        `  - path: skills/demo/${name}`,
        '    upstream: demo',
        `    source: skills/${name}`,
      ]),
      'orphans:',
      '  - path: skills/orphans/gamma',
      'local:',
      '  - root: skills/lettucebo',
      'overrides: []',
      'linkExceptions: []',
      '',
    ].join('\n'),
  );

  // Hash the upstream directories to get the contentHash (pre-stamp).
  const alphaContentHash = await hashDirectory(path.join(upstreamRoot, 'skills', 'alpha'));
  const betaContentHash = await hashDirectory(path.join(upstreamRoot, 'skills', 'beta'));

  // Vendored hashes (post-stamp, but in the fixture we don't stamp, so same as content).
  const alphaSnapshotHash = await hashDirectory(path.join(repoRoot, 'skills', 'demo', 'alpha'));
  const betaSnapshotHash = await hashDirectory(path.join(repoRoot, 'skills', 'demo', 'beta'));
  const gammaHash = await hashDirectory(path.join(repoRoot, 'skills', 'orphans', 'gamma'));
  const localHash = await hashDirectory(path.join(repoRoot, 'skills', 'lettucebo', 'local-skill'));

  const extraEntries = [];
  for (const name of extraNames) {
    extraEntries.push({
      path: `skills/demo/${name}`,
      name,
      category: 'mapped',
      version: '1.1.0',
      baseline: 'verified',
      license: 'Unknown',
      redistributable: true,
      snapshotHash: await hashDirectory(path.join(repoRoot, 'skills', 'demo', name)),
      contentHash: await hashDirectory(path.join(upstreamRoot, 'skills', name)),
      upstream: {
        repository: upstream.url,
        reference: 'refs/heads/main',
        source: `skills/${name}`,
        commit: upstream.commit,
      },
    });
  }

  const skills = [
    {
      path: 'skills/demo/alpha',
      name: 'alpha',
      category: 'mapped',
      version: '1.1.0',
      baseline: 'verified',
      license: 'Unknown',
      redistributable: true,
      snapshotHash: alphaSnapshotHash,
      contentHash: alphaContentHash,
      upstream: {
        repository: upstream.url,
        reference: 'refs/heads/main',
        source: 'skills/alpha',
        commit: upstream.commit,
      },
    },
    {
      path: 'skills/demo/beta',
      name: 'beta',
      category: 'mapped',
      version: '1.1.0',
      baseline: 'verified',
      license: 'Unknown',
      redistributable: true,
      snapshotHash: betaSnapshotHash,
      contentHash: betaContentHash,
      upstream: {
        repository: upstream.url,
        reference: 'refs/heads/main',
        source: 'skills/beta',
        commit: upstream.commit,
      },
    },
    ...extraEntries,
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
  ].sort((a, b) => (a.path < b.path ? -1 : 1));

  await writeFileEnsured(
    path.join(repoRoot, 'catalog', 'skills.lock.json'),
    `${JSON.stringify(
      {
        release: '1.1.0',
        generatedAt: '2026-02-02T00:00:00Z',
        counts: {
          total: 4 + extraNames.length,
          mapped: 2 + extraNames.length,
          orphan: 1,
          local: 1,
        },
        skills,
      },
      null,
      2,
    )}\n`,
  );

  for (const skill of skills) {
    const entries = [
      {
        release: '1.0.0',
        kind: 'bootstrap',
        version: '1.0.0',
        firstSeen: '2026-01-01T00:00:00Z',
        upstreamCommit: null,
        diffUrl: null,
        snapshotHash: skill.snapshotHash,
      },
    ];

    if (skill.category === 'mapped') {
      entries.push({
        release: '1.1.0',
        kind: 'baseline-verified',
        version: '1.1.0',
        upstreamCommit: upstream.commit,
        diffUrl: null,
        contentHash: skill.contentHash,
      });
    }

    await writeFileEnsured(
      path.join(repoRoot, 'catalog', 'history', `${skill.path.replace(/\//g, '__')}.json`),
      `${JSON.stringify(
        {
          path: skill.path,
          name: skill.name,
          category: skill.category,
          entries,
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

  // Initial commit + v1.1.0 tag for planRelease.
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-q', '-m', 'initial verified baseline']);
  git(repoRoot, ['tag', '-a', 'v1.1.0', '-m', 'baseline']);

  return { upstream, upstreamRoot, repoRoot };
}

// Stub runGit that reads tags from the fixture repo.
function makeRunGit(repoRoot) {
  return (args) => {
    const result = execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
    return result;
  };
}

// ---------------------------------------------------------------------------
// buildUpdateLock (pure)
// ---------------------------------------------------------------------------

function verifiedLock() {
  return {
    release: '1.1.0',
    generatedAt: '2026-02-02T00:00:00Z',
    counts: { total: 3, mapped: 2, orphan: 1, local: 0 },
    skills: [
      {
        path: 'skills/demo/alpha',
        name: 'alpha',
        category: 'mapped',
        version: '1.1.0',
        baseline: 'verified',
        license: 'Unknown',
        redistributable: true,
        snapshotHash: 'sha256:snap-alpha',
        contentHash: 'sha256:content-alpha',
        upstream: {
          repository: 'demo/upstream',
          reference: 'refs/heads/main',
          source: 'skills/alpha',
          commit: 'a'.repeat(40),
        },
      },
      {
        path: 'skills/demo/beta',
        name: 'beta',
        category: 'mapped',
        version: '1.1.0',
        baseline: 'verified',
        license: 'Unknown',
        redistributable: true,
        snapshotHash: 'sha256:snap-beta',
        contentHash: 'sha256:content-beta',
        upstream: {
          repository: 'demo/upstream',
          reference: 'refs/heads/main',
          source: 'skills/beta',
          commit: 'b'.repeat(40),
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

test('buildUpdateLock bumps only changed skills and leaves others untouched', () => {
  const staged = new Map([
    [
      'skills/demo/alpha',
      {
        commit: 'c'.repeat(40),
        contentHash: 'sha256:new-alpha',
        snapshotHash: 'sha256:new-snap-alpha',
        name: 'alpha',
        repository: 'migrated/upstream',
        reference: 'refs/tags/v2',
        source: 'new-layout/alpha',
      },
    ],
    ['skills/demo/beta', { commit: 'd'.repeat(40), contentHash: 'sha256:new-beta', snapshotHash: 'sha256:new-snap-beta' }],
  ]);

  const lock = buildUpdateLock({
    lock: verifiedLock(),
    staged,
    changedPaths: ['skills/demo/alpha'],
    release: '1.1.1',
    generatedAt: '2026-03-03T00:00:00Z',
  });

  assert.equal(lock.release, '1.1.1');

  const alpha = lock.skills.find((s) => s.path === 'skills/demo/alpha');
  assert.equal(alpha.version, '1.1.1');
  assert.equal(alpha.contentHash, 'sha256:new-alpha');
  assert.equal(alpha.snapshotHash, 'sha256:new-snap-alpha');
  assert.deepEqual(alpha.upstream, {
    repository: 'migrated/upstream',
    reference: 'refs/tags/v2',
    source: 'new-layout/alpha',
    commit: 'c'.repeat(40),
  });

  // Unchanged mapped skill stays exactly as before.
  const beta = lock.skills.find((s) => s.path === 'skills/demo/beta');
  assert.equal(beta.version, '1.1.0');
  assert.equal(beta.contentHash, 'sha256:content-beta');
  assert.equal(beta.snapshotHash, 'sha256:snap-beta');
  assert.equal(beta.upstream.commit, 'b'.repeat(40));

  // Orphan is completely untouched.
  const gamma = lock.skills.find((s) => s.path === 'skills/demo/gamma');
  assert.equal(gamma.version, '1.0.0');
  assert.equal(gamma.upstream, null);
});

// ---------------------------------------------------------------------------
// applyUpdate (fixture integration)
// ---------------------------------------------------------------------------

test('applyUpdate returns no-op when upstream has not changed', async () => {
  const workspace = await makeTempDir('update-noop');
  try {
    const { repoRoot } = await buildUpdateFixture(workspace);

    const skillsBefore = await hashDirectory(path.join(repoRoot, 'skills'));
    const lockBefore = await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8');

    const result = await applyUpdate({
      repoRoot,
      readGitStatus: cleanTree,
      runGit: makeRunGit(repoRoot),
    });

    assert.equal(result.applied, false);
    assert.deepEqual(result.changed, []);
    assert.equal(result.release, null);
    assert.equal(result.nextTag, null);
    assert.equal(result.commitMessage, null);

    // Filesystem unchanged.
    assert.equal(await hashDirectory(path.join(repoRoot, 'skills')), skillsBefore);
    assert.equal(await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'), lockBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyUpdate treats a reference-only migration with identical content as an update', async () => {
  const workspace = await makeTempDir('update-reference-migration');
  try {
    const { upstream, upstreamRoot, repoRoot } = await buildUpdateFixture(workspace);
    git(upstreamRoot, ['branch', 'legacy']);

    const sourcesPath = path.join(repoRoot, 'catalog', 'sources.yml');
    const sources = await readFile(sourcesPath, 'utf8');
    await writeFile(
      sourcesPath,
      sources.replace('reference: refs/heads/main', 'reference: refs/heads/legacy'),
    );
    git(repoRoot, ['add', '-A']);
    git(repoRoot, ['commit', '-q', '-m', 'manifest: migrate reference']);

    const result = await applyUpdate({
      repoRoot,
      readGitStatus: cleanTree,
      now: () => '2026-03-03T00:00:00Z',
      runGit: makeRunGit(repoRoot),
    });

    assert.equal(result.applied, true);
    assert.deepEqual(result.changed, ['skills/demo/alpha', 'skills/demo/beta']);
    const lock = JSON.parse(await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'));
    const alpha = lock.skills.find((skill) => skill.path === 'skills/demo/alpha');
    assert.deepEqual(alpha.upstream, {
      repository: upstream.url,
      reference: 'refs/heads/legacy',
      source: 'skills/alpha',
      commit: upstream.commit,
    });
    assert.equal(alpha.contentHash, await hashDirectory(path.join(upstreamRoot, 'skills', 'alpha')));

    const stamped = await readFile(path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md'), 'utf8');
    assert.match(stamped, new RegExp(`x-source: ${upstream.url}`));
    assert.match(stamped, /x-source-path: skills\/alpha/);
    assert.match(stamped, new RegExp(`x-source-commit: ${upstream.commit}`));
    assert.match(stamped, /x-version: 1\.1\.1/);

    const history = JSON.parse(
      await readFile(path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'), 'utf8'),
    );
    assert.equal(history.entries.at(-1).upstreamCommit, upstream.commit);
    assert.ok(history.entries.at(-1).diffUrl, 'a same-repository migration retains a compare URL');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyUpdate migrates repository and source with identical content without a cross-repository diff URL', async () => {
  const workspace = await makeTempDir('update-repository-source-migration');
  try {
    const { upstream, repoRoot } = await buildUpdateFixture(workspace);
    const migrated = await initUpstreamRepo(path.join(workspace, 'migrated-upstream'), {
      'new-layout/alpha/SKILL.md': skillDoc('alpha', 'Alpha upstream body.'),
      'new-layout/alpha/references/notes.md': '# alpha notes\n',
      'new-layout/beta/SKILL.md': skillDoc('beta', 'Beta upstream body.'),
    });
    const lockBeforeMigration = JSON.parse(
      await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
    );
    assert.equal(
      await hashDirectory(path.join(workspace, 'migrated-upstream', 'new-layout', 'alpha')),
      lockBeforeMigration.skills.find((skill) => skill.path === 'skills/demo/alpha').contentHash,
      'the repository/source migration fixture must preserve alpha content bytes',
    );

    const sourcesPath = path.join(repoRoot, 'catalog', 'sources.yml');
    const sources = await readFile(sourcesPath, 'utf8');
    await writeFile(
      sourcesPath,
      sources
        .replace(`repository: "${upstream.url}"`, `repository: "${migrated.url}"`)
        .replace('source: skills/alpha', 'source: new-layout/alpha')
        .replace('source: skills/beta', 'source: new-layout/beta'),
    );
    git(repoRoot, ['add', '-A']);
    git(repoRoot, ['commit', '-q', '-m', 'manifest: migrate repository and source']);

    const result = await applyUpdate({
      repoRoot,
      readGitStatus: cleanTree,
      now: () => '2026-03-03T00:00:00Z',
      runGit: makeRunGit(repoRoot),
    });

    assert.equal(result.applied, true);
    const lock = JSON.parse(await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'));
    const alpha = lock.skills.find((skill) => skill.path === 'skills/demo/alpha');
    assert.deepEqual(alpha.upstream, {
      repository: migrated.url,
      reference: 'refs/heads/main',
      source: 'new-layout/alpha',
      commit: migrated.commit,
    });
    const stamped = await readFile(path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md'), 'utf8');
    assert.match(stamped, new RegExp(`x-source: ${migrated.url}`));
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

test('applyUpdate leaves every target untouched when a tuple-only migration fails validation', async () => {
  const workspace = await makeTempDir('update-tuple-migration-rollback');
  try {
    const { upstream, repoRoot } = await buildUpdateFixture(workspace);
    const migrated = await initUpstreamRepo(path.join(workspace, 'migrated-upstream'), {
      'new-layout/alpha/SKILL.md': skillDoc('alpha', 'Alpha upstream body.'),
      'new-layout/alpha/references/notes.md': '# alpha notes\n',
      'new-layout/beta/SKILL.md': skillDoc('beta', 'Beta upstream body.'),
    });
    const lockBeforeMigration = JSON.parse(
      await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
    );
    assert.equal(
      await hashDirectory(path.join(workspace, 'migrated-upstream', 'new-layout', 'alpha')),
      lockBeforeMigration.skills.find((skill) => skill.path === 'skills/demo/alpha').contentHash,
      'the rollback fixture must exercise a tuple-only migration',
    );

    const sourcesPath = path.join(repoRoot, 'catalog', 'sources.yml');
    const sources = await readFile(sourcesPath, 'utf8');
    await writeFile(
      sourcesPath,
      sources
        .replace(`repository: "${upstream.url}"`, `repository: "${migrated.url}"`)
        .replace('source: skills/alpha', 'source: new-layout/alpha')
        .replace('source: skills/beta', 'source: new-layout/beta'),
    );
    git(repoRoot, ['add', '-A']);
    git(repoRoot, ['commit', '-q', '-m', 'manifest: migrate repository and source']);

    const skillsBefore = await hashDirectory(path.join(repoRoot, 'skills'));
    const lockBefore = await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8');
    const historyBefore = await readFile(
      path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'),
      'utf8',
    );
    const noticeBefore = await readFile(path.join(repoRoot, 'NOTICE'), 'utf8');
    const readmeBefore = await readFile(path.join(repoRoot, 'README.md'), 'utf8');

    await assert.rejects(
      applyUpdate({
        repoRoot,
        readGitStatus: cleanTree,
        runGit: makeRunGit(repoRoot),
        validate: async () => {
          throw new Error('injected tuple migration validation failure');
        },
      }),
      (error) => error instanceof BaselineError && /validation/i.test(error.message),
    );

    assert.equal(await hashDirectory(path.join(repoRoot, 'skills')), skillsBefore);
    assert.equal(await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'), lockBefore);
    assert.equal(
      await readFile(path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'), 'utf8'),
      historyBefore,
    );
    assert.equal(await readFile(path.join(repoRoot, 'NOTICE'), 'utf8'), noticeBefore);
    assert.equal(await readFile(path.join(repoRoot, 'README.md'), 'utf8'), readmeBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyUpdate detects upstream changes, updates lock and history for changed skills only', async () => {
  const workspace = await makeTempDir('update-changed');
  try {
    const { upstream, upstreamRoot, repoRoot } = await buildUpdateFixture(workspace);
    const previousCommit = upstream.commit;

    // Change only alpha upstream.
    const newCommit = await updateUpstreamRepo(upstreamRoot, {
      'skills/alpha/SKILL.md': skillDoc('alpha', 'Alpha updated body.'),
    });

    // Capture pre-apply state for unchanged skills.
    const betaHistoryBefore = await readFile(
      path.join(repoRoot, 'catalog', 'history', 'skills__demo__beta.json'),
      'utf8',
    );
    const gammaHistoryBefore = await readFile(
      path.join(repoRoot, 'catalog', 'history', 'skills__orphans__gamma.json'),
      'utf8',
    );
    const localHistoryBefore = await readFile(
      path.join(repoRoot, 'catalog', 'history', 'skills__lettucebo__local-skill.json'),
      'utf8',
    );

    const result = await applyUpdate({
      repoRoot,
      readGitStatus: cleanTree,
      now: () => '2026-03-03T00:00:00Z',
      runGit: makeRunGit(repoRoot),
    });

    assert.equal(result.applied, true);
    assert.deepEqual(result.changed, ['skills/demo/alpha']);
    assert.equal(result.release, '1.1.1');
    assert.equal(result.nextTag, 'v1.1.1');
    assert.equal(result.commitMessage, 'fix(skills): sync upstream updates');

    // Lock updated.
    const lock = JSON.parse(await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'));
    assert.equal(lock.release, '1.1.1');

    const alpha = lock.skills.find((s) => s.path === 'skills/demo/alpha');
    assert.equal(alpha.version, '1.1.1');
    assert.equal(alpha.baseline, 'verified');
    assert.equal(alpha.upstream.commit, newCommit);

    // Beta unchanged.
    const beta = lock.skills.find((s) => s.path === 'skills/demo/beta');
    assert.equal(beta.version, '1.1.0');
    assert.equal(beta.upstream.commit, previousCommit);

    // Orphan + local untouched in lock.
    const gamma = lock.skills.find((s) => s.path === 'skills/orphans/gamma');
    assert.equal(gamma.upstream, null);

    // Alpha history has exactly one new entry.
    const alphaHistory = JSON.parse(
      await readFile(path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'), 'utf8'),
    );
    assert.equal(alphaHistory.entries.length, 3);
    assert.equal(alphaHistory.entries[0].kind, 'bootstrap');
    assert.equal(alphaHistory.entries[1].kind, 'baseline-verified');
    assert.equal(alphaHistory.entries[2].kind, 'upstream-update');
    assert.equal(alphaHistory.entries[2].version, '1.1.1');
    assert.equal(alphaHistory.entries[2].upstreamCommit, newCommit);
    assert.ok(alphaHistory.entries[2].diffUrl.includes(previousCommit));
    assert.ok(alphaHistory.entries[2].diffUrl.includes(newCommit));

    // Unchanged skills' history is byte-identical.
    assert.equal(
      await readFile(path.join(repoRoot, 'catalog', 'history', 'skills__demo__beta.json'), 'utf8'),
      betaHistoryBefore,
    );
    assert.equal(
      await readFile(path.join(repoRoot, 'catalog', 'history', 'skills__orphans__gamma.json'), 'utf8'),
      gammaHistoryBefore,
    );
    assert.equal(
      await readFile(path.join(repoRoot, 'catalog', 'history', 'skills__lettucebo__local-skill.json'), 'utf8'),
      localHistoryBefore,
    );

    // NOTICE and README regenerated.
    const notice = await readFile(path.join(repoRoot, 'NOTICE'), 'utf8');
    assert.match(notice, /# NOTICE/);
    const readme = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
    assert.match(readme, /<!-- CATALOG:START -->/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyUpdate never writes orphan or local paths', async () => {
  const workspace = await makeTempDir('update-protect');
  try {
    const { upstreamRoot, repoRoot } = await buildUpdateFixture(workspace);

    // Change upstream so the update is not a no-op.
    await updateUpstreamRepo(upstreamRoot, {
      'skills/alpha/SKILL.md': skillDoc('alpha', 'Changed alpha.'),
    });

    const orphanBefore = await hashDirectory(path.join(repoRoot, 'skills', 'orphans', 'gamma'));
    const localBefore = await hashDirectory(path.join(repoRoot, 'skills', 'lettucebo', 'local-skill'));

    await applyUpdate({
      repoRoot,
      readGitStatus: cleanTree,
      runGit: makeRunGit(repoRoot),
    });

    assert.equal(await hashDirectory(path.join(repoRoot, 'skills', 'orphans', 'gamma')), orphanBefore);
    assert.equal(await hashDirectory(path.join(repoRoot, 'skills', 'lettucebo', 'local-skill')), localBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyUpdate refuses when working tree is dirty', async () => {
  const workspace = await makeTempDir('update-dirty');
  try {
    const { repoRoot } = await buildUpdateFixture(workspace);

    await assert.rejects(
      applyUpdate({
        repoRoot,
        readGitStatus: async () => ' M skills/demo/alpha/SKILL.md\n',
        runGit: makeRunGit(repoRoot),
      }),
      (error) => error instanceof BaselineError && /clean/i.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyUpdate refuses when any mapped skill is still unverified', async () => {
  const workspace = await makeTempDir('update-unverified');
  try {
    const { repoRoot } = await buildUpdateFixture(workspace);

    // Tamper with the lock to mark one skill as unverified.
    const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const alpha = lock.skills.find((s) => s.path === 'skills/demo/alpha');
    alpha.baseline = 'unverified';
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    await assert.rejects(
      applyUpdate({
        repoRoot,
        readGitStatus: cleanTree,
        runGit: makeRunGit(repoRoot),
      }),
      (error) => error instanceof BaselineError && /verified/i.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyUpdate refuses when an upstream is unavailable (never treats as deletion)', async () => {
  const workspace = await makeTempDir('update-unavail');
  try {
    const { repoRoot } = await buildUpdateFixture(workspace);

    // Point the manifest at a non-existent upstream repository.
    const bogus = pathToFileURL(path.join(workspace, 'nope', 'missing')).href;
    const sourcesPath = path.join(repoRoot, 'catalog', 'sources.yml');
    const sources = await readFile(sourcesPath, 'utf8');
    await writeFile(
      sourcesPath,
      sources.replace(/repository: ".*"/, `repository: "${bogus}"`),
    );

    const before = await hashDirectory(path.join(repoRoot, 'skills'));
    const lockBefore = await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8');

    await assert.rejects(
      applyUpdate({
        repoRoot,
        readGitStatus: cleanTree,
        runGit: makeRunGit(repoRoot),
      }),
      (error) => error instanceof BaselineError && /unavailable/i.test(error.message),
    );

    // No filesystem mutation.
    assert.equal(await hashDirectory(path.join(repoRoot, 'skills')), before);
    assert.equal(await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'), lockBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyUpdate rejects upstream symbolic links without mutating the repository', async (t) => {
  const workspace = await makeTempDir('update-symbolic-link');
  try {
    const { upstreamRoot, repoRoot } = await buildUpdateFixture(workspace);
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
    const historyBefore = await readFile(
      path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'),
      'utf8',
    );

    await assert.rejects(
      applyUpdate({ repoRoot, readGitStatus: cleanTree, runGit: makeRunGit(repoRoot) }),
      /symbolic link.*linked-skill\.md/i,
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

test('applyUpdate rolls back completely when post-apply validation fails', async () => {
  const workspace = await makeTempDir('update-rollback');
  try {
    const { upstreamRoot, repoRoot } = await buildUpdateFixture(workspace);

    // Change upstream so the update is not a no-op.
    await updateUpstreamRepo(upstreamRoot, {
      'skills/alpha/SKILL.md': skillDoc('alpha', 'Changed for rollback test.'),
    });

    const skillsBefore = await hashDirectory(path.join(repoRoot, 'skills'));
    const lockBefore = await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8');
    const historyBefore = await readFile(
      path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'),
      'utf8',
    );
    const noticeBefore = await readFile(path.join(repoRoot, 'NOTICE'), 'utf8');
    const readmeBefore = await readFile(path.join(repoRoot, 'README.md'), 'utf8');

    await assert.rejects(
      applyUpdate({
        repoRoot,
        readGitStatus: cleanTree,
        runGit: makeRunGit(repoRoot),
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
      await readFile(path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'), 'utf8'),
      historyBefore,
    );
    assert.equal(await readFile(path.join(repoRoot, 'NOTICE'), 'utf8'), noticeBefore);
    assert.equal(await readFile(path.join(repoRoot, 'README.md'), 'utf8'), readmeBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI flag rejection tests
// ---------------------------------------------------------------------------

test('--apply combined with --dry-run is rejected by the CLI', async () => {
  const workspace = await makeTempDir('cli-apply-dry');
  try {
    // We test the parseArgs + main logic by importing and calling main-like behavior.
    // Instead, test via child process to exercise the actual CLI.
    const repoRoot = path.join(workspace, 'repo');
    await mkdir(repoRoot, { recursive: true });

    let threw = false;
    try {
      execFileSync(
        process.execPath,
        [path.resolve(__dirname, '..', 'sync.mjs'), '--apply', '--dry-run'],
        { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (error) {
      threw = true;
      assert.match(error.stderr, /--apply cannot be combined with --dry-run/);
    }
    assert.ok(threw, 'Expected CLI to reject --apply --dry-run');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('--apply combined with --baseline is rejected by the CLI', async () => {
  const workspace = await makeTempDir('cli-apply-baseline');
  try {
    const repoRoot = path.join(workspace, 'repo');
    await mkdir(repoRoot, { recursive: true });

    let threw = false;
    try {
      execFileSync(
        process.execPath,
        [path.resolve(__dirname, '..', 'sync.mjs'), '--apply', '--baseline'],
        { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (error) {
      threw = true;
      assert.match(error.stderr, /--apply cannot be combined with --baseline/);
    }
    assert.ok(threw, 'Expected CLI to reject --apply --baseline');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Defect 3: release and tag must reconcile with lock
// ---------------------------------------------------------------------------

test('applyUpdate refuses when highest tag does not match lock.release', async () => {
  const workspace = await makeTempDir('update-tagmismatch');
  try {
    const { upstreamRoot, repoRoot } = await buildUpdateFixture(workspace);

    // Change upstream so update is not a no-op.
    await updateUpstreamRepo(upstreamRoot, {
      'skills/alpha/SKILL.md': skillDoc('alpha', 'Changed alpha.'),
    });

    // Create a higher tag that doesn't match lock release (1.1.0).
    git(repoRoot, ['tag', '-a', 'v2.0.0', '-m', 'rogue tag']);

    await assert.rejects(
      applyUpdate({
        repoRoot,
        readGitStatus: cleanTree,
        runGit: makeRunGit(repoRoot),
      }),
      (error) => error instanceof BaselineError && /mismatch|reconcil/i.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyUpdate refuses when the lock release tag is not an ancestor of HEAD', async () => {
  const workspace = await makeTempDir('update-noancestor');
  try {
    const { upstreamRoot, repoRoot } = await buildUpdateFixture(workspace);

    // Change upstream so update is not a no-op.
    await updateUpstreamRepo(upstreamRoot, {
      'skills/alpha/SKILL.md': skillDoc('alpha', 'Changed alpha.'),
    });

    // Create a detached tag that points at a commit not in HEAD's ancestry.
    // Delete the existing v1.1.0 tag, create a separate branch, tag it, come back.
    git(repoRoot, ['tag', '-d', 'v1.1.0']);
    git(repoRoot, ['checkout', '--orphan', 'detached-branch']);
    git(repoRoot, ['commit', '-q', '--allow-empty', '-m', 'orphan commit']);
    git(repoRoot, ['tag', '-a', 'v1.1.0', '-m', 'orphan tag']);
    git(repoRoot, ['checkout', 'main']);

    await assert.rejects(
      applyUpdate({
        repoRoot,
        readGitStatus: cleanTree,
        runGit: makeRunGit(repoRoot),
      }),
      (error) => error instanceof BaselineError && /ancestor/i.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Defect 5: convergence regression test
// ---------------------------------------------------------------------------

test('applyUpdate converges: second apply after an upstream change is a no-op', async () => {
  const workspace = await makeTempDir('update-converge');
  try {
    const { upstream, upstreamRoot, repoRoot } = await buildUpdateFixture(workspace);
    const previousCommit = upstream.commit;

    // 1. Change upstream.
    const newCommit = await updateUpstreamRepo(upstreamRoot, {
      'skills/alpha/SKILL.md': skillDoc('alpha', 'Convergence test body.'),
    });

    // 2. First apply: should succeed with changes.
    const result1 = await applyUpdate({
      repoRoot,
      readGitStatus: cleanTree,
      now: () => '2026-04-01T00:00:00Z',
      runGit: makeRunGit(repoRoot),
    });

    assert.equal(result1.applied, true);
    assert.deepEqual(result1.changed, ['skills/demo/alpha']);

    // Simulate what the workflow does: commit and tag.
    git(repoRoot, ['add', '-A']);
    git(repoRoot, ['commit', '-q', '-m', result1.commitMessage]);
    git(repoRoot, ['tag', '-a', result1.nextTag, '-m', result1.commitMessage]);

    // Capture post-first-apply state.
    const lockAfterFirst = JSON.parse(
      await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
    );
    const alphaHistoryAfterFirst = JSON.parse(
      await readFile(path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'), 'utf8'),
    );
    const skillsHashAfterFirst = await hashDirectory(path.join(repoRoot, 'skills'));

    // 3. Second apply: no upstream change => no-op.
    const result2 = await applyUpdate({
      repoRoot,
      readGitStatus: cleanTree,
      now: () => '2026-04-02T00:00:00Z',
      runGit: makeRunGit(repoRoot),
    });

    assert.equal(result2.applied, false);
    assert.deepEqual(result2.changed, []);

    // Lock unchanged.
    const lockAfterSecond = JSON.parse(
      await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
    );
    assert.deepEqual(lockAfterSecond, lockAfterFirst);

    // History length unchanged.
    const alphaHistoryAfterSecond = JSON.parse(
      await readFile(path.join(repoRoot, 'catalog', 'history', 'skills__demo__alpha.json'), 'utf8'),
    );
    assert.equal(alphaHistoryAfterSecond.entries.length, alphaHistoryAfterFirst.entries.length);

    // Filesystem unchanged.
    assert.equal(
      await hashDirectory(path.join(repoRoot, 'skills')),
      skillsHashAfterFirst,
    );

    // Vendored x-version matches lock per-skill version.
    const alphaSkillMd = await readFile(
      path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md'),
      'utf8',
    );
    const alphaLockEntry = lockAfterSecond.skills.find((s) => s.path === 'skills/demo/alpha');
    assert.match(alphaSkillMd, new RegExp(`x-version: ${alphaLockEntry.version}`));

    // Recomputed vendored hash equals snapshotHash in lock.
    const recomputedAlphaHash = await hashDirectory(
      path.join(repoRoot, 'skills', 'demo', 'alpha'),
    );
    assert.equal(recomputedAlphaHash, alphaLockEntry.snapshotHash);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Finding 4: protected-root guard must also run in the daily update engine
//
// The lock-based `local` defense is inert when the manifest drops its `local`
// declaration and the lock carries no local entry, so the guard must be derived
// from the manifest plus the always-protected root and run before any clone.
// ---------------------------------------------------------------------------

test('applyUpdate refuses a mapping into the reserved local root before any clone or write', async () => {
  const workspace = await makeTempDir('update-protected');
  try {
    const { upstream, repoRoot } = await buildUpdateFixture(workspace);

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

    // Drop the local lock entry so the lock-based defense cannot fire either:
    // the reserved path is re-declared as an ordinary mapped skill with a stale
    // content hash, which makes the update engine treat it as "changed".
    const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    lock.skills = lock.skills.map((skill) =>
      skill.category === 'local'
        ? {
            path: skill.path,
            name: skill.name,
            category: 'mapped',
            version: '1.1.0',
            baseline: 'verified',
            license: 'Unknown',
            redistributable: true,
            snapshotHash: skill.snapshotHash,
            contentHash: 'sha256:stale-on-purpose',
            upstream: {
              repository: upstream.url,
              reference: 'refs/heads/main',
              source: 'skills/alpha',
              commit: upstream.commit,
            },
          }
        : skill,
    );
    lock.counts = { total: 4, mapped: 3, orphan: 1, local: 0 };
    await writeFileEnsured(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const skillsBefore = await hashDirectory(path.join(repoRoot, 'skills'));
    const localBefore = await hashDirectory(
      path.join(repoRoot, 'skills', 'lettucebo', 'local-skill'),
    );
    const lockBefore = await readFile(lockPath, 'utf8');

    const gitCalls = [];
    const runGit = async (args) => {
      gitCalls.push(args);
      return makeRunGit(repoRoot)(args);
    };

    await assert.rejects(
      applyUpdate({ repoRoot, readGitStatus: cleanTree, runGit }),
      (error) => /protected root/i.test(error.message) && /lettucebo/.test(error.message),
    );

    assert.equal(
      gitCalls.some((args) => args[0] === 'clone'),
      false,
      'the update must fail before any upstream clone',
    );
    assert.equal(await hashDirectory(path.join(repoRoot, 'skills')), skillsBefore);
    assert.equal(
      await hashDirectory(path.join(repoRoot, 'skills', 'lettucebo', 'local-skill')),
      localBefore,
    );
    assert.equal(await readFile(lockPath, 'utf8'), lockBefore);
    assert.deepEqual(
      (await readdir(repoRoot)).filter((name) => name.startsWith('.update-work-')),
      [],
      'no staging work directory may be left behind',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('repository .gitignore ignores update staging work roots alongside baseline ones', async () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
  const patterns = gitignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  assert.ok(
    patterns.includes('.baseline-work-*/'),
    'baseline work roots must stay ignored',
  );
  assert.ok(
    patterns.includes('.update-work-*/'),
    'update staging work roots created by applyUpdate must be ignored',
  );
  assert.ok(
    gitignore.indexOf('.update-work-*/') > gitignore.indexOf('# Sync tooling'),
    'the update work pattern must live beside the other sync tooling scratch patterns',
  );
});

// ---------------------------------------------------------------------------
// Manifest mapping-set changes (added / removed mappings)
//
// `loadManifest` already refuses a manifest that disagrees with the on-disk
// tree (a mapping without a directory, or a directory without a declaration),
// so a real mapping-set change always moves the manifest AND the tree together.
// These fixtures reproduce exactly that shape: what applyUpdate used to miss is
// the resulting divergence between the manifest and the LOCKFILE.
// ---------------------------------------------------------------------------

/**
 * Rewrites the fixture manifest with an explicit mapping list and commits, so
 * the working tree stays clean (applyUpdate refuses a dirty tree).
 */
async function writeFixtureManifest(repoRoot, upstreamUrl, mappings) {
  await writeFileEnsured(
    path.join(repoRoot, 'catalog', 'sources.yml'),
    [
      'upstreams:',
      '  demo:',
      `    repository: "${upstreamUrl}"`,
      '    reference: refs/heads/main',
      'mappings:',
      ...mappings.flatMap((mapping) => [
        `  - path: ${mapping.path}`,
        '    upstream: demo',
        `    source: ${mapping.source}`,
      ]),
      'orphans:',
      '  - path: skills/orphans/gamma',
      'local:',
      '  - root: skills/lettucebo',
      'overrides: []',
      'linkExceptions: []',
      '',
    ].join('\n'),
  );

  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-q', '-m', 'manifest: change mapping set']);
}

/** The mapping list currently recorded in the lockfile. */
async function mappingsFromLock(repoRoot) {
  const lock = JSON.parse(
    await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
  );

  return lock.skills
    .filter((skill) => skill.category === 'mapped')
    .map((skill) => ({ path: skill.path, source: skill.upstream.source }));
}

async function readLockFile(repoRoot) {
  return readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8');
}

/** Undeclares mappings and removes their vendored directories, then commits. */
async function removeFixtureMappings(repoRoot, upstreamUrl, removedPaths) {
  const mappings = (await mappingsFromLock(repoRoot)).filter(
    (mapping) => !removedPaths.includes(mapping.path),
  );

  for (const removedPath of removedPaths) {
    await rm(path.join(repoRoot, ...removedPath.split('/')), { recursive: true, force: true });
  }

  await writeFixtureManifest(repoRoot, upstreamUrl, mappings);
}

test('applyUpdate fails closed when the manifest adds a mapping the lock does not know', async () => {
  const workspace = await makeTempDir('update-added');
  try {
    const { upstream, upstreamRoot, repoRoot } = await buildUpdateFixture(workspace);

    // The operator vendors the new skill and declares it in the manifest.
    await updateUpstreamRepo(upstreamRoot, { 'skills/delta/SKILL.md': skillDoc('delta') });
    await writeFileEnsured(
      path.join(repoRoot, 'skills', 'demo', 'delta', 'SKILL.md'),
      skillDoc('delta'),
    );

    const mappings = await mappingsFromLock(repoRoot);
    mappings.push({ path: 'skills/demo/delta', source: 'skills/delta' });
    await writeFixtureManifest(repoRoot, upstream.url, mappings);

    const lockBefore = await readLockFile(repoRoot);
    const treeBefore = await hashDirectory(path.join(repoRoot, 'skills'));

    await assert.rejects(
      applyUpdate({ repoRoot, readGitStatus: cleanTree, runGit: makeRunGit(repoRoot) }),
      (error) =>
        error instanceof BaselineError &&
        /skills\/demo\/delta/.test(error.message) &&
        /baseline/i.test(error.message),
    );

    assert.equal(await readLockFile(repoRoot), lockBefore, 'lock must not be mutated');
    assert.equal(
      await hashDirectory(path.join(repoRoot, 'skills')),
      treeBefore,
      'the skills tree must not be mutated',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyUpdate blocks a removed mapping in a small declared group', async () => {
  const workspace = await makeTempDir('update-removed-small');
  try {
    const { upstream, repoRoot } = await buildUpdateFixture(workspace);

    await removeFixtureMappings(repoRoot, upstream.url, ['skills/demo/beta']);

    const lockBefore = await readLockFile(repoRoot);
    const treeBefore = await hashDirectory(path.join(repoRoot, 'skills'));

    await assert.rejects(
      applyUpdate({ repoRoot, readGitStatus: cleanTree, runGit: makeRunGit(repoRoot) }),
      (error) =>
        error instanceof BaselineError &&
        /small-group-removal/.test(error.message) &&
        /skills\/demo\/beta/.test(error.message),
    );

    assert.equal(await readLockFile(repoRoot), lockBefore, 'lock must not be mutated');
    assert.equal(
      await hashDirectory(path.join(repoRoot, 'skills')),
      treeBefore,
      'the skills tree must not be mutated',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyUpdate blocks removals above the deletion ratio threshold', async () => {
  const workspace = await makeTempDir('update-removed-mass');
  try {
    const { upstream, repoRoot } = await buildUpdateFixture(workspace, { extraSkills: 10 });

    await removeFixtureMappings(
      repoRoot,
      upstream.url,
      ['extra01', 'extra02', 'extra03', 'extra04', 'extra05'].map((name) => `skills/demo/${name}`),
    );

    const lockBefore = await readLockFile(repoRoot);
    const treeBefore = await hashDirectory(path.join(repoRoot, 'skills'));

    await assert.rejects(
      applyUpdate({ repoRoot, readGitStatus: cleanTree, runGit: makeRunGit(repoRoot) }),
      (error) =>
        error instanceof BaselineError && /deletion-threshold-exceeded/.test(error.message),
    );

    assert.equal(await readLockFile(repoRoot), lockBefore, 'lock must not be mutated');
    assert.equal(
      await hashDirectory(path.join(repoRoot, 'skills')),
      treeBefore,
      'the skills tree must not be mutated',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyUpdate applies an allowed removal as a major release', async () => {
  const workspace = await makeTempDir('update-removed-ok');
  try {
    const { upstream, repoRoot } = await buildUpdateFixture(workspace, { extraSkills: 10 });

    await removeFixtureMappings(repoRoot, upstream.url, ['skills/demo/extra01']);

    const result = await applyUpdate({
      repoRoot,
      readGitStatus: cleanTree,
      now: () => '2026-03-03T00:00:00Z',
      runGit: makeRunGit(repoRoot),
    });

    assert.equal(result.applied, true);
    assert.deepEqual(result.removed, ['skills/demo/extra01']);
    assert.deepEqual(result.changed, []);
    assert.equal(result.release, '2.0.0');
    assert.equal(result.nextTag, 'v2.0.0');
    assert.equal(result.commitMessage, 'feat(skills)!: sync upstream changes');

    const lock = JSON.parse(await readLockFile(repoRoot));
    assert.equal(lock.release, '2.0.0');
    assert.equal(
      lock.skills.some((skill) => skill.path === 'skills/demo/extra01'),
      false,
      'the removed mapping must not survive as a phantom lock entry',
    );
    assert.equal(lock.counts.mapped, 11);
    assert.equal(lock.counts.total, 13);
    assert.equal(lock.skills.length, 13);

    const history = JSON.parse(
      await readFile(
        path.join(repoRoot, 'catalog', 'history', 'skills__demo__extra01.json'),
        'utf8',
      ),
    );
    const last = history.entries.at(-1);
    assert.equal(last.kind, 'mapping-removed');
    assert.equal(last.release, '2.0.0');

    // Orphan and local skills are untouched.
    assert.ok(
      await readFile(path.join(repoRoot, 'skills', 'orphans', 'gamma', 'SKILL.md'), 'utf8'),
    );
    assert.ok(
      await readFile(
        path.join(repoRoot, 'skills', 'lettucebo', 'local-skill', 'SKILL.md'),
        'utf8',
      ),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyUpdate classifies a removal plus a content change as major', async () => {
  const workspace = await makeTempDir('update-removed-and-changed');
  try {
    const { upstream, upstreamRoot, repoRoot } = await buildUpdateFixture(workspace, {
      extraSkills: 10,
    });

    await updateUpstreamRepo(upstreamRoot, {
      'skills/alpha/SKILL.md': skillDoc('alpha', 'Changed alpha body.'),
    });

    await removeFixtureMappings(repoRoot, upstream.url, ['skills/demo/extra02']);

    const result = await applyUpdate({
      repoRoot,
      readGitStatus: cleanTree,
      now: () => '2026-03-03T00:00:00Z',
      runGit: makeRunGit(repoRoot),
    });

    assert.equal(result.applied, true);
    assert.deepEqual(result.removed, ['skills/demo/extra02']);
    assert.deepEqual(result.changed, ['skills/demo/alpha']);
    assert.equal(result.commitMessage, 'feat(skills)!: sync upstream changes');
    assert.equal(result.release, '2.0.0');

    const lock = JSON.parse(await readLockFile(repoRoot));
    const alpha = lock.skills.find((skill) => skill.path === 'skills/demo/alpha');
    assert.equal(alpha.version, '1.1.1', 'per-skill versions still bump by patch');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyUpdate reports no-op when the mapping set and all content are unchanged', async () => {
  const workspace = await makeTempDir('update-noop-mapping');
  try {
    const { repoRoot } = await buildUpdateFixture(workspace, { extraSkills: 10 });

    const result = await applyUpdate({
      repoRoot,
      readGitStatus: cleanTree,
      runGit: makeRunGit(repoRoot),
    });

    assert.equal(result.applied, false);
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.removed, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Deletion-guard grouping key: one repository at two references
//
// The dry-run planner groups by (repository, reference) and names each group
// after the manifest upstream. `applyUpdate` used to group by `repository`
// alone, so two references of the SAME repository collapsed into one group with
// a doubled denominator — a removal that the plan blocks would be applied.
// ---------------------------------------------------------------------------

/**
 * Builds a verified-baseline fixture where one upstream repository is mapped at
 * two references (`refs/heads/main` as `demo`, `refs/heads/legacy` as
 * `legacy`), each contributing `perGroup` mapped skills.
 */
async function buildTwoReferenceFixture(workspace, { perGroup = 12 } = {}) {
  const mainNames = Array.from({ length: perGroup }, (_, index) =>
    `mainskill${String(index + 1).padStart(2, '0')}`,
  );
  const legacyNames = Array.from({ length: perGroup }, (_, index) =>
    `legacyskill${String(index + 1).padStart(2, '0')}`,
  );

  const upstreamRoot = path.join(workspace, 'upstream');
  const initial = await initUpstreamRepo(
    upstreamRoot,
    Object.fromEntries(
      [...mainNames, ...legacyNames].map((name) => [
        `skills/${name}/SKILL.md`,
        skillDoc(name),
      ]),
    ),
  );

  // Freeze the legacy line, then move main forward so the two references of the
  // same repository resolve to different commits.
  const legacyCommit = initial.commit;
  git(upstreamRoot, ['branch', 'legacy']);
  const mainCommit = await updateUpstreamRepo(upstreamRoot, {
    'MAIN.md': '# main line moved forward\n',
  });

  const groups = [
    { upstream: 'demo', reference: 'refs/heads/main', commit: mainCommit, prefix: 'skills/demo', names: mainNames },
    { upstream: 'legacy', reference: 'refs/heads/legacy', commit: legacyCommit, prefix: 'skills/legacy', names: legacyNames },
  ];

  const repoRoot = path.join(workspace, 'repo');
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'fixture@example.com']);
  git(repoRoot, ['config', 'user.name', 'Fixture']);

  const mappings = [];
  const skills = [];

  for (const group of groups) {
    for (const name of group.names) {
      const skillPath = `${group.prefix}/${name}`;
      await writeFileEnsured(
        path.join(repoRoot, ...skillPath.split('/'), 'SKILL.md'),
        skillDoc(name),
      );

      mappings.push({ path: skillPath, source: `skills/${name}`, upstream: group.upstream });
      skills.push({
        path: skillPath,
        name,
        category: 'mapped',
        version: '1.1.0',
        baseline: 'verified',
        license: 'Unknown',
        redistributable: true,
        snapshotHash: await hashDirectory(path.join(repoRoot, ...skillPath.split('/'))),
        contentHash: await hashDirectory(path.join(upstreamRoot, 'skills', name)),
        upstream: {
          repository: pathToFileURL(upstreamRoot).href,
          reference: group.reference,
          source: `skills/${name}`,
          commit: group.commit,
        },
      });
    }
  }

  skills.sort((left, right) => (left.path < right.path ? -1 : 1));

  await writeTwoReferenceManifest(repoRoot, pathToFileURL(upstreamRoot).href, mappings);

  await writeFileEnsured(
    path.join(repoRoot, 'catalog', 'skills.lock.json'),
    `${JSON.stringify(
      {
        release: '1.1.0',
        generatedAt: '2026-02-02T00:00:00Z',
        counts: { total: skills.length, mapped: skills.length, orphan: 0, local: 0 },
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
            {
              release: '1.1.0',
              kind: 'baseline-verified',
              version: '1.1.0',
              upstreamCommit: skill.upstream.commit,
              diffUrl: null,
              contentHash: skill.contentHash,
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

  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-q', '-m', 'initial verified baseline']);
  git(repoRoot, ['tag', '-a', 'v1.1.0', '-m', 'baseline']);

  return { repoRoot, upstreamRoot, upstreamUrl: pathToFileURL(upstreamRoot).href, mappings };
}

/** Writes the two-reference manifest and commits so the tree stays clean. */
async function writeTwoReferenceManifest(repoRoot, upstreamUrl, mappings, { commit = false } = {}) {
  await writeFileEnsured(
    path.join(repoRoot, 'catalog', 'sources.yml'),
    [
      'upstreams:',
      '  demo:',
      `    repository: "${upstreamUrl}"`,
      '    reference: refs/heads/main',
      '  legacy:',
      `    repository: "${upstreamUrl}"`,
      '    reference: refs/heads/legacy',
      'mappings:',
      ...mappings.flatMap((mapping) => [
        `  - path: ${mapping.path}`,
        `    upstream: ${mapping.upstream}`,
        `    source: ${mapping.source}`,
      ]),
      'orphans: []',
      'local: []',
      'overrides: []',
      'linkExceptions: []',
      '',
    ].join('\n'),
  );

  if (commit) {
    git(repoRoot, ['add', '-A']);
    git(repoRoot, ['commit', '-q', '-m', 'manifest: change mapping set']);
  }
}

test('applyUpdate keeps one repository at two references in separate deletion groups', async () => {
  const workspace = await makeTempDir('update-two-references');
  try {
    const { repoRoot, upstreamUrl, mappings } = await buildTwoReferenceFixture(workspace, {
      perGroup: 12,
    });

    // Five of the twelve `demo` (refs/heads/main) mappings are undeclared:
    //   per-reference group  → 5/12 = 41.7% > 30%  ⇒ BLOCKED
    //   repository-only group → 5/24 = 20.8% ≤ 30% ⇒ silently applied
    const removedPaths = mappings
      .filter((mapping) => mapping.upstream === 'demo')
      .slice(0, 5)
      .map((mapping) => mapping.path);

    for (const removedPath of removedPaths) {
      await rm(path.join(repoRoot, ...removedPath.split('/')), { recursive: true, force: true });
    }

    await writeTwoReferenceManifest(
      repoRoot,
      upstreamUrl,
      mappings.filter((mapping) => !removedPaths.includes(mapping.path)),
      { commit: true },
    );

    const lockBefore = await readLockFile(repoRoot);
    const treeBefore = await hashDirectory(path.join(repoRoot, 'skills'));

    await assert.rejects(
      applyUpdate({ repoRoot, readGitStatus: cleanTree, runGit: makeRunGit(repoRoot) }),
      (error) =>
        error instanceof BaselineError &&
        /deletion-threshold-exceeded/.test(error.message) &&
        /\(5\/12\)/.test(error.message),
      'the apply must group by (repository, reference) exactly like the dry-run planner; ' +
        'grouping by repository alone doubles the denominator and lets the removal through',
    );

    assert.equal(await readLockFile(repoRoot), lockBefore, 'lock must not be mutated');
    assert.equal(
      await hashDirectory(path.join(repoRoot, 'skills')),
      treeBefore,
      'the skills tree must not be mutated',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('applyUpdate names deletion groups after the manifest upstream, like the planner', async () => {
  const workspace = await makeTempDir('update-two-references-name');
  try {
    const { repoRoot, upstreamUrl, mappings } = await buildTwoReferenceFixture(workspace, {
      perGroup: 12,
    });

    const removedPaths = mappings
      .filter((mapping) => mapping.upstream === 'legacy')
      .slice(0, 5)
      .map((mapping) => mapping.path);

    for (const removedPath of removedPaths) {
      await rm(path.join(repoRoot, ...removedPath.split('/')), { recursive: true, force: true });
    }

    await writeTwoReferenceManifest(
      repoRoot,
      upstreamUrl,
      mappings.filter((mapping) => !removedPaths.includes(mapping.path)),
      { commit: true },
    );

    await assert.rejects(
      applyUpdate({ repoRoot, readGitStatus: cleanTree, runGit: makeRunGit(repoRoot) }),
      (error) =>
        error instanceof BaselineError &&
        /legacy: deletion-threshold-exceeded/.test(error.message),
      'the blocked group must be reported under its manifest upstream name so the apply error ' +
        'reads exactly like the dry-run guardrail report',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
