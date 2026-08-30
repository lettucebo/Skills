/**
 * Search live-region guards.
 *
 * The unified search keeps exactly one polite live region — the `#search-status`
 * paragraph — and writes its count only after card visibility has been applied,
 * so a screen reader never hears a number the DOM does not yet reflect. There is
 * no separate results container and no runtime-built result list to re-announce.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const componentPath = path.join(siteRoot, 'src', 'components', 'Search.astro');
const component = fs.readFileSync(componentPath, 'utf8');
const distIndex = path.join(siteRoot, 'dist', 'index.html');

/** Extracts the opening tag of an element by id. */
function openingTag(html: string, id: string): string {
  const anchor = html.indexOf(`id="${id}"`);
  assert.notEqual(anchor, -1, `element #${id} not found`);
  const start = html.lastIndexOf('<', anchor);
  const end = html.indexOf('>', anchor);
  return html.slice(start, end + 1);
}

test('LR1: the status paragraph is the single polite live region', () => {
  const statusTag = openingTag(component, 'search-status');

  assert.match(statusTag, /aria-live="polite"/, 'the status line must be the live region');
  assert.match(
    statusTag,
    /aria-atomic="true"/,
    'the status is a single sentence and must be announced atomically',
  );
  // The old #search-results container/live region must be gone entirely.
  assert.doesNotMatch(component, /id="search-results"/, 'the results container must no longer exist');
  assert.doesNotMatch(component, /id="search-result-list"/, 'the runtime result list must no longer exist');
});

test('LR2: the count is announced only after card visibility is applied', () => {
  const script = component.slice(component.indexOf('<script'));

  const applyIndex = script.indexOf('applyVisibility');
  assert.notEqual(applyIndex, -1, 'visibility application not found');

  const announceIndex = script.indexOf('announceCount(visible)');
  assert.notEqual(announceIndex, -1, 'count announcement not found');

  assert.ok(
    announceIndex > applyIndex,
    'the count must be announced after visibility is computed so the number matches the visible cards',
  );
});

test('LR3: the empty-match branch announces the no-results status', () => {
  const script = component.slice(component.indexOf('<script'));
  assert.match(
    script,
    /No matching skills found\./,
    'the no-results message must be preserved and driven by the visible count',
  );
  assert.match(
    script,
    /visible === 0[\s\S]{0,80}No matching skills found\./,
    'zero visible cards must announce the no-results message',
  );
});

test('LR4: the built page carries the same live-region wiring', { skip: !fs.existsSync(distIndex) }, () => {
  const html = fs.readFileSync(distIndex, 'utf8');

  assert.match(openingTag(html, 'search-status'), /aria-live="polite"/);
  assert.doesNotMatch(html, /id="search-result-list"/, 'the built page must not ship a runtime result list');
});
