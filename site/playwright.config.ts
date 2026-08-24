import { defineConfig, devices } from '@playwright/test';

const PORT = 4321;
const isCI = !!process.env.CI;

/**
 * Playwright E2E configuration for the skills catalog site.
 *
 * - Local (CI=false): uses the system Chrome channel to avoid downloading browsers.
 * - CI: uses Playwright's installed Chromium (installed via `npx playwright install chromium`).
 * - webServer starts `astro preview` directly (not via `npm run preview`) to avoid the
 *   npm argument-forwarding problem on Windows where `npm run X -- --port` is unreliable.
 * - baseURL includes the /Skills/ base path matching astro.config.mjs.
 * - test:e2e builds the site (including Pagefind postbuild) before this config runs.
 */
export default defineConfig({
  testDir: './e2e',

  outputDir: 'playwright-results',

  reporter: isCI
    ? [['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

  use: {
    baseURL: `http://127.0.0.1:${PORT}/Skills/`,
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
    url: `http://127.0.0.1:${PORT}/Skills/`,
    timeout: 120_000,
    // In CI always start fresh; locally reuse if a preview is already running on this port.
    reuseExistingServer: !isCI,
  },
});
