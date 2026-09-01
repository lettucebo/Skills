import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const githubIssuesPage = path.join(
  siteRoot,
  'dist',
  'en',
  'skills',
  'github',
  'github-issues',
  'index.html',
);
const restrictedPage = path.join(
  siteRoot,
  'dist',
  'en',
  'skills',
  'claude',
  'docx',
  'index.html',
);
const orphanPage = path.join(
  siteRoot,
  'dist',
  'en',
  'skills',
  'dotnet',
  'csharp-mcp-server-generator',
  'index.html',
);
const pagefindEntry = path.join(siteRoot, 'dist', 'pagefind', 'pagefind.js');
const distExists = fs.existsSync(pagefindEntry);
const skillPageSource = fs.readFileSync(
  path.join(siteRoot, 'src', 'components', 'pages', 'SkillPage.astro'),
  'utf8',
);

test('skill template places a closed Pagefind-excluded upstream disclosure above the body', () => {
  const detailsStart = skillPageSource.indexOf(
    '<details class="upstream-changes" data-pagefind-ignore>',
  );
  const bodyStart = skillPageSource.indexOf('<div class="detail-body">');
  const installStart = skillPageSource.indexOf('<InstallCommand');
  const historyStart = skillPageSource.indexOf("t(locale, 'history')");

  assert.ok(detailsStart >= 0, 'upstream changes must use a native details element');
  assert.ok(detailsStart < installStart, 'upstream disclosure must precede install controls');
  assert.ok(detailsStart < bodyStart, 'upstream disclosure must precede the raw body');
  assert.ok(historyStart > bodyStart, 'registry History must remain after the raw body');
  assert.doesNotMatch(
    skillPageSource.slice(detailsStart, skillPageSource.indexOf('>', detailsStart) + 1),
    /\bopen\b/,
    'upstream disclosure must default closed',
  );
  assert.match(skillPageSource, /<summary[^>]*>[\s\S]*upstreamChangesSummary/);
  assert.match(skillPageSource, /href=\{entry\.url\}/);
  assert.match(skillPageSource, /<time datetime=\{entry\.date\}>/);
  assert.match(skillPageSource, /\{entry\.subject\}/);
  assert.match(skillPageSource, /\{entry\.summary &&/);
});

test('built mapped skill renders Upstream changes separately from registry History', {
  skip: !distExists && 'dist/ not found (run npm run build first)',
}, () => {
  const rendered = fs.readFileSync(githubIssuesPage, 'utf8');

  assert.match(
    rendered,
    /<details class="upstream-changes" data-pagefind-ignore>\s*<summary>\s*Upstream changes \(\d+, latest included \d{4}-\d{2}-\d{2}\)\s*<\/summary>/,
  );
  assert.match(rendered, />History<\/h2>/);
  assert.match(
    rendered,
    /https:\/\/github\.com\/github\/awesome-copilot\/commit\/[0-9a-f]{40}/,
  );
  assert.ok(
    rendered.indexOf('class="upstream-changes"') < rendered.indexOf('class="detail-body"'),
  );
  assert.ok(
    rendered.indexOf('class="detail-body"') < rendered.indexOf('>History</h2>'),
  );
  assert.doesNotMatch(
    rendered.match(/<details class="upstream-changes"[^>]*>/)?.[0] ?? '',
    /\bopen\b/,
  );
});

test('removed proprietary page is absent and orphan page has no upstream changelog', {
  skip: !distExists && 'dist/ not found (run npm run build first)',
}, () => {
  const orphan = fs.readFileSync(orphanPage, 'utf8');

  assert.equal(fs.existsSync(restrictedPage), false);
  assert.doesNotMatch(orphan, /class="upstream-changes"/);
  assert.match(orphan, />History<\/h2>/);
});
