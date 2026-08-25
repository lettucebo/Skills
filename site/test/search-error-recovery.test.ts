/**
 * Search error-recovery tests.
 *
 * Both current-generation Pagefind failure paths (index load failure and search
 * failure) restore the full catalog card grid. If the previous query already
 * painted results into #search-result-list, that stale markup stays visible
 * underneath the error message and above the restored catalog, so the page ends
 * up showing results that no longer correspond to the current query.
 *
 * These tests execute the ACTUAL script shipped inside Search.astro against a
 * minimal DOM stub, so they fail if the clearing is dropped or moved before the
 * generation guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const searchAstroPath = path.join(siteRoot, 'src', 'components', 'Search.astro');
const fixturesBase = pathToFileURL(path.join(siteRoot, 'test-fixtures') + path.sep).href;
const missingBase = pathToFileURL(path.join(siteRoot, 'test-fixtures', 'does-not-exist') + path.sep).href;

const SCRIPT_RE = /<script define:vars=\{\{ base \}\}>([\s\S]*?)<\/script>/;
const STALE_MARKUP = '<li class="search-result-item">stale result from a previous query</li>';

interface FakeElement {
  id: string;
  value: string;
  textContent: string;
  innerHTML: string;
  hidden: boolean;
  handlers: Record<string, Array<() => unknown>>;
  addEventListener(type: string, handler: () => unknown): void;
}

function createElement(id: string): FakeElement {
  return {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    handlers: {},
    addEventListener(type, handler) {
      (this.handlers[type] ??= []).push(handler);
    },
  };
}

function readSearchAstro(): string {
  return fs.readFileSync(searchAstroPath, 'utf8');
}

function extractSearchScript(): string {
  const match = readSearchAstro().match(SCRIPT_RE);
  assert.ok(match, 'Search.astro must ship its Pagefind integration in a define:vars script block');
  return match![1];
}

/** Boots the shipped Search.astro script against a DOM stub. */
function bootSearch(base: string) {
  const ids = [
    'search-input',
    'filter-source',
    'filter-license',
    'filter-origin',
    'search-results',
    'search-status',
    'search-result-list',
    'full-catalog',
  ];
  const elements: Record<string, FakeElement> = {};
  for (const id of ids) elements[id] = createElement(id);

  const consoleErrors: unknown[][] = [];
  const documentStub = {
    getElementById(id: string) {
      return elements[id] ?? null;
    },
  };
  const consoleStub = {
    error(...args: unknown[]) {
      consoleErrors.push(args);
    },
  };

  const factory = new Function('document', 'base', 'console', extractSearchScript());
  factory(documentStub, base, consoleStub);

  const changeHandlers = elements['filter-source'].handlers.change ?? [];
  assert.equal(changeHandlers.length, 1, 'the source filter must be wired to doSearch');

  return {
    elements,
    consoleErrors,
    /** Runs a current-generation search driven by an active filter. */
    async search() {
      await changeHandlers[0]();
    },
  };
}

// ─── G1: index load failure ─────────────────────────────────────────

test('G1: a current-generation Pagefind load failure clears stale results before restoring the catalog', async () => {
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
  const harness = bootSearch(missingBase);

  harness.elements['search-result-list'].innerHTML = STALE_MARKUP;
  harness.elements['filter-source'].value = 'azure';

  await harness.search();

  assert.match(
    harness.elements['search-status'].textContent,
    /index could not be loaded/,
    'the load failure must be reported to the user',
  );
  assert.equal(
    harness.elements['search-result-list'].innerHTML,
    '',
    'stale result markup must not survive a load failure',
  );
  assert.equal(
    harness.elements['full-catalog'].hidden,
    false,
    'the full catalog must be restored after a load failure',
  );
  assert.equal(harness.consoleErrors.length, 1, 'the load failure must still be logged');
});

// ─── G2: search failure ─────────────────────────────────────────────

test('G2: a current-generation Pagefind search failure clears stale results before restoring the catalog', async () => {
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = { searchThrows: true };
  const harness = bootSearch(fixturesBase);

  harness.elements['search-result-list'].innerHTML = STALE_MARKUP;
  harness.elements['filter-source'].value = 'azure';

  await harness.search();

  const stubState = (globalThis as Record<string, any>).__PAGEFIND_STUB__;
  assert.equal(stubState.searchCalls, 1, 'the stubbed Pagefind search must have been reached');

  assert.match(
    harness.elements['search-status'].textContent,
    /Search error/,
    'the search failure must be reported to the user',
  );
  assert.equal(
    harness.elements['search-result-list'].innerHTML,
    '',
    'stale result markup must not survive a search failure',
  );
  assert.equal(
    harness.elements['full-catalog'].hidden,
    false,
    'the full catalog must be restored after a search failure',
  );
  assert.equal(harness.consoleErrors.length, 1, 'the search failure must still be logged');

  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});

// ─── G3: clearing stays behind the generation guard ─────────────────

test('G3: both error paths clear results only after the generation guard, so stale generations stay no-ops', () => {
  const script = extractSearchScript();
  const catchBlocks = [...script.matchAll(/catch \(err\) \{([\s\S]*?)\n      \}/g)].map((m) => m[1]);

  assert.equal(catchBlocks.length, 2, `expected the load and search catch blocks; found ${catchBlocks.length}`);

  for (const body of catchBlocks) {
    const guardIndex = body.indexOf('gen !== generation');
    const clearIndex = body.search(/resultList\.innerHTML\s*=\s*''/);

    assert.ok(guardIndex !== -1, `error path must keep its generation guard: ${body.trim()}`);
    assert.ok(clearIndex !== -1, `error path must clear stale results: ${body.trim()}`);
    assert.ok(
      guardIndex < clearIndex,
      'the generation guard must run before any DOM mutation so stale generations stay no-ops',
    );
  }
});
