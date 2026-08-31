import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

import { BASE } from './_helpers';

const artifact = JSON.parse(
  readFileSync(
    path.resolve(
      process.cwd(),
      '..',
      'catalog',
      'enrichment',
      'summaries',
      'skills__vscode__code-review.json',
    ),
    'utf8',
  ),
) as {
  locales: {
    en: {
      content: {
        purpose: string;
        whenToUse: string;
        outputs: string;
      };
    };
  };
};
const summary = artifact.locales.en.content;
const cardSelector = '[data-skill-card][data-name="code-review-excellence"]';
const searchTerm = [summary.purpose, summary.whenToUse, summary.outputs]
  .join(' ')
  .match(/[A-Za-z]{10,}/g)
  ?.sort((left, right) => right.length - left.length)[0];

test('fresh summary renders on the detail page and canonical catalog card', async ({ page }) => {
  await page.goto(`${BASE}skills/vscode/code-review/`);
  const summarySection = page.locator('.skill-summary');
  await expect(summarySection).toBeVisible();
  await expect(summarySection).toContainText(summary.purpose);
  await expect(summarySection).toContainText(summary.whenToUse);
  await expect(summarySection).toContainText(summary.outputs);

  await page.goto(BASE);
  const card = page.locator(cardSelector);
  await expect(card.locator('.card-description')).toHaveText(summary.purpose);
});

test('Pagefind matches text from the structured summary without duplicate result DOM', async ({ page }) => {
  expect(searchTerm, 'generated summary must contain an indexable long word').toBeTruthy();
  await page.goto(BASE);
  await page.locator('#search-input').fill(searchTerm!);

  await expect(page.locator(cardSelector)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('.search-result-item')).toHaveCount(0);
});
