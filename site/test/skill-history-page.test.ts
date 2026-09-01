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
  'components',
  'pages',
  'SkillPage.astro',
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

  assert.match(source, /loadSkillChangelog/);
  assert.match(source, /locale,/);
  assert.match(source, /'history'/);
  assert.match(source, /'upstreamChangesSummary'/);
  assert.match(source, /upstreamChanges\.commits\.length\s*>\s*0/);
  assert.ok(
    source.indexOf('class="upstream-changes"') <
      source.indexOf('class="detail-body"'),
  );
});

test('restricted and orphan pages are gated before changelog loading or rendering', async () => {
  const [source, enrichment] = await Promise.all([
    readFile(pagePath, 'utf8'),
    readFile(enrichmentPath, 'utf8'),
  ]);

  assert.match(source, /const changelog = !skill\.isRestricted/);
  assert.match(enrichment, /skill\.redistributable === false \|\| skill\.category === 'removed'/);
  assert.match(
    enrichment,
    /if \(skill\.upstream === null\)[\s\S]*reason: 'no-upstream'/,
  );
});

test('site enrichment module re-exports the changelog content type used by the page', async () => {
  const source = await readFile(enrichmentPath, 'utf8');

  assert.match(source, /export type \{[\s\S]*SkillChangelogContent[\s\S]*\};/);
});
