import { expect, test } from '@playwright/test';

import { SITE_BASE, waitForRenderedResults } from './_helpers';

const locales = [
  { route: 'en', lang: 'en', catalog: 'Catalog', theme: 'System' },
  { route: 'zh-tw', lang: 'zh-TW', catalog: '目錄', theme: '系統' },
  { route: 'zh-cn', lang: 'zh-CN', catalog: '目录', theme: '系统' },
] as const;

test.describe('full-route localization', () => {
  for (const locale of locales) {
    test(`${locale.route} renders localized chrome and theme control`, async ({ page }) => {
      await page.goto(`${SITE_BASE}${locale.route}/`);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.lang);
      await expect(page.getByRole('link', { name: locale.catalog, exact: true }).first()).toBeVisible();
      await expect(page.locator('[data-theme-label]')).toHaveText(locale.theme);
      await expect(page.locator(`[data-locale-link="${locale.route}"]`))
        .toHaveAttribute('aria-current', 'page');
    });
  }

  test('language switch preserves the logical route and persists explicit selection', async ({ page }) => {
    await page.goto(`${SITE_BASE}en/skills/github/github-issues/`);
    await page.locator('[data-locale-link="zh-tw"]').click();

    await expect(page).toHaveURL(/\/Skills\/zh-tw\/skills\/github\/github-issues\/$/);
    await expect(page.locator('[data-locale-link="zh-tw"]')).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('skillsLocale')))
      .toBe('zh-tw');
  });

  test('saved locale affects only the legacy root and never overrides a direct locale URL', async ({ page }) => {
    await page.goto(`${SITE_BASE}en/`);
    await page.evaluate(() => localStorage.setItem('skillsLocale', 'zh-cn'));

    await page.goto(SITE_BASE);
    await expect(page).toHaveURL(/\/Skills\/zh-cn\/$/);

    await page.goto(`${SITE_BASE}en/status/`);
    await expect(page).toHaveURL(/\/Skills\/en\/status\/$/);
  });

  test('legacy root detects browser Chinese locale when no explicit selection exists', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'zh-TW' });
    const page = await context.newPage();
    try {
      await page.goto(SITE_BASE);
      await expect(page).toHaveURL(/\/Skills\/zh-tw\/$/);
    } finally {
      await context.close();
    }
  });

  test('deep legacy routes always preserve their target and redirect to English', async ({ request }) => {
    const response = await request.get(`${SITE_BASE}skills/github/github-issues/`, {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(200);
    const html = await response.text();
    const target = `${SITE_BASE}en/skills/github/github-issues/`;
    expect(html).toContain(`content="0;url=${target}"`);
    expect(html).toContain(`href="${target}"`);
    expect(html).toContain('data-pagefind-ignore="all"');

    const root = await request.get(SITE_BASE, { maxRedirects: 0 });
    const rootHtml = await root.text();
    expect(rootHtml).toContain(`content="0;url=${SITE_BASE}en/"`);
    expect(rootHtml).toContain('skillsLocale');
  });

  test('native language links work when JavaScript is disabled', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      await page.goto(`${SITE_BASE}zh-tw/skills/github/github-issues/`);
      await page.locator('[data-locale-link="en"]').click();
      await expect(page).toHaveURL(/\/Skills\/en\/skills\/github\/github-issues\/$/);
    } finally {
      await context.close();
    }
  });

  test('traditional Chinese search uses its language index and keeps localized links', async ({ page }) => {
    await page.goto(`${SITE_BASE}zh-tw/`);
    await page.locator('#search-input').fill('里程碑');
    const rows = await waitForRenderedResults(page);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.title === 'github-issues')).toBe(true);
    for (const row of rows) {
      expect(row.href).toMatch(/^\/Skills\/zh-tw\/skills\//);
    }
  });

  test('simplified Chinese search uses its language index and keeps localized links', async ({ page }) => {
    await page.goto(`${SITE_BASE}zh-cn/`);
    await page.locator('#search-input').fill('里程碑');
    const rows = await waitForRenderedResults(page);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.title === 'github-issues')).toBe(true);
    for (const row of rows) {
      expect(row.href).toMatch(/^\/Skills\/zh-cn\/skills\//);
    }
  });

  test('localized install pages keep command contracts unchanged', async ({ page }) => {
    for (const locale of locales) {
      await page.goto(`${SITE_BASE}${locale.route}/install/`);
      const commands = await page.locator('.install-block code').allTextContents();
      expect(commands.some((command) =>
        /^npx skills add lettucebo\/Skills#v\d+\.\d+\.\d+ --full-depth$/.test(command),
      )).toBe(true);
      expect(commands.some((command) =>
        /^npx skills add lettucebo\/Skills\/skills\/azure#v\d+\.\d+\.\d+$/.test(command),
      )).toBe(true);
      expect(commands.some((command) =>
        /^npx skills add "lettucebo\/Skills#v\d+\.\d+\.\d+@[^"]+" --full-depth$/.test(command),
      )).toBe(true);
    }
  });

  test('restricted content boundaries hold in every locale', async ({ page }) => {
    for (const locale of locales) {
      await page.goto(`${SITE_BASE}${locale.route}/skills/claude/docx/`);
      await expect(page.locator('.detail-body')).toHaveCount(0);
      await expect(page.locator('.skill-summary')).toHaveCount(0);
      await expect(page.locator('.timeline-summary')).toHaveCount(0);
      await expect(page.locator('.install-block')).toHaveCount(0);
    }
  });

  for (const locale of locales) {
    test(`${locale.route} preserves the full Light/Dark/System cycle`, async ({ page }) => {
      await page.goto(`${SITE_BASE}${locale.route}/?scoutTheme=light`);
      const button = page.locator('#theme-toggle');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await button.click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await button.click();
      await expect(button).toHaveAttribute('data-theme-choice', 'system');
      await button.click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    });
  }
});
