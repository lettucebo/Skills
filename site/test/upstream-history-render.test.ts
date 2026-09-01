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

test('built mapped skill renders Upstream changes separately from registry History', {
  skip: !distExists && 'dist/ not found (run npm run build first)',
}, () => {
  const rendered = fs.readFileSync(githubIssuesPage, 'utf8');

  assert.match(rendered, />Upstream changes<\/h2>/);
  assert.match(rendered, />History<\/h2>/);
  assert.match(
    rendered,
    /https:\/\/github\.com\/github\/awesome-copilot\/commit\/[0-9a-f]{40}/,
  );
  assert.ok(
    rendered.indexOf('Upstream changes</h2>') < rendered.indexOf('History</h2>'),
  );
});

test('built restricted and orphan pages never render upstream changelog content', {
  skip: !distExists && 'dist/ not found (run npm run build first)',
}, () => {
  const restricted = fs.readFileSync(restrictedPage, 'utf8');
  const orphan = fs.readFileSync(orphanPage, 'utf8');

  assert.doesNotMatch(restricted, />Upstream changes<\/h2>/);
  assert.doesNotMatch(orphan, />Upstream changes<\/h2>/);
  assert.doesNotMatch(restricted, /data-copy-command/);
  assert.match(orphan, />History<\/h2>/);
});
