/**
 * restricted.spec.ts — Restricted skill page DOM boundary checks.
 *
 * Restricted skills must not render body content, the npx install command,
 * or a copy button. They must show a restricted badge and warning box.
 */
import { test, expect } from '@playwright/test';

const BASE = '/Skills/';

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

      test('copy button is absent or hidden', async ({ page }) => {
        const copyBtn = page.locator('.install-copy-btn');
        const count = await copyBtn.count();
        if (count > 0) {
          // If the button exists it must be hidden
          const isHidden = await copyBtn.first().evaluate(el => (el as HTMLElement).hidden);
          expect(isHidden, 'copy button on restricted page must be hidden').toBe(true);
        }
        // count === 0 is also acceptable (button not rendered at all)
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
