/**
 * Catalog grouping tests — source declaration and built-output structure.
 *
 * The homepage groups every non-tombstone skill under a native
 * `<details data-skill-group data-source="…">` folder, one per
 * `catalog.sources`, each with a `<summary>` carrying the source name and a
 * static skill count and a nested `.card-grid` of the source's cards. Groups
 * default collapsed (no `open`) so no-JS users can still open each folder, and
 * an Expand all / Collapse all control pair is present but hidden until JS
 * reveals it.
 *
 * These assertions derive every expectation from the catalog (never a
 * hardcoded source list or count), and read the built dist/ HTML when present.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as catalogModule from '../src/lib/catalog.ts';
import type { SkillViewModel } from '../src/lib/catalog.ts';

const { loadCatalog } = catalogModule;

function getBrowsableSources(skills: SkillViewModel[]): string[] {
  const helper = (catalogModule as typeof catalogModule & {
    getBrowsableSources?: (entries: SkillViewModel[]) => string[];
  }).getBrowsableSources;
  assert.equal(typeof helper, 'function', 'catalog.ts must export getBrowsableSources');
  return helper!(skills);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(siteRoot, '..');
const indexAstroPath = path.join(siteRoot, 'src', 'components', 'pages', 'HomePage.astro');
const distIndexPath = path.join(siteRoot, 'dist', 'en', 'index.html');
const distExists = fs.existsSync(distIndexPath);

/** Matches the bare `data-skill-group` marker, never `data-skill-group-count`. */
const GROUP_MARKER_RE = /data-skill-group(?![-\w])/g;

/**
 * Removes inline `<script>`/`<style>` blocks so counting the rendered markup is
 * never polluted by the shipped client script — whose comments and selectors
 * legitimately mention `<details>`, `[data-skill-group]`, and
 * `[data-skill-card]`.
 */
function renderedMarkup(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}

/** Splits built HTML into per-`<details>` chunks (index 0 is the pre-details head). */
function detailsChunks(html: string): string[] {
  return renderedMarkup(html).split('<details').slice(1);
}

/** Expected non-tombstone card count per source, derived from the catalog. */
async function expectedCountsBySource(): Promise<Map<string, number>> {
  const catalog = await loadCatalog(repoRoot);
  const counts = new Map<string, number>();
  for (const skill of catalog.skills) {
    if (skill.isTombstone) continue;
    counts.set(skill.source, (counts.get(skill.source) ?? 0) + 1);
  }
  return counts;
}

// ─── Source declaration (template) ──────────────────────────────────

test('browsable sources exclude a source whose only skills are tombstones', () => {
  const skills = [
    { source: 'active', isTombstone: false },
    { source: 'mixed', isTombstone: true },
    { source: 'mixed', isTombstone: false },
    { source: 'removed', isTombstone: true },
  ] as SkillViewModel[];

  assert.deepEqual(getBrowsableSources(skills), ['active', 'mixed']);
});

test('index.astro declares one group per browsable source without hardcoding the list', () => {
  const template = fs.readFileSync(indexAstroPath, 'utf8');

  // The groups must be generated from the non-tombstone skill population, not enumerated.
  assert.match(
    template,
    /browsableSources\.map/,
    'source folders must be generated from browsable sources',
  );
  assert.match(template, /data-skill-group\b/, 'each folder must expose the data-skill-group marker');
  assert.match(template, /data-source=/, 'each folder must carry its data-source');
  assert.match(template, /<details/, 'folders must be native <details> elements');
  assert.match(template, /<summary/, 'each folder must have a native <summary>');
});

test('index.astro never marks a source group open initially', () => {
  const template = fs.readFileSync(indexAstroPath, 'utf8');
  // No <details …> in the source may carry an `open` attribute.
  assert.doesNotMatch(
    template,
    /<details[^>]*\bopen\b/,
    'source groups must default collapsed (no open attribute in the template)',
  );
});

test('index.astro preserves a single canonical #skill-grid catalog root', () => {
  const template = fs.readFileSync(indexAstroPath, 'utf8');
  const matches = template.match(/id="skill-grid"/g) ?? [];
  assert.equal(matches.length, 1, 'there must be exactly one #skill-grid root');
});

test('index.astro declares hidden Expand all / Collapse all native buttons', () => {
  const template = fs.readFileSync(indexAstroPath, 'utf8');
  assert.match(template, /id="expand-all-groups"/, 'must have an expand-all control');
  assert.match(template, /id="collapse-all-groups"/, 'must have a collapse-all control');
  // Native buttons, not clickable divs.
  assert.match(template, /<button[^>]*id="expand-all-groups"[^>]*type="button"|<button[^>]*type="button"[^>]*id="expand-all-groups"/,
    'expand-all must be a native <button type="button">');
  assert.match(template, /<button[^>]*id="collapse-all-groups"[^>]*type="button"|<button[^>]*type="button"[^>]*id="collapse-all-groups"/,
    'collapse-all must be a native <button type="button">');
  // The controls container is hidden in markup so no-JS never shows dead buttons.
  assert.match(template, /id="catalog-group-controls"[^>]*hidden/, 'group controls must be hidden in markup');
});

// ─── Built output (dist/index.html) ─────────────────────────────────

test('built homepage renders one group per browsable source', {
  skip: !distExists && 'dist/ not found (run npm run build first)',
}, async () => {
  const html = fs.readFileSync(distIndexPath, 'utf8');
  const catalog = await loadCatalog(repoRoot);
  const browsableSources = getBrowsableSources(catalog.skills);
  const groupCount = (renderedMarkup(html).match(GROUP_MARKER_RE) ?? []).length;
  assert.equal(
    groupCount,
    browsableSources.length,
    `built homepage must render exactly ${browsableSources.length} source groups`,
  );
});

test('built homepage renders each non-tombstone card exactly once', {
  skip: !distExists && 'dist/ not found',
}, async () => {
  const html = fs.readFileSync(distIndexPath, 'utf8');
  const catalog = await loadCatalog(repoRoot);
  const expectedCards = catalog.skills.filter((s) => !s.isTombstone).length;
  const expectedUrls = catalog.skills
    .filter((skill) => !skill.isTombstone)
    .map((skill) => `/Skills/en/skills/${skill.source}/${skill.slug}/`)
    .sort();
  const renderedUrls = [...renderedMarkup(html).matchAll(
    /data-skill-card(?=[^>]*data-url="([^"]+)")[^>]*>/g,
  )].map((match) => match[1]).sort();
  assert.equal(renderedUrls.length, expectedCards, `every non-tombstone card must appear once (${expectedCards})`);
  assert.deepEqual(
    renderedUrls,
    expectedUrls,
    'rendered card identities must exactly match the non-tombstone catalog',
  );
});

test('every built group carries its source name and a derived count that sums to the cards', {
  skip: !distExists && 'dist/ not found',
}, async () => {
  const html = fs.readFileSync(distIndexPath, 'utf8');
  const expected = await expectedCountsBySource();
  const catalog = await loadCatalog(repoRoot);
  const chunks = detailsChunks(html);

  assert.equal(chunks.length, expected.size, 'one <details> chunk per source');

  let summed = 0;
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const sourceMatch = chunk.match(/data-source="([^"]+)"/);
    assert.ok(sourceMatch, 'each group must expose a data-source');
    const source = sourceMatch![1];
    assert.ok(!seen.has(source), `source ${source} must appear as a single group`);
    seen.add(source);

    // The visible summary must contain the source name text.
    const summaryMatch = chunk.match(/<summary[\s\S]*?<\/summary>/);
    assert.ok(summaryMatch, `group ${source} must have a summary`);
    assert.match(summaryMatch![0], new RegExp(source), `summary for ${source} must show its name`);

    const countMatch = chunk.match(/data-skill-group-count[^>]*>(\d+)</);
    assert.ok(countMatch, `group ${source} must render a static skill count`);
    const count = Number(countMatch![1]);
    assert.equal(count, expected.get(source), `group ${source} count must equal its catalog card count`);
    const expectedUrls = catalog.skills
      .filter((skill) => !skill.isTombstone && skill.source === source)
      .map((skill) => `/Skills/en/skills/${skill.source}/${skill.slug}/`)
      .sort();
    const renderedUrls = [...chunk.matchAll(
      /data-skill-card(?=[^>]*data-url="([^"]+)")[^>]*>/g,
    )].map((match) => match[1]).sort();
    assert.deepEqual(
      renderedUrls,
      expectedUrls,
      `group ${source} must contain exactly its catalog skills`,
    );
    summed += count;
  }

  const totalCards = [...expected.values()].reduce((a, b) => a + b, 0);
  assert.equal(summed, totalCards, 'group counts must sum to the total non-tombstone cards');
});

test('built groups default collapsed and stay natively operable without JS', {
  skip: !distExists && 'dist/ not found',
}, async () => {
  const html = fs.readFileSync(distIndexPath, 'utf8');
  const catalog = await loadCatalog(repoRoot);
  const browsableSources = getBrowsableSources(catalog.skills);

  // Native <details> present (no-JS operable) …
  const groupCount = (renderedMarkup(html).match(GROUP_MARKER_RE) ?? []).length;
  assert.equal(groupCount, browsableSources.length, 'native details groups must be present for no-JS users');

  // … and none is initially open.
  for (const chunk of detailsChunks(html)) {
    const openTag = chunk.slice(0, chunk.indexOf('>') + 1);
    assert.doesNotMatch(openTag, /\bopen\b/, 'no source group may be open on initial render');
  }
});

test('built homepage hides the Expand all / Collapse all controls until JS reveals them', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(distIndexPath, 'utf8');
  const controlsMatch = html.match(/id="catalog-group-controls"[^>]*>/);
  assert.ok(controlsMatch, 'the group controls container must exist');
  assert.match(controlsMatch![0], /hidden/, 'group controls must start hidden');
  assert.match(html, /id="expand-all-groups"/, 'expand-all button must be present in built HTML');
  assert.match(html, /id="collapse-all-groups"/, 'collapse-all button must be present in built HTML');
});
