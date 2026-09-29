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

const SCRIPT_RE = /<script define:vars=\{\{ base, clientMessages \}\}>([\s\S]*?)<\/script>/;
const CLIENT_MESSAGES = {
  noMatching: 'No matching skills found.',
  resultFound: '{count} result found.',
  resultsFound: '{count} results found.',
  unavailableFilter: 'Full-text search is unavailable. Showing {count} filter match{suffix}.',
  unavailableAll: 'Full-text search is unavailable. Showing all {count} skill{suffix}.',
  searching: 'Searching…',
  groupCount: '{count} of {total} skills matched',
};

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
  querySelector(selector: string): FakeElement | null;
  parentElement: FakeElement | null;
  anchor: FakeElement;
}

class FakeElement {
  tagName: string;
  children: Array<FakeElement | FakeCard | FakeGroup> = [];
  parentElement: FakeElement | null = null;
  className = '';
  attributes: Record<string, string> = {};
  private value = '';
  constructor(tagName = 'div') { this.tagName = tagName; }
  get textContent(): string {
    return this.children.length
      ? this.children.map((child) => child instanceof FakeElement ? child.textContent : '').join('')
      : this.value;
  }
  set textContent(value: string) {
    this.children = [];
    this.value = value;
  }
  appendChild<T extends FakeElement | FakeCard | FakeGroup>(child: T): T {
    if (child.parentElement) {
      child.parentElement.children = child.parentElement.children.filter((entry) => entry !== child);
    }
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  querySelector(selector: string): FakeElement | null {
    const matches = (element: FakeElement) =>
      selector === '[data-search-excerpt]' ? element.getAttribute('data-search-excerpt') !== null
        : selector.startsWith('.') ? element.className.split(' ').includes(selector.slice(1))
          : element.tagName === selector;
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      if (matches(child)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

interface FakeGroup {
  hidden: boolean;
  open: boolean;
  source: string;
  cards: FakeCard[];
  grid: FakeElement;
  count: FakeElement;
  parentElement: FakeElement | null;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): FakeCard[];
  querySelector(selector: string): FakeElement | null;
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

function createCard(data: CardData, order: number): FakeCard {
  const anchor = new FakeElement('a');
  const title = new FakeElement();
  title.className = 'card-title';
  title.textContent = data.name;
  const description = new FakeElement();
  description.className = 'card-description';
  description.textContent = data.name + ' description';
  anchor.appendChild(title);
  anchor.appendChild(description);
  return {
    hidden: false,
    data,
    anchor,
    parentElement: null,
    querySelector(selector) { return selector === 'a' ? anchor : anchor.querySelector(selector); },
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
        case 'data-catalog-order':
          return String(order);
        default:
          return null;
      }
    },
  };
}

/**
 * Groups the synthetic cards by source into native-<details> stand-ins, in the
 * same collapsed/visible initial state the server renders. The group objects
 * share the exact card instances the document returns, so a card hidden by
 * applyVisibility is immediately reflected in its group's match count.
 */
function createGroups(cards: FakeCard[]): FakeGroup[] {
  const bySource = new Map<string, FakeCard[]>();
  for (const card of cards) {
    const source = card.data.source;
    (bySource.get(source) ?? bySource.set(source, []).get(source)!).push(card);
  }
  return [...bySource.keys()].sort().map((source, order) => ({
    hidden: false,
    open: false,
    source,
    cards: bySource.get(source)!,
    grid: new FakeElement(),
    count: new FakeElement(),
    parentElement: null,
    getAttribute(name: string) {
      return name === 'data-source' ? this.source
        : name === 'data-catalog-order' ? String(order)
          : null;
    },
    querySelectorAll(selector: string) {
      return selector === '[data-skill-card]' ? this.grid.children as FakeCard[] : [];
    },
    querySelector(selector: string) {
      if (selector === '.skill-group-grid') return this.grid;
      if (selector === '[data-skill-group-count]') return this.count;
      return null;
    },
  })).map((group) => {
    group.count.textContent = String(group.cards.length);
    for (const card of group.cards) group.grid.appendChild(card);
    return group;
  });
}

const CARDS: CardData[] = [
  {
    source: 'azure',
    license: 'MIT',
    origin: 'Synced',
    name: 'az-cost-optimize',
    url: '/skills/azure/az-cost-optimize/',
  },
  {
    source: 'azure',
    license: 'Apache-2.0',
    origin: 'Synced',
    name: 'az-deploy',
    url: '/skills/azure/az-deploy/',
  },
  {
    source: 'cloudflare',
    license: 'MIT',
    origin: 'Synced',
    name: 'workers-ai',
    url: '/skills/cloudflare/workers-ai/',
  },
  {
    source: 'claude',
    license: 'Unknown',
    origin: 'Restricted',
    name: 'docx',
    url: '/skills/claude/docx/',
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
  const controlIds = ['search-input', 'filter-source', 'filter-license', 'filter-origin', 'search-status', 'catalog-count', 'expand-all-groups', 'collapse-all-groups', 'catalog-group-controls'];
  const controls: Record<string, FakeControl> = {};
  for (const id of controlIds) controls[id] = createControl(id);
  // The controls container starts hidden in markup; JS must reveal it.
  (controls['catalog-group-controls'] as unknown as { hidden: boolean }).hidden = true;

  const cards = cardData.map(createCard);
  const groups = createGroups(cards);
  const catalogGrid = new FakeElement();
  for (const group of groups) catalogGrid.appendChild(group);
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
      if (selector === '[data-skill-card]') return cards;
      if (selector === '[data-skill-group]') return groups;
      return [];
    },
    createElement(tag: string) { return new FakeElement(tag); },
    createTextNode(text: string) {
      const node = new FakeElement('#text');
      node.textContent = text;
      return node;
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
    'clientMessages',
    'console',
    'setTimeout',
    'clearTimeout',
    readSearchScript(),
  );
  factory(
    documentStub,
    base,
    CLIENT_MESSAGES,
    consoleStub,
    timers.setTimeout ?? setTimeout,
    timers.clearTimeout ?? clearTimeout,
  );

  return {
    controls,
    cards,
    groups,
    consoleErrors,
    visibleNames() {
      return catalogGrid.children.flatMap((group) =>
        (group as FakeGroup).grid.children.filter((c) => !(c as FakeCard).hidden).map((c) => (c as FakeCard).data.name));
    },
    groupOrder() { return catalogGrid.children.map((group) => (group as FakeGroup).source); },
    groupCounts() { return groups.map((group) => group.count.textContent); },
    /** Snapshot of every group's visibility and open state, in DOM order. */
    groupState() {
      return groups.map((g) => ({
        source: g.source,
        hidden: g.hidden,
        open: g.open,
        visibleCards: g.cards.filter((c) => !c.hidden).length,
      }));
    },
    openSources() {
      return groups.filter((g) => g.open && !g.hidden).map((g) => g.source);
    },
    visibleSources() {
      return groups.filter((g) => !g.hidden).map((g) => g.source);
    },
    controlsHidden() {
      return (controls['catalog-group-controls'] as unknown as { hidden?: boolean }).hidden === true;
    },
    fireExpandAll() {
      const handlers = controls['expand-all-groups'].handlers.click ?? [];
      assert.equal(handlers.length, 1, 'expand-all must be wired to one click handler');
      handlers[0]();
    },
    fireCollapseAll() {
      const handlers = controls['collapse-all-groups'].handlers.click ?? [];
      assert.equal(handlers.length, 1, 'collapse-all must be wired to one click handler');
      handlers[0]();
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
      '/skills/azure/az-cost-optimize/',
      '/skills/cloudflare/workers-ai/',
    ]),
  };
  const harness = bootSearch(fixturesBase);

  harness.controls['search-input'].value = 'deploy';
  // Fire via the filter change so the request runs synchronously (no debounce).
  await harness.fireFilterChange();

  const state = (globalThis as Record<string, any>).__PAGEFIND_STUB__;
  assert.equal(state.searchCalls, 1, `a text query must reach Pagefind: ${String(harness.consoleErrors)}`);
  assert.deepEqual(harness.visibleNames(), ['az-cost-optimize', 'workers-ai']);
  assert.equal(harness.status(), '2 results found.');

  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});

test('C7: a text query intersected with a dropdown filter keeps only cards in both sets', async () => {
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = {
    results: pagefindResults([
      '/skills/azure/az-cost-optimize/',
      '/skills/cloudflare/workers-ai/',
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
  assert.equal(scheduled.length, 3, 'the replacement query schedules status and debounce without settling the old result');

  releaseFirst({
    results: pagefindResults(['/skills/tampermonkey/tampermonkey/']),
  });
  await firstSearch;

  assert.deepEqual(
    harness.visibleNames(),
    ['az-cost-optimize', 'az-deploy', 'docx', 'workers-ai'],
    'the stale first response must not change cards after the input value changes',
  );
  assert.equal(harness.status(), '', 'the stale response must not announce its result count');

  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});

test('C12: a failed Pagefind initialization is retried on the next text query', async () => {
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = {
    optionsFailures: 1,
    results: pagefindResults(['/skills/azure/az-cost-optimize/']),
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

// ─── Source-folder group synchronization ────────────────────────────

test('G1: the initial bootstrap leaves every group visible and collapsed', () => {
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
  const harness = bootSearch(missingBase);

  for (const g of harness.groupState()) {
    assert.equal(g.hidden, false, `group ${g.source} must start visible`);
    assert.equal(g.open, false, `group ${g.source} must start collapsed`);
  }
  // The catalog is unfiltered, so all cards remain present.
  assert.equal(harness.visibleNames().length, CARDS.length);
});

test('G2: JS reveals the Expand all / Collapse all controls', () => {
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
  const harness = bootSearch(missingBase);
  assert.equal(harness.controlsHidden(), false, 'the controls container must be unhidden by JS');
});

test('G3: a source filter opens the matching group and hides the empty ones', async () => {
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
  const harness = bootSearch(missingBase);

  harness.controls['filter-source'].value = 'azure';
  await harness.fireFilterChange();

  assert.deepEqual(harness.openSources(), ['azure'], 'only the azure group must open');
  assert.deepEqual(harness.visibleSources(), ['azure'], 'groups with no match must be hidden');
  // Card counting is independent of group open state.
  assert.deepEqual(harness.visibleNames(), ['az-cost-optimize', 'az-deploy']);
  assert.equal(harness.status(), '2 results found.');
});

test('G4: a filter that matches nothing hides every group and keeps the count at zero', async () => {
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
  const harness = bootSearch(missingBase);

  harness.controls['filter-source'].value = 'azure';
  harness.controls['filter-license'].value = 'BSD-3-Clause';
  await harness.fireLicenseChange();

  assert.deepEqual(harness.visibleSources(), [], 'no group may stay visible with zero matches');
  assert.deepEqual(harness.openSources(), []);
  assert.equal(harness.visibleNames().length, 0);
  assert.equal(harness.status(), NO_RESULTS);
  assert.equal(harness.count(), '0');
});

test('G5: clearing every filter unhides all groups and collapses them, even after Expand all', async () => {
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
  const harness = bootSearch(missingBase);

  harness.controls['filter-source'].value = 'azure';
  await harness.fireFilterChange();
  harness.fireExpandAll();
  assert.deepEqual(harness.openSources(), ['azure'], 'expand-all opens the visible group');

  harness.controls['filter-source'].value = '';
  await harness.fireFilterChange();

  for (const g of harness.groupState()) {
    assert.equal(g.hidden, false, `group ${g.source} must be unhidden after clearing`);
    assert.equal(g.open, false, `group ${g.source} must collapse after clearing, regardless of prior expand-all`);
  }
  assert.equal(harness.visibleNames().length, CARDS.length);
});

test('G6: a Pagefind failure fallback syncs the groups to the cards it leaves visible', async () => {
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
  const harness = bootSearch(missingBase);

  harness.controls['search-input'].value = 'deploy';
  harness.controls['filter-source'].value = 'azure';
  await harness.fireFilterChange();

  // Fallback keeps only the azure filter matches, so only that group stays open.
  assert.deepEqual(harness.visibleNames(), ['az-cost-optimize', 'az-deploy']);
  assert.deepEqual(harness.openSources(), ['azure']);
  assert.deepEqual(harness.visibleSources(), ['azure']);
  assert.match(harness.status(), UNAVAILABLE_RE);
});

test('G7: Expand all / Collapse all operate only on non-hidden groups and never touch card visibility', async () => {
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
  const harness = bootSearch(missingBase);

  // Hide the non-azure groups via a filter.
  harness.controls['filter-source'].value = 'azure';
  await harness.fireFilterChange();
  const cardsBefore = harness.visibleNames();

  harness.fireExpandAll();
  for (const g of harness.groupState()) {
    if (g.hidden) {
      assert.equal(g.open, false, `hidden group ${g.source} must not be opened by expand-all`);
    } else {
      assert.equal(g.open, true, `visible group ${g.source} must open on expand-all`);
    }
  }
  assert.deepEqual(harness.visibleNames(), cardsBefore, 'expand-all must not change which cards are hidden');

  harness.fireCollapseAll();
  for (const g of harness.groupState()) {
    assert.equal(g.open, false, `collapse-all must close every non-hidden group (${g.source})`);
  }
  assert.deepEqual(harness.visibleNames(), cardsBefore, 'collapse-all must not change which cards are hidden');
});

test('G8: a text query opens every group holding a matching card', async () => {
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = {
    results: pagefindResults([
      '/skills/azure/az-cost-optimize/',
      '/skills/cloudflare/workers-ai/',
    ]),
  };
  const harness = bootSearch(fixturesBase);

  harness.controls['search-input'].value = 'deploy';
  await harness.fireFilterChange();

  assert.deepEqual(harness.visibleNames(), ['az-cost-optimize', 'workers-ai']);
  assert.deepEqual(harness.openSources().sort(), ['azure', 'cloudflare']);
  assert.deepEqual(harness.visibleSources().sort(), ['azure', 'cloudflare']);

  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});

test('G9: the DOMContentLoaded initial pass leaves all groups collapsed and visible', () => {
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
  const harness = bootSearch(missingBase, CARDS, { documentReadyState: 'loading' });

  harness.fireDocumentEvent('DOMContentLoaded');

  for (const g of harness.groupState()) {
    assert.equal(g.hidden, false, `group ${g.source} must be visible after the initial pass`);
    assert.equal(g.open, false, `group ${g.source} must be collapsed after the initial pass`);
  }
  assert.equal(harness.controlsHidden(), false, 'controls must be revealed after DOMContentLoaded');
});

test('R1: ranked results reorder existing cards and groups; clearing restores catalog order', async () => {
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = {
    results: [
      { score: 1, data: async () => ({ url: CARDS[0].url }) },
      { score: 12, data: async () => ({ url: CARDS[2].url }) },
      { score: 5, data: async () => ({ url: CARDS[1].url }) },
    ],
  };
  const harness = bootSearch(fixturesBase);
  harness.controls['search-input'].value = 'deploy';
  await harness.fireFilterChange();
  assert.deepEqual(harness.groupOrder().slice(0, 2), ['cloudflare', 'azure']);
  assert.deepEqual(harness.visibleNames(), ['workers-ai', 'az-deploy', 'az-cost-optimize']);
  harness.controls['search-input'].value = '';
  await harness.fireFilterChange();
  assert.deepEqual(harness.groupOrder(), ['azure', 'claude', 'cloudflare']);
  assert.deepEqual(harness.visibleNames(), ['az-cost-optimize', 'az-deploy', 'docx', 'workers-ai']);
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});

test('R2: excerpt decodes entities and treats hostile HTML as text, title/description marks clear', async () => {
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = {
    results: [{
      score: 9,
      data: async () => ({
        url: CARDS[1].url,
        excerpt: 'An <mark>az</mark> &amp; &lt;img src=x onerror=alert(1)&gt; <script>oops</script> &#x1F680;',
      }),
    }],
  };
  const harness = bootSearch(fixturesBase);
  harness.controls['search-input'].value = 'az';
  await harness.fireFilterChange();
  const card = harness.cards[1];
  const excerpt = card.querySelector('[data-search-excerpt]');
  assert.ok(excerpt);
  assert.equal(excerpt.textContent, 'An az & <img src=x onerror=alert(1)> <script>oops</script> 🚀');
  assert.equal(excerpt.children.filter((child) => (child as FakeElement).tagName === 'mark').length, 1);
  assert.equal(card.querySelector('.card-title')?.querySelector('mark')?.textContent, 'az');
  assert.equal(card.querySelector('.card-description')?.querySelector('mark')?.textContent, 'az');
  harness.controls['search-input'].value = '';
  await harness.fireFilterChange();
  assert.equal(card.querySelector('[data-search-excerpt]'), null);
  assert.equal(card.querySelector('.card-title')?.querySelector('mark'), null);
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});

test('R3: active group count shows matched / total with localized accessible label', async () => {
  const harness = bootSearch(missingBase);
  harness.controls['filter-license'].value = 'MIT';
  await harness.fireLicenseChange();
  assert.deepEqual(harness.groupCounts(), ['1 / 2', '0 / 1', '1 / 1']);
  assert.equal(harness.groups[0].count.getAttribute('aria-label'), '1 of 2 skills matched');
  harness.controls['filter-license'].value = '';
  await harness.fireLicenseChange();
  assert.deepEqual(harness.groupCounts(), ['2', '1', '1']);
});

test('R4: pending status is delayed and cancelled on settlement and replacement', async () => {
  const callbacks = new Map<number, () => unknown>();
  let next = 0;
  const harness = bootSearch(fixturesBase, CARDS, {
    setTimeout(handler) { const id = ++next; callbacks.set(id, handler); return id; },
    clearTimeout(id) { callbacks.delete(id as number); },
  });
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = { results: [] };
  harness.controls['search-input'].value = 'first';
  harness.fireInput();
  assert.equal(harness.status(), '');
  const delayed = [...callbacks.values()][0];
  delayed();
  assert.equal(harness.status(), 'Searching…');
  harness.controls['search-input'].value = '';
  harness.fireInput();
  assert.equal(harness.status(), '');
  delayed();
  assert.equal(harness.status(), '');
  for (const [id, callback] of [...callbacks]) if (id === next - 1) callback();
  assert.equal(harness.status(), '');
  await new Promise<void>((resolve) => setImmediate(resolve));
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});

test('R5: non-empty input preloads before debounce and its load failure settles unavailable only once', async () => {
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = {
    optionsFailures: 1, results: pagefindResults([CARDS[0].url]),
  };
  const callbacks = new Map<number, () => unknown>();
  let next = 0;
  const harness = bootSearch(fixturesBase, CARDS, {
    setTimeout(handler) { const id = ++next; callbacks.set(id, handler); return id; },
    clearTimeout(id) { callbacks.delete(id as number); },
  });
  harness.controls['search-input'].value = 'first';
  harness.fireInput();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((globalThis as Record<string, any>).__PAGEFIND_STUB__.optionsCalls, 1);
  const debounce = callbacks.get(2)!;
  await debounce();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(harness.status(), UNAVAILABLE_RE);
  assert.equal((globalThis as Record<string, any>).__PAGEFIND_STUB__.optionsCalls, 1);
  harness.controls['search-input'].value = 'second';
  await harness.fireFilterChange();
  assert.equal((globalThis as Record<string, any>).__PAGEFIND_STUB__.optionsCalls, 2);
  assert.deepEqual(harness.visibleNames(), ['az-cost-optimize']);
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});

test('R6: a replaced failed preload cannot write UI and next query retries', async () => {
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = {
    optionsFailures: 1, results: pagefindResults([CARDS[0].url]),
  };
  const harness = bootSearch(fixturesBase);
  harness.controls['search-input'].value = 'first';
  harness.fireInput();
  await new Promise<void>((resolve) => setImmediate(resolve));
  harness.controls['search-input'].value = '';
  harness.fireInput();
  harness.controls['search-input'].value = 'second';
  await harness.fireFilterChange();
  assert.deepEqual(harness.visibleNames(), ['az-cost-optimize']);
  assert.equal((globalThis as Record<string, any>).__PAGEFIND_STUB__.optionsCalls, 2);
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});

test('R7: a failed search destroys Pagefind and the next query reinitializes it', async () => {
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = { searchThrows: true };
  const harness = bootSearch(fixturesBase);
  harness.controls['search-input'].value = 'bad';
  await harness.fireFilterChange();
  assert.match(harness.status(), UNAVAILABLE_RE);
  const state = (globalThis as Record<string, any>).__PAGEFIND_STUB__;
  assert.equal(state.destroyCalls, 1);
  state.searchThrows = false;
  state.results = pagefindResults([CARDS[2].url]);
  harness.controls['search-input'].value = 'good';
  await harness.fireFilterChange();
  assert.equal(state.optionsCalls, 2);
  assert.deepEqual(harness.visibleNames(), ['workers-ai']);
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});

test('R8: input preloads the current query and filters before debounce, without loading on filter-only input', async () => {
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = { results: [] };
  const harness = bootSearch(fixturesBase, CARDS, {
    setTimeout() { return 1; },
    clearTimeout() {},
  });
  harness.controls['filter-source'].value = 'azure';
  harness.controls['search-input'].value = 'deploy';
  harness.fireInput();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const state = (globalThis as Record<string, any>).__PAGEFIND_STUB__;
  assert.equal(state.preloadCalls, 1);
  assert.equal(state.searchCalls, undefined);
  assert.equal(state.lastPreloadQuery, 'deploy');
  assert.deepEqual(state.lastPreloadOptions, { filters: { source: 'azure' } });
  harness.controls['search-input'].value = '';
  harness.fireInput();
  assert.equal(state.preloadCalls, 1);
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});

test('R9: settled result count cannot be overwritten by an expired Searching callback', async () => {
  (globalThis as Record<string, unknown>).__PAGEFIND_STUB__ = { results: pagefindResults([CARDS[0].url]) };
  const callbacks: Array<() => unknown> = [];
  const harness = bootSearch(fixturesBase, CARDS, {
    setTimeout(handler) { callbacks.push(handler); return callbacks.length; },
    clearTimeout() {},
  });
  harness.controls['search-input'].value = 'azure';
  harness.fireInput();
  const delayed = callbacks[0];
  await callbacks[1]();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.status(), '1 result found.');
  delayed();
  assert.equal(harness.status(), '1 result found.');
  delete (globalThis as Record<string, unknown>).__PAGEFIND_STUB__;
});
