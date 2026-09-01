import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HTML_LANG,
  LOCALE_DISPLAY_NAMES,
  SUPPORTED_LOCALES,
  assertLocale,
  localizedPath,
  parseLocale,
  routeForLocale,
  t,
} from './index.ts';

test('locale parsing accepts only the three supported route locales', () => {
  assert.deepEqual(SUPPORTED_LOCALES, ['en', 'zh-tw', 'zh-cn']);
  for (const locale of SUPPORTED_LOCALES) {
    assert.equal(parseLocale(locale), locale);
    assert.equal(assertLocale(locale), locale);
  }
  assert.equal(parseLocale('EN'), null);
  assert.equal(parseLocale('fr'), null);
  assert.equal(parseLocale(undefined), null);
  assert.throws(() => assertLocale('fr'), /Unsupported locale/);
});

test('localized paths always include the base, locale prefix, and trailing slash', () => {
  assert.equal(localizedPath('en', '/'), '/Skills/en/');
  assert.equal(localizedPath('zh-tw', 'install'), '/Skills/zh-tw/install/');
  assert.equal(
    localizedPath('zh-cn', '/skills/azure/az-cost-optimize/'),
    '/Skills/zh-cn/skills/azure/az-cost-optimize/',
  );
});

test('locale switching preserves the logical source or skill route', () => {
  assert.equal(
    routeForLocale('zh-cn', '/Skills/en/sources/microsoft/'),
    '/Skills/zh-cn/sources/microsoft/',
  );
  assert.equal(
    routeForLocale('zh-tw', '/Skills/zh-cn/skills/vscode/code-review/'),
    '/Skills/zh-tw/skills/vscode/code-review/',
  );
  assert.equal(routeForLocale('en', '/Skills/'), '/Skills/en/');
  assert.throws(
    () => routeForLocale('en', '/Other/en/skills/demo/'),
    /outside the site base/,
  );
});

test('locale metadata and typed messages expose native display names and interpolation', () => {
  assert.deepEqual(HTML_LANG, {
    en: 'en',
    'zh-tw': 'zh-TW',
    'zh-cn': 'zh-CN',
  });
  assert.deepEqual(LOCALE_DISPLAY_NAMES, {
    en: 'English',
    'zh-tw': '繁體中文',
    'zh-cn': '简体中文',
  });
  assert.equal(t('en', 'resultsFound', { count: 2 }), '2 results found.');
  assert.equal(t('zh-tw', 'resultsFound', { count: 2 }), '找到 2 個結果。');
  assert.equal(t('zh-cn', 'resultsFound', { count: 2 }), '找到 2 个结果。');
  assert.equal(t('en', 'commit'), 'Commit');
  assert.equal(t('zh-tw', 'commit'), '提交');
  assert.equal(t('zh-cn', 'commit'), '提交');
  assert.equal(t('en', 'latestIncludedChange'), 'Latest included change');
  assert.equal(t('zh-tw', 'latestIncludedChange'), '收錄的最新變更');
  assert.equal(t('zh-cn', 'latestIncludedChange'), '收录的最新变更');
  assert.equal(
    t('en', 'upstreamChangesSummary', { count: 5, date: '2026-02-19' }),
    'Upstream changes (5, latest included 2026-02-19)',
  );
  assert.equal(
    t('zh-tw', 'upstreamChangesSummary', { count: 5, date: '2026-02-19' }),
    '上游變更（5 筆，最新收錄 2026-02-19）',
  );
  assert.equal(
    t('zh-cn', 'upstreamChangesSummary', { count: 5, date: '2026-02-19' }),
    '上游变更（5 条，最新收录 2026-02-19）',
  );
});
