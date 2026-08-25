/**
 * Shared helpers for the E2E specs.
 *
 * Not matched by Playwright's default `testMatch` (`**\/*.spec.ts`), so this
 * file is a plain module rather than a test file.
 */
import { expect, type Page } from '@playwright/test';

export const BASE = '/Skills/';

export const NO_RESULTS_STATUS = 'No matching skills found.';

/** A single rendered search result row, as the user sees it. */
export interface ResultRow {
  title: string;
  href: string;
  /** First `<span>` inside `.search-result-meta` — the skill source. */
  source: string;
  /** Origin badge text (Synced / Frozen / Restricted / Local). */
  origin: string;
  /** All `.search-result-meta` direct child span texts, in DOM order. */
  metaSpans: string[];
}

/** Parses "N results found." / "No matching skills found." into a count. */
export function countFromStatus(status: string): number | null {
  const trimmed = status.trim();
  if (trimmed === NO_RESULTS_STATUS) return 0;
  const m = trimmed.match(/^(\d+) results? found\.$/);
  return m ? Number(m[1]) : null;
}

/**
 * Waits until the search UI is fully settled AND rendered, then returns the rows.
 *
 * Search.astro announces the result count only after the rows are inserted, so
 * a settled status now implies a populated list. Polling until the announced
 * count equals the rendered row count still removes any transitional frame
 * without a fixed sleep, and additionally asserts the live region and the DOM
 * agree with each other.
 */
export async function waitForRenderedResults(page: Page, timeout = 20_000): Promise<ResultRow[]> {
  await expect
    .poll(
      async () => {
        const status = await page.locator('#search-status').innerText();
        const announced = countFromStatus(status);
        if (announced === null) return `unsettled status: "${status.trim()}"`;
        const rendered = await page.locator('.search-result-item').count();
        return announced === rendered
          ? 'settled'
          : `announced ${announced} but rendered ${rendered}`;
      },
      {
        timeout,
        message: 'search must settle with the announced result count matching the rendered rows',
      },
    )
    .toBe('settled');

  return readResults(page);
}

/** Waits until the live region reports exactly `expected` results. */
export async function waitForResultCount(page: Page, expected: number, timeout = 20_000): Promise<void> {
  const suffix = expected === 1 ? 'result' : 'results';
  await expect(page.locator('#search-status')).toHaveText(`${expected} ${suffix} found.`, { timeout });
}

/** Reads every rendered result row with its full metadata. */
export async function readResults(page: Page): Promise<ResultRow[]> {
  return page.$$eval('.search-result-item', (items) =>
    items.map((li) => {
      const link = li.querySelector('a.search-result-link');
      const meta = li.querySelector('.search-result-meta');
      const metaSpans = meta
        ? Array.from(meta.querySelectorAll(':scope > span')).map((s) => (s.textContent ?? '').trim())
        : [];
      const badge = meta?.querySelector('.badge');
      return {
        title: (li.querySelector('.search-result-title')?.textContent ?? '').trim(),
        href: link?.getAttribute('href') ?? '',
        source: metaSpans[0] ?? '',
        origin: (badge?.textContent ?? '').trim(),
        metaSpans,
      };
    }),
  );
}

/** Runs a keyword search from a freshly loaded homepage and returns the settled rows. */
export async function searchAndRead(page: Page, query: string): Promise<ResultRow[]> {
  await page.goto(BASE);
  await page.locator('#search-input').fill(query);
  return waitForRenderedResults(page);
}

/**
 * Resolves a CSS custom property (e.g. `--cp-hover-surface`) to the browser's
 * canonical `rgb(...)` form by round-tripping it through a probe element.
 */
export async function resolveColorToken(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const probe = document.createElement('span');
    probe.style.color = raw;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, token);
}
