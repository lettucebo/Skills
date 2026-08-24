/**
 * a11y.spec.ts — Accessibility, responsive, and no-JS fallback checks.
 *
 * Covers:
 * - no-JS fallback: catalog still usable, controls and copy button hidden
 * - 375px viewport: no horizontal document overflow, filters stack vertically
 * - skip-link: receives focus on first Tab press, activates to main content
 * - clipboard feedback: copy button shows "Copied" aria-live message
 * - runtime search-result hover contrast: computed ratio >=4.5:1 on hover surface
 */
import { test, expect, type Page } from '@playwright/test';

const BASE = '/Skills/';
const SKILL_PAGE = `${BASE}skills/azure/az-cost-optimize/`;

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

/**
 * Traverses up the DOM tree from `selector` to find the nearest ancestor
 * (inclusive) whose background is NOT transparent / rgba(0,0,0,0).
 * Returns [r, g, b] of that background.
 */
async function nearestOpaqueBg(page: Page, selector: string): Promise<[number, number, number] | null> {
  return page.evaluate((sel) => {
    const start = document.querySelector(sel);
    if (!start) return null;
    let el: Element | null = start;
    while (el && el !== document.body.parentElement) {
      const bg = window.getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && !bg.startsWith('rgba(0, 0, 0, 0)')) {
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
      }
      el = el.parentElement;
    }
    return null;
  }, selector);
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

    // noscript block hides .search-box and .filter-controls
    const searchBox = page.locator('.search-box');
    const filterControls = page.locator('.filter-controls');

    // They should either not exist, or be hidden/have display:none
    // Playwright toBeHidden() considers display:none, visibility:hidden, etc.
    if ((await searchBox.count()) > 0) {
      await expect(searchBox).toBeHidden();
    }
    if ((await filterControls.count()) > 0) {
      await expect(filterControls).toBeHidden();
    }
  });

  test('copy button is hidden without JavaScript', async ({ page }) => {
    await page.goto(SKILL_PAGE);
    await page.waitForLoadState('load');

    const copyBtn = page.locator('.install-copy-btn');
    if ((await copyBtn.count()) > 0) {
      // Button starts hidden (JS reveals it); without JS it remains hidden
      await expect(copyBtn.first()).toBeHidden();
    }
  });
});

// ── 375px responsive ─────────────────────────────────────────────────

test.describe('375px viewport — no overflow, vertical filters', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('homepage has no horizontal document overflow at 375px', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    expect(
      scrollWidth,
      `scrollWidth (${scrollWidth}) must not exceed clientWidth (${clientWidth}) at 375px`,
    ).toBeLessThanOrEqual(clientWidth + 1); // +1 for sub-pixel rounding tolerance
  });

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

  test('skill detail page has no horizontal overflow at 375px', async ({ page }) => {
    await page.goto(SKILL_PAGE);
    await page.waitForLoadState('networkidle');

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    expect(
      scrollWidth,
      `detail page scrollWidth (${scrollWidth}) must not exceed clientWidth (${clientWidth}) at 375px`,
    ).toBeLessThanOrEqual(clientWidth + 1);
  });
});

// ── Skip-link ─────────────────────────────────────────────────────────

test.describe('Skip link', () => {
  test('skip link receives focus on first Tab press', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);

    const focusedClass = await page.evaluate(() => document.activeElement?.className ?? '');
    expect(focusedClass, 'first Tab must focus the skip link').toContain('skip-link');
  });

  test('skip link is visible when focused', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);

    // The skip link should be visible when focused (focus-visible reveals it)
    const rect = await page.evaluate(() => {
      const el = document.querySelector('.skip-link');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    expect(rect, 'skip link must exist in DOM').not.toBeNull();
    expect(rect!.width, 'skip link must have non-zero width when focused').toBeGreaterThan(0);
    expect(rect!.height, 'skip link must have non-zero height when focused').toBeGreaterThan(0);
  });

  test('pressing Enter on skip link moves focus to #main-content', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);

    const focusedId = await page.evaluate(() => document.activeElement?.id ?? '');
    expect(focusedId, 'Enter on skip link must move focus to #main-content').toBe('main-content');
  });
});

// ── Clipboard feedback ────────────────────────────────────────────────

test.describe('Copy button — clipboard feedback', () => {
  test.use({
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  test('clicking copy button shows feedback message', async ({ page }) => {
    await page.goto(SKILL_PAGE);
    await page.waitForLoadState('networkidle');

    const copyBtn = page.locator('.install-copy-btn');
    await expect(copyBtn).toBeVisible({ timeout: 5_000 });

    // Feedback region must be empty before click
    const feedbackBefore = await page.locator('[data-copy-feedback]').innerText();
    expect(feedbackBefore.trim()).toBe('');

    await copyBtn.click();
    await page.waitForTimeout(300);

    const feedback = await page.locator('[data-copy-feedback]').innerText();
    expect(
      feedback.toLowerCase(),
      'aria-live feedback region must mention "copied" after click',
    ).toMatch(/copied|copy/);
  });

  test('clipboard content matches the install command', async ({ page }) => {
    await page.goto(SKILL_PAGE);
    await page.waitForLoadState('networkidle');

    const copyBtn = page.locator('.install-copy-btn');
    await expect(copyBtn).toBeVisible({ timeout: 5_000 });

    const installCmd = await page.locator('.install-block code').innerText();
    await copyBtn.click();
    await page.waitForTimeout(300);

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
    await page.waitForLoadState('networkidle');

    const copyBtn = page.locator('.install-copy-btn');
    await expect(copyBtn).toBeVisible({ timeout: 5_000 });

    await copyBtn.click();
    await page.waitForTimeout(150);
    await copyBtn.click();
    await page.waitForTimeout(300);

    const feedback = await page.locator('[data-copy-feedback]').innerText();
    expect(
      feedback.toLowerCase(),
      'feedback must still show after rapid double-click (timer reset)',
    ).toMatch(/copied|copy/);
  });
});

// ── Search-result hover contrast ──────────────────────────────────────

test.describe('Search-result link hover contrast', () => {
  test('hovered search-result-link contrast ratio >= 4.5:1 (WCAG AA)', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    // Type a query to get search results
    await page.locator('#search-input').fill('azure');
    await expect(page.locator('.search-result-link').first()).toBeVisible({ timeout: 10_000 });

    // Hover over the first result link
    await page.locator('.search-result-link').first().hover();
    await page.waitForTimeout(100);

    // Read computed text color and background of the hovered link
    const colors = await page.evaluate(() => {
      const link = document.querySelector('.search-result-link') as HTMLElement | null;
      if (!link) return null;
      const style = window.getComputedStyle(link);
      const color = style.color;
      const bg = style.backgroundColor;

      // Traverse up for the nearest opaque background
      function nearestOpaque(el: Element | null): string {
        while (el && el !== document.documentElement) {
          const elBg = window.getComputedStyle(el).backgroundColor;
          if (elBg && elBg !== 'transparent' && !elBg.startsWith('rgba(0, 0, 0, 0)')) {
            return elBg;
          }
          el = el.parentElement;
        }
        return 'rgb(255,255,255)';
      }

      const effectiveBg = (bg === 'transparent' || bg.startsWith('rgba(0, 0, 0, 0)'))
        ? nearestOpaque(link.parentElement)
        : bg;

      return { color, bg: effectiveBg };
    });

    expect(colors, 'hovered .search-result-link must be present in DOM').not.toBeNull();

    const fg = parseRgb(colors!.color);
    const bg = parseRgb(colors!.bg);

    expect(fg, `could not parse text color: ${colors!.color}`).not.toBeNull();
    expect(bg, `could not parse background: ${colors!.bg}`).not.toBeNull();

    const ratio = contrastRatio(fg!, bg!);
    expect(
      ratio,
      `hovered .search-result-link contrast ratio is ${ratio.toFixed(2)}:1; must be >= 4.5:1 for WCAG AA (fg=${colors!.color}, bg=${colors!.bg})`,
    ).toBeGreaterThanOrEqual(4.5);
  });
});
