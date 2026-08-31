import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createArtifactFreshnessKey,
  createLocaleSignature,
  enrichmentArtifactPath,
  isArtifactFresh,
  isEligibleForEnrichment,
  validateEnrichmentArtifact,
} from '../lib/enrichment.mjs';
import { pruneEnrichment } from '../prune-enrichment.mjs';
import { validateEnrichment } from '../validate-enrichment.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const runtimeRoot = path.join(__dirname, '.runtime');
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;
const SIGNATURE = `sha256:${'d'.repeat(64)}`;

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

function llmLocale(content = {}) {
  return {
    signature: SIGNATURE,
    producer: 'llm',
    model: 'gpt-5.4',
    promptHash: HASH_C,
    generatorVersion: 1,
    content,
  };
}

function openccLocale(content = {}) {
  return {
    signature: SIGNATURE,
    producer: 'opencc',
    converterVersion: '1.0.6',
    generatorVersion: 1,
    content,
  };
}

function artifact(skill, kind = 'summaries', overrides = {}) {
  const content = kind === 'summaries'
    ? {
        purpose: 'Explains the skill purpose.',
        whenToUse: 'Use it when the skill applies.',
        outputs: 'Produces the documented result.',
      }
    : { text: 'English' };
  return {
    path: skill.path,
    schemaVersion: 1,
    freshnessKey: createArtifactFreshnessKey(kind, skill),
    locales: {
      en: llmLocale(content),
      'zh-tw': llmLocale(content),
      'zh-cn': openccLocale(content),
    },
    ...overrides,
  };
}

test('summary content schema requires exactly three non-empty string fields', () => {
  const skill = mappedSkill();
  const valid = artifact(skill);

  assert.equal(validateEnrichmentArtifact('summaries', valid).valid, true);

  for (const invalidContent of [
    {
      purpose: 'Explains the skill purpose.',
      whenToUse: 'Use it when the skill applies.',
    },
    {
      purpose: 'Explains the skill purpose.',
      whenToUse: 'Use it when the skill applies.',
      outputs: 'Produces the documented result.',
      extra: 'Not allowed.',
    },
    {
      purpose: 'Explains the skill purpose.',
      whenToUse: 42,
      outputs: 'Produces the documented result.',
    },
    {
      purpose: '',
      whenToUse: 'Use it when the skill applies.',
      outputs: 'Produces the documented result.',
    },
  ]) {
    const candidate = structuredClone(valid);
    candidate.locales.en.content = invalidContent;
    assert.equal(
      validateEnrichmentArtifact('summaries', candidate).valid,
      false,
      JSON.stringify(invalidContent),
    );
  }
});

async function createFixture({
  skills = [mappedSkill()],
  enabled = { summaries: true, changelog: false },
  directories = ['summaries'],
} = {}) {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'enrichment-'));
  await mkdir(path.join(root, 'catalog', 'enrichment'), { recursive: true });
  await writeFile(
    path.join(root, 'catalog', 'skills.lock.json'),
    `${JSON.stringify({ release: '1.0.0', generatedAt: '2026-01-01T00:00:00Z', skills }, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, 'catalog', 'enrichment', 'manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, enabled }, null, 2)}\n`,
  );
  for (const directory of directories) {
    await mkdir(path.join(root, 'catalog', 'enrichment', directory), { recursive: true });
  }
  return root;
}

async function writeArtifact(root, kind, value, filePath = value.path) {
  const target = enrichmentArtifactPath(root, kind, filePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

test('default validation accepts a stale artifact while strict validation rejects it', async () => {
  const skill = mappedSkill();
  const root = await createFixture({ skills: [skill] });

  try {
    await writeArtifact(
      root,
      'summaries',
      artifact(skill, 'summaries', { freshnessKey: { contentHash: HASH_B } }),
    );

    await assert.doesNotReject(validateEnrichment({ repoRoot: root }));
    await assert.rejects(
      validateEnrichment({ repoRoot: root, strict: true }),
      /stale summaries artifact.*skills\/demo\/alpha/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default validation accepts a missing artifact while strict validation rejects it', async () => {
  const root = await createFixture();

  try {
    await assert.doesNotReject(validateEnrichment({ repoRoot: root }));
    await assert.rejects(
      validateEnrichment({ repoRoot: root, strict: true }),
      /missing summaries artifact.*skills\/demo\/alpha/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default validation rejects an artifact for a restricted skill', async () => {
  const skill = mappedSkill({ redistributable: false, license: 'Proprietary' });
  const root = await createFixture({ skills: [skill] });

  try {
    await writeArtifact(root, 'summaries', artifact(skill));
    await assert.rejects(
      validateEnrichment({ repoRoot: root }),
      /restricted skill.*skills\/demo\/alpha/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default validation rejects an artifact for a tombstoned skill', async () => {
  const skill = mappedSkill({ category: 'removed' });
  const root = await createFixture({ skills: [skill] });

  try {
    await writeArtifact(root, 'summaries', artifact(skill));
    await assert.rejects(
      validateEnrichment({ repoRoot: root }),
      /tombstoned skill.*skills\/demo\/alpha/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default validation rejects a missing directory for an enabled kind', async () => {
  const root = await createFixture({ directories: [] });

  try {
    await assert.rejects(
      validateEnrichment({ repoRoot: root }),
      /enabled summaries directory.*does not exist/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('disabled kinds do not require directories or complete artifact sets', async () => {
  const root = await createFixture({
    enabled: { summaries: false, changelog: false },
    directories: [],
  });

  try {
    await assert.doesNotReject(validateEnrichment({ repoRoot: root }));
    await assert.doesNotReject(validateEnrichment({ repoRoot: root, strict: true }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default safety still rejects forbidden artifacts in a disabled kind', async () => {
  const restricted = mappedSkill({
    redistributable: false,
    license: 'Proprietary',
  });
  const root = await createFixture({
    skills: [restricted],
    enabled: { summaries: false, changelog: false },
    directories: ['summaries'],
  });

  try {
    await writeArtifact(root, 'summaries', artifact(restricted));
    await assert.rejects(
      validateEnrichment({ repoRoot: root }),
      /restricted skill.*skills\/demo\/alpha/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default safety rejects artifacts whose skill left the lock', async () => {
  const removed = mappedSkill({
    path: 'skills/demo/removed',
    name: 'removed',
  });
  const root = await createFixture({
    skills: [mappedSkill()],
    enabled: { summaries: false, changelog: false },
    directories: ['summaries'],
  });

  try {
    await writeArtifact(root, 'summaries', artifact(removed));
    await assert.rejects(
      validateEnrichment({ repoRoot: root }),
      /skills\/demo\/removed.*not present in the skills lock/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prune removes restricted and lock-removed artifacts without invoking an LLM', async () => {
  const retained = mappedSkill();
  const restricted = mappedSkill({
    path: 'skills/demo/restricted',
    name: 'restricted',
    redistributable: false,
    license: 'Proprietary',
  });
  const removed = mappedSkill({ path: 'skills/demo/removed', name: 'removed' });
  const root = await createFixture({ skills: [retained, restricted] });

  try {
    const retainedPath = await writeArtifact(root, 'summaries', artifact(retained));
    const restrictedPath = await writeArtifact(root, 'summaries', artifact(restricted));
    const removedPath = await writeArtifact(root, 'summaries', artifact(removed));

    const result = await pruneEnrichment({ repoRoot: root });

    assert.deepEqual(
      result.removed.map((value) => value.replace(/\\/g, '/')).sort(),
      [
        'catalog/enrichment/summaries/skills__demo__removed.json',
        'catalog/enrichment/summaries/skills__demo__restricted.json',
      ],
    );
    assert.deepEqual(await readdir(path.dirname(retainedPath)), [path.basename(retainedPath)]);
    await assert.rejects(readFile(restrictedPath), /ENOENT/);
    await assert.rejects(readFile(removedPath), /ENOENT/);

    const source = await readFile(path.join(repoRoot, 'scripts', 'prune-enrichment.mjs'), 'utf8');
    assert.doesNotMatch(source, /child_process|copilot|llm\.mjs/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('locale signature changes when generatorVersion changes alone', () => {
  const base = {
    locale: 'en',
    schemaVersion: 1,
    producer: 'llm',
    promptId: 'summary-en-v1',
    promptHash: HASH_A,
    model: 'gpt-5.4',
    generatorVersion: 1,
    cliContract: { version: 1, model: 'gpt-5.4' },
  };

  assert.notEqual(
    createLocaleSignature(base),
    createLocaleSignature({ ...base, generatorVersion: 2 }),
  );
});

test('locale signature is stable when cliContract object keys are reordered', () => {
  const base = {
    locale: 'en',
    schemaVersion: 1,
    producer: 'llm',
    promptId: 'summary-en-v1',
    promptHash: HASH_A,
    model: 'gpt-5.4',
    generatorVersion: 1,
  };

  assert.equal(
    createLocaleSignature({
      ...base,
      cliContract: { version: 1, model: 'gpt-5.4' },
    }),
    createLocaleSignature({
      ...base,
      cliContract: { model: 'gpt-5.4', version: 1 },
    }),
  );
});

test('changelog freshness rejects a changed pinnedCommit with unchanged contentHash', () => {
  const skill = mappedSkill();
  const value = artifact(skill, 'changelog');
  const advanced = mappedSkill({
    upstream: {
      ...skill.upstream,
      commit: 'fedcba9876543210fedcba9876543210fedcba98',
    },
  });

  assert.equal(isArtifactFresh('changelog', value, skill), true);
  assert.equal(isArtifactFresh('changelog', value, advanced), false);
});

test('freshness comparison is independent of JSON property order', () => {
  const skill = mappedSkill();
  const value = artifact(skill, 'changelog');
  value.freshnessKey = {
    pinnedCommit: value.freshnessKey.pinnedCommit,
    source: value.freshnessKey.source,
    reference: value.freshnessKey.reference,
    repository: value.freshnessKey.repository,
    contentHash: value.freshnessKey.contentHash,
  };

  assert.equal(isArtifactFresh('changelog', value, skill), true);
});

test('freshness and eligibility use snapshotHash for orphan summaries and exclude orphan changelogs', () => {
  const orphan = orphanSkill();

  assert.deepEqual(createArtifactFreshnessKey('summaries', orphan), {
    contentHash: orphan.snapshotHash,
  });
  assert.equal(isEligibleForEnrichment('summaries', orphan), true);
  assert.equal(isEligibleForEnrichment('changelog', orphan), false);
});

test('validation rejects path escape attempts before resolving artifact locations', async () => {
  const skill = mappedSkill();
  const root = await createFixture({ skills: [skill] });
  const unsafe = artifact(skill, 'summaries', { path: 'skills/demo/../escape' });
  const target = path.join(
    root,
    'catalog',
    'enrichment',
    'summaries',
    'skills__demo__..__escape.json',
  );

  try {
    await writeFile(target, `${JSON.stringify(unsafe, null, 2)}\n`);
    await assert.rejects(
      validateEnrichment({ repoRoot: root }),
      /unsafe enrichment skill path/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Tier 1 repository validation remains unaware of enrichment', async () => {
  const validateSource = await readFile(path.join(repoRoot, 'scripts', 'validate.mjs'), 'utf8');
  assert.doesNotMatch(validateSource, /enrichment/i);
});
