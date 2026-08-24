/**
 * a11y.spec.ts — Accessibility, responsive, and no-JS fallback checks.
 *
 * Covers:
 * - no-JS fallback: catalog still usable, controls and copy button hidden
 * - 375px viewport: no horizontal document overflow across representative
 *   table-heavy and long-URL pages, local table scrolling, vertical filters
 * - skip-link: receives focus on first Tab press, activates to main content
 * - clipboard feedback: copy button shows "Copied" aria-live message
 * - runtime search-result hover contrast: computed ratio >=4.5:1 on hover surface
 */
import { test, expect } from '@playwright/test';
import { BASE, resolveColorToken, waitForRenderedResults } from './_helpers';

const SKILL_PAGE = `${BASE}skills/azure/az-cost-optimize/`;

/**
 * Representative pages for the 375px overflow sweep. The review's browser pass
 * found overflow on 36 of 116 pages; these five cover every distinct cause
 * rather than only the two pages the suite used to check.
 */
const RESPONSIVE_PAGES = [
  { name: 'home', url: BASE, tables: false },
  { name: 'skill detail (az-cost-optimize)', url: SKILL_PAGE, tables: false },
  {
    name: 'table-heavy skill (microsoft/copilot-sdk, 15 tables)',
    url: `${BASE}skills/microsoft/copilot-sdk/`,
    tables: true,
  },
  { name: 'source page (cloudflare)', url: `${BASE}sources/cloudflare/`, tables: true },
  {
    name: 'long-URL skill (cloudflare/sandbox-migrate-to-next)',
    url: `${BASE}skills/cloudflare/sandbox-migrate-to-next/`,
    tables: true,
  },
  { name: 'status page', url: `${BASE}status/`, tables: true },
] as const;

// ── Helpers ──────────────────────────────────────────────────────────

function toLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}
function contrastRatio(fg: [number, number, number], bg: [number, number, number]): number {
  const l1 = relativeLuminance(...fg);
  const l2 = relativeLuminance(...bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Parses a computed color string like "rgb(r, g, b)" or "rgba(r, g, b, a)". */
function parseRgb(color: string): [number, number, number] | null {
  const m = color.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
}

// ── No-JS fallback ────────────────────────────────────────────────────

test.describe('No-JS fallback', () => {
  test.use({ javaScriptEnabled: false });

  test('catalog skills are visible without JavaScript', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('load');

    // Full catalog should be present in the DOM (not require JS to render)
    const catalog = page.locator('#full-catalog');
    await expect(catalog).toBeVisible();

    // At least one skill card link must be in the catalog
    const cards = catalog.locator('a');
    const count = await cards.count();
    expect(count, 'no-JS: catalog must contain skill links').toBeGreaterThan(0);
  });

  test('search box and filter controls are hidden without JavaScript', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('load');

    // Both are rendered unconditionally by Search.astro; the <noscript> <style>
    // block is what hides them. Assert existence FIRST so a missing element
    // (a rendering regression) can never masquerade as "hidden".
    const searchBox = page.locator('.search-box');
    await expect(searchBox).toHaveCount(1);
    await expect(searchBox).toBeHidden();

    const filterControls = page.locator('.filter-controls');
    await expect(filterControls).toHaveCount(1);
    await expect(filterControls).toBeHidden();
  });

  test('copy button is hidden without JavaScript', async ({ page }) => {
    await page.goto(SKILL_PAGE);
    await page.waitForLoadState('load');

    // az-cost-optimize is redistributable, so exactly one InstallCommand
    // (and therefore one copy button) is rendered. Without JS the button
    // keeps its server-rendered `hidden` attribute.
    const copyBtn = page.locator('.install-copy-btn');
    await expect(copyBtn).toHaveCount(1);
    await expect(copyBtn).toBeHidden();
  });
});

// ── 375px responsive ─────────────────────────────────────────────────

test.describe('375px viewport — no overflow, vertical filters', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  for (const page_ of RESPONSIVE_PAGES) {
    test(`no horizontal document overflow at 375px — ${page_.name}`, async ({ page }) => {
      await page.goto(page_.url);
      await page.waitForLoadState('networkidle');

      const { scrollWidth, clientWidth, widest } = await page.evaluate(() => {
        const docWidth = document.documentElement.clientWidth;
        let widest: string | null = null;
        let widestRight = docWidth;
        for (const el of Array.from(document.querySelectorAll('body *'))) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          if (rect.right > widestRight + 1) {
            widestRight = rect.right;
            widest = `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} right=${Math.round(rect.right)}`;
          }
        }
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: docWidth,
          widest,
        };
      });

      expect(
        scrollWidth,
        `${page_.name}: scrollWidth (${scrollWidth}) must not exceed clientWidth (${clientWidth}) at 375px` +
          (widest ? `; widest offender: ${widest}` : ''),
      ).toBeLessThanOrEqual(clientWidth + 1); // +1 for sub-pixel rounding tolerance
    });
  }

  for (const page_ of RESPONSIVE_PAGES.filter((p) => p.tables)) {
    test(`tables scroll locally and keep their semantics — ${page_.name}`, async ({ page }) => {
      await page.goto(page_.url);
      await page.waitForLoadState('networkidle');

      const report = await page.evaluate(() => {
        const tables = Array.from(document.querySelectorAll('table'));
        return tables.map((t) => {
          const wrapper = t.parentElement as HTMLElement | null;
          const style = wrapper ? window.getComputedStyle(wrapper) : null;
          return {
            display: window.getComputedStyle(t).display,
            wrapped: wrapper?.classList.contains('table-scroll') ?? false,
            overflowX: style?.overflowX ?? '',
            tabindex: wrapper?.getAttribute('tabindex') ?? '',
            role: wrapper?.getAttribute('role') ?? '',
            labelled: Boolean(wrapper?.getAttribute('aria-label')),
            wrapperWidth: wrapper ? Math.round(wrapper.getBoundingClientRect().width) : 0,
            docWidth: document.documentElement.clientWidth,
            rows: t.querySelectorAll('tr').length,
          };
        });
      });

      expect(report.length, `${page_.name} should render at least one table`).toBeGreaterThan(0);

      for (const t of report) {
        expect(t.wrapped, 'every table must sit in a .table-scroll container').toBe(true);
        expect(t.overflowX, 'the container must scroll horizontally').toMatch(/auto|scroll/);
        expect(t.tabindex, 'a scrollable region must be keyboard reachable').toBe('0');
        expect(t.role).toBe('region');
        expect(t.labelled, 'the region needs an accessible name').toBe(true);
        // Semantics must survive: the table itself is never switched to block.
        expect(t.display, 'the table must keep its table layout and ARIA role').toBe('table');
        expect(t.rows).toBeGreaterThan(0);
        expect(
          t.wrapperWidth,
          'the scroll container must stay inside the viewport',
        ).toBeLessThanOrEqual(t.docWidth + 1);
      }
    });
  }

  test('filter controls stack vertically at 375px', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    const filterDirection = await page.evaluate(() => {
      const el = document.querySelector('.filter-controls');
      if (!el) return null;
      return window.getComputedStyle(el).flexDirection;
    });

    // The mobile breakpoint (max-width: 640px) should set flex-direction: column
    expect(filterDirection, 'filter-controls must be flex-direction: column at 375px').toBe('column');
  });
});

// ── Skip-link ─────────────────────────────────────────────────────────

test.describe('Skip link', () => {
  test('skip link receives focus on first Tab press', async ({ page }) => {
    await page.goto(BASE);

    await page.keyboard.press('Tab');

    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.className ?? ''), {
        message: 'first Tab must focus the skip link',
      })
      .toContain('skip-link');
  });

  test('skip link is visible when focused', async ({ page }) => {
    await page.goto(BASE);

    const skipLink = page.locator('.skip-link');
    await expect(skipLink).toHaveCount(1);

    await page.keyboard.press('Tab');
    await expect(skipLink).toBeFocused();

    // The skip link should be revealed (non-zero box) when focused.
    const rect = await skipLink.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    expect(rect.width, 'skip link must have non-zero width when focused').toBeGreaterThan(0);
    expect(rect.height, 'skip link must have non-zero height when focused').toBeGreaterThan(0);
  });

  test('pressing Enter on skip link moves focus to #main-content', async ({ page }) => {
    await page.goto(BASE);

    await page.keyboard.press('Tab');
    await expect(page.locator('.skip-link')).toBeFocused();
    await page.keyboard.press('Enter');

    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.id ?? ''), {
        message: 'Enter on skip link must move focus to #main-content',
      })
      .toBe('main-content');
  });
});

// ── Clipboard feedback ────────────────────────────────────────────────

test.describe('Copy button — clipboard feedback', () => {
  test.use({
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  test('clicking copy button shows feedback message', async ({ page }) => {
    await page.goto(SKILL_PAGE);

    const copyBtn = page.locator('.install-copy-btn');
    await expect(copyBtn).toHaveCount(1);
    await expect(copyBtn).toBeVisible();

    // Feedback region must be empty before click
    await expect(page.locator('[data-copy-feedback]')).toHaveText('');

    await copyBtn.click();

    await expect(page.locator('[data-copy-feedback]')).toHaveText('Copied!');
  });

  test('clipboard content matches the install command', async ({ page }) => {
    await page.goto(SKILL_PAGE);

    const copyBtn = page.locator('.install-copy-btn');
    await expect(copyBtn).toBeVisible();

    const installCmd = await page.locator('.install-block code').innerText();
    await copyBtn.click();
    await expect(page.locator('[data-copy-feedback]')).toHaveText('Copied!');

    const clipboardContent = await page.evaluate(() =>
      navigator.clipboard.readText().catch(() => null)
    );
    expect(
      clipboardContent,
      'clipboard must contain the install command after clicking copy',
    ).toBe(installCmd);
  });

  test('rapid double-click: feedback persists after second click', async ({ page }) => {
    await page.goto(SKILL_PAGE);

    const copyBtn = page.locator('.install-copy-btn');
    await expect(copyBtn).toBeVisible();
    const feedback = page.locator('[data-copy-feedback]');

    await copyBtn.click();
    await expect(feedback).toHaveText('Copied!');
    await copyBtn.click();

    // The second click must reset the 2s clear-timer, so the message stays.
    await expect(feedback).toHaveText('Copied!');
  });
});

// ── Search-result hover contrast ──────────────────────────────────────

test.describe('Search-result link hover contrast', () => {
  test('hover styling is applied and yields >= 4.5:1 contrast (WCAG AA)', async ({ page }) => {
    await page.goto(BASE);

    await page.locator('#search-input').fill('azure');
    await waitForRenderedResults(page);

    const link = page.locator('.search-result-link').first();
    await expect(link).toBeVisible();

    // Runtime-created Pagefind nodes carry no [data-astro-cid-*] attribute, so
    // only the :global(.search-result-link:hover) rule can style them. Capture
    // the un-hovered computed style first: if that rule is ever deleted, the
    // hovered background stays identical (transparent) and this test fails.
    const before = await link.evaluate((el) => {
      const s = window.getComputedStyle(el);
      return { background: s.backgroundColor, color: s.color };
    });

    await link.hover();

    const hoverSurface = await resolveColorToken(page, '--cp-hover-surface');
    const textColor = await resolveColorToken(page, '--cp-text');

    // Web-first: retry until the hover transition has settled on the token value.
    await expect
      .poll(
        async () => link.evaluate((el) => window.getComputedStyle(el).backgroundColor),
        {
          message:
            'hovered .search-result-link background must resolve to var(--cp-hover-surface) — ' +
            'the :global(.search-result-link:hover) rule must exist and match runtime Pagefind nodes',
          timeout: 5_000,
        },
      )
      .toBe(hoverSurface);

    const after = await link.evaluate((el) => {
      const s = window.getComputedStyle(el);
      return { background: s.backgroundColor, color: s.color };
    });

    expect(
      after.background,
      `hover must change the background (before=${before.background}, after=${after.background})`,
    ).not.toBe(before.background);
    expect(
      after.color,
      'hovered link text colour must resolve to var(--cp-text)',
    ).toBe(textColor);

    const fg = parseRgb(after.color);
    const bg = parseRgb(after.background);
    expect(fg, `could not parse text color: ${after.color}`).not.toBeNull();
    expect(bg, `could not parse background: ${after.background}`).not.toBeNull();

    const ratio = contrastRatio(fg!, bg!);
    expect(
      ratio,
      `hovered .search-result-link contrast ratio is ${ratio.toFixed(2)}:1; must be >= 4.5:1 for WCAG AA ` +
        `(fg=${after.color}, bg=${after.background})`,
    ).toBeGreaterThanOrEqual(4.5);
  });

  test('hovered meta and excerpt text also reach AA on the hover surface', async ({ page }) => {
    await page.goto(BASE);

    await page.locator('#search-input').fill('azure');
    await waitForRenderedResults(page);

    const link = page.locator('.search-result-link').first();
    await link.hover();

    const hoverSurface = await resolveColorToken(page, '--cp-hover-surface');
    const bg = parseRgb(hoverSurface);
    expect(bg, `could not parse --cp-hover-surface: ${hoverSurface}`).not.toBeNull();

    for (const selector of ['.search-result-title', '.search-result-meta']) {
      const child = link.locator(selector).first();
      await expect(child, `${selector} must exist inside a search result`).toHaveCount(1);
      const color = await child.evaluate((el) => window.getComputedStyle(el).color);
      const fg = parseRgb(color);
      expect(fg, `could not parse ${selector} color: ${color}`).not.toBeNull();
      const ratio = contrastRatio(fg!, bg!);
      expect(
        ratio,
        `${selector} contrast on hover is ${ratio.toFixed(2)}:1 (fg=${color}, bg=${hoverSurface}); must be >= 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
