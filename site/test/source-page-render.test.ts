import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const sourcePage = path.join(siteRoot, 'dist', 'sources', 'azure', 'index.html');
const pagefindEntry = path.join(siteRoot, 'dist', 'pagefind', 'pagefind.js');

function ensureSourcePageIsBuilt() {
  if (fs.existsSync(sourcePage) && fs.existsSync(pagefindEntry)) {
    return;
  }

  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run build'], {
      cwd: siteRoot,
      stdio: 'inherit',
    });
    return;
  }

  execFileSync('npm', ['run', 'build'], { cwd: siteRoot, stdio: 'inherit' });
}

test('built source page names its skills table with the actual source', () => {
  ensureSourcePageIsBuilt();
  const rendered = fs.readFileSync(sourcePage, 'utf8');

  assert.match(
    rendered,
    /<div class="table-scroll" role="region" aria-label="Skills in azure" tabindex="0">/,
  );
  assert.doesNotMatch(rendered, /Skills in undefined/);
});
