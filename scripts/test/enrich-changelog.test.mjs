import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHANGELOG_GENERATOR_VERSION,
  CHANGELOG_LLM_TIMEOUT_MS,
  CHANGELOG_PROMPT_HASH,
  cloneFullUpstream,
  createChangelogArtifact,
  generateChangelogs,
  isChangelogArtifactCurrent,
  parseChangelogArgs,
  writeChangelogArtifact,
} from '../enrich-changelog.mjs';
import { enrichmentArtifactPath } from '../lib/enrichment.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.join(__dirname, '.runtime');
const HASH_A = `sha256:${'a'.repeat(64)}`;
const SHA_A = '1111111111111111111111111111111111111111';
const SHA_B = '2222222222222222222222222222222222222222';

function skill(overrides = {}) {
  return {
    path: 'skills/demo/alpha',
    name: 'alpha',
    category: 'mapped',
    redistributable: true,
    snapshotHash: `sha256:${'b'.repeat(64)}`,
    contentHash: HASH_A,
    upstream: {
      repository: 'owner/repository',
      reference: 'refs/heads/main',
      source: 'skills/alpha',
      commit: SHA_A,
    },
    ...overrides,
  };
}

function history() {
  return {
    commits: [{
      sha: SHA_A,
      date: '2026-08-30T00:00:00Z',
      subject: '新增 alpha skill',
      changes: [{ status: 'A', paths: ['skills/alpha/SKILL.md'] }],
      pathAtCommit: 'skills/alpha/SKILL.md',
      resolvedVia: 'direct',
    }],
  };
}

async function createGeneratorFixture(skills, enabled = false) {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'changelog-generate-'));
  await mkdir(path.join(root, 'catalog', 'enrichment'), { recursive: true });
  await writeFile(
    path.join(root, 'catalog', 'skills.lock.json'),
    `${JSON.stringify({ release: '1.0.0', skills }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(root, 'catalog', 'enrichment', 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      enabled: { summaries: false, changelog: enabled },
    }, null, 2)}\n`,
    'utf8',
  );
  return root;
}

function historyFor(targetSkill) {
  return {
    commits: [{
      sha: targetSkill.upstream.commit,
      date: '2026-08-30T00:00:00Z',
      subject: `Add ${targetSkill.name}`,
      changes: [{
        status: 'A',
        paths: [`${targetSkill.upstream.source}/SKILL.md`],
      }],
      pathAtCommit: `${targetSkill.upstream.source}/SKILL.md`,
      resolvedVia: 'direct',
    }],
  };
}

test('artifact builder creates signed en and zh-tw locales plus deterministic zh-cn', () => {
  const value = createChangelogArtifact({
    skill: skill(),
    history: history(),
    summaries: new Map([[
      SHA_A,
      {
        en: 'Adds the alpha skill.',
        'zh-tw': '新增 alpha 軟體 skill。',
      },
    ]]),
  });

  assert.equal(value.path, 'skills/demo/alpha');
  assert.equal(value.freshnessKey.pinnedCommit, SHA_A);
  assert.equal(value.locales.en.model, 'gpt-5.4');
  assert.equal(value.locales.en.promptHash, CHANGELOG_PROMPT_HASH);
  assert.equal(value.locales.en.generatorVersion, CHANGELOG_GENERATOR_VERSION);
  assert.equal(value.locales['zh-tw'].content.commits[0].summary, '新增 alpha 軟體 skill。');
  assert.equal(value.locales['zh-cn'].content.commits[0].summary, '添加 alpha 软件 skill。');
  assert.equal(value.locales['zh-cn'].content.commits[0].subject, '新增 alpha skill');
  assert.equal(isChangelogArtifactCurrent(value, skill()), true);
});

test('generatorVersion-only changes invalidate changelog cache signatures', () => {
  const value = createChangelogArtifact({
    skill: skill(),
    history: history(),
    summaries: new Map([[
      SHA_A,
      { en: 'Adds alpha.', 'zh-tw': '新增 alpha。' },
    ]]),
  });

  assert.equal(
    isChangelogArtifactCurrent(value, skill(), {
      generatorVersion: CHANGELOG_GENERATOR_VERSION + 1,
    }),
    false,
  );
});

test('author-date ordering drift invalidates a changelog artifact', () => {
  const targetSkill = skill();
  const value = createChangelogArtifact({
    skill: targetSkill,
    history: {
      commits: [
        {
          ...history().commits[0],
          sha: SHA_A,
          date: '2026-08-29T00:00:00Z',
        },
        {
          ...history().commits[0],
          sha: SHA_B,
          date: '2026-08-30T00:00:00Z',
        },
      ],
    },
    summaries: new Map([
      [SHA_A, { en: 'Earlier.', 'zh-tw': '較早。' }],
      [SHA_B, { en: 'Later.', 'zh-tw': '較晚。' }],
    ]),
  });

  assert.equal(isChangelogArtifactCurrent(value, targetSkill), false);
});

test('empty changelog history is never cache-current', () => {
  const targetSkill = skill();
  const value = createChangelogArtifact({
    skill: targetSkill,
    history: history(),
    summaries: new Map([[
      SHA_A,
      { en: 'Adds alpha.', 'zh-tw': '新增 alpha。' },
    ]]),
  });

  for (const locale of Object.values(value.locales)) {
    locale.content.commits = [];
  }

  assert.equal(isChangelogArtifactCurrent(value, targetSkill), false);
});

test('changelog commit links must match the pinned upstream repository and SHA', () => {
  const targetSkill = skill();
  const value = createChangelogArtifact({
    skill: targetSkill,
    history: history(),
    summaries: new Map([[
      SHA_A,
      { en: 'Adds alpha.', 'zh-tw': '新增 alpha。' },
    ]]),
  });

  for (const locale of Object.values(value.locales)) {
    locale.content.commits[0].url =
      `https://github.com/other/repository/commit/${SHA_B}`;
  }

  assert.equal(isChangelogArtifactCurrent(value, targetSkill), false);
});

test('changelog cache rejects locale metadata drift', () => {
  const targetSkill = skill();
  const value = createChangelogArtifact({
    skill: targetSkill,
    history: history(),
    summaries: new Map([[
      SHA_A,
      { en: 'Adds alpha.', 'zh-tw': '新增 alpha。' },
    ]]),
  });
  value.locales['zh-tw'].content.commits[0].pathAtCommit =
    'skills/other/SKILL.md';

  assert.equal(isChangelogArtifactCurrent(value, targetSkill), false);
});

test('changelog cache rejects zh-cn content that is not derived from zh-tw', () => {
  const targetSkill = skill();
  const value = createChangelogArtifact({
    skill: targetSkill,
    history: history(),
    summaries: new Map([[
      SHA_A,
      { en: 'Adds alpha.', 'zh-tw': '新增 alpha。' },
    ]]),
  });
  value.locales['zh-cn'].content.commits[0].summary = 'CORRUPTED';

  assert.equal(isChangelogArtifactCurrent(value, targetSkill), false);
});

test('changelog Copilot calls allow large path-scoped multi-commit payloads to finish', () => {
  assert.equal(CHANGELOG_LLM_TIMEOUT_MS, 300_000);
});

test('full upstream clone uses one no-checkout single-branch clone without shallow history', async () => {
  const calls = [];
  const result = await cloneFullUpstream({
    repository: 'owner/repository',
    reference: 'refs/heads/main',
    destination: 'C:\\work\\clone',
    runGit: async (args) => {
      calls.push(args);
      return '';
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    'clone',
    '--no-checkout',
    '--single-branch',
    '--branch',
    'main',
    '--config',
    'core.autocrlf=false',
    '--',
    'https://github.com/owner/repository.git',
    'C:\\work\\clone',
  ]);
  assert.equal(calls[0].includes('--depth'), false);
  assert.deepEqual(result, {
    dir: 'C:\\work\\clone',
    ref: 'main',
  });
});

test('CLI parser supports check and one skill selector while rejecting unknown arguments', () => {
  assert.deepEqual(parseChangelogArgs([]), { check: false, skill: null });
  assert.deepEqual(parseChangelogArgs(['--check']), { check: true, skill: null });
  assert.deepEqual(parseChangelogArgs(['--skill', 'alpha']), {
    check: false,
    skill: 'alpha',
  });
  assert.throws(() => parseChangelogArgs(['--unknown']), /unknown.*--unknown/i);
  assert.throws(() => parseChangelogArgs(['--skill']), /--skill.*value/i);
  assert.throws(
    () => parseChangelogArgs(['--skill', 'alpha', '--skill', 'beta']),
    /--skill.*once/i,
  );
});

test('artifact writes are deterministic, atomic, and end with one newline', async () => {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'changelog-write-'));
  const value = createChangelogArtifact({
    skill: skill(),
    history: history(),
    summaries: new Map([[
      SHA_A,
      { en: 'Adds alpha.', 'zh-tw': '新增 alpha。' },
    ]]),
  });

  try {
    const target = enrichmentArtifactPath(root, 'changelog', value.path);
    await writeChangelogArtifact({ repoRoot: root, artifact: value });
    const first = await readFile(target, 'utf8');
    await writeChangelogArtifact({ repoRoot: root, artifact: value });
    const second = await readFile(target, 'utf8');

    assert.equal(first, second);
    assert.match(first, /\n$/);
    assert.doesNotMatch(first, /\n\n$/);
    assert.deepEqual(await readdir(path.dirname(target)), [path.basename(target)]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed changelog writes remove their temporary artifact', async () => {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'changelog-write-failure-'));
  const value = createChangelogArtifact({
    skill: skill(),
    history: history(),
    summaries: new Map([[
      SHA_A,
      { en: 'Adds alpha.', 'zh-tw': '新增 alpha。' },
    ]]),
  });

  try {
    await assert.rejects(
      writeChangelogArtifact({
        repoRoot: root,
        artifact: value,
        writeData: async () => {
          throw new Error('write failed');
        },
      }),
      /write failed/,
    );
    const directory = path.dirname(
      enrichmentArtifactPath(root, 'changelog', value.path),
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generation clones each upstream once, reuses it for skills, then skips fully cached upstreams', async () => {
  const alpha = skill();
  const beta = skill({
    path: 'skills/demo/beta',
    name: 'beta',
    contentHash: `sha256:${'c'.repeat(64)}`,
    upstream: {
      ...skill().upstream,
      source: 'skills/beta',
    },
  });
  const gamma = skill({
    path: 'skills/other/gamma',
    name: 'gamma',
    contentHash: `sha256:${'d'.repeat(64)}`,
    upstream: {
      repository: 'other/repository',
      reference: 'refs/heads/main',
      source: 'skills/gamma',
      commit: SHA_B,
    },
  });
  const root = await createGeneratorFixture([alpha, beta, gamma]);
  const cloneCalls = [];
  const collectCalls = [];
  const summaryCalls = [];
  const cloneRepository = async (input) => {
    cloneCalls.push(input.repository);
    await mkdir(input.destination, { recursive: true });
    return { dir: input.destination, ref: 'main' };
  };
  const collectHistory = async ({ skill: targetSkill }) => {
    collectCalls.push(targetSkill.path);
    return historyFor(targetSkill);
  };
  const summarizeHistory = async ({ skill: targetSkill }) => {
    summaryCalls.push(targetSkill.path);
    return new Map([[
      targetSkill.upstream.commit,
      { en: `Adds ${targetSkill.name}.`, 'zh-tw': `新增 ${targetSkill.name}。` },
    ]]);
  };

  try {
    const first = await generateChangelogs({
      repoRoot: root,
      runner: {},
      workRoot: path.join(root, '.changelog-work-test'),
      cloneRepository,
      collectHistory,
      summarizeHistory,
    });

    assert.deepEqual(cloneCalls.sort(), ['other/repository', 'owner/repository']);
    assert.equal(collectCalls.length, 3);
    assert.equal(summaryCalls.length, 3);
    assert.deepEqual({
      eligible: first.eligible,
      generated: first.generated,
      cacheHits: first.cacheHits,
      clonedUpstreams: first.clonedUpstreams,
      skippedUpstreams: first.skippedUpstreams,
      runnerCalls: first.runnerCalls,
    }, {
      eligible: 3,
      generated: 3,
      cacheHits: 0,
      clonedUpstreams: 2,
      skippedUpstreams: 0,
      runnerCalls: 3,
    });
    assert.equal(first.model, 'gpt-5.4');
    assert.equal(typeof first.cloneBytes, 'number');
    assert.equal(typeof first.cloneTimeMs, 'number');
    assert.equal(typeof first.copilotTimeMs, 'number');
    assert.deepEqual(
      first.upstreams.map((entry) => entry.repository).sort(),
      ['other/repository', 'owner/repository'],
    );
    const enabledManifest = JSON.parse(
      await readFile(path.join(root, 'catalog', 'enrichment', 'manifest.json'), 'utf8'),
    );
    assert.equal(enabledManifest.enabled.changelog, true);
    await assert.rejects(
      readFile(path.join(root, '.changelog-work-test')),
      /ENOENT|EISDIR/,
    );

    cloneCalls.length = 0;
    collectCalls.length = 0;
    summaryCalls.length = 0;
    const second = await generateChangelogs({
      repoRoot: root,
      runner: {},
      workRoot: path.join(root, '.changelog-work-test-2'),
      cloneRepository: async () => {
        throw new Error('cache hit must skip clone');
      },
      collectHistory,
      summarizeHistory,
    });

    assert.deepEqual({
      eligible: second.eligible,
      generated: second.generated,
      cacheHits: second.cacheHits,
      clonedUpstreams: second.clonedUpstreams,
      skippedUpstreams: second.skippedUpstreams,
      runnerCalls: second.runnerCalls,
    }, {
      eligible: 3,
      generated: 0,
      cacheHits: 3,
      clonedUpstreams: 0,
      skippedUpstreams: 2,
      runnerCalls: 0,
    });
    assert.equal(second.cloneBytes, 0);
    assert.equal(second.upstreams.every((entry) => entry.skipped), true);
    assert.equal(collectCalls.length, 0);
    assert.equal(summaryCalls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('check mode validates signatures and freshness without cloning, running Copilot, or writing', async () => {
  const targetSkill = skill();
  const root = await createGeneratorFixture([targetSkill], true);
  const value = createChangelogArtifact({
    skill: targetSkill,
    history: historyFor(targetSkill),
    summaries: new Map([[
      targetSkill.upstream.commit,
      { en: 'Adds alpha.', 'zh-tw': '新增 alpha。' },
    ]]),
  });

  try {
    await writeChangelogArtifact({ repoRoot: root, artifact: value });
    const result = await generateChangelogs({
      repoRoot: root,
      check: true,
      runner: { run: async () => { throw new Error('runner called'); } },
      cloneRepository: async () => { throw new Error('clone called'); },
    });
    assert.deepEqual({
      eligible: result.eligible,
      generated: result.generated,
      cacheHits: result.cacheHits,
      clonedUpstreams: result.clonedUpstreams,
      skippedUpstreams: result.skippedUpstreams,
      runnerCalls: result.runnerCalls,
    }, {
      eligible: 1,
      generated: 0,
      cacheHits: 1,
      clonedUpstreams: 0,
      skippedUpstreams: 1,
      runnerCalls: 0,
    });

    value.locales.en.generatorVersion += 1;
    await writeChangelogArtifact({ repoRoot: root, artifact: value });
    await assert.rejects(
      generateChangelogs({ repoRoot: root, check: true, runner: {} }),
      /stale or signature-mismatched.*skills\/demo\/alpha/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generation cleans clone work on failure and never enables a partial artifact set', async () => {
  const alpha = skill();
  const beta = skill({
    path: 'skills/demo/beta',
    name: 'beta',
    contentHash: `sha256:${'c'.repeat(64)}`,
    upstream: {
      ...skill().upstream,
      source: 'skills/beta',
    },
  });

  const root = await createGeneratorFixture([alpha, beta]);
  const workRoot = path.join(root, '.changelog-work-failure');

  try {
    await assert.rejects(
      generateChangelogs({
        repoRoot: root,
        runner: {},
        workRoot,
        cloneRepository: async (input) => {
          await mkdir(input.destination, { recursive: true });
          return { dir: input.destination, ref: 'main' };
        },
        collectHistory: async ({ skill: targetSkill }) => {
          if (targetSkill.name === 'beta') {
            throw new Error('persistent skill failure');
          }
          return historyFor(targetSkill);
        },
        summarizeHistory: async ({ skill: targetSkill }) => new Map([[
          targetSkill.upstream.commit,
          { en: 'Adds alpha.', 'zh-tw': '新增 alpha。' },
        ]]),
      }),
      /persistent skill failure/,
    );
    await assert.rejects(readFile(workRoot), /ENOENT|EISDIR/);
    const manifest = JSON.parse(
      await readFile(path.join(root, 'catalog', 'enrichment', 'manifest.json'), 'utf8'),
    );
    assert.equal(manifest.enabled.changelog, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generation blocks every path beneath a restricted upstream skill directory', async () => {
  const publicSkill = skill();
  const restrictedSkill = skill({
    path: 'skills/demo/docx',
    name: 'docx',
    redistributable: false,
    contentHash: `sha256:${'e'.repeat(64)}`,
    upstream: {
      ...skill().upstream,
      source: 'skills/docx',
    },
  });
  const root = await createGeneratorFixture([publicSkill, restrictedSkill]);
  let observedBlockedPaths;

  try {
    await generateChangelogs({
      repoRoot: root,
      runner: {},
      workRoot: path.join(root, '.changelog-work-restricted-prefix'),
      cloneRepository: async (input) => {
        await mkdir(input.destination, { recursive: true });
        return { dir: input.destination, ref: 'main' };
      },
      collectHistory: async ({ skill: targetSkill, blockedSourcePaths }) => {
        observedBlockedPaths = [...blockedSourcePaths];
        return historyFor(targetSkill);
      },
      summarizeHistory: async ({ skill: targetSkill }) => new Map([[
        targetSkill.upstream.commit,
        { en: 'Adds alpha.', 'zh-tw': '新增 alpha。' },
      ]]),
    });

    assert.deepEqual(observedBlockedPaths, ['skills/docx/']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a skill selector accepts path or unique name and does not enable the global manifest', async () => {
  const alpha = skill();
  const beta = skill({
    path: 'skills/demo/beta',
    name: 'beta',
    contentHash: `sha256:${'c'.repeat(64)}`,
    upstream: {
      ...skill().upstream,
      source: 'skills/beta',
    },
  });
  const root = await createGeneratorFixture([alpha, beta]);
  const processed = [];

  try {
    const result = await generateChangelogs({
      repoRoot: root,
      skillSelector: 'beta',
      runner: {},
      workRoot: path.join(root, '.changelog-work-selector'),
      cloneRepository: async (input) => {
        await mkdir(input.destination, { recursive: true });
        return { dir: input.destination, ref: 'main' };
      },
      collectHistory: async ({ skill: targetSkill }) => {
        processed.push(targetSkill.path);
        return historyFor(targetSkill);
      },
      summarizeHistory: async ({ skill: targetSkill }) => new Map([[
        targetSkill.upstream.commit,
        { en: 'Adds beta.', 'zh-tw': '新增 beta。' },
      ]]),
    });

    assert.deepEqual(processed, ['skills/demo/beta']);
    assert.equal(result.eligible, 1);
    const manifest = JSON.parse(
      await readFile(path.join(root, 'catalog', 'enrichment', 'manifest.json'), 'utf8'),
    );
    assert.equal(manifest.enabled.changelog, false);
    await assert.rejects(
      generateChangelogs({
        repoRoot: root,
        skillSelector: 'unknown',
        runner: {},
      }),
      /unknown changelog skill.*unknown/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('package script exposes enrich:changelog and clone scratch directories stay ignored', async () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const packageJson = JSON.parse(
    await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  const gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');

  assert.equal(
    packageJson.scripts['enrich:changelog'],
    'node scripts/enrich-changelog.mjs',
  );
  assert.match(gitignore, /^\/\.changelog-work-\*\/$/m);
});

test('generation overlaps per-skill Copilot work within a shared upstream clone', async () => {
  const alpha = skill();
  const beta = skill({
    path: 'skills/demo/beta',
    name: 'beta',
    contentHash: `sha256:${'c'.repeat(64)}`,
    upstream: {
      ...skill().upstream,
      source: 'skills/beta',
    },
  });
  const root = await createGeneratorFixture([alpha, beta]);
  let active = 0;
  let maximumActive = 0;

  try {
    await generateChangelogs({
      repoRoot: root,
      runner: {},
      workRoot: path.join(root, '.changelog-work-concurrency'),
      cloneRepository: async (input) => {
        await mkdir(input.destination, { recursive: true });
        return { dir: input.destination, ref: 'main' };
      },
      collectHistory: async ({ skill: targetSkill }) => historyFor(targetSkill),
      summarizeHistory: async ({ skill: targetSkill }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return new Map([[
          targetSkill.upstream.commit,
          { en: 'Adds skill.', 'zh-tw': '新增 skill。' },
        ]]);
      },
    });

    assert.equal(maximumActive, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
