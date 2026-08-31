import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  GIT_LOG_SENTINEL,
  buildGitLogArgs,
  collectSkillHistory,
  extractScopedPatch,
  parseGitLogZ,
  parsePatchPaths,
  resolveHistoryProvenance,
  summarizeSkillHistory,
} from '../lib/changelog.mjs';

const SHA_A = '1111111111111111111111111111111111111111';
const SHA_B = '2222222222222222222222222222222222222222';
const SHA_C = '3333333333333333333333333333333333333333';
const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.join(__dirname, '.runtime');

async function git(repo, args) {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

async function createHistoryFixture() {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'changelog-history-'));
  await git(root, ['init']);
  await git(root, ['config', 'user.name', 'Test Author']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  const skillDirectory = path.join(root, 'skills', 'demo');
  const skillPath = path.join(skillDirectory, 'SKILL.md');
  await mkdir(skillDirectory, { recursive: true });

  const commits = [];
  for (let index = 1; index <= 7; index += 1) {
    await writeFile(skillPath, `change ${index}\n`, 'utf8');
    await git(root, ['add', '--', 'skills/demo/SKILL.md']);
    await git(root, ['commit', '-m', `change ${index}`]);
    commits.push(await git(root, ['rev-parse', 'HEAD']));
  }
  return { root, commits };
}

test('git log arguments pin the lock commit, follow history, disable merges, and use NUL framing', () => {
  const args = buildGitLogArgs({
    pinnedCommit: SHA_A,
    sourcePath: 'skills/demo/SKILL.md',
  });

  assert.deepEqual(args.slice(0, 3), ['-c', 'diff.renameLimit=0', 'log']);
  assert.ok(args.includes('--follow'));
  assert.ok(args.includes('--no-merges'));
  assert.ok(args.includes('-z'));
  assert.ok(args.some((arg) => arg.includes(GIT_LOG_SENTINEL)));
  assert.deepEqual(args.slice(-3), [SHA_A, '--', 'skills/demo/SKILL.md']);
  assert.equal(args.includes('HEAD'), false);
});

test('NUL log parser preserves multiline delimiter subjects and Unicode or quoted-looking paths', () => {
  const subject = `Describe | delimiter\n${GIT_LOG_SENTINEL} remains data`;
  const unicodePath = 'skills/工具/"quoted name"/SKILL.md';
  const oldPath = 'prompts/舊.prompt.md';
  const newPath = 'skills/新/SKILL.md';
  const raw = [
    '',
    GIT_LOG_SENTINEL,
    SHA_A,
    '2026-08-30T10:20:30+08:00',
    subject,
    'M',
    unicodePath,
    '',
    GIT_LOG_SENTINEL,
    SHA_B,
    '2026-08-29T01:02:03Z',
    'Rename the source',
    'R100',
    oldPath,
    newPath,
    '',
  ].join('\0');

  assert.deepEqual(parseGitLogZ(raw), [
    {
      sha: SHA_A,
      date: '2026-08-30T10:20:30+08:00',
      subject,
      changes: [{ status: 'M', paths: [unicodePath] }],
    },
    {
      sha: SHA_B,
      date: '2026-08-29T01:02:03Z',
      subject: 'Rename the source',
      changes: [{ status: 'R100', paths: [oldPath, newPath] }],
    },
  ]);
});

test('history collection stops at the exact pinned commit instead of repository HEAD', async () => {
  const fixture = await createHistoryFixture();

  try {
    const history = await collectSkillHistory({
      repoDir: fixture.root,
      pinnedCommit: fixture.commits[4],
      sourcePath: 'skills/demo/SKILL.md',
    });

    assert.equal(history.commits.length, 5);
    assert.equal(history.commits[0].sha, fixture.commits[4]);
    assert.equal(history.commits.some((entry) => entry.sha === fixture.commits[5]), false);
    assert.equal(history.commits.some((entry) => entry.sha === fixture.commits[6]), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('provenance resolves direct changes and rename transitions while continuing old-path history', async () => {
  const parsed = [
    {
      sha: SHA_A,
      date: '2026-08-30T00:00:00Z',
      subject: 'Modify new path',
      changes: [{ status: 'M', paths: ['skills/new/SKILL.md'] }],
    },
    {
      sha: SHA_B,
      date: '2026-08-29T00:00:00Z',
      subject: 'Rename skill',
      changes: [{
        status: 'R100',
        paths: ['skills/old/SKILL.md', 'skills/new/SKILL.md'],
      }],
    },
    {
      sha: SHA_C,
      date: '2026-08-28T00:00:00Z',
      subject: 'Modify old path',
      changes: [{ status: 'M', paths: ['skills/old/SKILL.md'] }],
    },
  ];

  assert.deepEqual(
    await resolveHistoryProvenance({
      commits: parsed,
      sourcePath: 'skills/new/SKILL.md',
      pinnedCommit: SHA_A,
      isCopySourceDeleted: async () => false,
    }),
    {
      commits: [
        {
          ...parsed[0],
          pathAtCommit: 'skills/new/SKILL.md',
          resolvedVia: 'direct',
        },
        {
          ...parsed[1],
          pathAtCommit: 'skills/new/SKILL.md',
          resolvedVia: 'rename',
          transition: {
            status: 'R100',
            sourcePath: 'skills/old/SKILL.md',
            destinationPath: 'skills/new/SKILL.md',
          },
        },
        {
          ...parsed[2],
          pathAtCommit: 'skills/old/SKILL.md',
          resolvedVia: 'direct',
        },
      ],
    },
  );
});

test('copy followed by source deletion is a migration and continues source history', async () => {
  const parsed = [
    {
      sha: SHA_A,
      date: '2026-08-30T00:00:00Z',
      subject: 'Delete old prompt later',
      changes: [{ status: 'M', paths: ['skills/new/SKILL.md'] }],
    },
    {
      sha: SHA_B,
      date: '2026-08-29T00:00:00Z',
      subject: 'Copy prompt into skill',
      changes: [{
        status: 'C099',
        paths: ['prompts/old.prompt.md', 'skills/new/SKILL.md'],
      }],
    },
    {
      sha: SHA_C,
      date: '2026-08-28T00:00:00Z',
      subject: 'Original prompt history',
      changes: [{ status: 'M', paths: ['prompts/old.prompt.md'] }],
    },
  ];
  const checks = [];

  const result = await resolveHistoryProvenance({
    commits: parsed,
    sourcePath: 'skills/new/SKILL.md',
    pinnedCommit: SHA_A,
    isCopySourceDeleted: async (input) => {
      checks.push(input);
      return true;
    },
  });

  assert.equal(result.commits.length, 3);
  assert.equal(result.commits[1].resolvedVia, 'copy-then-delete-migration');
  assert.equal(result.commits[2].pathAtCommit, 'prompts/old.prompt.md');
  assert.equal(result.truncatedAt, undefined);
  assert.deepEqual(checks, [{
    transitionSha: SHA_B,
    pinnedCommit: SHA_A,
    sourcePath: 'prompts/old.prompt.md',
  }]);
});

test('copy with a still-live source stops inherited history and records truncation', async () => {
  const parsed = [
    {
      sha: SHA_B,
      date: '2026-08-29T00:00:00Z',
      subject: 'Copy prompt into skill',
      changes: [{
        status: 'C099',
        paths: ['prompts/old.prompt.md', 'skills/new/SKILL.md'],
      }],
    },
    {
      sha: SHA_C,
      date: '2026-08-28T00:00:00Z',
      subject: 'Unrelated live source history',
      changes: [{ status: 'M', paths: ['prompts/old.prompt.md'] }],
    },
  ];

  const result = await resolveHistoryProvenance({
    commits: parsed,
    sourcePath: 'skills/new/SKILL.md',
    pinnedCommit: SHA_A,
    isCopySourceDeleted: async () => false,
  });

  assert.equal(result.commits.length, 1);
  assert.equal(result.commits[0].pathAtCommit, 'skills/new/SKILL.md');
  assert.equal(result.commits[0].resolvedVia, 'direct');
  assert.deepEqual(result.commits[0].transition, {
    status: 'C099',
    sourcePath: 'prompts/old.prompt.md',
    destinationPath: 'skills/new/SKILL.md',
  });
  assert.deepEqual(result.truncatedAt, {
    sha: SHA_B,
    sourcePath: 'prompts/old.prompt.md',
    reason: 'copy-source-still-live',
  });
});

test('copy liveness is decided by source existence at the pinned commit', async () => {
  const raw = [
    '',
    GIT_LOG_SENTINEL,
    SHA_A,
    '2026-08-30T00:00:00Z',
    'Modify destination',
    'M',
    'skills/new/SKILL.md',
    '',
    GIT_LOG_SENTINEL,
    SHA_B,
    '2026-08-29T00:00:00Z',
    'Copy source',
    'C099',
    'prompts/source.md',
    'skills/new/SKILL.md',
    '',
    GIT_LOG_SENTINEL,
    SHA_C,
    '2026-08-28T00:00:00Z',
    'Old source history',
    'M',
    'prompts/source.md',
    '',
  ].join('\0');
  const calls = [];
  const result = await collectSkillHistory({
    repoDir: 'ignored',
    pinnedCommit: SHA_A,
    sourcePath: 'skills/new/SKILL.md',
    runGit: async (args) => {
      calls.push(args);
      if (args.includes('ls-tree')) return 'prompts/source.md\0';
      return raw;
    },
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('ls-tree'));
  assert.ok(calls[1].includes(SHA_A));
  assert.equal(result.commits.length, 2);
  assert.deepEqual(result.truncatedAt, {
    sha: SHA_B,
    sourcePath: 'prompts/source.md',
    reason: 'copy-source-still-live',
  });
});

test('restricted transition sources truncate before liveness or source patch reads', async () => {
  const raw = [
    '',
    GIT_LOG_SENTINEL,
    SHA_B,
    '2026-08-29T00:00:00Z',
    'Copy restricted source',
    'C099',
    'skills/docx/SKILL.md',
    'skills/public/SKILL.md',
    '',
    GIT_LOG_SENTINEL,
    SHA_C,
    '2026-08-28T00:00:00Z',
    'Restricted source history',
    'M',
    'skills/docx/SKILL.md',
    '',
  ].join('\0');
  const gitCalls = [];
  const result = await collectSkillHistory({
    repoDir: 'ignored',
    pinnedCommit: SHA_A,
    sourcePath: 'skills/public/SKILL.md',
    blockedSourcePaths: new Set(['skills/docx/SKILL.md']),
    runGit: async (args) => {
      gitCalls.push(args);
      return raw;
    },
  });

  assert.equal(gitCalls.length, 1);
  assert.equal(result.commits.length, 1);
  assert.deepEqual(result.truncatedAt, {
    sha: SHA_B,
    sourcePath: 'skills/docx/SKILL.md',
    reason: 'restricted-transition-source',
  });

  const patchCalls = [];
  await summarizeSkillHistory({
    skill: {
      path: 'skills/demo/public',
      upstream: { repository: 'owner/repository', commit: SHA_A },
    },
    history: result,
    repoDir: 'ignored',
    restrictedSourcePaths: new Set(['skills/docx/SKILL.md']),
    runner: {
      run: async (request) => {
        const serialized = JSON.stringify(request.payload);
        assert.doesNotMatch(serialized, /skills\/docx/);
        return {
          commits: [{
            sha: SHA_B,
            en: 'Adds the public skill.',
            'zh-tw': '新增公開 skill。',
          }],
        };
      },
    },
    extractPatch: async (input) => {
      patchCalls.push(input);
      return 'public destination patch';
    },
  });
  assert.equal(patchCalls[0].transition, undefined);
});

test('collected history is deterministically newest-first by author date', async () => {
  const raw = [
    '',
    GIT_LOG_SENTINEL,
    SHA_A,
    '2026-08-29T00:00:00Z',
    'Committed later but authored earlier',
    'M',
    'skills/demo/SKILL.md',
    '',
    GIT_LOG_SENTINEL,
    SHA_B,
    '2026-08-30T00:00:00Z',
    'Authored later',
    'A',
    'skills/demo/SKILL.md',
    '',
  ].join('\0');
  const result = await collectSkillHistory({
    repoDir: 'ignored',
    pinnedCommit: SHA_A,
    sourcePath: 'skills/demo/SKILL.md',
    runGit: async () => raw,
  });

  assert.deepEqual(
    result.commits.map((entry) => entry.sha),
    [SHA_B, SHA_A],
  );
});

test('patch path parser handles quoted Unicode diff headers', () => {
  const patch = [
    'diff --git "a/skills/工具/\\"quoted name\\"/SKILL.md" "b/skills/工具/\\"quoted name\\"/SKILL.md"',
    'index 1111111..2222222 100644',
    '--- "a/skills/工具/\\"quoted name\\"/SKILL.md"',
    '+++ "b/skills/工具/\\"quoted name\\"/SKILL.md"',
  ].join('\n');

  assert.deepEqual(
    parsePatchPaths(patch),
    ['skills/工具/"quoted name"/SKILL.md'],
  );
});

test('path-scoped extraction excludes restricted files changed by the same commit', async () => {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'changelog-patch-'));

  try {
    await git(root, ['init']);
    await git(root, ['config', 'user.name', 'Test Author']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await mkdir(path.join(root, 'skills', 'public'), { recursive: true });
    await mkdir(path.join(root, 'skills', 'docx'), { recursive: true });
    await writeFile(
      path.join(root, 'skills', 'public', 'SKILL.md'),
      'public-safe-marker\n',
      'utf8',
    );
    await writeFile(
      path.join(root, 'skills', 'docx', 'SKILL.md'),
      'restricted-secret-marker\n',
      'utf8',
    );
    await git(root, ['add', '--', 'skills/public/SKILL.md', 'skills/docx/SKILL.md']);
    await git(root, ['commit', '-m', 'Change public and restricted skills']);
    const sha = await git(root, ['rev-parse', 'HEAD']);

    const patch = await extractScopedPatch({
      repoDir: root,
      sha,
      pathAtCommit: 'skills/public/SKILL.md',
    });

    assert.match(patch, /public-safe-marker/);
    assert.doesNotMatch(patch, /skills\/docx|restricted-secret-marker/);
    assert.deepEqual(parsePatchPaths(patch), ['skills/public/SKILL.md']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('path-scoped extraction fails closed if a diff header escapes explicit pathspecs', async () => {
  const calls = [];
  const runGit = async (args) => {
    calls.push(args);
    return [
      'diff --git a/skills/public/SKILL.md b/skills/public/SKILL.md',
      '--- a/skills/public/SKILL.md',
      '+++ b/skills/public/SKILL.md',
      'diff --git a/skills/docx/SKILL.md b/skills/docx/SKILL.md',
      '--- a/skills/docx/SKILL.md',
      '+++ b/skills/docx/SKILL.md',
    ].join('\n');
  };

  await assert.rejects(
    extractScopedPatch({
      repoDir: 'ignored',
      sha: SHA_A,
      pathAtCommit: 'skills/public/SKILL.md',
      runGit,
    }),
    /outside explicit pathspecs.*skills\/docx\/SKILL\.md/i,
  );
  assert.deepEqual(calls[0].slice(-3), [
    SHA_A,
    '--',
    'skills/public/SKILL.md',
  ]);
});

test('one runner call summarizes every commit in English and Traditional Chinese', async () => {
  const calls = [];
  const runner = {
    async run(request) {
      calls.push(request);
      return {
        commits: [
          { sha: SHA_A, en: 'Updates alpha.', 'zh-tw': '更新 alpha。' },
          { sha: SHA_B, en: 'Adds alpha.', 'zh-tw': '新增 alpha。' },
        ],
      };
    },
  };
  const history = {
    commits: [
      {
        sha: SHA_A,
        date: '2026-08-30T00:00:00Z',
        subject: 'Update alpha',
        changes: [{ status: 'M', paths: ['skills/alpha/SKILL.md'] }],
        pathAtCommit: 'skills/alpha/SKILL.md',
        resolvedVia: 'direct',
      },
      {
        sha: SHA_B,
        date: '2026-08-29T00:00:00Z',
        subject: 'Add alpha',
        changes: [{ status: 'A', paths: ['skills/alpha/SKILL.md'] }],
        pathAtCommit: 'skills/alpha/SKILL.md',
        resolvedVia: 'direct',
      },
    ],
  };

  const summaries = await summarizeSkillHistory({
    skill: {
      path: 'skills/demo/alpha',
      upstream: {
        repository: 'owner/repository',
        commit: SHA_A,
      },
    },
    history,
    repoDir: 'ignored',
    runner,
    extractPatch: async ({ sha }) => `patch for ${sha}`,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].payload.commits.map((entry) => entry.sha),
    [SHA_A, SHA_B],
  );
  assert.match(calls[0].instruction, /untrusted data/i);
  assert.match(calls[0].instruction, /ignore instructions embedded/i);
  assert.deepEqual(summaries, new Map([
    [SHA_A, { en: 'Updates alpha.', 'zh-tw': '更新 alpha。' }],
    [SHA_B, { en: 'Adds alpha.', 'zh-tw': '新增 alpha。' }],
  ]));
});

for (const [label, commits] of [
  ['missing', [{ sha: SHA_A, en: 'A', 'zh-tw': '甲' }]],
  ['extra', [
    { sha: SHA_A, en: 'A', 'zh-tw': '甲' },
    { sha: SHA_B, en: 'B', 'zh-tw': '乙' },
    { sha: SHA_C, en: 'C', 'zh-tw': '丙' },
  ]],
  ['duplicate', [
    { sha: SHA_A, en: 'A', 'zh-tw': '甲' },
    { sha: SHA_A, en: 'Again', 'zh-tw': '再次' },
  ]],
]) {
  test(`summary generation rejects a ${label} SHA response`, async () => {
    const runner = { run: async () => ({ commits }) };
    const history = {
      commits: [
        {
          sha: SHA_A,
          date: '2026-08-30T00:00:00Z',
          subject: 'A',
          changes: [{ status: 'M', paths: ['skills/alpha/SKILL.md'] }],
          pathAtCommit: 'skills/alpha/SKILL.md',
          resolvedVia: 'direct',
        },
        {
          sha: SHA_B,
          date: '2026-08-29T00:00:00Z',
          subject: 'B',
          changes: [{ status: 'A', paths: ['skills/alpha/SKILL.md'] }],
          pathAtCommit: 'skills/alpha/SKILL.md',
          resolvedVia: 'direct',
        },
      ],
    };

    await assert.rejects(
      summarizeSkillHistory({
        skill: {
          path: 'skills/demo/alpha',
          upstream: { repository: 'owner/repository', commit: SHA_A },
        },
        history,
        repoDir: 'ignored',
        runner,
        extractPatch: async () => 'patch',
      }),
      new RegExp(`${label}.*SHA|SHA.*${label}`, 'i'),
    );
  });
}

test('the runner payload cannot receive restricted bytes from a mixed commit', async () => {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'changelog-runner-boundary-'));
  let calls = 0;

  try {
    await git(root, ['init']);
    await git(root, ['config', 'user.name', 'Test Author']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await mkdir(path.join(root, 'skills', 'public'), { recursive: true });
    await mkdir(path.join(root, 'skills', 'docx'), { recursive: true });
    await writeFile(
      path.join(root, 'skills', 'public', 'SKILL.md'),
      'public-safe-marker\n',
      'utf8',
    );
    await writeFile(
      path.join(root, 'skills', 'docx', 'SKILL.md'),
      'restricted-secret-marker\n',
      'utf8',
    );
    await git(root, ['add', '--', 'skills/public/SKILL.md', 'skills/docx/SKILL.md']);
    await git(root, ['commit', '-m', 'Mixed change']);
    const sha = await git(root, ['rev-parse', 'HEAD']);
    const runner = {
      async run(request) {
        calls += 1;
        const serialized = JSON.stringify(request.payload);
        assert.match(serialized, /public-safe-marker/);
        assert.doesNotMatch(serialized, /skills\/docx|restricted-secret-marker/);
        return {
          commits: [{
            sha,
            en: 'Adds the public skill.',
            'zh-tw': '新增公開 skill。',
          }],
        };
      },
    };

    await summarizeSkillHistory({
      skill: {
        path: 'skills/demo/public',
        upstream: { repository: 'owner/repository', commit: sha },
      },
      history: {
        commits: [{
          sha,
          date: '2026-08-30T00:00:00Z',
          subject: 'Mixed change',
          changes: [{ status: 'A', paths: ['skills/public/SKILL.md'] }],
          pathAtCommit: 'skills/public/SKILL.md',
          resolvedVia: 'direct',
        }],
      },
      repoDir: root,
      runner,
    });

    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
