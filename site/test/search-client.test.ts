/**
 * Search client behaviour tests.
 *
 * These execute the ACTUAL client script shipped inside Search.astro against a
 * minimal DOM stub whose `querySelectorAll('[data-skill-card]')` returns a
 * synthetic set of catalog cards. They prove the unified-search contract:
 *
 *  - Filter-only changes (empty text query) never import or call Pagefind and
 *    filter the existing cards purely from their data-* attributes.
 *  - A non-empty text query loads Pagefind and keeps only the cards whose URL
 *    is in the result set (intersected with any active dropdown filters).
 *  - A Pagefind load failure with an active filter keeps the matching cards
 *    visible, hides the rest, shows one status message, and never renders a
 *    second result list.
 *  - The heading count and the single live region always reflect the number of
 *    visible cards.
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

const UNAVAILABLE_RE = /full-text search is unavailable/i;
const NO_RESULTS = 'No matching skills found.';

interface FakeControl {
  id: string;
  value: string;
  textContent: string;
  dataset: Record<string, string>;
  handlers: Record<string, Array<(event?: unknown) => unknown>>;
  addEventListener(type: string, handler: (event?: unknown) => unknown): void;
}

interface CardData {
  source: string;
  license: string;
  origin: string;
  name: string;
  url: string;
}

interface FakeCard {
  hidden: boolean;
  getAttribute(name: string): string | null;
  data: CardData;
}

function createControl(id: string): FakeControl {
  return {
    id,
    value: '',
    textContent: '',
    dataset: {},
    handlers: {},
    addEventListener(type, handler) {
      (this.handlers[type] ??= []).push(handler);
    },
  };
}

function createCard(data: CardData): FakeCard {
  return {
    hidden: false,
    data,
    getAttribute(name: string) {
      switch (name) {
        case 'data-source':
          return this.data.source;
        case 'data-license':
          return this.data.license;
        case 'data-origin':
          return this.data.origin;
        case 'data-name':
          return this.data.name;
        case 'data-url':
          return this.data.url;
        default:
          return null;
      }
    },
  };
}

const CARDS: CardData[] = [
  {
    source: 'azure',
    license: 'MIT',
    origin: 'Synced',
    name: 'az-cost-optimize',
    url: '/Skills/skills/azure/az-cost-optimize/',
  },
  {
    source: 'azure',
    license: 'Apache-2.0',
    origin: 'Synced',
    name: 'az-deploy',
    url: '/Skills/skills/azure/az-deploy/',
  },
  {
    source: 'cloudflare',
    license: 'MIT',
    origin: 'Synced',
    name: 'workers-ai',
    url: '/Skills/skills/cloudflare/workers-ai/',
  },
  {
    source: 'claude',
    license: 'Unknown',
    origin: 'Restricted',
    name: 'docx',
    url: '/Skills/skills/claude/docx/',
  },
];

function readSearchScript(): string {
  const match = fs.readFileSync(searchAstroPath, 'utf8').match(SCRIPT_RE);
  assert.ok(match, 'Search.astro must ship its client integration in a define:vars script block');
  return match![1];
}

/** Boots the shipped Search.astro script against a DOM stub with synthetic cards. */
function bootSearch(
  base: string,
  cardData: CardData[] = CARDS,
  timers: {
    setTimeout?: (handler: () => unknown, delay: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
    documentReadyState?: 'loading' | 'complete';
  } = {},
) {
  const controlIds = ['search-input', 'filter-source', 'filter-license', 'filter-origin', 'search-status', 'catalog-count'];
  const controls: Record<string, FakeControl> = {};
  for (const id of controlIds) controls[id] = createControl(id);

  const cards = cardData.map(createCard);
  const consoleErrors: unknown[][] = [];
  const documentHandlers: Record<string, Array<() => unknown>> = {};

  const documentStub = {
    readyState: timers.documentReadyState ?? 'complete',
    addEventListener(type: string, handler: () => unknown) {
      (documentHandlers[type] ??= []).push(handler);
    },
    getElementById(id: string) {
      return controls[id] ?? null;
    },
    querySelectorAll(selector: string) {
      return selector === '[data-skill-card]' ? cards : [];
    },
  };
  const consoleStub = {
    error(...args: unknown[]) {
      consoleErrors.push(args);
    },
  };

  const factory = new Function(
    'document',
    'base',
    'console',
    'setTimeout',
    'clearTimeout',
    readSearchScript(),
  );
  factory(
    documentStub,
    base,
    consoleStub,
    timers.setTimeout ?? setTimeout,
    timers.clearTimeout ?? clearTimeout,
  );

  return {
    controls,
    cards,
    consoleErrors,
    visibleNames() {
      return cards.filter((c) => !c.hidden).map((c) => c.data.name);
    },
    status() {
      return controls['search-status'].textContent;
    },
    count() {
      return controls['catalog-count'].textContent;
    },
    async fireFilterChange() {
      const handlers = controls['filter-source'].handlers.change ?? [];
      assert.equal(handlers.length, 1, 'the source filter must be wired to the search handler');
      await handlers[0]({ type: 'change' });
    },
    async fireLicenseChange() {
      const handlers = controls['filter-license'].handlers.change ?? [];
      assert.equal(handlers.length, 1, 'the license filter must be wired to the search handler');
      await handlers[0]({ type: 'change' });
    },
    fireInput() {
      const handlers = controls['search-input'].handlers.input ?? [];
      assert.equal(handlers.length, 1, 'the search input must have one input handler');
      handlers[0]();
    },
    fireDocumentEvent(type: string) {
      for (const handler of documentHandlers[type] ?? []) handler();
    },
  };
}

function pagefindResults(urls: string[]) {
  return urls.map((url) => ({ data: async () => ({ url }) }));
}

// ─── Filter-only path is Pagefind-independent ───────────────────────

test('C1: a filter-only change never imports or calls Pagefind', async () => {
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
  const harness = bootSearch(missingBase); // a real import here would throw

  harness.controls['filter-source'].value = 'azure';
  await harness.fireFilterChange();

  assert.equal(
    (globalThis as Record<string, unknown>).__PAGEFIND_STUB__,
    undefined,
    'filter-only search must not load the Pagefind module',
  );
  assert.equal(harness.consoleErrors.length, 0, 'no load error can occur if Pagefind was never imported');
});

test('C2: a filter-only change shows only the matching cards and hides the rest', async () => {
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
  const harness = bootSearch(missingBase);

  harness.controls['filter-source'].value = 'azure';
  await harness.fireFilterChange();

  assert.deepEqual(harness.visibleNames(), ['az-cost-optimize', 'az-deploy']);
  assert.equal(harness.status(), '2 results found.');
  assert.equal(harness.count(), '2', 'the heading count must reflect the visible cards');
});

test('C3: combined dropdown filters intersect on the cards', async () => {
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
  const harness = bootSearch(missingBase);

  harness.controls['filter-source'].value = 'azure';
  harness.controls['filter-license'].value = 'MIT';
  await harness.fireLicenseChange();

  assert.deepEqual(harness.visibleNames(), ['az-cost-optimize']);
  assert.equal(harness.status(), '1 result found.');
});

test('C4: an empty filter set restores every card and clears the status', async () => {
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
  const harness = bootSearch(missingBase);

  harness.controls['filter-source'].value = 'azure';
  await harness.fireFilterChange();
  assert.equal(harness.visibleNames().length, 2);

  harness.controls['filter-source'].value = '';
  await harness.fireFilterChange();

  assert.equal(harness.visibleNames().length, CARDS.length, 'clearing the filter restores every card');
  assert.equal(harness.status(), '', 'the live region is emptied when nothing is active');
  assert.equal(harness.count(), String(CARDS.length), 'the heading count returns to the total');
});

test('C5: a filter-only change that matches nothing shows the no-results status', async () => {
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
  const harness = bootSearch(missingBase);

  harness.controls['filter-source'].value = 'azure';
  harness.controls['filter-license'].value = 'BSD-3-Clause';
  await harness.fireLicenseChange();

  assert.equal(harness.visibleNames().length, 0, 'no card matches the impossible combination');
  assert.equal(harness.status(), NO_RESULTS);
  assert.equal(harness.count(), '0');
});

// ─── Text query uses Pagefind result URLs ───────────────────────────

test('C6: a text query keeps only the cards whose URL is in the Pagefind result set', async () => {
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = {
    results: pagefindResults([
      '/Skills/skills/azure/az-cost-optimize/',
      '/Skills/skills/cloudflare/workers-ai/',
    ]),
  };
  const harness = bootSearch(fixturesBase);

  harness.controls['search-input'].value = 'deploy';
  // Fire via the filter change so the request runs synchronously (no debounce).
  await harness.fireFilterChange();

  const state = (globalThis as Record<string, any>).__PAGEFIND_STUB__;
  assert.equal(state.searchCalls, 1, 'a text query must reach Pagefind');
  assert.deepEqual(harness.visibleNames(), ['az-cost-optimize', 'workers-ai']);
  assert.equal(harness.status(), '2 results found.');

  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});

test('C7: a text query intersected with a dropdown filter keeps only cards in both sets', async () => {
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = {
    results: pagefindResults([
      '/Skills/skills/azure/az-cost-optimize/',
      '/Skills/skills/cloudflare/workers-ai/',
    ]),
  };
  const harness = bootSearch(fixturesBase);

  harness.controls['search-input'].value = 'deploy';
  harness.controls['filter-source'].value = 'azure';
  await harness.fireFilterChange();

  assert.deepEqual(
    harness.visibleNames(),
    ['az-cost-optimize'],
    'card-side matching must require both the URL membership and the source filter',
  );

  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});

// ─── Pagefind failure leaves the filtered cards in place ────────────

test('C8: a Pagefind load failure with an active filter keeps the matching cards and shows one message', async () => {
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
  const harness = bootSearch(missingBase);

  harness.controls['search-input'].value = 'deploy';
  harness.controls['filter-source'].value = 'azure';
  await harness.fireFilterChange();

  assert.deepEqual(
    harness.visibleNames(),
    ['az-cost-optimize', 'az-deploy'],
    'the dropdown filter must still narrow the cards when full-text search is unavailable',
  );
  assert.equal(
    harness.status(),
    'Full-text search is unavailable. Showing 2 filter matches.',
  );
  assert.equal(harness.consoleErrors.length, 1, 'the load failure must still be logged');
});

test('C9: a Pagefind search failure with an active filter behaves the same as a load failure', async () => {
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = { searchThrows: true };
  const harness = bootSearch(fixturesBase);

  harness.controls['search-input'].value = 'deploy';
  harness.controls['filter-source'].value = 'azure';
  await harness.fireFilterChange();

  const state = (globalThis as Record<string, any>).__PAGEFIND_STUB__;
  assert.equal(state.searchCalls, 1, 'the stubbed Pagefind search must have been reached');
  assert.deepEqual(harness.visibleNames(), ['az-cost-optimize', 'az-deploy']);
  assert.equal(harness.status(), 'Full-text search is unavailable. Showing 2 filter matches.');
  assert.equal(harness.consoleErrors.length, 1, 'the search failure must still be logged');

  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});

// ─── Structural contract: no second result list ─────────────────────

test('C10: the client never renders a runtime result list via innerHTML', () => {
  const template = fs.readFileSync(searchAstroPath, 'utf8');
  assert.doesNotMatch(template, /search-result-list/, 'the separate runtime result list must be gone');
  assert.doesNotMatch(template, /\.innerHTML\s*=/, 'results must be shown by toggling existing cards, not innerHTML');
});

test('C11: changing text immediately invalidates an older in-flight search before debounce runs', async () => {
  let releaseFirst!: (value: { results: ReturnType<typeof pagefindResults> }) => void;
  const firstPromise = new Promise<{ results: ReturnType<typeof pagefindResults> }>((resolve) => {
    releaseFirst = resolve;
  });
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = {
    searchPromise: firstPromise,
  };

  const scheduled: Array<() => unknown> = [];
  const harness = bootSearch(fixturesBase, CARDS, {
    setTimeout(handler) {
      scheduled.push(handler);
      return scheduled.length;
    },
    clearTimeout() {},
  });

  harness.controls['search-input'].value = 'tampermonkey';
  const firstSearch = harness.fireFilterChange();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((globalThis as Record<string, any>).__PAGEFIND_STUB__.searchCalls === 1) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(
    (globalThis as Record<string, any>).__PAGEFIND_STUB__.searchCalls,
    1,
    'the first search must be in flight before the input changes',
  );

  harness.controls['search-input'].value = 'terraform';
  harness.fireInput();
  assert.equal(scheduled.length, 1, 'the replacement query must still be waiting in debounce');

  releaseFirst({
    results: pagefindResults(['/Skills/skills/tampermonkey/tampermonkey/']),
  });
  await firstSearch;

  assert.deepEqual(
    harness.visibleNames(),
    CARDS.map((card) => card.name),
    'the stale first response must not change cards after the input value changes',
  );
  assert.equal(harness.status(), '', 'the stale response must not announce its result count');

  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});

test('C12: a failed Pagefind initialization is retried on the next text query', async () => {
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = {
    optionsFailures: 1,
    results: pagefindResults(['/Skills/skills/azure/az-cost-optimize/']),
  };
  const harness = bootSearch(fixturesBase);

  harness.controls['search-input'].value = 'first';
  await harness.fireFilterChange();
  assert.match(harness.status(), UNAVAILABLE_RE);

  harness.controls['search-input'].value = 'second';
  await harness.fireFilterChange();

  const state = (globalThis as Record<string, any>).__PAGEFIND_STUB__;
  assert.equal(state.optionsCalls, 2, 'failed initialization must be attempted again');
  assert.equal(state.searchCalls, 1, 'the recovered module must execute the second search');
  assert.deepEqual(harness.visibleNames(), ['az-cost-optimize']);
  assert.equal(harness.status(), '1 result found.');

  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});

test('C13: initialization waits for the catalog DOM and applies controls changed during parsing', () => {
  const harness = bootSearch(missingBase, CARDS, { documentReadyState: 'loading' });
  assert.equal(
    harness.controls['filter-source'].handlers.change?.length ?? 0,
    0,
    'filter handlers must not attach before DOMContentLoaded',
  );

  harness.controls['filter-source'].value = 'azure';
  harness.fireDocumentEvent('DOMContentLoaded');

  assert.equal(harness.controls['filter-source'].handlers.change?.length, 1);
  assert.deepEqual(
    harness.visibleNames(),
    ['az-cost-optimize', 'az-deploy'],
    'initialization must apply a filter selected before the catalog finished parsing',
  );
  assert.equal(harness.status(), '2 results found.');
});
