/**
 * Mobile table overflow guards (375px).
 *
 * Browser evidence from the final UI/UX review found horizontal document
 * overflow on 36 of 116 built pages. The two causes were:
 *
 *  1. Markdown tables rendered by `renderMarkdownBody` and the `.skill-table`
 *     markup on the source/status pages are laid out at their min-content
 *     width, which exceeds a 375px viewport on table-heavy pages such as
 *     `skills/microsoft/copilot-sdk` (15 tables).
 *  2. Very long unbroken URLs/identifiers in detail bodies, e.g.
 *     `skills/cloudflare/sandbox-migrate-to-next` (a 231-character token).
 *
 * The fix wraps every table in a focusable scroll container so the scrolling
 * is local to the table, and allows long tokens to break at the mobile
 * breakpoint. Table semantics must stay intact: the `<table>` element keeps
 * `display: table`, so the accessibility tree still exposes rows and cells.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdownBody } from '../src/lib/catalog.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(siteRoot, 'src', 'styles', 'global.css'), 'utf8');

const MARKDOWN_TABLE = [
  '| Command | Description | Notes |',
  '| --- | --- | --- |',
  '| `a` | first | one |',
  '| `b` | second | two |',
  '',
].join('\n');

test('TO1: markdown tables are wrapped in a focusable scroll container', () => {
  const html = renderMarkdownBody(MARKDOWN_TABLE);

  assert.match(
    html,
    /<div class="table-scroll" role="region" aria-label="Table" tabindex="0">\s*<table>/,
    'each table must be wrapped so horizontal scrolling stays local to the table',
  );
  assert.match(html, /<\/table>\s*<\/div>/, 'the wrapper must close after the table');
});

test('TO1b: the scroll container stays keyboard reachable (tabindex must not be removed)', () => {
  // A scrollable region that is not focusable is unreachable by keyboard
  // (WCAG 2.1.1): the only way to scroll it would be a pointer. The extra tab
  // stop this costs on table-heavy pages is a deliberate, accepted trade-off —
  // see the "Table scroll regions add tab stops" residual risk. Removing the
  // attribute to reduce tab stops would reintroduce a real a11y defect, so it
  // is pinned separately from the markup shape asserted in TO1.
  const html = renderMarkdownBody(MARKDOWN_TABLE);
  const wrappers = html.match(/<div class="table-scroll"[^>]*>/g) ?? [];

  assert.equal(wrappers.length, 1);
  assert.match(wrappers[0], /tabindex="0"/);
  assert.match(wrappers[0], /role="region"/, 'a focusable scroll container needs an accessible role');
  assert.match(wrappers[0], /aria-label="[^"]+"/, 'the region must be named');
});

test('TO2: wrapping preserves table semantics in the DOM', () => {
  const html = renderMarkdownBody(MARKDOWN_TABLE);

  assert.match(html, /<table>/, 'the table element itself must survive');
  assert.match(html, /<thead>/);
  assert.match(html, /<tbody>/);
  assert.equal((html.match(/<tr>/g) ?? []).length, 3, 'all rows must survive');
  assert.doesNotMatch(
    html,
    /<table[^>]*style=/,
    'no inline display override may strip the implicit table role',
  );
});

test('TO3: consecutive tables are each wrapped exactly once', () => {
  const html = renderMarkdownBody(`${MARKDOWN_TABLE}\ntext between\n\n${MARKDOWN_TABLE}`);

  assert.equal((html.match(/class="table-scroll"/g) ?? []).length, 2);
  assert.equal((html.match(/<table>/g) ?? []).length, 2);
  assert.doesNotMatch(
    html,
    /<div class="table-scroll"[^>]*>\s*<div class="table-scroll"/,
    'wrappers must not nest',
  );
});

test('TO4: non-table markdown is untouched', () => {
  const html = renderMarkdownBody('Just a paragraph with `code`.\n');

  assert.doesNotMatch(html, /table-scroll/);
  assert.match(html, /<p>/);
});

test('TO5: the scroll container is constrained and scrollable in CSS', () => {
  const rule = css.match(/\.table-scroll\s*\{[^}]*\}/);
  assert.ok(rule, '.table-scroll rule must exist in global.css');

  assert.match(rule[0], /max-width:\s*100%/, 'the container must not exceed its parent');
  assert.match(rule[0], /overflow-x:\s*auto/, 'the container must scroll horizontally');
});

test('TO6: the focusable scroll container has a visible focus indicator', () => {
  assert.match(
    css,
    /\.table-scroll:focus-visible\s*\{[^}]*outline:/,
    'a tabbable container must show a visible focus ring (WCAG 2.4.7)',
  );
});

test('TO7: long unbroken tokens wrap at the mobile breakpoint', () => {
  const mobile = css.match(/@media \(max-width: 640px\) \{[\s\S]*?\n\}/);
  assert.ok(mobile, 'the 640px breakpoint block must exist');

  assert.match(
    mobile[0],
    /overflow-wrap:\s*anywhere/,
    'long URLs and identifiers must be allowed to break at mobile widths',
  );
});

test('TO8: .skill-table markup is wrapped on the source and status pages', () => {
  const pages = [
    path.join(siteRoot, 'src', 'components', 'pages', 'SourcePage.astro'),
    path.join(siteRoot, 'src', 'components', 'pages', 'StatusPage.astro'),
  ];

  for (const file of pages) {
    const src = fs.readFileSync(file, 'utf8');
    const tables = (src.match(/<table class="skill-table">/g) ?? []).length;
    const wrappers = (src.match(/class="table-scroll"/g) ?? []).length;

    assert.ok(tables > 0, `${path.basename(file)} should contain at least one skill table`);
    assert.equal(
      wrappers,
      tables,
      `${path.basename(file)}: every .skill-table needs its own scroll container`,
    );
  }
});

/**
 * TO9 regression: parsing block-scalar frontmatter (see frontmatter-parsing.test.ts)
 * restored real descriptions on five cards, one of which — `claude-api` — contains
 * an 84-character unbroken code token
 * (`'openai|langchain_openai|google.generativeai|genai|mistralai|cohere|ollama'`).
 *
 * At the mobile breakpoint `.card-grid` collapses to `grid-template-columns: 1fr`,
 * whose `auto` minimum is the item's min-content width, so that single token
 * widened the homepage document to 488px at a 375px viewport. `overflow-wrap:
 * anywhere` (unlike `word-break: break-word`) reduces the min-content
 * contribution, which is what actually collapses the grid track.
 */
test('TO9: card text can break mid-token so the grid track never exceeds the viewport', () => {
  for (const selector of ['.card-title', '.card-description']) {
    const rule = css.match(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`));
    assert.ok(rule, `${selector} rule must exist in global.css`);
    assert.match(
      rule[0],
      /overflow-wrap:\s*anywhere/,
      `${selector} must use overflow-wrap: anywhere so an unbreakable token ` +
        'cannot inflate the grid track min-content width',
    );
  }
});

/**
 * TO10 regression: the same restored `claude-api` description is also rendered
 * verbatim as the skill detail page lead paragraph, which was the last of the
 * 36 overflowing pages. It needs a class so the mobile rule can reach it.
 */
test('TO10: the skill detail lead paragraph can break long tokens at mobile', () => {
  const detailPage = fs.readFileSync(
    path.join(siteRoot, 'src', 'components', 'pages', 'SkillPage.astro'),
    'utf8',
  );
  assert.match(
    detailPage,
    /<p class="detail-description"/,
    'the frontmatter description paragraph must be addressable from CSS',
  );

  const mobile = css.match(/@media \(max-width: 640px\) \{[\s\S]*?\n\}/);
  assert.ok(mobile);
  assert.match(
    mobile[0],
    /\.detail-description/,
    '.detail-description must be in the mobile overflow-wrap group',
  );
});
