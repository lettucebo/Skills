/**
 * search.spec.ts — Unified search and filter interaction tests.
 *
 * The site renders ONE catalog grid (`#skill-grid` with `[data-skill-card]`
 * articles). Searching and filtering toggle each card's `hidden` attribute, so
 * a "result" is a visible card — there is never a second list. Every assertion
 * waits on the settled `#search-status` live region *and* the visible cards
 * (see `waitForRenderedResults`) rather than a fixed sleep, and validates the
 * metadata of what stayed visible.
 */
import { test, expect } from '@playwright/test';
import {
  BASE,
  NO_RESULTS_STATUS,
  countFromStatus,
  searchAndRead,
  waitForRenderedResults,
  waitForResultCount,
  type ResultRow,
} from './_helpers';

const HOME = BASE;

/**
 * A visible card must link to the current locale's skill detail page.
 * The localized homepage and source pages do not match.
 */
const SKILL_DETAIL_PATH_RE = /^\/Skills\/en\/skills\/[^/]+\/[^/]+\/$/;

/**
 * A query with no match at all. Pagefind does fuzzy/partial word matching, so
 * a run of latin letters still scores hits; only non-indexable symbols yield
 * the genuine empty state.
 */
const NO_MATCH_QUERY = '\u2295\u221E\u2297\u222E\u2298';

/**
 * Known-good filter combination taken from catalog/skills.lock.json:
 * `azure` + `MIT` + `Synced` is a non-empty, deterministic intersection.
 */
const COMBINED = { source: 'azure', license: 'MIT', origin: 'Synced' };

/**
 * Observation window (inside the page) used by the fault-injected generation
 * guard test. It starts only AFTER the stalled first-query responses have all
 * been delivered, so it is a bounded observation of an event that has already
 * happened — not a sleep used to paper over flakiness.
 */
const STALE_OBSERVATION_WINDOW_MS = 1_500;

/** Asserts every visible card carries the metadata that was filtered on. */
function assertEveryResultMatches(
  rows: ResultRow[],
  expected: { source?: string; license?: string; origin?: string },
): void {
  expect(rows.length, 'filtered search must leave at least one visible card').toBeGreaterThan(0);
  for (const row of rows) {
    const where = `card "${row.title}" (meta: ${JSON.stringify(row.metaSpans)})`;
    if (expected.source !== undefined) {
      expect(row.source, `${where} must be from source "${expected.source}"`).toBe(expected.source);
    }
    if (expected.origin !== undefined) {
      expect(row.origin, `${where} must show the "${expected.origin}" origin badge`).toBe(expected.origin);
    }
    if (expected.license !== undefined) {
      expect(row.metaSpans, `${where} must show license "${expected.license}"`).toContain(expected.license);
    }
  }
}

test.describe('Search — keyword, filters, rapid input, click-through', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HOME);
  });

  // ── Keyword search ───────────────────────────────────────────────────

  test('keyword search filters the canonical cards and keeps the catalog visible', async ({ page }) => {
    await page.locator('#search-input').fill('azure');
    const rows = await waitForRenderedResults(page);

    expect(rows.length, 'search for "azure" must leave at least 1 visible card').toBeGreaterThan(0);
    // There is exactly one grid — no separate runtime result list.
    await expect(page.locator('.search-result-item')).toHaveCount(0);
    await expect(page.locator('#full-catalog')).toBeVisible();
    await expect(page.locator('#skill-grid')).toBeVisible();
    // The heading count must equal the visible-card count.
    await expect(page.locator('#catalog-count')).toHaveText(String(rows.length));
  });

  test('latest-change clarification does not turn every card into a Pagefind match', async ({ page }) => {
    const total = await page.locator('[data-skill-card]').count();
    await page.locator('#search-input').fill('pinned');
    const rows = await waitForRenderedResults(page);

    expect(
      rows.length,
      'Pagefind must ignore the shared latest-change clarification text',
    ).toBeLessThan(total);
    await expect(page.locator('.search-result-item')).toHaveCount(0);
  });

  test('visible cards keep their source/version metadata', async ({ page }) => {
    await page.locator('#search-input').fill('azure');
    const rows = await waitForRenderedResults(page);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source, `card "${row.title}" must expose its source`).not.toBe('');
      expect(
        row.metaSpans.some((s) => /^v\d/.test(s)),
        `card "${row.title}" meta must include a version; got ${JSON.stringify(row.metaSpans)}`,
      ).toBe(true);
    }
  });

  // ── No-results state ──────────────────────────────────────────────────

  test('no-results query settles on the exact no-results message with an empty grid', async ({ page }) => {
    await page.locator('#search-input').fill(NO_MATCH_QUERY);

    // Web-first assertion: retries until the live region reaches its settled
    // no-results text. A stuck status or a stale count fails the test.
    await expect(page.locator('#search-status')).toHaveText(NO_RESULTS_STATUS, { timeout: 20_000 });

    // The grid remains present in the DOM but every card is hidden (an empty
    // grid collapses to zero height, so assert it is attached, not "visible").
    await expect(page.locator('#skill-grid')).toBeAttached();
    await expect(page.locator('[data-skill-card]:not([hidden])')).toHaveCount(0);
    await expect(page.locator('.search-result-item')).toHaveCount(0);
    await expect(page.locator('#catalog-count')).toHaveText('0');
  });

  test('full-text search retries after a transient Pagefind module-load failure', async ({ page }) => {
    let pagefindRequests = 0;
    await page.route('**/pagefind/pagefind.js*', async (route) => {
      pagefindRequests += 1;
      if (pagefindRequests === 1) {
        await route.abort();
        return;
      }
      await route.continue();
    });

    await page.goto(HOME);
    const total = await page.locator('[data-skill-card]').count();
    const input = page.locator('#search-input');

    await input.fill('tampermonkey');
    await expect(page.locator('#search-status')).toHaveText(
      `Full-text search is unavailable. Showing all ${total} skills.`,
      { timeout: 20_000 },
    );
    await expect(page.locator('[data-skill-card]:not([hidden])')).toHaveCount(total);

    await input.fill('terraform');
    const rows = await waitForRenderedResults(page);
    expect(rows.length, 'the retried Pagefind request must produce real results').toBeGreaterThan(0);
    expect(pagefindRequests, 'the second query must use a new module request').toBeGreaterThanOrEqual(2);
  });

  // ── Live-region sequencing ────────────────────────────────────────────

  /**
   * The status line is the only live region, and it must never announce a
   * count that the DOM has not applied yet. A MutationObserver records the
   * visible-card count at the exact moment each status text becomes visible.
   */
  test('every announced count matches the cards already visible', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as { __statusLog?: Array<{ text: string; rows: number }> };
      w.__statusLog = [];
      const status = document.querySelector('#search-status');
      if (!status) throw new Error('#search-status not found');
      new MutationObserver(() => {
        w.__statusLog!.push({
          text: (status.textContent ?? '').trim(),
          rows: document.querySelectorAll('[data-skill-card]:not([hidden])').length,
        });
      }).observe(status, { childList: true, characterData: true, subtree: true });
    });

    await page.locator('#search-input').fill('azure');
    await waitForRenderedResults(page);
    await page.locator('#search-input').fill(NO_MATCH_QUERY);
    await expect(page.locator('#search-status')).toHaveText(NO_RESULTS_STATUS, { timeout: 20_000 });

    const log = await page.evaluate(
      () => (window as unknown as { __statusLog: Array<{ text: string; rows: number }> }).__statusLog,
    );

    expect(log.length, 'the observer must have captured status updates').toBeGreaterThan(0);

    const counted = log.filter((entry) => countFromStatus(entry.text) !== null);
    expect(counted.length, 'at least one settled status must have been announced').toBeGreaterThan(0);

    for (const entry of counted) {
      expect(
        entry.rows,
        `status "${entry.text}" was announced while ${entry.rows} cards were visible`,
      ).toBe(countFromStatus(entry.text));
    }
  });

  test('only the status line is a live region', async ({ page }) => {
    const liveRegions = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[aria-live]')).map((el) => ({
        id: el.id,
        live: el.getAttribute('aria-live'),
      })),
    );
    expect(liveRegions, 'exactly one polite live region — the status line').toEqual([
      { id: 'search-status', live: 'polite' },
    ]);
  });

  // ── Clear → catalog restored ──────────────────────────────────────────

  test('clearing the keyword restores every card', async ({ page }) => {
    const total = await page.locator('[data-skill-card]').count();

    await page.locator('#search-input').fill('azure');
    await waitForRenderedResults(page);

    await page.locator('#search-input').fill('');

    await expect(page.locator('[data-skill-card]:not([hidden])')).toHaveCount(total);
    await expect(page.locator('#search-status')).toHaveText('');
    await expect(page.locator('#catalog-count')).toHaveText(String(total));
  });

  // ── Source filter (Pagefind-independent) ──────────────────────────────

  test('source filter: every visible card belongs to the selected source', async ({ page }) => {
    await page.locator('#filter-source').selectOption('azure');
    const rows = await waitForRenderedResults(page);

    assertEveryResultMatches(rows, { source: 'azure' });
    await expect(page.locator('#full-catalog')).toBeVisible();
    await expect(page.locator('.search-result-item')).toHaveCount(0);
    await expect(page.locator('#catalog-count')).toHaveText(String(rows.length));
  });

  test('clearing the source filter restores every card', async ({ page }) => {
    const total = await page.locator('[data-skill-card]').count();

    await page.locator('#filter-source').selectOption('azure');
    await waitForRenderedResults(page);

    await page.locator('#filter-source').selectOption('');

    await expect(page.locator('[data-skill-card]:not([hidden])')).toHaveCount(total);
    await expect(page.locator('#search-status')).toHaveText('');
  });

  // ── License filter ────────────────────────────────────────────────────

  test('license filter: every visible card carries the selected license', async ({ page }) => {
    await page.locator('#filter-license').selectOption('MIT');
    const rows = await waitForRenderedResults(page);

    assertEveryResultMatches(rows, { license: 'MIT' });
  });

  // ── Origin filter ─────────────────────────────────────────────────────

  test('origin filter: every visible card shows the Frozen badge', async ({ page }) => {
    await page.locator('#filter-origin').selectOption('Frozen');
    const rows = await waitForRenderedResults(page);

    assertEveryResultMatches(rows, { origin: 'Frozen' });
  });

  // ── Combined filters ──────────────────────────────────────────────────

  test('combined source + license + origin filters narrow to the exact intersection', async ({ page }) => {
    await page.locator('#filter-source').selectOption(COMBINED.source);
    const sourceOnly = await waitForRenderedResults(page);
    assertEveryResultMatches(sourceOnly, { source: COMBINED.source });

    await page.locator('#filter-license').selectOption(COMBINED.license);
    await page.locator('#filter-origin').selectOption(COMBINED.origin);
    const rows = await waitForRenderedResults(page);

    // This combination is non-empty in catalog/skills.lock.json, so an empty
    // result set is a real failure here, not an acceptable outcome.
    assertEveryResultMatches(rows, COMBINED);

    expect(
      rows.length,
      `combined filter must be a subset of the source-only result set ` +
        `(${rows.length} vs ${sourceOnly.length})`,
    ).toBeLessThanOrEqual(sourceOnly.length);

    const sourceTitles = new Set(sourceOnly.map((r) => r.title));
    for (const row of rows) {
      expect(
        sourceTitles.has(row.title),
        `"${row.title}" must also appear under the source-only filter`,
      ).toBe(true);
    }

    // The live region must agree with the DOM.
    await waitForResultCount(page, rows.length);
  });

  // ── Rapid consecutive input (generation guard) ────────────────────────

  test('rapid successive inputs leave only the final query\u2019s cards visible', async ({ page }) => {
    const firstQuery = 'tampermonkey';
    const finalQuery = 'terraform';

    // Control runs: what each query settles to on its own.
    const firstControl = await searchAndRead(page, firstQuery);
    const firstStatus = (await page.locator('#search-status').innerText()).trim();
    const finalControl = await searchAndRead(page, finalQuery);
    const finalStatus = (await page.locator('#search-status').innerText()).trim();

    expect(
      firstControl.length,
      `"${firstQuery}" must return results for this test to be meaningful`,
    ).toBeGreaterThan(0);
    expect(
      finalControl.length,
      `"${finalQuery}" must return results for this test to be meaningful`,
    ).toBeGreaterThan(0);

    const firstTitles = firstControl.map((r) => r.title).sort();
    const finalTitles = finalControl.map((r) => r.title).sort();
    const overlap = firstTitles.filter((t) => finalTitles.includes(t));
    expect(
      overlap,
      `queries "${firstQuery}" and "${finalQuery}" must have disjoint result sets; overlap: ${overlap.join(', ')}`,
    ).toEqual([]);
    expect(
      finalStatus,
      'the two control queries must announce different counts so a stale status is detectable',
    ).not.toBe(firstStatus);

    // Case 1 — the first query fully settles, then the final query replaces it.
    await page.goto(HOME);
    const input = page.locator('#search-input');
    await input.fill(firstQuery);
    const firstRendered = (await waitForRenderedResults(page)).map((r) => r.title).sort();
    expect(firstRendered, 'control sanity: first query must show its own cards').toEqual(firstTitles);

    await input.fill(finalQuery);
    await expect(page.locator('#search-status')).toHaveText(finalStatus, { timeout: 20_000 });
    const afterReplace = (await waitForRenderedResults(page)).map((r) => r.title).sort();
    expect(afterReplace, 'visible cards must equal the final query control set').toEqual(finalTitles);
    for (const staleTitle of firstTitles) {
      expect(
        afterReplace,
        `stale card "${staleTitle}" from "${firstQuery}" must not survive the second query`,
      ).not.toContain(staleTitle);
    }

    // Case 2 — both queries typed back-to-back with no wait.
    await page.goto(HOME);
    await input.fill(firstQuery);
    await input.fill(finalQuery);

    await expect(page.locator('#search-status')).toHaveText(finalStatus, { timeout: 20_000 });
    expect(await input.inputValue()).toBe(finalQuery);

    const rapidRendered = (await waitForRenderedResults(page)).map((r) => r.title).sort();
    expect(rapidRendered, 'rapid input must show only the final query cards').toEqual(finalTitles);
    for (const staleTitle of firstTitles) {
      expect(
        rapidRendered,
        `stale card "${staleTitle}" from "${firstQuery}" must not be visible`,
      ).not.toContain(staleTitle);
    }
  });

  // ── Overlapping searches (generation guard, fault-injected) ───────────

  test('a slow first search cannot overwrite the newer query\u2019s cards', async ({ page }) => {
    const firstQuery = 'tampermonkey';
    const finalQuery = 'terraform';

    const firstControl = await searchAndRead(page, firstQuery);
    const firstStatus = (await page.locator('#search-status').innerText()).trim();
    const finalControl = await searchAndRead(page, finalQuery);
    const finalStatus = (await page.locator('#search-status').innerText()).trim();

    const firstTitles = firstControl.map((r) => r.title).sort();
    const finalTitles = finalControl.map((r) => r.title).sort();
    expect(firstTitles.length, `"${firstQuery}" must return results`).toBeGreaterThan(0);
    expect(finalTitles.length, `"${finalQuery}" must return results`).toBeGreaterThan(0);
    expect(
      firstTitles.filter((t) => finalTitles.includes(t)),
      'the two queries must have disjoint result sets',
    ).toEqual([]);
    // The test waits for `finalStatus` before reading the visible cards. If both
    // queries announced the same count, that wait could be satisfied by the
    // STALE first-query render. Requiring different counts makes the wait
    // unambiguous instead of merely probable.
    expect(
      finalStatus,
      `queries "${firstQuery}" and "${finalQuery}" must announce different counts so the ` +
        `wait on "${finalStatus}" cannot be satisfied by the stale first-query render`,
    ).not.toBe(firstStatus);

    // Record EVERY change to the visible-card set, so a stale render that is
    // later overwritten again still shows up.
    await page.addInitScript(() => {
      (window as unknown as { __renderLog: string[][] }).__renderLog = [];
      const start = () => {
        const grid = document.getElementById('skill-grid');
        if (!grid) return;
        const snapshot = () => {
          const titles = Array.from(grid.querySelectorAll('[data-skill-card]:not([hidden])'))
            .map((el) => (el.getAttribute('data-name') ?? '').trim())
            .sort();
          (window as unknown as { __renderLog: string[][] }).__renderLog.push(titles);
        };
        new MutationObserver(snapshot).observe(grid, {
          attributes: true,
          attributeFilter: ['hidden'],
          subtree: true,
        });
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
      } else {
        start();
      }
    });

    // Fault injection: stall the Pagefind fragment fetches belonging to the
    // FIRST query only. Its doSearch() is then still awaiting result.data()
    // while the second query completes and applies visibility. Without the
    // generation check after that await, the stale response would overwrite it.
    let stall = true;
    let stallsStarted = 0;
    let stallsCompleted = 0;
    await page.route('**/pagefind/fragment/**', async (route) => {
      if (stall) {
        stallsStarted += 1;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.continue();
        stallsCompleted += 1;
        return;
      }
      await route.continue();
    });

    await page.goto(HOME);
    const input = page.locator('#search-input');
    await input.fill(firstQuery);

    // Condition wait (not a sleep): proceed once the first query's fragment
    // fetches are genuinely in flight.
    await expect
      .poll(() => stallsStarted, {
        message: 'the first query must reach the fragment-fetch stage before the second query is typed',
        timeout: 20_000,
      })
      .toBeGreaterThan(0);

    stall = false;
    await input.fill(finalQuery);

    await expect(page.locator('#search-status')).toHaveText(finalStatus, { timeout: 20_000 });
    const rendered = (await waitForRenderedResults(page)).map((r) => r.title).sort();
    expect(rendered, 'the newer query must own the visible cards').toEqual(finalTitles);

    // Let every stalled first-query response be delivered, then observe the
    // render log for a bounded window so the stale continuation has run.
    await expect
      .poll(() => stallsCompleted, {
        message: 'all stalled first-query fragment responses must be delivered',
        timeout: 20_000,
      })
      .toBe(stallsStarted);

    const renderLog: string[][] = await page.evaluate(
      (waitMs) =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve((window as unknown as { __renderLog: string[][] }).__renderLog),
            waitMs,
          );
        }),
      STALE_OBSERVATION_WINDOW_MS,
    );

    const staleRenders = renderLog.filter((titles) => JSON.stringify(titles) === JSON.stringify(firstTitles));
    expect(
      staleRenders.length,
      `the stale "${firstQuery}" response must never become the visible set; render log was ${JSON.stringify(renderLog)}`,
    ).toBe(0);
    await expect(page.locator('#search-status')).toHaveText(finalStatus);
    const finalVisible = (await waitForRenderedResults(page)).map((r) => r.title).sort();
    expect(finalVisible, 'the final visible set must belong to the newer query').toEqual(finalTitles);
  });

  // ── Click-through to skill detail page ───────────────────────────────

  test('clicking a visible card navigates to that exact skill detail page', async ({ page }) => {
    await page.locator('#search-input').fill('cost optimize');
    const rows = await waitForRenderedResults(page);
    expect(rows.length, 'query must leave at least one visible card to click').toBeGreaterThan(0);

    const target = rows[0];
    const targetPath = new URL(target.href, page.url()).pathname;
    expect(
      targetPath,
      `card href "${target.href}" must point at /Skills/en/skills/<source>/<skill>/`,
    ).toMatch(SKILL_DETAIL_PATH_RE);
    expect(target.title.length, 'card must expose a title to compare against the destination').toBeGreaterThan(0);

    await page.locator('[data-skill-card]:not([hidden]) a').first().click();
    await page.waitForURL((url) => SKILL_DETAIL_PATH_RE.test(url.pathname), { timeout: 15_000 });

    const landedPath = new URL(page.url()).pathname;
    expect(landedPath, 'must land on the href captured before the click').toBe(targetPath);
    expect(landedPath, 'the homepage must not satisfy this assertion').not.toBe('/Skills/en/');
    expect(landedPath, 'a source listing page must not satisfy this assertion').not.toMatch(
      /^\/Skills\/sources\//,
    );

    // The destination must be the skill named in the clicked card.
    await expect(page.locator('h1').first()).toHaveText(target.title);
    await expect(page).toHaveTitle(`${target.title} | Skills Registry`);
  });
});
