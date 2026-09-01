/**
 * health.spec.ts — Request-based health and internal-link check.
 *
 * Uses Playwright's APIRequestContext (no browser tabs, no JS) to verify key
 * pages are reachable, return 200, and render their *own* page identity
 * (`<title>` + `<h1>`) — not just any page under the /Skills/ base path.
 */
import { test, expect } from '@playwright/test';
import { BASE, SITE_BASE } from './_helpers';

/**
 * Key pages plus the exact title/heading each one must render.
 * A generic "Skills" substring would be satisfied by every page (and by the
 * base path itself), so each expectation names the page uniquely.
 */
const KEY_PAGES = [
  {
    path: '/',
    label: 'homepage',
    title: 'Catalog | Skills Registry',
    h1: 'Skills Registry',
  },
  {
    path: '/status/',
    label: 'status page',
    title: 'Status | Skills Registry',
    h1: 'Registry Status',
  },
  {
    path: '/install/',
    label: 'install page',
    title: 'Install | Skills Registry',
    h1: 'Install Skills',
  },
  {
    path: '/sources/azure/',
    label: 'azure source page',
    title: 'azure skills | Skills Registry',
    h1: 'azure',
  },
  {
    path: '/sources/claude/',
    label: 'claude source page',
    title: 'claude skills | Skills Registry',
    h1: 'claude',
  },
  {
    path: '/skills/azure/az-cost-optimize/',
    label: 'az-cost-optimize skill',
    title: 'az-cost-optimize | Skills Registry',
    h1: 'az-cost-optimize',
  },
  {
    path: '/skills/claude/docx/',
    label: 'restricted docx skill',
    title: 'docx | Skills Registry',
    h1: 'docx',
  },
  {
    path: '/skills/microsoft/skill-creator/',
    label: 'skill-creator skill',
    title: 'microsoft-skill-creator | Skills Registry',
    h1: 'microsoft-skill-creator',
  },
  {
    path: '/skills/vscode/code-review/',
    label: 'frozen vscode/code-review skill',
    title: 'code-review-excellence | Skills Registry',
    h1: 'code-review-excellence',
  },
];

// A representative sample of internal links from the homepage and nav
const INTERNAL_LINK_SAMPLE = [
  '/',
  '/status/',
  '/install/',
  '/sources/azure/',
  '/sources/cloudflare/',
  '/sources/github/',
  '/sources/microsoft/',
  '/sources/vscode/',
  '/skills/azure/az-cost-optimize/',
  '/skills/cloudflare/agents-sdk/',
  '/skills/microsoft/skill-creator/',
];

function url(path: string): string {
  return BASE + path.replace(/^\//, '');
}

/** Extracts the document title text from a raw HTML response body. */
function titleOf(html: string): string | null {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : null;
}

/** Extracts the first `<h1>` text (tags stripped) from a raw HTML response body. */
function firstH1(html: string): string | null {
  const m = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : null;
}

test.describe('Site health — request-based', () => {
  for (const { path, label, title, h1 } of KEY_PAGES) {
    test(`${label} responds 200 with its own title and heading`, async ({ request }) => {
      const response = await request.get(url(path));
      expect(response.status(), `${label} at ${path} must return 200`).toBe(200);

      const body = await response.text();
      expect(body.length, `${label} response body must not be empty`).toBeGreaterThan(100);
      expect(titleOf(body), `${label} must render its own <title>`).toBe(title);
      expect(firstH1(body), `${label} must render its own <h1>`).toBe(h1);
    });
  }

  test('homepage HTML includes pagefind JS bundle', async ({ request }) => {
    const response = await request.get(BASE);
    const body = await response.text();
    // pagefind bundle is loaded from <base>/pagefind/pagefind.js
    expect(body).toMatch(/pagefind/i);
  });

  test('sample of internal links all return 200', async ({ request }) => {
    const failures: string[] = [];
    for (const linkPath of INTERNAL_LINK_SAMPLE) {
      const response = await request.get(url(linkPath));
      if (response.status() !== 200) {
        failures.push(`${linkPath} → ${response.status()}`);
      }
    }
    expect(failures, `Internal links returned non-200:\n${failures.join('\n')}`).toHaveLength(0);
  });

  test('pagefind JS asset is served', async ({ request }) => {
    const response = await request.get(`${SITE_BASE}pagefind/pagefind.js`);
    expect(response.status(), 'pagefind.js must be served').toBe(200);
  });

  test('status page reports a verified/total ratio', async ({ request }) => {
    const response = await request.get(`${BASE}status/`);
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toMatch(/\d+\s*\/\s*\d+/);
  });

  test('unknown skill path returns 404, not a soft 200', async ({ request }) => {
    const response = await request.get(url('/skills/azure/this-skill-does-not-exist/'));
    expect(
      response.status(),
      'a non-existent skill URL must 404 so broken links are detectable',
    ).toBe(404);
  });

  test('unknown top-level path returns 404', async ({ request }) => {
    const response = await request.get(url('/definitely-not-a-page/'));
    expect(response.status(), 'a non-existent page must 404').toBe(404);
  });

  test('unsupported locale prefix returns 404', async ({ request }) => {
    const response = await request.get(`${SITE_BASE}fr/`);
    expect(response.status(), 'unsupported locales must fail closed').toBe(404);
  });
});
