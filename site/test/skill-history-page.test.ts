import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pagePath = path.join(
  __dirname,
  '..',
  'src',
  'pages',
  'skills',
  '[source]',
  '[skill].astro',
);
const enrichmentPath = path.join(
  __dirname,
  '..',
  'src',
  'lib',
  'enrichment.ts',
);

test('skill detail keeps registry History separate from fresh Upstream changes', async () => {
  const source = await readFile(pagePath, 'utf8');

  assert.match(source, /loadEnrichmentLocale/);
  assert.match(source, /kind:\s*'changelog'/);
  assert.match(source, /locale:\s*'en'/);
  assert.match(source, /<h2>History<\/h2>/);
  assert.match(source, /<h2>Upstream changes<\/h2>/);
  assert.match(source, /upstreamChanges\.commits\.length\s*>\s*0/);
});

test('restricted and orphan pages are gated before changelog loading or rendering', async () => {
  const source = await readFile(pagePath, 'utf8');

  assert.match(
    source,
    /!skill\.isRestricted\s*&&\s*!skill\.isOrphan\s*&&\s*skill\.upstreamRepo/,
  );
  assert.match(source, /upstreamChangesPromise/);
  assert.match(
    source,
    /const emptyUpstreamChanges:\s*SkillChangelogContent\s*=\s*\{\s*commits:\s*\[\]\s*\}/,
  );
  assert.match(source, /Promise\.resolve\(emptyUpstreamChanges\)/);
});

test('site enrichment module re-exports the changelog content type used by the page', async () => {
  const source = await readFile(enrichmentPath, 'utf8');

  assert.match(source, /export type \{[\s\S]*SkillChangelogContent[\s\S]*\};/);
});
