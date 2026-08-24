/**
 * health.spec.ts — Request-based health and internal-link check.
 *
 * Uses Playwright's APIRequestContext (no browser tabs, no JS) to verify key
 * pages are reachable and return 200 with expected content, without launching
 * 116 browser tabs. This keeps CI fast and non-flaky.
 */
import { test, expect } from '@playwright/test';

const BASE = '/Skills/';

// Key pages the CI should always verify are reachable
const KEY_PAGES = [
  { path: '/', label: 'homepage' },
  { path: '/status/', label: 'status page' },
  { path: '/sources/azure/', label: 'azure source page' },
  { path: '/sources/claude/', label: 'claude source page' },
  { path: '/skills/azure/az-cost-optimize/', label: 'az-cost-optimize skill' },
  { path: '/skills/claude/docx/', label: 'restricted docx skill' },
  { path: '/skills/microsoft/skill-creator/', label: 'skill-creator skill' },
  { path: '/skills/vscode/code-review/', label: 'frozen vscode/code-review skill' },
];

// A representative sample of internal links from the homepage and nav
const INTERNAL_LINK_SAMPLE = [
  '/',
  '/status/',
  '/sources/azure/',
  '/sources/cloudflare/',
  '/sources/github/',
  '/sources/microsoft/',
  '/sources/vscode/',
  '/skills/azure/az-cost-optimize/',
  '/skills/cloudflare/agents-sdk/',
  '/skills/microsoft/skill-creator/',
];

test.describe('Site health — request-based', () => {
  for (const { path, label } of KEY_PAGES) {
    test(`${label} responds 200`, async ({ request }) => {
      const response = await request.get(BASE + path.replace(/^\//, ''));
      expect(response.status(), `${label} at ${path} must return 200`).toBe(200);
      const body = await response.text();
      expect(body.length, `${label} response body must not be empty`).toBeGreaterThan(100);
    });
  }

  test('homepage response includes site title', async ({ request }) => {
    const response = await request.get(BASE);
    const body = await response.text();
    expect(body).toContain('Skills');
  });

  test('homepage HTML includes pagefind JS bundle', async ({ request }) => {
    const response = await request.get(BASE);
    const body = await response.text();
    // pagefind bundle is loaded from <base>/pagefind/pagefind.js
    expect(body).toMatch(/pagefind/i);
  });

  test('sample of internal links all return 200', async ({ request }) => {
    const failures: string[] = [];
    for (const linkPath of INTERNAL_LINK_SAMPLE) {
      const url = BASE + linkPath.replace(/^\//, '');
      const response = await request.get(url);
      if (response.status() !== 200) {
        failures.push(`${linkPath} → ${response.status()}`);
      }
    }
    expect(failures, `Internal links returned non-200:\n${failures.join('\n')}`).toHaveLength(0);
  });

  test('pagefind JS asset is served', async ({ request }) => {
    const response = await request.get(`${BASE}pagefind/pagefind.js`);
    expect(response.status(), 'pagefind.js must be served').toBe(200);
  });

  test('status page returns 200 and contains skill counts', async ({ request }) => {
    const response = await request.get(`${BASE}status/`);
    expect(response.status()).toBe(200);
    const body = await response.text();
    // Should contain numbers (verified/mapped ratio, totals)
    expect(body).toMatch(/\d+\s*\/\s*\d+/);
  });
});
