import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const sourcePage = path.join(siteRoot, 'dist', 'en', 'sources', 'azure', 'index.html');
const pagefindEntry = path.join(siteRoot, 'dist', 'pagefind', 'pagefind.js');
const distExists = fs.existsSync(pagefindEntry);

test('built source page names its skills table with the actual source', {
  skip: !distExists && 'dist/ not found (run npm run build first)',
}, () => {
  const rendered = fs.readFileSync(sourcePage, 'utf8');

  assert.match(
    rendered,
    /<div class="table-scroll" role="region" aria-label="Skills in azure" tabindex="0">/,
  );
  assert.doesNotMatch(rendered, /Skills in undefined/);
});
