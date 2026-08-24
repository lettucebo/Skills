/**
 * restricted.spec.ts — Restricted skill page DOM boundary checks.
 *
 * Restricted skills must not render body content, the npx install command,
 * or a copy button. They must show a restricted badge and warning box.
 */
import { test, expect } from '@playwright/test';
import { BASE } from './_helpers';

const RESTRICTED_SKILLS = [
  { source: 'claude', slug: 'docx' },
  { source: 'claude', slug: 'pdf' },
  { source: 'claude', slug: 'pptx' },
  { source: 'claude', slug: 'xlsx' },
];

test.describe('Restricted skill pages', () => {
  for (const { source, slug } of RESTRICTED_SKILLS) {
    test.describe(`${source}/${slug}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.goto(`${BASE}skills/${source}/${slug}/`);
        await page.waitForLoadState('networkidle');
      });

      test('has no .detail-body (body content must not render)', async ({ page }) => {
        const body = page.locator('.detail-body');
        await expect(body).toHaveCount(0);
      });

      test('does not show npx install string in visible text', async ({ page }) => {
        const bodyText = await page.evaluate(() => document.body.innerText);
        expect(bodyText, 'restricted page must not show npx install string').not.toContain('npx skills add');
      });

      test('no copy button is rendered at all', async ({ page }) => {
        // Restricted skills get no install command, so InstallCommand (and its
        // copy button) must never be rendered — not merely hidden.
        await expect(page.locator('.install-copy-btn')).toHaveCount(0);
        await expect(page.locator('.install-block')).toHaveCount(0);
      });

      test('restricted badge is visible', async ({ page }) => {
        const badge = page.locator('.badge--restricted');
        await expect(badge).toBeVisible();
      });

      test('warning box is visible and mentions restricted', async ({ page }) => {
        const warning = page.locator('.warning-box');
        await expect(warning).toBeVisible();
        const text = await warning.innerText();
        expect(text.toLowerCase()).toMatch(/restrict/);
      });
    });
  }
});
