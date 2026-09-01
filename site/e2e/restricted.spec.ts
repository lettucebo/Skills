/**
 * The unpublished proprietary mirrors have no static routes or redirects.
 * Restricted rendering itself remains covered by unit fixtures.
 */
import { test, expect } from '@playwright/test';
import { BASE } from './_helpers';

const REMOVED_SKILLS = ['docx', 'pdf', 'pptx', 'xlsx'];

test.describe('Removed proprietary skill routes', () => {
  for (const slug of REMOVED_SKILLS) {
    test(`claude/${slug} returns 404`, async ({ page }) => {
      const response = await page.goto(`${BASE}skills/claude/${slug}/`);
      expect(response?.status()).toBe(404);
      await expect(page.locator('.detail-body')).toHaveCount(0);
      await expect(page.locator('.install-copy-btn')).toHaveCount(0);
    });
  }
});
