/**
 * catalog-groups.spec.ts — source-folder grouping on the homepage.
 *
 * Every non-tombstone card lives inside a native
 * `<details data-skill-group data-source="…">` folder. Folders default
 * collapsed, so a card is only *user-visible* once its folder is open. Search
 * and filters open the folders that hold matches and hide the empty ones; the
 * heading count still reflects the number of matching cards, independent of
 * which folders happen to be open.
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { BASE, NO_RESULTS_STATUS, waitForRenderedResults } from './_helpers';
import { getBrowsableSources, loadCatalog } from '../src/lib/catalog';

const HOME = BASE;
const repoRoot = path.resolve(process.cwd(), '..');

/** A query with no indexable match at all (non-word symbols only). */
const NO_MATCH_QUERY = '\u2295\u221E\u2297\u222E\u2298';

test.describe('Catalog source folders — JS enabled', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HOME);
  });

  test('every source folder is present, collapsed, and matches the card sources', async ({ page }) => {
    const groups = page.locator('[data-skill-group]');
    const groupCount = await groups.count();
    expect(groupCount, 'there must be at least one source folder').toBeGreaterThan(0);

    const catalog = await loadCatalog(repoRoot);
    const expectedSources = getBrowsableSources(catalog.skills);
    const renderedSources = await groups.evaluateAll((entries) =>
      entries.map((entry) => entry.getAttribute('data-source') ?? '').sort(),
    );
    expect(renderedSources, 'folders must match the browsable catalog source set').toEqual(expectedSources);

    // None is open initially.
    await expect(page.locator('[data-skill-group][open]')).toHaveCount(0);

    // Collapsed folders hide their cards from the user even though the cards
    // remain in the DOM (and thus keep [data-skill-card]:not([hidden])).
    await expect(page.locator('[data-skill-card]').first()).not.toBeVisible();
    await expect(page.locator('[data-skill-card]:not([hidden])').first()).toBeAttached();
  });

  test('each folder summary shows its source name and a skill count', async ({ page }) => {
    const first = page.locator('[data-skill-group]').first();
    const source = await first.getAttribute('data-source');
    const summary = first.locator('summary');
    await expect(summary).toContainText(String(source));
    await expect(first.locator('[data-skill-group-count]')).toHaveText(/^\d+$/);
  });

  test('clicking a summary opens the folder and reveals its cards', async ({ page }) => {
    const group = page.locator('[data-skill-group]').first();
    const firstCard = group.locator('[data-skill-card]').first();
    await expect(firstCard).not.toBeVisible();

    await group.locator('summary').click();

    await expect(group).toHaveAttribute('open', '');
    await expect(firstCard).toBeVisible();
  });

  test('Expand all opens every visible folder; Collapse all closes them', async ({ page }) => {
    const controls = page.locator('#catalog-group-controls');
    await expect(controls).toBeVisible();

    const total = await page.locator('[data-skill-group]').count();

    await page.locator('#expand-all-groups').click();
    await expect(page.locator('[data-skill-group][open]')).toHaveCount(total);

    await page.locator('#collapse-all-groups').click();
    await expect(page.locator('[data-skill-group][open]')).toHaveCount(0);
  });

  test('a source filter opens only the matching folder and hides the empty ones', async ({ page }) => {
    await page.locator('#filter-source').selectOption('azure');
    await waitForRenderedResults(page);

    const azure = page.locator('[data-skill-group][data-source="azure"]');
    await expect(azure).toHaveAttribute('open', '');
    await expect(azure).toBeVisible();

    // Every other folder is hidden.
    await expect(page.locator('[data-skill-group]:not([data-source="azure"]):not([hidden])')).toHaveCount(0);
    // The azure cards are now user-visible.
    await expect(azure.locator('[data-skill-card]:not([hidden])').first()).toBeVisible();
  });

  test('a keyword query opens every folder holding a match', async ({ page }) => {
    await page.locator('#search-input').fill('azure');
    const rows = await waitForRenderedResults(page);
    expect(rows.length).toBeGreaterThan(0);

    // Each visible card must live inside an open, non-hidden folder.
    const openSources = new Set(
      await page.$$eval('[data-skill-group][open]:not([hidden])', (els) =>
        els.map((e) => e.getAttribute('data-source') ?? ''),
      ),
    );
    const cardSources = new Set(rows.map((r) => r.source));
    for (const src of cardSources) {
      expect(openSources.has(src), `folder for source "${src}" must be open`).toBe(true);
    }
    await expect(page.locator('#catalog-count')).toHaveText(String(rows.length));
  });

  test('a no-results query hides every folder and keeps the count at zero', async ({ page }) => {
    await page.locator('#search-input').fill(NO_MATCH_QUERY);
    await expect(page.locator('#search-status')).toHaveText(NO_RESULTS_STATUS, { timeout: 20_000 });

    await expect(page.locator('[data-skill-group]:not([hidden])')).toHaveCount(0);
    await expect(page.locator('#catalog-count')).toHaveText('0');
  });

  test('clearing a filter unhides every folder and returns them all to collapsed', async ({ page }) => {
    const total = await page.locator('[data-skill-group]').count();

    await page.locator('#filter-source').selectOption('azure');
    await waitForRenderedResults(page);
    // Manually expand everything still visible before clearing.
    await page.locator('#expand-all-groups').click();

    await page.locator('#filter-source').selectOption('');
    await expect(page.locator('#search-status')).toHaveText('');

    await expect(page.locator('[data-skill-group]:not([hidden])')).toHaveCount(total);
    await expect(page.locator('[data-skill-group][open]')).toHaveCount(0);
  });
});

test.describe('Catalog source folders — no JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('folders are natively operable and the group controls stay hidden', async ({ page }) => {
    await page.goto(HOME);

    // The Expand/Collapse controls are only useful with JS, so they stay hidden.
    await expect(page.locator('#catalog-group-controls')).toBeHidden();

    const group = page.locator('[data-skill-group]').first();
    const firstCard = group.locator('[data-skill-card]').first();
    await expect(firstCard).not.toBeVisible();

    // A native <details> opens on click without any script.
    await group.locator('summary').click();
    await expect(group).toHaveAttribute('open', '');
    await expect(firstCard).toBeVisible();

    // And it can be toggled shut again by keyboard on the focused summary.
    await group.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(group).not.toHaveAttribute('open', '');
  });
});
