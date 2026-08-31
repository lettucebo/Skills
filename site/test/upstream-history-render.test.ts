import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const githubIssuesPage = path.join(
  siteRoot,
  'dist',
  'skills',
  'github',
  'github-issues',
  'index.html',
);
const restrictedPage = path.join(
  siteRoot,
  'dist',
  'skills',
  'claude',
  'docx',
  'index.html',
);
const orphanPage = path.join(
  siteRoot,
  'dist',
  'skills',
  'dotnet',
  'csharp-mcp-server-generator',
  'index.html',
);

function buildSite() {
  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run build'], {
      cwd: siteRoot,
      stdio: 'inherit',
    });
    return;
  }
  execFileSync('npm', ['run', 'build'], { cwd: siteRoot, stdio: 'inherit' });
}

test('built mapped skill renders Upstream changes separately from registry History', () => {
  buildSite();
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

test('built restricted and orphan pages never render upstream changelog content', () => {
  if (!fs.existsSync(restrictedPage) || !fs.existsSync(orphanPage)) buildSite();
  const restricted = fs.readFileSync(restrictedPage, 'utf8');
  const orphan = fs.readFileSync(orphanPage, 'utf8');

  assert.doesNotMatch(restricted, />Upstream changes<\/h2>/);
  assert.doesNotMatch(orphan, />Upstream changes<\/h2>/);
  assert.doesNotMatch(restricted, /data-copy-command/);
  assert.match(orphan, />History<\/h2>/);
});
