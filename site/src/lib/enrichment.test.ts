import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LockSkillEntry } from './catalog.ts';
import { loadEnrichmentLocale } from './enrichment.ts';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const SIGNATURE = `sha256:${'c'.repeat(64)}`;

function skill(overrides: Partial<LockSkillEntry> = {}): LockSkillEntry {
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

function artifact(contentHash = HASH_A) {
  return {
    path: 'skills/demo/alpha',
    schemaVersion: 1,
    freshnessKey: { contentHash },
    locales: {
      en: {
        signature: SIGNATURE,
        producer: 'llm',
        model: 'gpt-5.4',
        promptHash: HASH_B,
        generatorVersion: 1,
        content: { text: 'English' },
      },
      'zh-tw': {
        signature: SIGNATURE,
        producer: 'llm',
        model: 'gpt-5.4',
        promptHash: HASH_B,
        generatorVersion: 1,
        content: { text: '繁體中文' },
      },
      'zh-cn': {
        signature: SIGNATURE,
        producer: 'opencc',
        converterVersion: '1.0.6',
        generatorVersion: 1,
        content: { text: '简体中文' },
      },
    },
  };
}

async function createFixture(value = artifact()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'site-enrichment-'));
  const directory = path.join(root, 'catalog', 'enrichment', 'summaries');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(root, 'catalog', 'enrichment', 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      enabled: { summaries: true, changelog: false },
    })}\n`,
  );
  await writeFile(
    path.join(directory, 'skills__demo__alpha.json'),
    `${JSON.stringify(value)}\n`,
  );
  return root;
}

test('loader short-circuits restricted and tombstoned skills before touching sidecars', async () => {
  const fallback = { text: 'fallback' };
  const missingRoot = path.join(os.tmpdir(), `missing-enrichment-${Date.now()}`);

  assert.equal(
    await loadEnrichmentLocale({
      repoRoot: missingRoot,
      kind: 'summaries',
      skill: skill({ redistributable: false }),
      locale: 'en',
      fallback,
    }),
    fallback,
  );
  assert.equal(
    await loadEnrichmentLocale({
      repoRoot: missingRoot,
      kind: 'summaries',
      skill: skill({ category: 'removed' }),
      locale: 'en',
      fallback,
    }),
    fallback,
  );
});

test('loader suppresses stale artifacts and returns the caller fallback', async () => {
  const root = await createFixture(artifact(HASH_B));
  const fallback = { text: 'fallback' };

  try {
    assert.equal(
      await loadEnrichmentLocale({
        repoRoot: root,
        kind: 'summaries',
        skill: skill(),
        locale: 'en',
        fallback,
      }),
      fallback,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader returns only the requested locale and never falls back across languages', async () => {
  const value = artifact();
  delete (value.locales as Partial<typeof value.locales>)['zh-tw'];
  const root = await createFixture(value);
  const fallback = { text: 'fallback' };

  try {
    assert.equal(
      await loadEnrichmentLocale({
        repoRoot: root,
        kind: 'summaries',
        skill: skill(),
        locale: 'zh-tw',
        fallback,
      }),
      fallback,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader returns fresh content for the exact requested locale', async () => {
  const root = await createFixture();
  const fallback = { text: 'fallback' };

  try {
    assert.deepEqual(
      await loadEnrichmentLocale({
        repoRoot: root,
        kind: 'summaries',
        skill: skill(),
        locale: 'zh-tw',
        fallback,
      }),
      { text: '繁體中文' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
