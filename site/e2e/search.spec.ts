/**
 * search.spec.ts — Search and filter interaction tests.
 *
 * Every assertion waits on the settled `#search-status` live-region text *and*
 * the rendered rows (see `waitForRenderedResults`) instead of a fixed sleep,
 * and validates the content of what was rendered — destination URL, per-row
 * metadata, final titles — rather than only counts.
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
 * A search result must land on a skill detail page: /Skills/skills/<source>/<skill>/.
 * The homepage (/Skills/) and source pages (/Skills/sources/<source>/) do NOT match.
 */
const SKILL_DETAIL_PATH_RE = /^\/Skills\/skills\/[^/]+\/[^/]+\/$/;

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

/** Asserts every rendered row carries the metadata that was filtered on. */
function assertEveryResultMatches(
  rows: ResultRow[],
  expected: { source?: string; license?: string; origin?: string },
): void {
  expect(rows.length, 'filtered search must return at least one result').toBeGreaterThan(0);
  for (const row of rows) {
    const where = `result "${row.title}" (meta: ${JSON.stringify(row.metaSpans)})`;
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

  test('keyword search shows results and hides full catalog', async ({ page }) => {
    await page.locator('#search-input').fill('azure');
    const rows = await waitForRenderedResults(page);

    expect(rows.length, 'search for "azure" must return at least 1 result').toBeGreaterThan(0);
    await expect(page.locator('#search-results')).toBeVisible();
    await expect(page.locator('#full-catalog')).toBeHidden();
  });

  test('search result items have non-empty meta (source/version)', async ({ page }) => {
    await page.locator('#search-input').fill('azure');
    const rows = await waitForRenderedResults(page);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source, `result "${row.title}" must expose its source in the meta row`).not.toBe('');
      expect(
        row.metaSpans.some((s) => /^v\d/.test(s)),
        `result "${row.title}" meta must include a version; got ${JSON.stringify(row.metaSpans)}`,
      ).toBe(true);
    }
  });

  // ── No-results state ──────────────────────────────────────────────────

  test('no-results query settles on the exact no-results message', async ({ page }) => {
    await page.locator('#search-input').fill(NO_MATCH_QUERY);

    // Web-first assertion: retries until the live region reaches its settled
    // no-results text. A stuck "Searching…" or a stale count fails the test.
    await expect(page.locator('#search-status')).toHaveText(NO_RESULTS_STATUS, { timeout: 20_000 });

    await expect(page.locator('.search-result-item')).toHaveCount(0);
    await expect(page.locator('#search-results')).toBeVisible();
    await expect(page.locator('#full-catalog')).toBeHidden();
  });

  // ── Live-region sequencing ────────────────────────────────────────────

  /**
   * The status line is the only live region, and it must never announce a
   * count that the DOM has not rendered yet. A MutationObserver records the
   * rendered row count at the exact moment each status text becomes visible
   * to assistive technology.
   */
  test('every announced result count matches the rows already rendered', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as { __statusLog?: Array<{ text: string; rows: number }> };
      w.__statusLog = [];
      const status = document.querySelector('#search-status');
      if (!status) throw new Error('#search-status not found');
      new MutationObserver(() => {
        w.__statusLog!.push({
          text: (status.textContent ?? '').trim(),
          rows: document.querySelectorAll('.search-result-item').length,
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
        `status "${entry.text}" was announced while ${entry.rows} rows were rendered`,
      ).toBe(countFromStatus(entry.text));
    }
  });

  test('only the status line is a live region', async ({ page }) => {
    const wiring = await page.evaluate(() => ({
      status: document.querySelector('#search-status')?.getAttribute('aria-live') ?? null,
      atomic: document.querySelector('#search-status')?.getAttribute('aria-atomic') ?? null,
      container: document.querySelector('#search-results')?.getAttribute('aria-live') ?? null,
      list: document.querySelector('#search-result-list')?.getAttribute('aria-live') ?? null,
    }));

    expect(wiring.status).toBe('polite');
    expect(wiring.atomic).toBe('true');
    expect(wiring.container, 'the results container must not re-announce every row').toBeNull();
    expect(wiring.list).toBeNull();
  });

  // ── Clear → catalog restored ──────────────────────────────────────────

  test('clearing search restores full catalog', async ({ page }) => {
    await page.locator('#search-input').fill('azure');
    await waitForRenderedResults(page);

    await page.locator('#search-input').fill('');

    await expect(page.locator('#search-results')).toBeHidden();
    await expect(page.locator('#full-catalog')).toBeVisible();
  });

  // ── Source filter ─────────────────────────────────────────────────────

  test('source filter: every result belongs to the selected source', async ({ page }) => {
    await page.locator('#filter-source').selectOption('azure');
    const rows = await waitForRenderedResults(page);

    assertEveryResultMatches(rows, { source: 'azure' });
    await expect(page.locator('#full-catalog')).toBeHidden();
  });

  test('clearing source filter restores full catalog', async ({ page }) => {
    await page.locator('#filter-source').selectOption('azure');
    await waitForRenderedResults(page);

    await page.locator('#filter-source').selectOption('');

    await expect(page.locator('#full-catalog')).toBeVisible();
    await expect(page.locator('#search-results')).toBeHidden();
  });

  // ── License filter ────────────────────────────────────────────────────

  test('license filter: every result carries the selected license', async ({ page }) => {
    await page.locator('#filter-license').selectOption('MIT');
    const rows = await waitForRenderedResults(page);

    assertEveryResultMatches(rows, { license: 'MIT' });
  });

  // ── Origin filter ─────────────────────────────────────────────────────

  test('origin filter: every result shows the Frozen badge', async ({ page }) => {
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

  test('rapid successive inputs render only the final query\u2019s results', async ({ page }) => {
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

    // Case 1 — the first query fully renders, then the final query replaces it.
    // Every stale row must be gone, not merely appended to or partially updated.
    await page.goto(HOME);
    const input = page.locator('#search-input');
    await input.fill(firstQuery);
    const firstRendered = (await waitForRenderedResults(page)).map((r) => r.title).sort();
    expect(firstRendered, 'control sanity: first query must render its own titles').toEqual(firstTitles);

    await input.fill(finalQuery);
    await expect(page.locator('#search-status')).toHaveText(finalStatus, { timeout: 20_000 });
    const afterReplace = (await waitForRenderedResults(page)).map((r) => r.title).sort();
    expect(afterReplace, 'rendered titles must equal the final query control set').toEqual(finalTitles);
    for (const staleTitle of firstTitles) {
      expect(
        afterReplace,
        `stale result "${staleTitle}" from "${firstQuery}" must not survive the second query`,
      ).not.toContain(staleTitle);
    }

    // Case 2 — both queries typed back-to-back with no wait, so the first
    // search may still be in flight when the second one starts. The generation
    // guard must ensure the older response never wins the render.
    await page.goto(HOME);
    await input.fill(firstQuery);
    await input.fill(finalQuery);

    await expect(page.locator('#search-status')).toHaveText(finalStatus, { timeout: 20_000 });
    expect(await input.inputValue()).toBe(finalQuery);

    const rapidRendered = (await waitForRenderedResults(page)).map((r) => r.title).sort();
    expect(rapidRendered, 'rapid input must render only the final query results').toEqual(finalTitles);
    for (const staleTitle of firstTitles) {
      expect(
        rapidRendered,
        `stale result "${staleTitle}" from "${firstQuery}" must not be rendered`,
      ).not.toContain(staleTitle);
    }
  });

  // ── Overlapping searches (generation guard, fault-injected) ───────────

  test('a slow first search cannot overwrite the newer query\u2019s results', async ({ page }) => {
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
    // The test waits for `finalStatus` before reading the rendered rows. If both
    // queries announced the same count, that wait could be satisfied by the
    // STALE first-query render and the assertions below would inspect the wrong
    // state — passing or failing for the wrong reason. Requiring different
    // counts makes the wait unambiguous instead of merely probable.
    expect(
      finalStatus,
      `queries "${firstQuery}" and "${finalQuery}" must announce different counts so the ` +
        `wait on "${finalStatus}" cannot be satisfied by the stale first-query render`,
    ).not.toBe(firstStatus);

    // Record EVERY render of the result list, so a stale render that is later
    // overwritten again still shows up. A plain end-state assertion would miss it.
    await page.addInitScript(() => {
      (window as unknown as { __renderLog: string[][] }).__renderLog = [];
      const start = () => {
        const list = document.getElementById('search-result-list');
        if (!list) return;
        new MutationObserver(() => {
          const titles = Array.from(list.querySelectorAll('.search-result-title'))
            .map((el) => (el.textContent ?? '').trim())
            .sort();
          (window as unknown as { __renderLog: string[][] }).__renderLog.push(titles);
        }).observe(list, { childList: true, subtree: true });
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
      } else {
        start();
      }
    });

    // Fault injection: stall the Pagefind fragment fetches belonging to the
    // FIRST query only. Its doSearch() is then still awaiting result.data()
    // while the second query completes and renders. Without the generation
    // check after that await, the stale response overwrites the newer results.
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
    expect(rendered, 'the newer query must own the rendered results').toEqual(finalTitles);

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
      `the stale "${firstQuery}" response must never be rendered; render log was ${JSON.stringify(renderLog)}`,
    ).toBe(0);
    expect(
      renderLog.at(-1),
      `the last render must belong to "${finalQuery}"; render log was ${JSON.stringify(renderLog)}`,
    ).toEqual(finalTitles);
    await expect(page.locator('#search-status')).toHaveText(finalStatus);
  });

  // ── Click-through to skill detail page ───────────────────────────────

  test('clicking a search result navigates to that exact skill detail page', async ({ page }) => {
    await page.locator('#search-input').fill('cost optimize');
    const rows = await waitForRenderedResults(page);
    expect(rows.length, 'query must return at least one result to click').toBeGreaterThan(0);

    const target = rows[0];
    const targetPath = new URL(target.href, page.url()).pathname;
    expect(
      targetPath,
      `result href "${target.href}" must point at /Skills/skills/<source>/<skill>/`,
    ).toMatch(SKILL_DETAIL_PATH_RE);
    expect(target.title.length, 'result must expose a title to compare against the destination').toBeGreaterThan(0);

    await page.locator('.search-result-link').first().click();
    await page.waitForURL((url) => SKILL_DETAIL_PATH_RE.test(url.pathname), { timeout: 15_000 });

    const landedPath = new URL(page.url()).pathname;
    expect(landedPath, 'must land on the href captured before the click').toBe(targetPath);
    expect(landedPath, 'the homepage must not satisfy this assertion').not.toBe('/Skills/');
    expect(landedPath, 'a source listing page must not satisfy this assertion').not.toMatch(
      /^\/Skills\/sources\//,
    );

    // The destination must be the skill named in the clicked result row.
    await expect(page.locator('h1').first()).toHaveText(target.title);
    await expect(page).toHaveTitle(`${target.title} | Skills Registry`);
  });
});
