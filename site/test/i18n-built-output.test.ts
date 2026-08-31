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

test('build emits exactly 536 static pages with approved localized and redirect arithmetic', {
  skip: !distExists && 'dist/ not found (run npm run build first)',
}, async () => {
  const catalog = await loadCatalog(repoRoot);
  const localized = getLocalizedRouteEntries(catalog);
  const redirects = getLegacyRedirectEntries(catalog);

  assert.equal(localized.length, 402);
  assert.equal(redirects.length, 134);
  assert.equal(allHtmlFiles(distDir).length, 536);
  for (const entry of [...localized.map(({ path }) => path), ...redirects.map(({ from }) => from)]) {
    assert.ok(fs.existsSync(htmlPath(entry)), `missing built page for ${entry}`);
  }
});

test('all 134 legacy redirects contain exact English meta, canonical, anchor, and Pagefind exclusion', {
  skip: !distExists && 'dist/ not found',
}, async () => {
  const catalog = await loadCatalog(repoRoot);
  const redirects = getLegacyRedirectEntries(catalog);
  assert.equal(redirects.length, 134);

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
    for (const { locale, lang, label } of [
      { locale: 'en', lang: 'en', label: 'English' },
      { locale: 'zh-tw', lang: 'zh-TW', label: '繁體中文' },
      { locale: 'zh-cn', lang: 'zh-CN', label: '简体中文' },
    ]) {
      assert.match(
        html,
        new RegExp(
          `<a[^>]+lang="${lang}"[^>]+hreflang="${locale}"[^>]*>${label}</a>`,
        ),
        `${from} must identify the language of ${locale} link text and target`,
      );
    }
  }
});

test('localized pages expose language, canonical, hreflang, translated navigation, and route-preserving switcher', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const samples = [
    {
      locale: 'en',
      lang: 'en',
      path: '/Skills/en/skills/github/github-issues/',
      nav: 'Catalog',
    },
    {
      locale: 'zh-tw',
      lang: 'zh-TW',
      path: '/Skills/zh-tw/skills/github/github-issues/',
      nav: '目錄',
    },
    {
      locale: 'zh-cn',
      lang: 'zh-CN',
      path: '/Skills/zh-cn/skills/github/github-issues/',
      nav: '目录',
    },
  ];

  for (const sample of samples) {
    const html = fs.readFileSync(htmlPath(sample.path), 'utf8');
    assert.match(html, new RegExp(`<html[^>]+lang="${sample.lang}"`));
    assert.ok(
      html.includes(`rel="canonical" href="https://lettucebo.github.io${sample.path}"`),
    );
    for (const locale of ['en', 'zh-tw', 'zh-cn']) {
      const target = sample.path.replace(`/Skills/${sample.locale}/`, `/Skills/${locale}/`);
      assert.ok(html.includes(`hreflang="${locale}" href="https://lettucebo.github.io${target}"`));
      assert.ok(html.includes(`href="${target}"`), `switcher must preserve route to ${locale}`);
    }
    assert.ok(html.includes(`>${sample.nav}</a>`));
    const switcher = html.match(
      /<(nav|div)\b[^>]*class="language-switcher"[^>]*>/,
    );
    assert.ok(switcher, 'language switcher wrapper must exist');
    assert.match(switcher[0], /aria-label="[^"]+"/);
    assert.ok(
      switcher[1] === 'nav' || /role="group"/.test(switcher[0]),
      'language switcher must be a named nav or group, not a generic div',
    );
    for (const { locale, lang, label } of [
      { locale: 'en', lang: 'en', label: 'English' },
      { locale: 'zh-tw', lang: 'zh-TW', label: '繁體中文' },
      { locale: 'zh-cn', lang: 'zh-CN', label: '简体中文' },
    ]) {
      assert.match(
        html,
        new RegExp(
          `<a[^>]+lang="${lang}"[^>]+hreflang="${locale}"[^>]*>${label}</a>`,
        ),
        `${sample.path} must identify the language of ${locale} link text and target`,
      );
    }
    assert.match(html, new RegExp(`href="[^"]*"[^>]+aria-current="page"[^>]*>${sample.locale === 'en' ? 'English' : sample.locale === 'zh-tw' ? '繁體中文' : '简体中文'}</a>`));
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

test('restricted pages in all locales suppress body, summaries, changelog summaries, and install controls', {
  skip: !distExists && 'dist/ not found',
}, () => {
  for (const locale of ['en', 'zh-tw', 'zh-cn']) {
    const html = fs.readFileSync(
      htmlPath(`/Skills/${locale}/skills/claude/docx/`),
      'utf8',
    );
    assert.doesNotMatch(html, /class="detail-body"/);
    assert.doesNotMatch(html, /class="skill-summary"/);
    assert.doesNotMatch(html, /class="timeline-summary"/);
    assert.doesNotMatch(html, /install-copy-btn|npx skills add/);
  }
});

test('Pagefind indexes exactly 357 localized skill pages across all three languages', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const entry = JSON.parse(
    fs.readFileSync(path.join(distDir, 'pagefind', 'pagefind-entry.json'), 'utf8'),
  );
  assert.equal(entry.languages.en.page_count, 119);
  assert.equal(entry.languages['zh-tw'].page_count, 119);
  assert.equal(entry.languages['zh-cn'].page_count, 119);
  assert.equal(
    Object.values(entry.languages).reduce(
      (sum: number, language: any) => sum + language.page_count,
      0,
    ),
    357,
  );
  const fragments = fs.readdirSync(path.join(distDir, 'pagefind', 'fragment'))
    .filter((name) => name.endsWith('.pf_fragment'));
  assert.equal(fragments.length, 357);
});
