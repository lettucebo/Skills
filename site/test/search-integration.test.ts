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
import { loadCatalog } from '../src/lib/catalog.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(siteRoot, '..');
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

test('pagefind indexes exactly 357 localized skill pages with filters and metadata', {
  skip: !distExists && 'dist/ not found',
}, () => {
  // Verify the built pagefind index has the correct page count
  const entryPath = path.join(distDir, 'pagefind', 'pagefind-entry.json');
  assert.ok(fs.existsSync(entryPath), 'pagefind-entry.json must exist');

  const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
  assert.equal(
    entry.languages.en.page_count, 119,
    'Pagefind must index exactly 119 English skill pages',
  );
  assert.equal(entry.languages['zh-tw'].page_count, 119);
  assert.equal(entry.languages['zh-cn'].page_count, 119);

  // Verify fragment files exist (one per indexed page)
  const fragmentDir = path.join(distDir, 'pagefind', 'fragment');
  const fragments = fs.readdirSync(fragmentDir).filter(f => f.endsWith('.pf_fragment'));
  assert.equal(fragments.length, 357, 'Must have 357 fragment files');

  // Verify filter index files exist
  const filterDir = path.join(distDir, 'pagefind', 'filter');
  const filterFiles = fs.readdirSync(filterDir).filter(f => f.endsWith('.pf_filter'));
  assert.ok(filterFiles.length >= 3, `Must have at least 3 filter files (source, license, origin), got ${filterFiles.length}`);
});

// ─── Restricted Page Safety: HTML Content Check ─────────────────────

test('restricted skill pages do not contain SKILL.md body content in built HTML', {
  skip: !distExists && 'dist/ not found',
}, async () => {
  const catalog = await loadCatalog(repoRoot);
  const restrictedPaths = [
    'en/skills/claude/docx/index.html',
    'en/skills/claude/pdf/index.html',
    'en/skills/claude/pptx/index.html',
    'en/skills/claude/xlsx/index.html',
  ];

  for (const relPath of restrictedPaths) {
    const fullPath = path.join(distDir, relPath);
    if (!fs.existsSync(fullPath)) {
      assert.fail(`Expected restricted page at ${relPath}`);
    }

    const html = fs.readFileSync(fullPath, 'utf8');
    const skillPath = relPath.replace(/^en\//, '').replace(/\/index\.html$/, '');
    const skill = catalog.skills.find((entry) => entry.path === skillPath);
    assert.ok(skill, `Expected catalog entry for ${skillPath}`);

    // Restricted pages must NOT have a detail-body section
    assert.doesNotMatch(
      html,
      /class="detail-body"/,
      `Restricted page ${relPath} must not contain rendered body content`,
    );

    // Must NOT contain npx install command
    assert.doesNotMatch(
      html,
      /npx skills add/,
      `Restricted page ${relPath} must not contain npx install command`,
    );

    assert.ok(
      html.includes(
        `href="https://github.com/${skill.upstreamRepo}/tree/${skill.upstreamCommit}/${skill.upstreamSource}"`,
      ),
      `Restricted page ${relPath} must link to its pinned upstream source`,
    );
    assert.ok(
      html.includes(
        `href="https://github.com/${skill.upstreamRepo}/commit/${skill.upstreamCommit}"`,
      ),
      `Restricted page ${relPath} must link to its pinned upstream commit`,
    );
  }
});

test('orphan skill pages build without upstream source or commit links', {
  skip: !distExists && 'dist/ not found',
}, async () => {
  const catalog = await loadCatalog(repoRoot);
  const orphans = catalog.skills.filter((skill) => skill.isOrphan);

  assert.equal(orphans.length, 3);
  for (const skill of orphans) {
    const fullPath = path.join(
      distDir,
      'en',
      'skills',
      skill.source,
      skill.slug,
      'index.html',
    );
    assert.ok(fs.existsSync(fullPath), `Expected orphan page for ${skill.path}`);

    const html = fs.readFileSync(fullPath, 'utf8');
    assert.doesNotMatch(html, /Source:/);
    assert.doesNotMatch(html, /Commit:/);
  }
});

// ─── Known Public Skill HTML Contains Source and Version ─────────────

test('built public skill page contains source and version metadata in HTML', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const publicPath = path.join(distDir, 'en', 'skills', 'azure', 'az-cost-optimize', 'index.html');
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
  assert.ok(
    html.includes(
      'href="https://github.com/github/awesome-copilot/tree/4742f265959bf025882314564b364d9d7af6e2d5/skills/az-cost-optimize"',
    ),
    'Must link the full upstream source path at the synced commit',
  );
  assert.match(
    html,
    /github\/awesome-copilot\/skills\/az-cost-optimize/,
    'Must display the full upstream repository and source path',
  );
  assert.ok(
    html.includes(
      'href="https://github.com/github/awesome-copilot/commit/4742f265959bf025882314564b364d9d7af6e2d5"',
    ),
    'Must link the short commit label to the full upstream commit',
  );
});
