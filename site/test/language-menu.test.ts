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

const layout = read('src/layouts/Layout.astro');
const redirect = read('src/components/LegacyRedirect.astro');
const css = read('src/styles/global.css');

test('header uses a compact native language menu inside right-side controls', () => {
  const nav = layout.match(/<nav aria-label=\{t\(locale, 'mainNavigation'\)\}>([\s\S]*?)<\/nav>/)?.[1] ?? '';
  const controls = nav.match(/<div class="header-controls">([\s\S]*?)<\/div>/)?.[1] ?? '';

  assert.ok(controls, 'the header must contain a .header-controls group');
  assert.match(controls, /<details[^>]*class="language-menu"/);
  assert.match(controls, /role="group"/);
  assert.match(controls, /aria-label=\{t\(locale, 'languageNavigation'\)\}/);
  assert.match(controls, /<summary[^>]*class="language-menu-summary"/);
  assert.match(controls, /LOCALE_DISPLAY_NAMES\[locale\]/);
  assert.ok(
    controls.indexOf('language-menu') < controls.indexOf('theme-toggle'),
    'the language menu must be immediately left of the theme toggle',
  );

  const topLevelSwitcher = nav.match(
    /<div[\s\S]*?class="language-switcher"[\s\S]*?SUPPORTED_LOCALES/,
  );
  assert.equal(topLevelSwitcher, null, 'three always-visible language anchors must be removed');
});

test('legacy redirects use the same compact native language affordance', () => {
  assert.doesNotMatch(
    redirect,
    /import ['"]\.\.\/styles\/global\.css['"]/,
    'redirect stubs must stay free of render-blocking site CSS',
  );
  assert.match(redirect, /<style is:inline>/);
  assert.match(redirect, /<details[^>]*class="language-menu legacy-language-menu"/);
  assert.match(redirect, /role="group"/);
  assert.match(redirect, /aria-label=\{t\('en', 'languageNavigation'\)\}/);
  assert.match(redirect, /<summary[^>]*class="language-menu-summary"/);
  assert.match(redirect, /routeForLocale\(locale, target\)/);
  assert.match(redirect, /aria-current=\{locale === 'en' \? 'page' : undefined\}/);
  assert.match(
    redirect,
    /\.legacy-language-menu \.language-menu-list\s*\{[\s\S]*?inset-inline-start:\s*0;[\s\S]*?inset-inline-end:\s*auto;/,
  );
});

test('language menu CSS uses logical positioning and preserves focus and forced-colors visibility', () => {
  assert.match(css, /\.header-controls\s*\{[\s\S]*?margin-inline-start:\s*auto/);
  assert.match(css, /\.language-menu\s*\{[\s\S]*?position:\s*relative/);
  assert.match(css, /\.language-menu-list\s*\{[\s\S]*?inset-inline-end:\s*0/);
  assert.match(css, /\.language-menu-summary:focus-visible\s*\{[\s\S]*?outline:/);

  const forcedColors = css.slice(css.indexOf('@media (forced-colors: active)'));
  assert.match(forcedColors, /\.language-menu-summary/);
  assert.match(forcedColors, /\.language-menu-list/);
  assert.match(forcedColors, /\.language-menu-list a\[aria-current="page"\]/);
});
