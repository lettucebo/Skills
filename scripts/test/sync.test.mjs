import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from 'yaml';

import { loadManifest, ManifestValidationError } from '../lib/manifest.mjs';
import { hashDirectory } from '../lib/hash.mjs';
import {
  cloneUpstream,
  isShaReference,
  resolveCloneRef,
  resolveRepositoryUrl,
  GitReferenceError,
} from '../lib/git-source.mjs';
import {
  computeOverrideName,
  stampFrontmatter,
  transformStaged,
} from '../transform.mjs';
import { assertWritableSkillPath, runSync, SyncProtectionError } from '../sync.mjs';

function lockDoc(skills) {
  return `${JSON.stringify(
    {
      release: '1.0.0',
      generatedAt: '2026-01-01T00:00:00Z',
      counts: { total: skills.length, mapped: skills.length, orphan: 0, local: 0 },
      skills,
    },
    null,
    2,
  )}\n`;
}

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

function skillDoc(name) {
  return `---\nname: ${name}\ndescription: Fixture skill ${name}\n---\n\n# ${name}\n\nBody for ${name}.\n`;
}

async function initUpstreamRepo(root, files, { branch = 'main', tag } = {}) {
  await mkdir(root, { recursive: true });
  git(root, ['init', '-q', '-b', branch]);
  git(root, ['config', 'user.email', 'fixture@example.com']);
  git(root, ['config', 'user.name', 'Fixture']);

  for (const [relativePath, content] of Object.entries(files)) {
    await writeFileEnsured(path.join(root, relativePath), content);
  }

  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial']);

  if (tag) {
    git(root, ['tag', tag]);
  }

  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  return { url: pathToFileURL(root).href, commit, branch, tag };
}

// ---------------------------------------------------------------------------
// git-source: reference parsing and clone
// ---------------------------------------------------------------------------

test('isShaReference detects 40-hex commit SHAs only', () => {
  assert.equal(isShaReference('a'.repeat(40)), true);
  assert.equal(isShaReference('A'.repeat(40)), true);
  assert.equal(isShaReference('refs/heads/main'), false);
  assert.equal(isShaReference('main'), false);
  assert.equal(isShaReference('a'.repeat(39)), false);
});

test('resolveCloneRef normalizes refs/heads and refs/tags to short names', () => {
  assert.equal(resolveCloneRef('refs/heads/main'), 'main');
  assert.equal(resolveCloneRef('refs/tags/v1.2.3'), 'v1.2.3');
  assert.equal(resolveCloneRef('release/2.0'), 'release/2.0');
});

test('resolveCloneRef rejects commit SHA references with a targeted message', () => {
  assert.throws(
    () => resolveCloneRef('a'.repeat(40)),
    (error) => error instanceof GitReferenceError && /commit SHA/i.test(error.message),
  );
});

test('resolveRepositoryUrl keeps URLs and expands owner/repo shorthand', () => {
  assert.equal(
    resolveRepositoryUrl('file:///C:/tmp/repo'),
    'file:///C:/tmp/repo',
  );
  assert.equal(
    resolveRepositoryUrl('github/awesome-copilot'),
    'https://github.com/github/awesome-copilot.git',
  );
});

test('cloneUpstream performs a shallow branch clone and reports the commit', async () => {
  const workspace = await makeTempDir('git-branch');
  try {
    const upstream = await initUpstreamRepo(path.join(workspace, 'upstream'), {
      'skills/alpha/SKILL.md': skillDoc('alpha'),
    });

    const destination = path.join(workspace, 'clone');
    const result = await cloneUpstream({
      repository: upstream.url,
      reference: 'refs/heads/main',
      destination,
    });

    assert.equal(result.commit, upstream.commit);
    assert.equal(result.ref, 'main');
    const clonedSkill = await readFile(
      path.join(destination, 'skills', 'alpha', 'SKILL.md'),
      'utf8',
    );
    assert.match(clonedSkill, /name: alpha/);
    const depth = git(destination, ['rev-list', '--count', 'HEAD']).trim();
    assert.equal(depth, '1');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('cloneUpstream performs a shallow tag clone', async () => {
  const workspace = await makeTempDir('git-tag');
  try {
    const upstream = await initUpstreamRepo(
      path.join(workspace, 'upstream'),
      { 'skills/beta/SKILL.md': skillDoc('beta') },
      { tag: 'v9.9.9' },
    );

    const destination = path.join(workspace, 'clone');
    const result = await cloneUpstream({
      repository: upstream.url,
      reference: 'refs/tags/v9.9.9',
      destination,
    });

    assert.equal(result.commit, upstream.commit);
    assert.equal(result.ref, 'v9.9.9');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// manifest validation: SHA rejection
// ---------------------------------------------------------------------------

test('loadManifest rejects upstream references that are commit SHAs', async () => {
  const workspace = await makeTempDir('manifest-sha');
  try {
    await writeFileEnsured(
      path.join(workspace, 'skills', 'demo', 'alpha', 'SKILL.md'),
      skillDoc('alpha'),
    );
    const manifestPath = path.join(workspace, 'catalog', 'sources.yml');
    await writeFileEnsured(
      manifestPath,
      [
        'upstreams:',
        '  demo:',
        '    repository: github/demo',
        `    reference: ${'a'.repeat(40)}`,
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

    await assert.rejects(
      loadManifest(manifestPath),
      (error) =>
        error instanceof ManifestValidationError && /commit SHA/i.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// transform: stamping and name overrides
// ---------------------------------------------------------------------------

test('computeOverrideName joins the source collection and skill folder', () => {
  assert.equal(computeOverrideName('skills/claude/mcp-builder'), 'claude-mcp-builder');
  assert.equal(
    computeOverrideName('skills/microsoft/skill-creator'),
    'microsoft-skill-creator',
  );
});

test('stampFrontmatter adds provenance fields and preserves the body bytes', () => {
  const original = skillDoc('alpha');
  const stamped = stampFrontmatter(original, {
    stamps: {
      'x-source': 'github/demo',
      'x-source-path': 'skills/alpha',
      'x-source-commit': 'abc123',
      'x-version': '1.0.0',
    },
  });

  const data = parse(stamped.split('---')[1]);
  assert.equal(data.name, 'alpha');
  assert.equal(data['x-source'], 'github/demo');
  assert.equal(data['x-source-path'], 'skills/alpha');
  assert.equal(data['x-source-commit'], 'abc123');
  assert.equal(data['x-version'], '1.0.0');

  const body = original.slice(original.indexOf('---', 3) + 3);
  assert.ok(stamped.endsWith(body));
});

test('stampFrontmatter is idempotent', () => {
  const original = skillDoc('alpha');
  const stamps = {
    'x-source': 'github/demo',
    'x-source-path': 'skills/alpha',
    'x-source-commit': 'abc123',
    'x-version': '1.0.0',
  };
  const once = stampFrontmatter(original, { stamps });
  const twice = stampFrontmatter(once, { stamps });
  assert.equal(twice, once);
});

test('stampFrontmatter preserves CRLF frontmatter line endings and stays idempotent', () => {
  const crlf = '---\r\nname: alpha\r\ndescription: A skill\r\n---\r\n\r\n# alpha\r\nBody\r\n';
  const stamps = { 'x-source': 'github/demo', 'x-version': '1.0.0' };
  const once = stampFrontmatter(crlf, { stamps });

  const frontmatterBlock = once.slice(0, once.indexOf('---', 3));
  assert.ok(frontmatterBlock.includes('\r\n'));
  assert.ok(!/(?<!\r)\n/.test(frontmatterBlock), 'frontmatter must not contain bare LF');

  const data = parse(once.slice(3, once.indexOf('---', 3)).replace(/\r/g, ''));
  assert.equal(data.name, 'alpha');
  assert.equal(data['x-source'], 'github/demo');

  const twice = stampFrontmatter(once, { stamps });
  assert.equal(twice, once);
});

test('transformStaged applies rename-frontmatter-name overrides and stamps SKILL.md', async () => {
  const workspace = await makeTempDir('transform');
  try {
    const skillDir = path.join(workspace, 'skills', 'claude', 'mcp-builder');
    await writeFileEnsured(path.join(skillDir, 'SKILL.md'), skillDoc('mcp-builder'));

    await transformStaged({
      skillDir,
      skillPath: 'skills/claude/mcp-builder',
      override: { path: 'skills/claude/mcp-builder', transform: 'rename-frontmatter-name' },
      upstream: { repository: 'anthropics/skills', reference: 'refs/heads/main' },
      source: 'skills/mcp-builder',
      commit: 'deadbeef',
      version: '1.0.0',
    });

    const text = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
    const data = parse(text.slice(3, text.indexOf('---', 3)));
    assert.equal(data.name, 'claude-mcp-builder');
    assert.equal(data['x-source'], 'anthropics/skills');
    assert.equal(data['x-source-path'], 'skills/mcp-builder');
    assert.equal(data['x-source-commit'], 'deadbeef');
    assert.equal(data['x-version'], '1.0.0');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// protection guard
// ---------------------------------------------------------------------------

test('assertWritableSkillPath rejects the reserved local root', () => {
  assert.throws(
    () => assertWritableSkillPath('skills/lettucebo/evil', ['skills/lettucebo']),
    (error) => error instanceof SyncProtectionError,
  );
  assert.throws(
    () => assertWritableSkillPath('skills/lettucebo', ['skills/lettucebo']),
    (error) => error instanceof SyncProtectionError,
  );
});

test('assertWritableSkillPath allows ordinary mapped paths', () => {
  assert.doesNotThrow(() =>
    assertWritableSkillPath('skills/azure/az-cost-optimize', ['skills/lettucebo']),
  );
});

// ---------------------------------------------------------------------------
// sync --dry-run change set
// ---------------------------------------------------------------------------

async function buildSyncFixture(workspace) {
  const upstream = await initUpstreamRepo(path.join(workspace, 'upstream'), {
    'skills/mapped-skill/SKILL.md': skillDoc('mapped-skill'),
    'skills/mapped-skill/references/notes.md': '# notes\n',
    'skills/added-skill/SKILL.md': skillDoc('added-skill'),
    'skills/extra-skill/SKILL.md': skillDoc('extra-skill'),
    'docs/tool/SKILL.md': skillDoc('tool'),
  });

  const repoRoot = path.join(workspace, 'repo');
  await writeFileEnsured(
    path.join(repoRoot, 'skills', 'demo', 'mapped-skill', 'SKILL.md'),
    skillDoc('mapped-skill'),
  );
  await writeFileEnsured(
    path.join(repoRoot, 'skills', 'demo', 'mapped-skill', 'references', 'notes.md'),
    '# notes\n',
  );
  await writeFileEnsured(
    path.join(repoRoot, 'skills', 'demo', 'added-skill', 'SKILL.md'),
    skillDoc('added-skill'),
  );
  await writeFileEnsured(
    path.join(repoRoot, 'skills', 'demo', 'missing', 'SKILL.md'),
    skillDoc('missing'),
  );

  await writeFileEnsured(
    path.join(repoRoot, 'catalog', 'sources.yml'),
    [
      'upstreams:',
      '  demo:',
      `    repository: "${upstream.url}"`,
      '    reference: refs/heads/main',
      'mappings:',
      '  - path: skills/demo/mapped-skill',
      '    upstream: demo',
      '    source: skills/mapped-skill',
      '  - path: skills/demo/added-skill',
      '    upstream: demo',
      '    source: skills/added-skill',
      '  - path: skills/demo/missing',
      '    upstream: demo',
      '    source: skills/does-not-exist',
      'orphans: []',
      'local: []',
      'overrides: []',
      'linkExceptions: []',
      '',
    ].join('\n'),
  );

  const snapshotHash = await hashDirectory(
    path.join(repoRoot, 'skills', 'demo', 'mapped-skill'),
  );
  await writeFileEnsured(
    path.join(repoRoot, 'catalog', 'skills.lock.json'),
    `${JSON.stringify(
      {
        release: '1.0.0',
        generatedAt: '2026-01-01T00:00:00Z',
        counts: { total: 1, mapped: 1, orphan: 0, local: 0 },
        skills: [
          {
            path: 'skills/demo/mapped-skill',
            name: 'mapped-skill',
            category: 'mapped',
            version: '1.0.0',
            baseline: 'unverified',
            license: 'Unknown',
            redistributable: true,
            snapshotHash,
            upstream: {
              repository: upstream.url,
              reference: 'refs/heads/main',
              source: 'skills/mapped-skill',
              commit: null,
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  return { upstream, repoRoot };
}

test('runSync --dry-run classifies changes deterministically without mutating the repo', async () => {
  const workspace = await makeTempDir('sync-dryrun');
  try {
    const { upstream, repoRoot } = await buildSyncFixture(workspace);
    const workspaceRoot = path.join(workspace, 'ws');

    const repoHashBefore = await hashDirectory(path.join(repoRoot, 'skills'));
    const { changeSet } = await runSync({ repoRoot, dryRun: true, workspaceRoot });
    const repoHashAfter = await hashDirectory(path.join(repoRoot, 'skills'));

    // dry-run must never touch the working tree
    assert.equal(repoHashAfter, repoHashBefore);

    // sources report the resolved commit
    assert.equal(changeSet.sources.length, 1);
    assert.equal(changeSet.sources[0].upstream, 'demo');
    assert.equal(changeSet.sources[0].available, true);
    assert.equal(changeSet.sources[0].commit, upstream.commit);

    // exact diff categories
    assert.deepEqual(changeSet.changed, []);
    assert.deepEqual(changeSet.removed, []);
    assert.deepEqual(changeSet.renamed, []);

    assert.deepEqual(
      changeSet.added.map((entry) => entry.path),
      ['skills/demo/added-skill'],
    );
    assert.deepEqual(
      changeSet.baselineRequired.map((entry) => entry.path),
      ['skills/demo/mapped-skill'],
    );
    assert.deepEqual(changeSet.unavailable, [
      { path: 'skills/demo/missing', upstream: 'demo', reason: 'missing-source' },
    ]);
    assert.deepEqual(
      changeSet.unadopted.map((entry) => entry.source),
      ['skills/extra-skill'],
    );

    // pre-stamp hash is computed BEFORE stamping (independent of transform)
    const rawSourceHash = await hashDirectory(
      path.join(workspace, 'upstream', 'skills', 'mapped-skill'),
    );
    assert.equal(changeSet.baselineRequired[0].preStampHash, rawSourceHash);
    assert.equal(changeSet.baselineRequired[0].snapshotHash, rawSourceHash);
    assert.equal(changeSet.baselineRequired[0].upstreamCommit, upstream.commit);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('runSync cleans up its temp workspace on success', async () => {
  const workspace = await makeTempDir('sync-cleanup');
  try {
    const { repoRoot } = await buildSyncFixture(workspace);
    const workspaceRoot = path.join(workspace, 'ws');
    await mkdir(workspaceRoot, { recursive: true });

    await runSync({ repoRoot, dryRun: true, workspaceRoot });

    const leftovers = (await readdir(workspaceRoot)).filter((name) =>
      name.startsWith('skills-sync-'),
    );
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('runSync is idempotent across repeated dry runs', async () => {
  const workspace = await makeTempDir('sync-idem');
  try {
    const { repoRoot } = await buildSyncFixture(workspace);
    const workspaceRoot = path.join(workspace, 'ws');

    const first = await runSync({ repoRoot, dryRun: true, workspaceRoot });
    const second = await runSync({ repoRoot, dryRun: true, workspaceRoot });

    assert.equal(second.json, first.json);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('runSync writes the change set JSON to --output', async () => {
  const workspace = await makeTempDir('sync-output');
  try {
    const { repoRoot } = await buildSyncFixture(workspace);
    const workspaceRoot = path.join(workspace, 'ws');
    const outputPath = path.join(workspace, 'changeset.json');

    const { json } = await runSync({
      repoRoot,
      dryRun: true,
      workspaceRoot,
      output: outputPath,
    });

    const written = await readFile(outputPath, 'utf8');
    assert.equal(written, json);
    const parsed = JSON.parse(written);
    assert.ok(Array.isArray(parsed.baselineRequired));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('runSync classifies an unreachable upstream as unavailable', async () => {
  const workspace = await makeTempDir('sync-unavailable');
  try {
    const repoRoot = path.join(workspace, 'repo');
    await writeFileEnsured(
      path.join(repoRoot, 'skills', 'demo', 'alpha', 'SKILL.md'),
      skillDoc('alpha'),
    );
    const bogusUrl = pathToFileURL(path.join(workspace, 'nope', 'missing-repo')).href;
    await writeFileEnsured(
      path.join(repoRoot, 'catalog', 'sources.yml'),
      [
        'upstreams:',
        '  demo:',
        `    repository: "${bogusUrl}"`,
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
    await writeFileEnsured(
      path.join(repoRoot, 'catalog', 'skills.lock.json'),
      `${JSON.stringify(
        {
          release: '1.0.0',
          generatedAt: '2026-01-01T00:00:00Z',
          counts: { total: 1, mapped: 1, orphan: 0, local: 0 },
          skills: [],
        },
        null,
        2,
      )}\n`,
    );

    const { changeSet } = await runSync({
      repoRoot,
      dryRun: true,
      workspaceRoot: path.join(workspace, 'ws'),
    });

    assert.equal(changeSet.sources[0].available, false);
    assert.deepEqual(changeSet.unavailable, [
      { path: 'skills/demo/alpha', upstream: 'demo', reason: 'upstream-unavailable' },
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('runSync fails before writes and cleans up when a mapping targets a protected root', async () => {
  const workspace = await makeTempDir('sync-protected');
  try {
    const upstream = await initUpstreamRepo(path.join(workspace, 'upstream'), {
      'skills/evil/SKILL.md': skillDoc('evil'),
    });
    const repoRoot = path.join(workspace, 'repo');
    await writeFileEnsured(
      path.join(repoRoot, 'skills', 'lettucebo', 'evil', 'SKILL.md'),
      skillDoc('evil'),
    );
    await writeFileEnsured(
      path.join(repoRoot, 'catalog', 'sources.yml'),
      [
        'upstreams:',
        '  demo:',
        `    repository: "${upstream.url}"`,
        '    reference: refs/heads/main',
        'mappings:',
        '  - path: skills/lettucebo/evil',
        '    upstream: demo',
        '    source: skills/evil',
        'orphans: []',
        'local: []',
        'overrides: []',
        'linkExceptions: []',
        '',
      ].join('\n'),
    );
    await writeFileEnsured(
      path.join(repoRoot, 'catalog', 'skills.lock.json'),
      `${JSON.stringify(
        {
          release: '1.0.0',
          generatedAt: '2026-01-01T00:00:00Z',
          counts: { total: 1, mapped: 0, orphan: 0, local: 1 },
          skills: [],
        },
        null,
        2,
      )}\n`,
    );

    const workspaceRoot = path.join(workspace, 'ws');
    await mkdir(workspaceRoot, { recursive: true });

    await assert.rejects(
      runSync({ repoRoot, dryRun: true, workspaceRoot }),
      (error) => error instanceof SyncProtectionError,
    );

    // reserved root must remain untouched
    const evilDoc = await readFile(
      path.join(repoRoot, 'skills', 'lettucebo', 'evil', 'SKILL.md'),
      'utf8',
    );
    assert.equal(evilDoc, skillDoc('evil'));

    // workspace cleaned up on failure
    const leftovers = (await readdir(workspaceRoot)).filter((name) =>
      name.startsWith('skills-sync-'),
    );
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task 7: guardrail + classification exposed on the change set
// ---------------------------------------------------------------------------

test('runSync exposes a minor classification and unblocked guardrail for additions', async () => {
  const workspace = await makeTempDir('sync-classify');
  try {
    const { repoRoot } = await buildSyncFixture(workspace);
    const workspaceRoot = path.join(workspace, 'ws');

    const repoHashBefore = await hashDirectory(path.join(repoRoot, 'skills'));
    const { changeSet } = await runSync({ repoRoot, dryRun: true, workspaceRoot });
    const repoHashAfter = await hashDirectory(path.join(repoRoot, 'skills'));

    // exposing classification must not weaken dry-run write safety
    assert.equal(repoHashAfter, repoHashBefore);

    // only additions changed; the unverified baseline is NOT counted as a change
    assert.equal(changeSet.classification.diffClass, 'minor');
    assert.equal(
      changeSet.classification.commitMessage,
      'feat(skills): sync new upstream skills',
    );
    assert.equal(changeSet.classification.pendingBaseline, 1);

    assert.equal(changeSet.guardrail.blocked, false);
    const demo = changeSet.guardrail.groups.find((group) => group.upstream === 'demo');
    assert.equal(demo.removed, 0);
    assert.equal(demo.status, 'ok');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('runSync blocks and reports a major classification when a mapped skill is removed', async () => {
  const workspace = await makeTempDir('sync-removed');
  try {
    const upstream = await initUpstreamRepo(path.join(workspace, 'upstream'), {
      'skills/kept/SKILL.md': skillDoc('kept'),
    });
    const repoRoot = path.join(workspace, 'repo');
    await writeFileEnsured(
      path.join(repoRoot, 'skills', 'demo', 'kept', 'SKILL.md'),
      skillDoc('kept'),
    );
    await writeFileEnsured(
      path.join(repoRoot, 'catalog', 'sources.yml'),
      [
        'upstreams:',
        '  demo:',
        `    repository: "${upstream.url}"`,
        '    reference: refs/heads/main',
        'mappings:',
        '  - path: skills/demo/kept',
        '    upstream: demo',
        '    source: skills/kept',
        'orphans: []',
        'local: []',
        'overrides: []',
        'linkExceptions: []',
        '',
      ].join('\n'),
    );
    await writeFileEnsured(
      path.join(repoRoot, 'catalog', 'skills.lock.json'),
      lockDoc([
        {
          path: 'skills/demo/kept',
          name: 'kept',
          category: 'mapped',
          version: '1.0.0',
          baseline: 'unverified',
          license: 'Unknown',
          redistributable: true,
          snapshotHash: 'sha256:0',
          upstream: {
            repository: upstream.url,
            reference: 'refs/heads/main',
            source: 'skills/kept',
            commit: null,
          },
        },
        {
          path: 'skills/demo/removed-one',
          name: 'removed-one',
          category: 'mapped',
          version: '1.0.0',
          baseline: 'unverified',
          license: 'Unknown',
          redistributable: true,
          snapshotHash: 'sha256:1',
          upstream: {
            repository: upstream.url,
            reference: 'refs/heads/main',
            source: 'skills/removed-one',
            commit: null,
          },
        },
      ]),
    );

    const { changeSet } = await runSync({
      repoRoot,
      dryRun: true,
      workspaceRoot: path.join(workspace, 'ws'),
    });

    assert.deepEqual(
      changeSet.removed.map((entry) => entry.path),
      ['skills/demo/removed-one'],
    );
    assert.equal(changeSet.classification.diffClass, 'major');
    assert.equal(
      changeSet.classification.commitMessage,
      'feat(skills)!: sync upstream changes',
    );

    assert.equal(changeSet.guardrail.blocked, true);
    const demo = changeSet.guardrail.groups.find((group) => group.upstream === 'demo');
    assert.equal(demo.removed, 1);
    assert.equal(demo.status, 'small-group-removal');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('runSync fails fast on a malformed upstream SKILL.md instead of marking it unavailable', async () => {
  const workspace = await makeTempDir('sync-malformed');
  try {
    const upstream = await initUpstreamRepo(path.join(workspace, 'upstream'), {
      'skills/broken/SKILL.md': '# broken\n\nNo frontmatter here.\n',
    });
    const repoRoot = path.join(workspace, 'repo');
    await writeFileEnsured(
      path.join(repoRoot, 'skills', 'demo', 'broken', 'SKILL.md'),
      skillDoc('broken'),
    );
    await writeFileEnsured(
      path.join(repoRoot, 'catalog', 'sources.yml'),
      [
        'upstreams:',
        '  demo:',
        `    repository: "${upstream.url}"`,
        '    reference: refs/heads/main',
        'mappings:',
        '  - path: skills/demo/broken',
        '    upstream: demo',
        '    source: skills/broken',
        'orphans: []',
        'local: []',
        'overrides: []',
        'linkExceptions: []',
        '',
      ].join('\n'),
    );
    await writeFileEnsured(
      path.join(repoRoot, 'catalog', 'skills.lock.json'),
      lockDoc([]),
    );

    await assert.rejects(
      runSync({
        repoRoot,
        dryRun: true,
        workspaceRoot: path.join(workspace, 'ws'),
      }),
      (error) => /frontmatter/i.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
