import { test, expect } from '@playwright/test';
import { BASE } from './_helpers';

test('selects skills across sources and keeps the command across navigation and locale', async ({ page }) => {
  await page.goto(BASE);
  const cards = page.locator('[data-skill-card]:has([data-select-skill])');
  const first = cards.first();
  const firstSource = await first.getAttribute('data-source');
  const next = page.locator(`[data-skill-card]:not([data-source="${firstSource}"]):has([data-select-skill])`).first();
  expect(await next.count()).toBe(1);
  for (const card of [first, next]) {
    await card.locator('xpath=ancestor::details[1]/summary').click();
    await card.locator('[data-select-skill]').check();
  }
  const names = [await first.getAttribute('data-name'), await next.getAttribute('data-name')].sort();
  const tray = page.locator('[data-selection-tray]');
  await expect(tray).toBeVisible();
  await expect(tray.locator('[data-selected-count]')).toHaveText('2');
  const command = await tray.locator('[data-selection-command]').textContent();
  expect(command).toContain('--full-depth');
  for (const name of names) expect(command).toContain(`--skill ${name}`);
  await page.reload();
  await expect(tray.locator('[data-selected-count]')).toHaveText('2');
  await page.locator('.language-menu summary').click();
  await page.locator('[data-locale-link="zh-tw"]').click();
  await expect(tray.locator('[data-selection-command]')).toHaveText(command!);

  await page.goto(await first.locator('a').getAttribute('href') ?? BASE);
  await expect(page.locator('[data-toggle-skill]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-toggle-skill]').click();
  await expect(page.locator('[data-selection-tray] [data-selected-count]')).toHaveText('1');
  await page.locator('[data-selection-tray] summary').click();
  await page.locator('[data-selection-tray] [data-remove-skill]').click();
  await expect(page.locator('[data-selection-tray]')).toBeHidden();
});

test('rejects stale stored names and excludes restricted controls', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('skills-selection', '["removed-private","--all"]'));
  await page.goto(BASE);
  await expect(page.locator('[data-selection-tray]')).toBeHidden();
  await expect(page.locator('[data-skill-card][data-origin="Restricted"] [data-select-skill]')).toHaveCount(0);
});

test('copies the combined command and clears all selections', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(BASE);
  const group = page.locator('[data-skill-group]').first();
  await group.locator('summary').click();
  await group.locator('[data-select-skill]').first().check();
  const tray = page.locator('[data-selection-tray]');
  const command = await tray.locator('[data-selection-command]').textContent();
  await tray.locator('[data-copy-selection]').click();
  await expect(tray.locator('[data-selection-feedback]')).toHaveText('Copied!');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
  await tray.locator('[data-clear-selection]').click();
  await expect(tray).toBeHidden();
  await expect(group.locator('[data-select-skill]').first()).not.toBeChecked();
});

test('keeps in-memory selection when localStorage is unavailable', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new Error('Storage blocked'); },
  }));
  await page.goto(BASE);
  const group = page.locator('[data-skill-group]').first();
  await group.locator('summary').click();
  await group.locator('[data-select-skill]').first().check();
  await expect(page.locator('[data-selection-tray] [data-selected-count]')).toHaveText('1');
});

test('keeps the long command inside the viewport on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto(BASE);
  const group = page.locator('[data-skill-group]').first();
  await group.locator('summary').click();
  await group.locator('[data-select-skill]').first().check();
  const copy = page.locator('[data-copy-selection]');
  await expect(copy).toBeInViewport();
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(pageWidth).toBeLessThanOrEqual(375);
  await group.locator('[data-select-skill]').first().focus();
  await page.keyboard.press('Space');
  await expect(page.locator('[data-selection-tray]')).toBeHidden();
});
