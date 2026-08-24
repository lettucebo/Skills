/**
 * search.spec.ts — Search and filter interaction tests.
 *
 * Covers: keyword search, no-results state, clear (catalog restored),
 * filter controls (source/license/origin), rapid input (generation guard),
 * and search result click-through to a skill detail page.
 */
import { test, expect } from '@playwright/test';

const HOME = '/Skills/';

test.describe('Search — keyword, filters, rapid input, click-through', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HOME);
    await page.waitForLoadState('networkidle');
  });

  // ── Keyword search ───────────────────────────────────────────────────

  test('keyword search shows results and hides full catalog', async ({ page }) => {
    const searchInput = page.locator('#search-input');
    await searchInput.fill('azure');

    await expect(page.locator('#search-results')).toBeVisible({ timeout: 10_000 });

    const items = page.locator('.search-result-item');
    await expect(items.first()).toBeVisible({ timeout: 5_000 });
    const count = await items.count();
    expect(count, 'search for "azure" must return at least 1 result').toBeGreaterThan(0);

    await expect(page.locator('#full-catalog')).toBeHidden();
  });

  test('search result items have meta (source/version)', async ({ page }) => {
    await page.locator('#search-input').fill('azure');
    await expect(page.locator('.search-result-item').first()).toBeVisible({ timeout: 10_000 });

    const firstMeta = page.locator('.search-result-item').first().locator('.search-result-meta');
    const metaText = await firstMeta.innerText();
    expect(metaText.trim().length, 'first result meta must not be empty').toBeGreaterThan(0);
  });

  // ── No-results state ──────────────────────────────────────────────────

  test('no-results query shows status message and no items', async ({ page }) => {
    await page.locator('#search-input').fill('⊕∞⊗∮⊘');
    await page.waitForTimeout(4_000);

    const count = await page.locator('.search-result-item').count();
    expect(count, 'no-results query must show 0 items').toBe(0);

    await expect(page.locator('#full-catalog')).toBeHidden();
  });

  // ── Clear → catalog restored ──────────────────────────────────────────

  test('clearing search restores full catalog', async ({ page }) => {
    await page.locator('#search-input').fill('azure');
    await expect(page.locator('#search-results')).toBeVisible({ timeout: 10_000 });

    await page.locator('#search-input').fill('');
    await page.waitForTimeout(1_500);

    await expect(page.locator('#search-results')).toBeHidden();
    await expect(page.locator('#full-catalog')).toBeVisible();
  });

  // ── Source filter ─────────────────────────────────────────────────────

  test('source filter returns results', async ({ page }) => {
    await page.locator('#search-input').fill('');
    await page.waitForTimeout(500);

    await page.locator('#filter-source').selectOption('azure');
    await expect(page.locator('.search-result-item').first()).toBeVisible({ timeout: 10_000 });

    const count = await page.locator('.search-result-item').count();
    expect(count, 'source filter must return at least 1 result').toBeGreaterThan(0);

    await expect(page.locator('#full-catalog')).toBeHidden();
  });

  test('clearing source filter restores full catalog', async ({ page }) => {
    await page.locator('#filter-source').selectOption('azure');
    await expect(page.locator('.search-result-item').first()).toBeVisible({ timeout: 10_000 });

    await page.locator('#filter-source').selectOption('');
    await page.waitForTimeout(1_500);

    await expect(page.locator('#full-catalog')).toBeVisible();
  });

  // ── License filter ────────────────────────────────────────────────────

  test('license filter returns results', async ({ page }) => {
    await page.locator('#filter-license').selectOption('MIT');
    await expect(page.locator('.search-result-item').first()).toBeVisible({ timeout: 10_000 });
    const count = await page.locator('.search-result-item').count();
    expect(count).toBeGreaterThan(0);
  });

  // ── Origin filter ─────────────────────────────────────────────────────

  test('origin (Frozen) filter returns results', async ({ page }) => {
    await page.locator('#filter-origin').selectOption('Frozen');
    await expect(page.locator('.search-result-item').first()).toBeVisible({ timeout: 10_000 });
    const count = await page.locator('.search-result-item').count();
    expect(count).toBeGreaterThan(0);
  });

  // ── Rapid consecutive input (generation guard) ────────────────────────

  test('rapid successive inputs show results for the last query only', async ({ page }) => {
    const input = page.locator('#search-input');

    for (const q of ['a', 'az', 'azu', 'azur']) {
      await input.fill(q);
      await page.waitForTimeout(80);
    }
    await input.fill('azure');
    await expect(page.locator('.search-result-item').first()).toBeVisible({ timeout: 12_000 });

    const value = await input.inputValue();
    expect(value).toBe('azure');

    const count = await page.locator('.search-result-item').count();
    expect(count, 'final query must yield results').toBeGreaterThan(0);
  });

  // ── Click-through to skill detail page ───────────────────────────────

  test('clicking a search result navigates to the skill detail page', async ({ page }) => {
    await page.locator('#search-input').fill('cost optimize');
    const firstLink = page.locator('.search-result-link').first();
    await expect(firstLink).toBeVisible({ timeout: 10_000 });

    const href = await firstLink.getAttribute('href');
    expect(href, 'result link must have href').toBeTruthy();
    expect(href).toMatch(/\/Skills\//);

    await firstLink.click();
    await page.waitForLoadState('networkidle', { timeout: 15_000 });

    const h1 = page.locator('h1').first();
    await expect(h1).toBeVisible();
    const title = await h1.innerText();
    expect(title.trim().length, 'skill detail page must have h1 text').toBeGreaterThan(0);

    expect(page.url()).toContain('/Skills/');
  });
});
