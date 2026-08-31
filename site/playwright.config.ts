import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E configuration for the skills catalog site.
 *
 * - Serves the freshly built `dist/` through `astro preview` on a dedicated
 *   E2E port so a stray Astro dev server on the framework default port can
 *   never be mistaken for the build under test. Override with E2E_PORT.
 * - `reuseExistingServer: false` everywhere: reusing a foreign server would
 *   silently test a different build. Playwright fails fast if the port is
 *   already occupied, which is the intended, loud behaviour — set E2E_PORT to
 *   move the suite off a busy port.
 * - Local (CI unset): uses the system Chrome channel to avoid downloading browsers.
 * - CI: uses Playwright's installed Chromium (`npx playwright install chromium`).
 * - baseURL includes the /Skills/ base path matching astro.config.mjs.
 * - `npm run test:e2e` builds the site (including the Pagefind postbuild) first.
 */
const PORT = Number(process.env.E2E_PORT) || 4331;
const isCI = !!process.env.CI;
const BASE_URL = `http://127.0.0.1:${PORT}/Skills/en/`;

export default defineConfig({
  testDir: './e2e',

  outputDir: 'playwright-results',

  reporter: isCI
    ? [['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: isCI
    ? [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
    : [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],

  webServer: {
    // Invoke astro preview directly to avoid npm argument-forwarding issues on Windows.
    // Use --host 127.0.0.1 to bind to IPv4 explicitly; on some systems "localhost"
    // resolves to ::1 (IPv6) which causes ERR_CONNECTION_REFUSED on the 127.0.0.1 check.
    command: process.platform === 'win32'
      ? `node_modules\\.bin\\astro.cmd preview --port ${PORT} --host 127.0.0.1`
      : `node_modules/.bin/astro preview --port ${PORT} --host 127.0.0.1`,
    url: BASE_URL,
    timeout: 120_000,
    // Never reuse: the E2E run must always exercise the dist produced by this run.
    reuseExistingServer: false,
  },
});
