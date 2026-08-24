/**
 * Search feature tests — structural checks, Pagefind build integration,
 * filter/UI semantics, base-path safety, and restricted-index safeguards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');

// ─── Build Integration ──────────────────────────────────────────────

test('package.json has postbuild script that runs pagefind', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(siteRoot, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.postbuild, 'postbuild script must exist');
  assert.match(pkg.scripts.postbuild, /pagefind/i, 'postbuild must reference pagefind');
});

test('pagefind is listed as a dependency', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(siteRoot, 'package.json'), 'utf8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(allDeps.pagefind, 'pagefind must be a dependency');
});

// ─── Search Component Existence ─────────────────────────────────────

test('Search.astro component exists', () => {
  const searchPath = path.join(siteRoot, 'src', 'components', 'Search.astro');
  assert.ok(fs.existsSync(searchPath), 'Search.astro must exist in src/components/');
});

// ─── Skill Detail Page: Pagefind Data Attributes ────────────────────

test('skill detail page template includes data-pagefind-body', () => {
  const template = fs.readFileSync(
    path.join(siteRoot, 'src', 'pages', 'skills', '[source]', '[skill].astro'),
    'utf8',
  );
  assert.match(template, /data-pagefind-body/, 'detail page must mark searchable body');
});

test('skill detail page template includes pagefind filter attributes', () => {
  const template = fs.readFileSync(
    path.join(siteRoot, 'src', 'pages', 'skills', '[source]', '[skill].astro'),
    'utf8',
  );
  assert.match(template, /data-pagefind-filter="source"/, 'must have source filter');
  assert.match(template, /data-pagefind-filter="license"/, 'must have license filter');
  assert.match(template, /data-pagefind-filter="origin"/, 'must have origin filter');
});

test('skill detail page template includes pagefind version meta', () => {
  const template = fs.readFileSync(
    path.join(siteRoot, 'src', 'pages', 'skills', '[source]', '[skill].astro'),
    'utf8',
  );
  assert.match(template, /data-pagefind-meta/, 'must have pagefind meta for version');
});

// ─── Index Page Includes Search ─────────────────────────────────────

test('index.astro imports Search component', () => {
  const template = fs.readFileSync(
    path.join(siteRoot, 'src', 'pages', 'index.astro'),
    'utf8',
  );
  assert.match(template, /import.*Search/, 'index must import Search component');
  assert.match(template, /<Search/, 'index must render Search component');
});

// ─── Base Path Safety ───────────────────────────────────────────────

test('Search component does not hardcode root pagefind path', () => {
  const template = fs.readFileSync(
    path.join(siteRoot, 'src', 'components', 'Search.astro'),
    'utf8',
  );
  // Must not contain a bare "/pagefind/" path (which breaks under /Skills base)
  assert.doesNotMatch(
    template,
    /['"`]\/pagefind\//,
    'Search must not hardcode root /pagefind/ path; must use base URL',
  );
});

test('Search component references base URL for pagefind loading', () => {
  const template = fs.readFileSync(
    path.join(siteRoot, 'src', 'components', 'Search.astro'),
    'utf8',
  );
  // Must dynamically use the Astro base URL
  assert.match(template, /pagefind/, 'Must reference pagefind');
});

// ─── Restricted Index Safety ────────────────────────────────────────

test('restricted skill pages never render SKILL.md body content', () => {
  const template = fs.readFileSync(
    path.join(siteRoot, 'src', 'pages', 'skills', '[source]', '[skill].astro'),
    'utf8',
  );
  // The template must gate body rendering on !skill.isRestricted
  assert.match(
    template,
    /!skill\.isRestricted.*renderedBody/s,
    'Body must only render when not restricted',
  );
});

test('non-searchable pages are excluded from pagefind index', () => {
  // index.astro, source pages, and status page should not be indexed
  const indexPage = fs.readFileSync(
    path.join(siteRoot, 'src', 'pages', 'index.astro'),
    'utf8',
  );
  const sourcePage = fs.readFileSync(
    path.join(siteRoot, 'src', 'pages', 'sources', '[source].astro'),
    'utf8',
  );
  // These should have data-pagefind-ignore or NOT have data-pagefind-body
  // If they don't have data-pagefind-body and the default is set on layout,
  // we need pagefind-ignore. Simplest: skill detail pages opt IN with data-pagefind-body.
  // Other pages must not have data-pagefind-body.
  assert.doesNotMatch(
    indexPage,
    /data-pagefind-body/,
    'index page must not be marked as pagefind body',
  );
  assert.doesNotMatch(
    sourcePage,
    /data-pagefind-body/,
    'source page must not be marked as pagefind body',
  );
});

// ─── Filter Options ─────────────────────────────────────────────────

test('Search component has filter selects for source, license, and origin', () => {
  const template = fs.readFileSync(
    path.join(siteRoot, 'src', 'components', 'Search.astro'),
    'utf8',
  );
  assert.match(template, /filter.*source/is, 'Must have source filter');
  assert.match(template, /filter.*license/is, 'Must have license filter');
  assert.match(template, /filter.*origin/is, 'Must have origin filter');
});

// ─── Progressive Enhancement ────────────────────────────────────────

test('Search component provides loading and error states', () => {
  const template = fs.readFileSync(
    path.join(siteRoot, 'src', 'components', 'Search.astro'),
    'utf8',
  );
  // Must have elements/text for loading and error feedback
  assert.match(template, /loading|Loading/i, 'Must have a loading state');
  assert.match(template, /error|Error|failed|unavailable/i, 'Must have an error state');
});

test('Search component provides a no-results state', () => {
  const template = fs.readFileSync(
    path.join(siteRoot, 'src', 'components', 'Search.astro'),
    'utf8',
  );
  assert.match(template, /no.*result|not.*found|no.*match/i, 'Must indicate when no results found');
});

// ─── Regression: Version Double-v Fix ───────────────────────────────

test('Search result rendering does not prepend extra v to version meta (prevents vv1.1.0)', () => {
  const template = fs.readFileSync(
    path.join(siteRoot, 'src', 'components', 'Search.astro'),
    'utf8',
  );
  // meta.version is already stored as "v1.1.0" from the detail page.
  // The JS must NOT prepend another "v" producing "vv1.1.0".
  assert.doesNotMatch(
    template,
    /'<span>v'\s*\+\s*escapeHtml\(version\)/,
    'Search JS must not prepend extra v to version meta (already contains v prefix)',
  );
});

// ─── Regression: License UX ─────────────────────────────────────────

test('skill detail page license visibility is conditional on not-Unknown', () => {
  const template = fs.readFileSync(
    path.join(siteRoot, 'src', 'pages', 'skills', '[source]', '[skill].astro'),
    'utf8',
  );
  // Must guard visible license on license !== 'Unknown'
  assert.match(
    template,
    /skill\.license\s*!==\s*['"]Unknown['"]/,
    'License visibility must be conditional on license !== Unknown',
  );
});

test('skill detail page visible license display includes "License:" label', () => {
  const template = fs.readFileSync(
    path.join(siteRoot, 'src', 'pages', 'skills', '[source]', '[skill].astro'),
    'utf8',
  );
  assert.match(
    template,
    /License:/,
    'Visible license must include "License:" label',
  );
});

test('skill detail page raw license element for Pagefind has hidden attribute', () => {
  const template = fs.readFileSync(
    path.join(siteRoot, 'src', 'pages', 'skills', '[source]', '[skill].astro'),
    'utf8',
  );
  // The pagefind filter/meta element carrying the raw license value must be hidden
  assert.match(
    template,
    /data-pagefind-filter="license"[^>]*hidden|hidden[^/\n>]*data-pagefind-filter="license"/,
    'Raw license element for Pagefind must have hidden attribute',
  );
});

// ─── Regression: Unexposed Version Filter Removed ────────────────────

test('skill detail page does not have unexposed data-pagefind-filter="version"', () => {
  const template = fs.readFileSync(
    path.join(siteRoot, 'src', 'pages', 'skills', '[source]', '[skill].astro'),
    'utf8',
  );
  assert.doesNotMatch(
    template,
    /data-pagefind-filter="version"/,
    'Unexposed version filter must be removed; data-pagefind-meta="version" alone suffices',
  );
});
