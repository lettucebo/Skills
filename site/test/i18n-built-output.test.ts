import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadCatalog } from '../src/lib/catalog.ts';
import {
  getLegacyRedirectEntries,
  getLocalizedRouteEntries,
} from '../src/i18n/routes.ts';
import {
  HTML_LANG,
  LOCALE_DISPLAY_NAMES,
  SUPPORTED_LOCALES,
  routeForLocale,
  t,
} from '../src/i18n/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(siteRoot, '..');
const distDir = path.join(siteRoot, 'dist');
const distExists = fs.existsSync(path.join(distDir, 'pagefind', 'pagefind.js'));

function htmlPath(urlPath: string): string {
  const relative = urlPath.replace(/^\/Skills\/?/, '').replace(/\/$/, '');
  return path.join(distDir, relative, 'index.html');
}

function allHtmlFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? allHtmlFiles(fullPath)
      : entry.name === 'index.html' ? [fullPath] : [];
  });
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

test('build emits exactly 520 static pages with approved localized and redirect arithmetic', {
  skip: !distExists && 'dist/ not found (run npm run build first)',
}, async () => {
  const catalog = await loadCatalog(repoRoot);
  const localized = getLocalizedRouteEntries(catalog);
  const redirects = getLegacyRedirectEntries(catalog);

  assert.equal(localized.length, 390);
  assert.equal(redirects.length, 130);
  assert.equal(allHtmlFiles(distDir).length, 520);
  for (const entry of [...localized.map(({ path }) => path), ...redirects.map(({ from }) => from)]) {
    assert.ok(fs.existsSync(htmlPath(entry)), `missing built page for ${entry}`);
  }
});

test('all current legacy redirects contain exact redirect metadata and a compact language menu', {
  skip: !distExists && 'dist/ not found',
}, async () => {
  const catalog = await loadCatalog(repoRoot);
  const redirects = getLegacyRedirectEntries(catalog);
  const activeSkillCount = catalog.skills.filter((skill) => !skill.isTombstone).length;
  assert.equal(redirects.length, 3 + catalog.sources.length + activeSkillCount);
  assert.equal(redirects.length, 130);

  for (const { from, to } of redirects) {
    const html = fs.readFileSync(htmlPath(from), 'utf8');
    assert.ok(html.includes(`content="0;url=${to}"`), `${from} meta target`);
    assert.ok(
      html.includes(`rel="canonical" href="https://lettucebo.github.io${to}"`),
      `${from} canonical target`,
    );
    assert.ok(html.includes(`href="${to}"`), `${from} anchor target`);
    assert.match(html, /data-pagefind-ignore="all"/, `${from} Pagefind exclusion`);
    assert.doesNotMatch(html, /data-pagefind-body/, `${from} must not be indexed`);
    assert.doesNotMatch(
      html,
      /<link\b[^>]*rel="stylesheet"/,
      `${from} redirect must not wait for a stylesheet before meta refresh`,
    );
    const menu = html.match(
      /<details\b[^>]*class="language-menu legacy-language-menu"[^>]*>[\s\S]*?<\/details>/,
    )?.[0];
    assert.ok(menu, `${from} compact language details`);
    assert.match(menu, new RegExp(`aria-label="${t('en', 'languageNavigation')}"`));
    assert.match(menu, /<summary\b[^>]*>[\s\S]*English[\s\S]*<\/summary>/);
    for (const locale of SUPPORTED_LOCALES) {
      const expectedTarget = routeForLocale(locale, to);
      assert.match(
        menu,
        new RegExp(
          `<a[^>]+href="${expectedTarget}"[^>]+lang="${HTML_LANG[locale]}"[^>]+hreflang="${locale}"[^>]*${locale === 'en' ? 'aria-current="page"[^>]*' : ''}>${LOCALE_DISPLAY_NAMES[locale]}</a>`,
        ),
        `${from} must identify the language of ${locale} link text and target`,
      );
    }
  }
});

test('every localized page exposes a compact named route-preserving language menu', {
  skip: !distExists && 'dist/ not found',
}, async () => {
  const catalog = await loadCatalog(repoRoot);
  const localized = getLocalizedRouteEntries(catalog);
  const redirects = getLegacyRedirectEntries(catalog);
  assert.equal(localized.length, SUPPORTED_LOCALES.length * redirects.length);

  for (const entry of localized) {
    const html = fs.readFileSync(htmlPath(entry.path), 'utf8');
    assert.match(html, new RegExp(`<html[^>]+lang="${HTML_LANG[entry.locale]}"`));
    assert.ok(
      html.includes(`rel="canonical" href="https://lettucebo.github.io${entry.path}"`),
    );
    const menu = html.match(
      /<details\b[^>]*class="language-menu"[^>]*>[\s\S]*?<\/details>/,
    )?.[0];
    assert.ok(menu, `${entry.path} compact language details`);
    assert.match(menu, new RegExp(`aria-label="${t(entry.locale, 'languageNavigation')}"`));
    assert.match(
      menu,
      new RegExp(`<summary\\b[^>]*>[\\s\\S]*${LOCALE_DISPLAY_NAMES[entry.locale]}[\\s\\S]*</summary>`),
    );
    for (const locale of SUPPORTED_LOCALES) {
      const target = routeForLocale(locale, entry.path);
      assert.ok(html.includes(`hreflang="${locale}" href="https://lettucebo.github.io${target}"`));
      assert.match(
        menu,
        new RegExp(
          `<a[^>]+href="${target}"[^>]+lang="${HTML_LANG[locale]}"[^>]+hreflang="${locale}"[^>]*${locale === entry.locale ? 'aria-current="page"[^>]*' : ''}>${LOCALE_DISPLAY_NAMES[locale]}</a>`,
        ),
        `${entry.path} must identify the language of ${locale} link text and target`,
      );
    }
  }
});

test('localized skill metadata translates the Commit label without changing its SHA or URL', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const labels = {
    en: 'Commit',
    'zh-tw': '提交',
    'zh-cn': '提交',
  } as const;
  const sha = '4742f26';
  const commitUrl =
    'https://github.com/github/awesome-copilot/commit/4742f265959bf025882314564b364d9d7af6e2d5';

  for (const locale of ['en', 'zh-tw', 'zh-cn'] as const) {
    const html = fs.readFileSync(
      htmlPath(`/Skills/${locale}/skills/azure/az-cost-optimize/`),
      'utf8',
    );
    assert.ok(html.includes(`${labels[locale]}:`));
    assert.ok(html.includes(`<code>${sha}</code>`));
    assert.ok(html.includes(`href="${commitUrl}"`));
    if (locale !== 'en') {
      assert.doesNotMatch(html, />\s*Commit:/);
    }
  }
});

test('localized UI uses matching summaries while raw names, body, and commit subjects remain unchanged', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const artifact = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'catalog', 'enrichment', 'changelog', 'skills__github__github-issues.json'),
    'utf8',
  ));
  const subject = artifact.locales.en.content.commits[0].subject;

  for (const locale of ['en', 'zh-tw', 'zh-cn'] as const) {
    const html = fs.readFileSync(
      htmlPath(`/Skills/${locale}/skills/github/github-issues/`),
      'utf8',
    );
    assert.match(html, /<h1>github-issues<\/h1>/);
    assert.ok(html.includes(subject), 'original upstream subject must remain unchanged');
    assert.ok(html.includes(escapeHtmlText(
      artifact.locales[locale].content.commits[0].summary,
    )));
    assert.match(html, /class="detail-body"/, 'raw SKILL.md body must render in every locale');
  }
});

test('all three structured summary locales render their matching content', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const artifact = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'catalog', 'enrichment', 'summaries', 'skills__vscode__code-review.json'),
    'utf8',
  ));

  for (const locale of ['en', 'zh-tw', 'zh-cn'] as const) {
    const html = fs.readFileSync(
      htmlPath(`/Skills/${locale}/skills/vscode/code-review/`),
      'utf8',
    );
    const summary = artifact.locales[locale].content;
    assert.ok(html.includes(escapeHtmlText(summary.purpose)));
    assert.ok(html.includes(escapeHtmlText(summary.whenToUse)));
    assert.ok(html.includes(escapeHtmlText(summary.outputs)));
  }
});

test('removed proprietary pages and their legacy redirects are absent', {
  skip: !distExists && 'dist/ not found',
}, () => {
  for (const skill of ['docx', 'pdf', 'pptx', 'xlsx']) {
    for (const locale of ['en', 'zh-tw', 'zh-cn']) {
      assert.equal(
        fs.existsSync(htmlPath(`/Skills/${locale}/skills/claude/${skill}/`)),
        false,
      );
    }
    assert.equal(
      fs.existsSync(htmlPath(`/Skills/skills/claude/${skill}/`)),
      false,
    );
  }
});

test('Pagefind indexes exactly 345 localized skill pages across all three languages', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const entry = JSON.parse(
    fs.readFileSync(path.join(distDir, 'pagefind', 'pagefind-entry.json'), 'utf8'),
  );
  assert.equal(entry.languages.en.page_count, 115);
  assert.equal(entry.languages['zh-tw'].page_count, 115);
  assert.equal(entry.languages['zh-cn'].page_count, 115);
  assert.equal(
    Object.values(entry.languages).reduce(
      (sum: number, language: any) => sum + language.page_count,
      0,
    ),
    345,
  );
  const fragments = fs.readdirSync(path.join(distDir, 'pagefind', 'fragment'))
    .filter((name) => name.endsWith('.pf_fragment'));
  assert.equal(fragments.length, 345);
});
