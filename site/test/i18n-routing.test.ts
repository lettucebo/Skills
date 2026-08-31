import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(siteRoot, relativePath), 'utf8');
}

test('Astro config enables prefix_all routing for all supported locales', () => {
  const config = read('astro.config.mjs');
  assert.match(config, /defaultLocale:\s*['"]en['"]/);
  assert.match(config, /locales:\s*\[['"]en['"],\s*['"]zh-tw['"],\s*['"]zh-cn['"]\]/);
  assert.match(config, /prefixDefaultLocale:\s*true/);
  assert.match(config, /redirectToDefaultLocale:\s*false/);
  assert.match(config, /base:\s*['"]\/Skills['"]/);
  assert.match(config, /trailingSlash:\s*['"]always['"]/);
});

test('localized route tree delegates all five route kinds to shared page components', () => {
  const routes = [
    'src/pages/[locale]/index.astro',
    'src/pages/[locale]/install.astro',
    'src/pages/[locale]/status.astro',
    'src/pages/[locale]/sources/[source].astro',
    'src/pages/[locale]/skills/[source]/[skill].astro',
  ];

  for (const route of routes) {
    const source = read(route);
    assert.match(source, /assertLocale/);
    assert.match(source, /Page\s+from/);
    assert.match(source, /<Page\b/);
  }
});

test('legacy route files are redirect wrappers and never duplicate full page logic', () => {
  const routes = [
    'src/pages/index.astro',
    'src/pages/install.astro',
    'src/pages/status.astro',
    'src/pages/sources/[source].astro',
    'src/pages/skills/[source]/[skill].astro',
  ];

  for (const route of routes) {
    const source = read(route);
    assert.match(source, /LegacyRedirect/);
    assert.match(source, /localizedPath\(['"]en['"]/);
    assert.doesNotMatch(source, /data-pagefind-body/);
    assert.ok(source.split(/\r?\n/).length <= 40, `${route} must stay a tiny wrapper`);
  }
});

test('legacy redirect component emits meta refresh, canonical, anchor fallback, and Pagefind exclusion', () => {
  const source = read('src/components/LegacyRedirect.astro');
  assert.match(source, /http-equiv="refresh"/);
  assert.match(source, /rel="canonical"/);
  assert.match(source, /data-pagefind-ignore="all"/);
  assert.match(source, /<a\s+href=\{target\}/);
  assert.doesNotMatch(source, /data-pagefind-body/);
});
