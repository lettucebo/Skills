/**
 * Integration tests — run AFTER a successful site build (npm run build).
 * Verifies the Pagefind index via the Node API, restricted-page safety,
 * and that a known public skill result includes source and version.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const distDir = path.join(siteRoot, 'dist');

// Guard: skip integration tests if dist/ doesn't exist
const distExists = fs.existsSync(distDir);

// ─── Pagefind Index Exists ──────────────────────────────────────────

test('pagefind index files exist in dist/', { skip: !distExists && 'dist/ not found (run npm run build first)' }, () => {
  assert.ok(
    fs.existsSync(path.join(distDir, 'pagefind', 'pagefind.js')),
    'pagefind.js must exist in dist/pagefind/',
  );
});

// ─── Programmatic Search: Known Public Skill ────────────────────────

test('pagefind indexes exactly 103 skill pages with filters and metadata', {
  skip: !distExists && 'dist/ not found',
}, () => {
  // Verify the built pagefind index has the correct page count
  const entryPath = path.join(distDir, 'pagefind', 'pagefind-entry.json');
  assert.ok(fs.existsSync(entryPath), 'pagefind-entry.json must exist');

  const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
  assert.equal(
    entry.languages.en.page_count, 103,
    'Pagefind must index exactly 103 skill pages (only data-pagefind-body pages)',
  );

  // Verify fragment files exist (one per indexed page)
  const fragmentDir = path.join(distDir, 'pagefind', 'fragment');
  const fragments = fs.readdirSync(fragmentDir).filter(f => f.endsWith('.pf_fragment'));
  assert.equal(fragments.length, 103, 'Must have 103 fragment files');

  // Verify filter index files exist
  const filterDir = path.join(distDir, 'pagefind', 'filter');
  const filterFiles = fs.readdirSync(filterDir).filter(f => f.endsWith('.pf_filter'));
  assert.ok(filterFiles.length >= 3, `Must have at least 3 filter files (source, license, origin), got ${filterFiles.length}`);
});

// ─── Restricted Page Safety: HTML Content Check ─────────────────────

test('restricted skill pages do not contain SKILL.md body content in built HTML', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const restrictedPaths = [
    'skills/claude/docx/index.html',
    'skills/claude/pdf/index.html',
    'skills/claude/pptx/index.html',
    'skills/claude/xlsx/index.html',
  ];

  for (const relPath of restrictedPaths) {
    const fullPath = path.join(distDir, relPath);
    if (!fs.existsSync(fullPath)) {
      assert.fail(`Expected restricted page at ${relPath}`);
    }

    const html = fs.readFileSync(fullPath, 'utf8');

    // Restricted pages must NOT have a detail-body section
    assert.doesNotMatch(
      html,
      /class="detail-body"/,
      `Restricted page ${relPath} must not contain rendered body content`,
    );

    // Must have the restricted warning
    assert.match(
      html,
      /Restricted Content/,
      `Restricted page ${relPath} must show restricted warning`,
    );

    // Must NOT contain npx install command
    assert.doesNotMatch(
      html,
      /npx skills add/,
      `Restricted page ${relPath} must not contain npx install command`,
    );
  }
});

// ─── Known Public Skill HTML Contains Source and Version ─────────────

test('built public skill page contains source and version metadata in HTML', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const publicPath = path.join(distDir, 'skills', 'azure', 'az-cost-optimize', 'index.html');
  assert.ok(fs.existsSync(publicPath), 'Public skill page must exist');

  const html = fs.readFileSync(publicPath, 'utf8');

  // Must contain pagefind data attributes
  assert.match(html, /data-pagefind-body/, 'Must have pagefind body marker');
  assert.match(html, /data-pagefind-filter="source"/, 'Must have source filter attribute');
  assert.match(html, /data-pagefind-filter="license"/, 'Must have license filter attribute');
  assert.match(html, /data-pagefind-filter="origin"/, 'Must have origin filter attribute');

  // Must contain source "azure" and version "1.1.0" in metadata
  assert.match(html, /azure/, 'Must contain source name');
  assert.match(html, /1\.1\.0/, 'Must contain version');
});
