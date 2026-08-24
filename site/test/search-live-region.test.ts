/**
 * Search live-region sequencing guards.
 *
 * Two defects lived together in Search.astro:
 *
 *  1. `aria-live="polite"` sat on `#search-results`, the container that also
 *     holds `<ul id="search-result-list">`. Every row insertion therefore
 *     queued its own announcement, so a screen reader read the whole result
 *     list instead of the one-line status.
 *  2. The status text ("N results found.") was written BEFORE
 *     `await Promise.all(...data())` and before the rows were inserted, so the
 *     count was announced while the list was still empty or stale.
 *
 * The live region now sits on the status paragraph only, and the count is
 * written after the rows exist.
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

test('LR1: the live region is the status paragraph, not the results container', () => {
  const statusTag = openingTag(component, 'search-status');
  const containerTag = openingTag(component, 'search-results');

  assert.match(statusTag, /aria-live="polite"/, 'the status line must be the live region');
  assert.match(
    statusTag,
    /aria-atomic="true"/,
    'the status is a single sentence and must be announced atomically',
  );
  assert.doesNotMatch(
    containerTag,
    /aria-live/,
    'the results container must not announce every inserted row',
  );
});

test('LR2: the results count is written only after the rows are rendered', () => {
  const script = component.slice(component.indexOf('<script'));

  const rowsIndex = script.indexOf('resultList.innerHTML = data.map');
  assert.notEqual(rowsIndex, -1, 'row rendering not found');

  const countIndex = script.indexOf("' result'");
  assert.notEqual(countIndex, -1, 'result-count status not found');

  assert.ok(
    countIndex > rowsIndex,
    'the count announcement must come after the rows are inserted, ' +
      'otherwise assistive tech reads a number the DOM does not have yet',
  );
});

test('LR3: the empty-result status still short-circuits before rendering rows', () => {
  const script = component.slice(component.indexOf('<script'));

  assert.match(
    script,
    /No matching skills found\./,
    'the no-results message must be preserved',
  );

  const noResults = script.indexOf('No matching skills found.');
  const clearsRows = script.indexOf("resultList.innerHTML = ''", noResults);
  assert.ok(
    clearsRows > noResults && clearsRows - noResults < 200,
    'the no-results branch must clear the list next to its status write',
  );
});

test('LR4: the built page carries the same live-region wiring', { skip: !fs.existsSync(distIndex) }, () => {
  const html = fs.readFileSync(distIndex, 'utf8');

  assert.match(openingTag(html, 'search-status'), /aria-live="polite"/);
  assert.doesNotMatch(openingTag(html, 'search-results'), /aria-live/);
});
