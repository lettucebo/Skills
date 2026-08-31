import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { LockSkillEntry } from './catalog.ts';
import { loadEnrichmentLocale } from './enrichment.ts';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const SIGNATURE = `sha256:${'c'.repeat(64)}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(__dirname, '..', '..', 'test', '.runtime');

function summary(purpose: string) {
  return {
    purpose,
    whenToUse: 'Use it when the documented workflow applies.',
    outputs: 'Produces the documented result.',
  };
}

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
        content: summary('English purpose'),
      },
      'zh-tw': {
        signature: SIGNATURE,
        producer: 'llm',
        model: 'gpt-5.4',
        promptHash: HASH_B,
        generatorVersion: 1,
        content: summary('繁體中文用途'),
      },
      'zh-cn': {
        signature: SIGNATURE,
        producer: 'opencc',
        converterVersion: '1.0.6',
        generatorVersion: 1,
        content: summary('简体中文用途'),
      },
    },
  };
}

async function createFixture(value = artifact()) {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'site-enrichment-'));
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

function manifestPath(root: string): string {
  return path.join(root, 'catalog', 'enrichment', 'manifest.json');
}

function artifactPath(root: string): string {
  return path.join(
    root,
    'catalog',
    'enrichment',
    'summaries',
    'skills__demo__alpha.json',
  );
}

test('loader short-circuits restricted and tombstoned skills before touching sidecars', async () => {
  const fallback = { text: 'fallback' };
  const missingRoot = path.join(runtimeRoot, `missing-enrichment-${Date.now()}`);

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

test('loader fails when the mandatory manifest is missing', async () => {
  const root = await createFixture();

  try {
    await rm(manifestPath(root));
    await assert.rejects(
      loadEnrichmentLocale({
        repoRoot: root,
        kind: 'summaries',
        skill: skill(),
        locale: 'en',
        fallback: { text: 'fallback' },
      }),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader fails when the mandatory manifest contains invalid JSON', async () => {
  const root = await createFixture();

  try {
    await writeFile(manifestPath(root), '{"schemaVersion":');
    await assert.rejects(
      loadEnrichmentLocale({
        repoRoot: root,
        kind: 'summaries',
        skill: skill(),
        locale: 'en',
        fallback: { text: 'fallback' },
      }),
      /manifest\.json.*invalid JSON/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader fails when the mandatory manifest violates its schema', async () => {
  const root = await createFixture();

  try {
    await writeFile(
      manifestPath(root),
      JSON.stringify({
        schemaVersion: 2,
        enabled: { summaries: true, changelog: false },
      }),
    );
    await assert.rejects(
      loadEnrichmentLocale({
        repoRoot: root,
        kind: 'summaries',
        skill: skill(),
        locale: 'en',
        fallback: { text: 'fallback' },
      }),
      /manifest\.json failed schema validation/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader returns fallback when an enabled artifact is missing', async () => {
  const root = await createFixture();
  const fallback = { text: 'fallback' };

  try {
    await rm(artifactPath(root));
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

test('loader fails when an artifact contains invalid JSON', async () => {
  const root = await createFixture();

  try {
    await writeFile(artifactPath(root), '{"path":');
    await assert.rejects(
      loadEnrichmentLocale({
        repoRoot: root,
        kind: 'summaries',
        skill: skill(),
        locale: 'en',
        fallback: { text: 'fallback' },
      }),
      /skills__demo__alpha\.json.*invalid JSON/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader fails when an artifact violates its schema', async () => {
  const root = await createFixture({
    ...artifact(),
    schemaVersion: 2,
  });

  try {
    await assert.rejects(
      loadEnrichmentLocale({
        repoRoot: root,
        kind: 'summaries',
        skill: skill(),
        locale: 'en',
        fallback: { text: 'fallback' },
      }),
      /summaries artifact failed schema validation/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader fails when an artifact declares a different skill path', async () => {
  const root = await createFixture({
    ...artifact(),
    path: 'skills/demo/beta',
  });

  try {
    await assert.rejects(
      loadEnrichmentLocale({
        repoRoot: root,
        kind: 'summaries',
        skill: skill(),
        locale: 'en',
        fallback: { text: 'fallback' },
      }),
      /declares path "skills\/demo\/beta".*"skills\/demo\/alpha"/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader does not let a missing-locale fallback hide a different skill path', async () => {
  const value = {
    ...artifact(),
    path: 'skills/demo/beta',
  };
  delete (value.locales as Partial<typeof value.locales>)['zh-tw'];
  const root = await createFixture(value);

  try {
    await assert.rejects(
      loadEnrichmentLocale({
        repoRoot: root,
        kind: 'summaries',
        skill: skill(),
        locale: 'zh-tw',
        fallback: { text: 'fallback' },
      }),
      /declares path "skills\/demo\/beta".*"skills\/demo\/alpha"/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader surfaces non-ENOENT artifact read errors', async () => {
  const root = await createFixture();
  const target = artifactPath(root);

  try {
    await rm(target);
    await mkdir(target);
    await assert.rejects(
      loadEnrichmentLocale({
        repoRoot: root,
        kind: 'summaries',
        skill: skill(),
        locale: 'en',
        fallback: { text: 'fallback' },
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader returns fallback for a disabled kind without reading its artifact', async () => {
  const root = await createFixture();
  const target = artifactPath(root);
  const fallback = { text: 'fallback' };

  try {
    await writeFile(
      manifestPath(root),
      JSON.stringify({
        schemaVersion: 1,
        enabled: { summaries: false, changelog: false },
      }),
    );
    await rm(target);
    await mkdir(target);

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
      summary('繁體中文用途'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
