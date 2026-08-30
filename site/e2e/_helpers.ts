/**
 * Shared helpers for the E2E specs.
 *
 * Not matched by Playwright's default `testMatch` (`**\/*.spec.ts`), so this
 * file is a plain module rather than a test file.
 *
 * The site has ONE catalog grid: `#skill-grid` holds `[data-skill-card]`
 * articles. Searching and filtering toggle each card's `hidden` attribute, so a
 * "result" is simply a visible card. These helpers read the visible cards and
 * the single `#search-status` live region.
 */
import { expect, type Page } from '@playwright/test';

export const BASE = '/Skills/';

export const NO_RESULTS_STATUS = 'No matching skills found.';

/** A single visible catalog card, as the user sees it. */
export interface ResultRow {
  title: string;
  href: string;
  /** Skill source (from the card `data-source` attribute and the first meta span). */
  source: string;
  /** Origin badge text (Synced / Frozen / Restricted / Local). */
  origin: string;
  /** All `.card-meta` direct child span texts, in DOM order. */
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
 * Waits until the search UI is fully settled AND the visible cards match the
 * announced count, then returns the visible rows.
 *
 * The live region announces the count only after card visibility is applied, so
 * a settled status implies a settled grid. Polling until the announced count
 * equals the visible-card count removes any transitional frame without a fixed
 * sleep, and asserts the live region and the DOM agree with each other.
 */
export async function waitForRenderedResults(page: Page, timeout = 20_000): Promise<ResultRow[]> {
  await expect
    .poll(
      async () => {
        const status = await page.locator('#search-status').innerText();
        const state = await page.locator('#search-status').getAttribute('data-search-state');
        if (state !== 'settled') return `search state: ${state ?? 'unset'}`;
        const announced = countFromStatus(status);
        if (announced === null) return `unsettled status: "${status.trim()}"`;
        const rendered = await page.locator('[data-skill-card]:not([hidden])').count();
        const inaccessible = await page.locator('[data-skill-card]:not([hidden])').evaluateAll(
          (cards) => cards.filter((card) => {
            const group = card.closest('[data-skill-group]');
            return group !== null && (group.hasAttribute('hidden') || !group.hasAttribute('open'));
          }).length,
        );
        if (inaccessible > 0) {
          return `${inaccessible} matching cards are inside closed or hidden groups`;
        }
        return announced === rendered
          ? 'settled'
          : `announced ${announced} but ${rendered} cards visible`;
      },
      {
        timeout,
        message: 'search must settle with the announced count matching the visible cards',
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

/** Reads every visible catalog card with its metadata. */
export async function readResults(page: Page): Promise<ResultRow[]> {
  return page.$$eval('[data-skill-card]:not([hidden])', (cards) =>
    cards.map((card) => {
      const link = card.querySelector('a');
      const meta = card.querySelector('.card-meta');
      const metaSpans = meta
        ? Array.from(meta.querySelectorAll(':scope > span')).map((s) => (s.textContent ?? '').trim())
        : [];
      const badge = meta?.querySelector('.badge');
      return {
        title:
          card.getAttribute('data-name') ??
          (card.querySelector('.card-title')?.textContent ?? '').trim(),
        href: link?.getAttribute('href') ?? '',
        source: card.getAttribute('data-source') ?? (metaSpans[0] ?? ''),
        origin: card.getAttribute('data-origin') ?? (badge?.textContent ?? '').trim(),
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
 * Resolves a CSS custom property (e.g. `--cp-accent`) to the browser's
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
