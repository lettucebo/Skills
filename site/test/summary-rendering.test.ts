import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadEnrichmentLocale,
  type SkillSummaryContent,
} from '../src/lib/enrichment.ts';
import type { LockSkillEntry } from '../src/lib/catalog.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const distExists = existsSync(path.join(siteRoot, 'dist'));
const runtimeRoot = path.join(__dirname, '.runtime');
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
    upstream: null,
    ...overrides,
  };
}

const summary: SkillSummaryContent = {
  purpose: 'Creates a human-oriented result.',
  whenToUse: 'Use it for a relevant workflow.',
  outputs: 'Produces the requested change.',
};
const missingSummary: SkillSummaryContent = {
  purpose: '',
  whenToUse: '',
  outputs: '',
};

function locale(content: SkillSummaryContent) {
  return {
    signature: SIGNATURE,
    producer: 'llm',
    model: 'gpt-5.4',
    promptHash: HASH_B,
    generatorVersion: 1,
    content,
  };
}

function artifact(
  entry: LockSkillEntry,
  overrides: Record<string, unknown> = {},
) {
  return {
    path: entry.path,
    schemaVersion: 1,
    freshnessKey: { contentHash: entry.contentHash ?? entry.snapshotHash },
    locales: {
      en: locale(summary),
      'zh-tw': locale({
        purpose: '建立人類易讀的成果。',
        whenToUse: '適合相關工作流程。',
        outputs: '產生所需變更。',
      }),
      'zh-cn': {
        signature: SIGNATURE,
        producer: 'opencc',
        converterVersion: 'opencc-js:twp-to-cn@1.4.2',
        generatorVersion: 1,
        content: {
          purpose: '创建人类易读的成果。',
          whenToUse: '适合相关工作流程。',
          outputs: '产生所需变更。',
        },
      },
    },
    ...overrides,
  };
}

async function createFixture({
  entry = skill(),
  enabled = true,
  value = artifact(entry),
}: {
  entry?: LockSkillEntry;
  enabled?: boolean;
  value?: Record<string, unknown> | null;
} = {}) {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'summary-site-'));
  await mkdir(path.join(root, 'catalog', 'enrichment', 'summaries'), {
    recursive: true,
  });
  await writeFile(
    path.join(root, 'catalog', 'enrichment', 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      enabled: { summaries: enabled, changelog: false },
    }, null, 2)}\n`,
  );
  if (value) {
    await writeFile(
      path.join(
        root,
        'catalog',
        'enrichment',
        'summaries',
        'skills__demo__alpha.json',
      ),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  }
  return root;
}

test('fresh English summary loads for detail and card rendering', async () => {
  const entry = skill();
  const root = await createFixture({ entry });

  try {
    assert.deepEqual(
      await loadEnrichmentLocale<SkillSummaryContent>({
        repoRoot: root,
        kind: 'summaries',
        skill: entry,
        locale: 'en',
        fallback: missingSummary,
      }),
      summary,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing stale and disabled summaries fall back without cross-language substitution', async () => {
  const entry = skill();
  const stale = artifact(entry, { freshnessKey: { contentHash: HASH_B } });
  const withoutEnglish = artifact(entry);
  delete (withoutEnglish.locales as Record<string, unknown>).en;

  for (const fixture of [
    { enabled: true, value: null },
    { enabled: true, value: stale },
    { enabled: false, value: artifact(entry) },
    { enabled: true, value: withoutEnglish },
  ]) {
    const root = await createFixture({ entry, ...fixture });
    try {
      assert.equal(
        await loadEnrichmentLocale<SkillSummaryContent>({
          repoRoot: root,
          kind: 'summaries',
          skill: entry,
          locale: 'en',
          fallback: missingSummary,
        }),
        missingSummary,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('restricted summary loading short-circuits before any enrichment filesystem access', async () => {
  const restricted = skill({
    path: 'skills/claude/docx',
    name: 'docx',
    redistributable: false,
    license: 'Proprietary',
  });

  assert.equal(
    await loadEnrichmentLocale<SkillSummaryContent>({
      repoRoot: path.join(runtimeRoot, 'does-not-exist'),
      kind: 'summaries',
      skill: restricted,
      locale: 'en',
      fallback: missingSummary,
    }),
    missingSummary,
  );
});

test('pages use structured summaries in the canonical detail and card DOM', async () => {
  const [detail, index] = await Promise.all([
    readFile(
      path.join(siteRoot, 'src', 'components', 'pages', 'SkillPage.astro'),
      'utf8',
    ),
    readFile(path.join(siteRoot, 'src', 'components', 'pages', 'HomePage.astro'), 'utf8'),
  ]);

  assert.match(detail, /class="skill-summary"/);
  assert.match(detail, /'purpose'/);
  assert.match(detail, /'whenToUse'/);
  assert.match(detail, /'outputs'/);
  assert.match(detail, /loadEnrichmentLocale<SkillSummaryContent/);
  assert.match(index, /loadEnrichmentLocale<SkillSummaryContent/);
  assert.match(index, /summary\?\.purpose\s*\?\?\s*body\?\.description/);
  assert.doesNotMatch(index, /search-result-item/);
});

test('built detail and canonical card render the fresh generated summary', {
  skip: !distExists && 'dist/ not found',
}, async () => {
  const repoRoot = path.resolve(siteRoot, '..');
  const artifactValue = JSON.parse(
    await readFile(
      path.join(
        repoRoot,
        'catalog',
        'enrichment',
        'summaries',
        'skills__vscode__code-review.json',
      ),
      'utf8',
    ),
  ) as {
    locales: {
      en: { content: SkillSummaryContent };
    };
  };
  const [detail, index] = await Promise.all([
    readFile(
      path.join(siteRoot, 'dist', 'en', 'skills', 'vscode', 'code-review', 'index.html'),
      'utf8',
    ),
    readFile(path.join(siteRoot, 'dist', 'en', 'index.html'), 'utf8'),
  ]);
  const { purpose, whenToUse, outputs } = artifactValue.locales.en.content;

  assert.match(detail, /class="skill-summary"/);
  assert.ok(detail.includes(purpose));
  assert.ok(detail.includes(whenToUse));
  assert.ok(detail.includes(outputs));
  assert.ok(index.includes(purpose));
});
