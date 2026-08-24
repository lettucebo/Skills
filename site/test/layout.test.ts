/**
 * Regression test: Layout.astro must import global.css in frontmatter,
 * not inside a scoped <style> block (which would prevent global selectors
 * from applying to slot-rendered content).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const layoutPath = path.resolve(__dirname, '../src/layouts/Layout.astro');
const source = fs.readFileSync(layoutPath, 'utf-8');

// Extract frontmatter (content between the first pair of `---` fences)
// Use \r?\n to handle both LF and CRLF line endings
const frontmatterMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
const frontmatter = frontmatterMatch ? frontmatterMatch[1] : '';

// Extract all <style> blocks that are NOT is:global
const scopedStyleBlocks = [...source.matchAll(/<style(?![^>]*\bis:global\b)[^>]*>([\s\S]*?)<\/style>/g)];

test('Layout.astro: global.css is imported in frontmatter', () => {
  assert.ok(
    frontmatter.includes("import '../styles/global.css'"),
    `Expected Layout.astro frontmatter to contain "import '../styles/global.css'", but it does not.\nFrontmatter:\n${frontmatter}`,
  );
});

test('Layout.astro: global.css is NOT imported inside a scoped <style> block', () => {
  for (const match of scopedStyleBlocks) {
    const blockContent = match[1];
    assert.ok(
      !blockContent.includes('global.css'),
      `Found global.css @import inside a scoped <style> block. ` +
        `This causes Astro to scope the selectors, breaking global styles.\n` +
        `Block content:\n${blockContent}`,
    );
  }
});

test('Layout.astro: main#main-content has tabindex="-1" for skip-link programmatic focus', () => {
  // The skip link <a href="#main-content"> scrolls the viewport to <main> but the
  // browser will not move keyboard focus there unless the element is programmatically
  // focusable.  tabindex="-1" allows focus.focus() / fragment activation to work
  // without adding <main> to the natural tab order.
  assert.ok(
    /id="main-content"[^>]*tabindex="-1"|tabindex="-1"[^>]*id="main-content"/.test(source),
    'main#main-content must have tabindex="-1" so skip-link activation moves keyboard focus inside <main>',
  );
});
