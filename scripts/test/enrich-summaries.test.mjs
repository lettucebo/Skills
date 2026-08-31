import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { COPILOT_CLI_CONTRACT } from '../lib/llm.mjs';
import { isEligibleForEnrichment } from '../lib/enrichment.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const runtimeRoot = path.join(__dirname, '.runtime');
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

function mappedSkill(overrides = {}) {
  return {
    path: 'skills/demo/alpha',
    name: 'alpha',
    category: 'mapped',
    version: '1.0.0',
    baseline: 'verified',
    license: 'MIT',
    redistributable: true,
    snapshotHash: HASH_B,
    contentHash: HASH_A,
    upstream: {
      repository: 'owner/repository',
      reference: 'refs/heads/main',
      source: 'skills/alpha',
      commit: '0123456789abcdef0123456789abcdef01234567',
    },
    ...overrides,
  };
}

function orphanSkill(overrides = {}) {
  return mappedSkill({
    path: 'skills/demo/orphan',
    name: 'orphan',
    category: 'orphan',
    baseline: null,
    contentHash: undefined,
    upstream: null,
    ...overrides,
  });
}

async function createFixture({
  skills = [mappedSkill()],
  enabled = { summaries: false, changelog: false },
} = {}) {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'summaries-'));
  await mkdir(path.join(root, 'catalog', 'enrichment'), { recursive: true });
  await writeFile(
    path.join(root, 'catalog', 'skills.lock.json'),
    `${JSON.stringify({ release: '1.0.0', generatedAt: '2026-01-01T00:00:00Z', skills }, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, 'catalog', 'enrichment', 'manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, enabled }, null, 2)}\n`,
  );
  for (const skill of skills) {
    const skillDirectory = path.join(root, ...skill.path.split('/'));
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      path.join(skillDirectory, 'SKILL.md'),
      `---\nname: ${skill.name}\ndescription: Agent trigger for ${skill.name}.\n---\n\n# ${skill.name}\n`,
    );
  }
  return root;
}

function response() {
  return {
    en: {
      purpose: 'Creates a useful software result.',
      whenToUse: 'Use it when the documented workflow applies.',
      outputs: 'Produces the requested files or changes.',
    },
    'zh-tw': {
      purpose: '建立實用的軟體成果。',
      whenToUse: '適合在文件描述的工作流程適用時使用。',
      outputs: '產生所需的檔案或變更。',
    },
  };
}

function runnerReturning(value = response()) {
  const calls = [];
  return {
    calls,
    async run(request) {
      calls.push(request);
      return value;
    },
  };
}

test('summary generator exposes a versioned prompt contract', async () => {
  const generator = await import('../enrich-summaries.mjs');

  assert.equal(typeof generator.PROMPT_ID, 'string');
  assert.ok(generator.PROMPT_ID.length > 0);
  assert.equal(Number.isInteger(generator.GENERATOR_VERSION), true);
  assert.ok(generator.GENERATOR_VERSION > 0);
  assert.match(generator.PROMPT_HASH, /^sha256:[0-9a-f]{64}$/);
});

test('production generation filters eligibility before SKILL.md reads and counts all 115 allowed skills', async () => {
  const { runSummaryEnrichment } = await import('../enrich-summaries.mjs');
  const repositoryCheck = await runSummaryEnrichment({ repoRoot, check: true });
  const lock = JSON.parse(
    await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
  );

  assert.equal(repositoryCheck.eligible, 115);
  assert.deepEqual(
    lock.skills
      .filter((entry) => isEligibleForEnrichment('summaries', entry))
      .filter((entry) => entry.upstream === null)
      .map((entry) => entry.path),
    [
      'skills/dotnet/csharp-mcp-server-generator',
      'skills/github/create-github-pull-request-from-specification',
      'skills/vscode/code-review',
    ],
  );

  const restricted = mappedSkill({
    path: 'skills/claude/docx',
    name: 'docx',
    redistributable: false,
    license: 'Proprietary',
  });
  const root = await createFixture({ skills: [mappedSkill(), restricted] });
  const reads = [];
  const runner = runnerReturning();
  try {
    const generated = await runSummaryEnrichment({
      repoRoot: root,
      runner,
      readSkillFile: async (filePath) => {
        reads.push(filePath.replace(/\\/g, '/'));
        return 'trusted only as source data';
      },
    });

    assert.equal(generated.eligible, 1);
    assert.deepEqual(reads.map((value) => value.slice(root.length + 1)), [
      'skills/demo/alpha/SKILL.md',
    ]);
    assert.equal(runner.calls.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skill source reads reject unsafe lock paths before filesystem access', async () => {
  const { runSummaryEnrichment } = await import('../enrich-summaries.mjs');
  const unsafe = mappedSkill({
    path: 'skills/demo/../restricted',
    name: 'restricted',
  });
  const root = await createFixture({ skills: [unsafe] });
  let reads = 0;

  try {
    await assert.rejects(
      runSummaryEnrichment({
        repoRoot: root,
        runner: runnerReturning(),
        readSkillFile: async () => {
          reads += 1;
          return 'must not be read';
        },
      }),
      /unsafe enrichment skill path/i,
    );
    assert.equal(reads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('one runner call creates en and zh-tw while zh-cn is converted deterministically', async () => {
  const { runSummaryEnrichment } = await import('../enrich-summaries.mjs');
  const root = await createFixture();
  const runner = runnerReturning();

  try {
    const result = await runSummaryEnrichment({ repoRoot: root, runner });
    const artifact = JSON.parse(
      await readFile(
        path.join(root, 'catalog', 'enrichment', 'summaries', 'skills__demo__alpha.json'),
        'utf8',
      ),
    );

    assert.equal(result.generated, 1);
    assert.equal(result.copilotCalls, 1);
    assert.equal(runner.calls.length, 1);
    assert.deepEqual(runner.calls[0].schema.required, ['en', 'zh-tw']);
    assert.deepEqual(artifact.locales.en.content, response().en);
    assert.deepEqual(artifact.locales['zh-tw'].content, response()['zh-tw']);
    assert.deepEqual(artifact.locales['zh-cn'].content, {
      purpose: '创建实用的软件成果。',
      whenToUse: '适合在文档描述的工作流程适用时使用。',
      outputs: '产生所需的文件或变更。',
    });
    assert.equal(artifact.locales.en.model, COPILOT_CLI_CONTRACT.model);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cache requires freshness and every locale signature including generatorVersion', async () => {
  const { runSummaryEnrichment } = await import('../enrich-summaries.mjs');
  const root = await createFixture();

  try {
    const firstRunner = runnerReturning();
    await runSummaryEnrichment({ repoRoot: root, runner: firstRunner });
    assert.equal(firstRunner.calls.length, 1);

    const cachedRunner = runnerReturning();
    const cached = await runSummaryEnrichment({ repoRoot: root, runner: cachedRunner });
    assert.equal(cached.cached, 1);
    assert.equal(cachedRunner.calls.length, 0);

    const invalidatedRunner = runnerReturning();
    const invalidated = await runSummaryEnrichment({
      repoRoot: root,
      runner: invalidatedRunner,
      generatorVersion: 2,
    });
    assert.equal(invalidated.generated, 1);
    assert.equal(invalidatedRunner.calls.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--check reports missing and stale artifacts without reading skills or writing files', async () => {
  const {
    buildSummaryArtifact,
    runSummaryEnrichment,
    writeArtifactAtomically,
  } = await import('../enrich-summaries.mjs');
  const stale = mappedSkill();
  const missing = orphanSkill();
  const root = await createFixture({ skills: [stale, missing] });
  const artifactPath = path.join(
    root,
    'catalog',
    'enrichment',
    'summaries',
    'skills__demo__alpha.json',
  );
  const artifact = buildSummaryArtifact({
    skill: stale,
    summary: response(),
  });
  artifact.freshnessKey.contentHash = HASH_B;
  await writeArtifactAtomically(artifactPath, artifact);

  try {
    const result = await runSummaryEnrichment({
      repoRoot: root,
      check: true,
      readSkillFile: async () => {
        throw new Error('check mode must not read SKILL.md');
      },
      writeArtifactFile: async () => {
        throw new Error('check mode must not write');
      },
    });

    assert.deepEqual(result.missing, ['skills/demo/orphan']);
    assert.deepEqual(result.stale, ['skills/demo/alpha']);
    assert.deepEqual(result.signatureMismatched, []);
    assert.equal(result.ok, false);
    assert.equal(
      (await readFile(path.join(root, 'catalog', 'enrichment', 'manifest.json'), 'utf8'))
        .includes('"summaries": false'),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('signature-only mismatch is reported separately from stale content', async () => {
  const {
    buildSummaryArtifact,
    runSummaryEnrichment,
    writeArtifactAtomically,
  } = await import('../enrich-summaries.mjs');
  const skill = mappedSkill();
  const root = await createFixture({ skills: [skill] });
  const artifactPath = path.join(
    root,
    'catalog',
    'enrichment',
    'summaries',
    'skills__demo__alpha.json',
  );
  await writeArtifactAtomically(
    artifactPath,
    buildSummaryArtifact({ skill, summary: response(), generatorVersion: 1 }),
  );

  try {
    const result = await runSummaryEnrichment({
      repoRoot: root,
      check: true,
      generatorVersion: 2,
    });

    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.stale, []);
    assert.deepEqual(result.signatureMismatched, ['skills/demo/alpha']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact path mismatch cannot be accepted as a cache hit', async () => {
  const {
    buildSummaryArtifact,
    runSummaryEnrichment,
    writeArtifactAtomically,
  } = await import('../enrich-summaries.mjs');
  const entry = mappedSkill();
  const root = await createFixture({ skills: [entry] });
  const value = buildSummaryArtifact({ skill: entry, summary: response() });
  value.path = 'skills/demo/beta';
  await writeArtifactAtomically(
    path.join(
      root,
      'catalog',
      'enrichment',
      'summaries',
      'skills__demo__alpha.json',
    ),
    value,
  );

  try {
    const result = await runSummaryEnrichment({ repoRoot: root, check: true });
    assert.deepEqual(result.signatureMismatched, ['skills/demo/alpha']);
    assert.equal(result.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('atomic artifact writes leave no target or temporary file when rename fails', async () => {
  const { writeArtifactAtomically } = await import('../enrich-summaries.mjs');
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'atomic-'));
  const target = path.join(root, 'artifact.json');

  try {
    await assert.rejects(
      writeArtifactAtomically(target, { value: true }, {
        renameFile: async () => {
          throw new Error('rename failed');
        },
      }),
      /rename failed/,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest stays disabled when complete-set validation fails and enables after success', async () => {
  const { runSummaryEnrichment } = await import('../enrich-summaries.mjs');
  const root = await createFixture({ skills: [mappedSkill(), orphanSkill()] });

  try {
    await assert.rejects(
      runSummaryEnrichment({
        repoRoot: root,
        runner: runnerReturning(),
        validateComplete: async () => {
          throw new Error('strict validation failed');
        },
      }),
      /strict validation failed/,
    );
    let manifest = JSON.parse(
      await readFile(path.join(root, 'catalog', 'enrichment', 'manifest.json'), 'utf8'),
    );
    assert.equal(manifest.enabled.summaries, false);

    const result = await runSummaryEnrichment({
      repoRoot: root,
      runner: runnerReturning(),
    });
    manifest = JSON.parse(
      await readFile(path.join(root, 'catalog', 'enrichment', 'manifest.json'), 'utf8'),
    );
    assert.equal(result.complete, true);
    assert.equal(manifest.enabled.summaries, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('argument parsing supports check and one skill while rejecting unknown arguments', async () => {
  const { parseArguments } = await import('../enrich-summaries.mjs');

  assert.deepEqual(parseArguments(['--check', '--skill', 'alpha']), {
    check: true,
    skillSelector: 'alpha',
  });
  assert.throws(() => parseArguments(['--unknown']), /unknown.*--unknown/i);
  assert.throws(() => parseArguments(['--skill']), /--skill requires/i);
});
