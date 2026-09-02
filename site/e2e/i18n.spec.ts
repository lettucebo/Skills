import { expect, test } from '@playwright/test';

import { SITE_BASE, waitForRenderedResults } from './_helpers';

const locales = [
  { route: 'en', lang: 'en', catalog: 'Catalog', theme: 'System', languageLabel: 'Choose language', commitLabel: 'Commit' },
  { route: 'zh-tw', lang: 'zh-TW', catalog: '目錄', theme: '系統', languageLabel: '選擇語言', commitLabel: '提交' },
  { route: 'zh-cn', lang: 'zh-CN', catalog: '目录', theme: '系统', languageLabel: '选择语言', commitLabel: '提交' },
] as const;

test.describe('full-route localization', () => {
  for (const locale of locales) {
    test(`${locale.route} renders localized chrome and theme control`, async ({ page }) => {
      await page.goto(`${SITE_BASE}${locale.route}/`);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.lang);
      await expect(page.getByRole('link', { name: locale.catalog, exact: true }).first()).toBeVisible();
      await expect(page.locator('[data-theme-label]')).toHaveText(locale.theme);
      await expect(page.locator('.language-menu-summary')).toContainText(
        locale.route === 'en' ? 'English' : locale.route === 'zh-tw' ? '繁體中文' : '简体中文',
      );
      await expect(page.locator(`[data-locale-link="${locale.route}"]`))
        .toHaveAttribute('aria-current', 'page');
    });
  }

  test('language switcher exposes a named group and identifies each link language', async ({ page }) => {
    for (const locale of locales) {
      await page.goto(`${SITE_BASE}${locale.route}/`);
      await expect(page.getByRole('group', { name: locale.languageLabel })).toBeVisible();
      await page.locator('.language-menu-summary').click();
      for (const target of locales) {
        const link = page.locator(`[data-locale-link="${target.route}"]`);
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute('lang', target.lang);
        await expect(link).toHaveAttribute('hreflang', target.route);
      }
    }
  });

  test('Chinese skill pages translate the Commit label without changing the commit target', async ({ page }) => {
    const commitUrl =
      'https://github.com/github/awesome-copilot/commit/4742f265959bf025882314564b364d9d7af6e2d5';
    for (const locale of locales) {
      await page.goto(`${SITE_BASE}${locale.route}/skills/azure/az-cost-optimize/`);
      await expect(page.locator('.detail-meta')).toContainText(`${locale.commitLabel}:`);
      const commitLink = page.locator(`.detail-meta a[href="${commitUrl}"]`);
      await expect(commitLink).toHaveText('4742f26');
    }
  });

  test('language switch preserves the logical route and persists explicit selection', async ({ page }) => {
    await page.goto(`${SITE_BASE}en/skills/github/github-issues/`);
    await page.locator('.language-menu-summary').click();
    await page.locator('[data-locale-link="zh-tw"]').click();

    await expect(page).toHaveURL(/\/zh-tw\/skills\/github\/github-issues\/$/);
    await expect(page.locator('[data-locale-link="zh-tw"]')).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('skillsLocale')))
      .toBe('zh-tw');
  });

  test('keyboard opens the native menu with Enter and Space and navigates a language link', async ({ page }) => {
    await page.goto(`${SITE_BASE}en/status/`);
    const menu = page.locator('.language-menu');
    const summary = page.locator('.language-menu-summary');

    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveAttribute('open', '');
    await page.keyboard.press('Space');
    await expect(menu).not.toHaveAttribute('open', '');
    await page.keyboard.press('Space');
    await expect(menu).toHaveAttribute('open', '');

    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-locale-link="zh-tw"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/zh-tw\/status\/$/);
  });

  test('saved locale affects only the legacy root and never overrides a direct locale URL', async ({ page }) => {
    await page.goto(`${SITE_BASE}en/`);
    await page.evaluate(() => localStorage.setItem('skillsLocale', 'zh-cn'));

    await page.goto(SITE_BASE);
    await expect(page).toHaveURL(/\/zh-cn\/$/);

    await page.goto(`${SITE_BASE}en/status/`);
    await expect(page).toHaveURL(/\/en\/status\/$/);
  });

  test('legacy root detects browser Chinese locale when no explicit selection exists', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'zh-TW' });
    const page = await context.newPage();
    try {
      await page.goto(SITE_BASE);
      await expect(page).toHaveURL(/\/zh-tw\/$/);
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
    expect(html).toContain('class="language-menu legacy-language-menu"');
    expect(html).toContain(`href="${SITE_BASE}zh-tw/skills/github/github-issues/"`);
    expect(html).toContain('lang="zh-TW"');
    expect(html).toContain('hreflang="zh-tw"');
    expect(html).toContain('aria-current="page"');

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
      await page.locator('.language-menu-summary').click();
      await page.locator('[data-locale-link="en"]').click();
      await expect(page).toHaveURL(/\/en\/skills\/github\/github-issues\/$/);
    } finally {
      await context.close();
    }
  });

  test('language menu stays inside a 375px viewport without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${SITE_BASE}zh-tw/`);
    await page.locator('.language-menu-summary').click();

    const geometry = await page.evaluate(() => {
      const list = document.querySelector('.language-menu-list')?.getBoundingClientRect();
      return {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        left: list?.left ?? -1,
        right: list?.right ?? -1,
      };
    });

    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.clientWidth + 1);
  });

  test('legacy redirect language menu opens within a 375px viewport', async ({ page }) => {
    const legacyPath = `${SITE_BASE}skills/github/github-issues/`;
    await page.setViewportSize({ width: 375, height: 812 });
    await page.route(`**${legacyPath}`, async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replace(
        /<meta http-equiv="refresh"[^>]*>/,
        '',
      );
      await route.fulfill({ response, body: html });
    });
    await page.goto(legacyPath);
    await page.locator('.language-menu-summary').click();

    const geometry = await page.evaluate(() => {
      const list = document.querySelector('.language-menu-list')?.getBoundingClientRect();
      const links = Array.from(document.querySelectorAll('.language-menu-list a'))
        .map((link) => link.getBoundingClientRect());
      return {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        listLeft: list?.left ?? -1,
        listRight: list?.right ?? -1,
        links,
      };
    });

    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(geometry.listLeft).toBeGreaterThanOrEqual(0);
    expect(geometry.listRight).toBeLessThanOrEqual(geometry.clientWidth + 1);
    for (const link of geometry.links) {
      expect(link.left).toBeGreaterThanOrEqual(0);
      expect(link.right).toBeLessThanOrEqual(geometry.clientWidth + 1);
    }
  });

  test('traditional Chinese search uses its language index and keeps localized links', async ({ page }) => {
    await page.goto(`${SITE_BASE}zh-tw/`);
    await page.locator('#search-input').fill('里程碑');
    const rows = await waitForRenderedResults(page);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.title === 'github-issues')).toBe(true);
    for (const row of rows) {
      expect(row.href).toMatch(/^\/zh-tw\/skills\//);
    }
  });

  test('simplified Chinese search uses its language index and keeps localized links', async ({ page }) => {
    await page.goto(`${SITE_BASE}zh-cn/`);
    await page.locator('#search-input').fill('里程碑');
    const rows = await waitForRenderedResults(page);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.title === 'github-issues')).toBe(true);
    for (const row of rows) {
      expect(row.href).toMatch(/^\/zh-cn\/skills\//);
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

  test('removed proprietary routes return 404 in every locale', async ({ page }) => {
    for (const locale of locales) {
      for (const skill of ['docx', 'pdf', 'pptx', 'xlsx']) {
        const response = await page.goto(
          `${SITE_BASE}${locale.route}/skills/claude/${skill}/`,
        );
        expect(response?.status()).toBe(404);
      }
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
