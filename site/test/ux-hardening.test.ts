/**
 * UX hardening tests — contrast, accessibility, navigation, search UX,
 * catalog cards, install-command component, and progressive enhancement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const distDir = path.join(siteRoot, 'dist');
const distExists = fs.existsSync(distDir);

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Parse a hex color to linear RGB components (0–1).
 * Supports #RGB and #RRGGBB.
 */
function hexToLinear(hex: string): [number, number, number] {
  hex = hex.replace(/^#/, '');
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  return [toLinear(r), toLinear(g), toLinear(b)];
}

function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(hexToLinear(fg));
  const l2 = relativeLuminance(hexToLinear(bg));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ─── A. Contrast and Visual Accessibility ───────────────────────────

test('A1: light warning text token #7a4b00 on #f7f4ef meets AA (>=4.5:1)', () => {
  const ratio = contrastRatio('#7a4b00', '#f7f4ef');
  assert.ok(ratio >= 4.5, `Expected >=4.5:1, got ${ratio.toFixed(2)}:1`);
});

test('A2: light link text token #0067b8 on #f7f4ef meets AA (>=4.5:1)', () => {
  const ratio = contrastRatio('#0067b8', '#f7f4ef');
  assert.ok(ratio >= 4.5, `Expected >=4.5:1, got ${ratio.toFixed(2)}:1`);
});

test('A3: dark warning text token #fbbf24 on #3d3b3a meets AA (>=4.5:1)', () => {
  const ratio = contrastRatio('#fbbf24', '#3d3b3a');
  assert.ok(ratio >= 4.5, `Expected >=4.5:1, got ${ratio.toFixed(2)}:1`);
});

test('A4: dark link text token #5aafff on #3d3b3a meets AA (>=4.5:1)', () => {
  const ratio = contrastRatio('#5aafff', '#3d3b3a');
  assert.ok(ratio >= 4.5, `Expected >=4.5:1, got ${ratio.toFixed(2)}:1`);
});

test('A5: global.css defines accessible text tokens', () => {
  const css = fs.readFileSync(path.join(siteRoot, 'src', 'styles', 'global.css'), 'utf8');
  // Light theme accessible tokens
  assert.match(css, /--cp-warning-text:\s*#7a4b00/, 'Must define --cp-warning-text for light theme');
  assert.match(css, /--cp-link-text:\s*#0067b8/, 'Must define --cp-link-text for light theme');
  // Dark theme accessible tokens
  assert.match(css, /--cp-warning-text:\s*#fbbf24/, 'Must define dark --cp-warning-text');
  assert.match(css, /--cp-link-text:\s*#5aafff/, 'Must define dark --cp-link-text');
});

test('A6: link anchor uses --cp-link-text, not --cp-link directly', () => {
  const css = fs.readFileSync(path.join(siteRoot, 'src', 'styles', 'global.css'), 'utf8');
  // The anchor rule should reference link-text
  const anchorBlock = css.match(/^a\s*\{[^}]+\}/m);
  assert.ok(anchorBlock, 'Must have anchor rule');
  assert.match(anchorBlock![0], /--cp-link-text/, 'Anchor color must use --cp-link-text');
});

test('A7: pending badge uses --cp-warning-text', () => {
  const css = fs.readFileSync(path.join(siteRoot, 'src', 'styles', 'global.css'), 'utf8');
  const pendingBadge = css.match(/\.badge--pending\s*\{[^}]+\}/);
  assert.ok(pendingBadge, 'Must have pending badge rule');
  assert.match(pendingBadge![0], /--cp-warning-text/, 'Pending badge color must use --cp-warning-text');
});

test('A8: global reduced-motion coverage for card transitions', () => {
  const css = fs.readFileSync(path.join(siteRoot, 'src', 'styles', 'global.css'), 'utf8');
  assert.match(css, /prefers-reduced-motion/, 'Must have reduced-motion media query');
  assert.match(css, /\.card/, 'Must reference .card in reduced-motion context');
});

test('A9: forced-colors treatment exists', () => {
  const css = fs.readFileSync(path.join(siteRoot, 'src', 'styles', 'global.css'), 'utf8');
  assert.match(css, /forced-colors:\s*active/, 'Must have forced-colors: active treatment');
});

// ─── B. Accurate UI Content and Navigation ──────────────────────────

test('B1: status page does not contain stale Pagefind/search limitation', () => {
  const status = fs.readFileSync(path.join(siteRoot, 'src', 'pages', 'status.astro'), 'utf8');
  assert.doesNotMatch(status, /Search\/filter functionality is planned/, 'Stale search limitation must be removed');
  assert.doesNotMatch(status, /Pagefind integration/, 'Stale Pagefind claim must be removed');
});

test('B2: favicon.svg exists in site/public/', () => {
  assert.ok(
    fs.existsSync(path.join(siteRoot, 'public', 'favicon.svg')),
    'favicon.svg must exist in site/public/',
  );
});

test('B3: Layout references favicon.svg', () => {
  const layout = fs.readFileSync(path.join(siteRoot, 'src', 'layouts', 'Layout.astro'), 'utf8');
  assert.match(layout, /favicon\.svg/, 'Layout must reference favicon.svg');
});

test('B4: nav links have aria-current="page" for active page', () => {
  const layout = fs.readFileSync(path.join(siteRoot, 'src', 'layouts', 'Layout.astro'), 'utf8');
  assert.match(layout, /aria-current/, 'Layout must use aria-current for active nav link');
});

test('B5: breadcrumb separators have aria-hidden="true"', () => {
  const skillPage = fs.readFileSync(
    path.join(siteRoot, 'src', 'pages', 'skills', '[source]', '[skill].astro'),
    'utf8',
  );
  const sourcePage = fs.readFileSync(
    path.join(siteRoot, 'src', 'pages', 'sources', '[source].astro'),
    'utf8',
  );
  assert.match(skillPage, /aria-hidden="true"/, 'Skill page breadcrumb separators need aria-hidden');
  assert.match(sourcePage, /aria-hidden="true"/, 'Source page breadcrumb separators need aria-hidden');
});

test('B6: landing page stats include restricted count explicitly', () => {
  const index = fs.readFileSync(path.join(siteRoot, 'src', 'pages', 'index.astro'), 'utf8');
  assert.match(index, /counts\.restricted/, 'Landing page must display counts.restricted');
});

// ─── C. Search/Filter UX and Progressive Enhancement ────────────────

test('C1: search input does not have redundant aria-label when sr-only label exists', () => {
  const search = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'Search.astro'), 'utf8');
  // If a <label for="search-input"> with sr-only text exists, the input should not ALSO have aria-label
  const hasLabelFor = search.includes('for="search-input"');
  if (hasLabelFor) {
    // The input element itself should not duplicate aria-label
    const inputMatch = search.match(/<input[^>]*id="search-input"[^>]*>/);
    assert.ok(inputMatch, 'search input must exist');
    assert.doesNotMatch(inputMatch![0], /aria-label/, 'Input must not have redundant aria-label when label element exists');
  }
});

test('C2: filter selects do not have redundant aria-label', () => {
  const search = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'Search.astro'), 'utf8');
  // Each select is wrapped in a <label> with sr-only text — no need for aria-label on select
  const selects = [...search.matchAll(/<select[^>]*>/g)];
  for (const match of selects) {
    assert.doesNotMatch(match[0], /aria-label/, `Select must not have redundant aria-label: ${match[0]}`);
  }
});

test('C3: noscript message exists in Search component', () => {
  const search = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'Search.astro'), 'utf8');
  assert.match(search, /<noscript/, 'Must have noscript element');
  assert.match(search, /JavaScript/i, 'noscript must mention JavaScript');
});

test('C4: no-JS dark theme CSS fallback for html:not([data-theme])', () => {
  const css = fs.readFileSync(path.join(siteRoot, 'src', 'styles', 'global.css'), 'utf8');
  assert.match(css, /prefers-color-scheme:\s*dark/, 'Must have prefers-color-scheme: dark');
  assert.match(css, /html:not\(\[data-theme\]\)/, 'Must target html:not([data-theme]) for no-JS fallback');
});

test('C5: search JS hides full catalog when query/filter active', () => {
  const search = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'Search.astro'), 'utf8');
  // The JS must manipulate catalog visibility
  assert.match(search, /catalog.*hidden|style\.display|classList/i, 'Search JS must control catalog visibility');
});

test('C6: search renders all results, not sliced to 20', () => {
  const search = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'Search.astro'), 'utf8');
  assert.doesNotMatch(search, /slice\(0,\s*20\)/, 'Must not slice results to 20');
});

// ─── D. Catalog Cards ──────────────────────────────────────────────

test('D1: card link is a block link filling card area', () => {
  const index = fs.readFileSync(path.join(siteRoot, 'src', 'pages', 'index.astro'), 'utf8');
  // The card should have a block link containing title, meta, and description
  const css = fs.readFileSync(path.join(siteRoot, 'src', 'styles', 'global.css'), 'utf8');
  assert.match(css, /\.card\s+a|\.card-link/, 'Must have card link styling for block hit area');
});

test('D2: card renders description for non-restricted skills', () => {
  const index = fs.readFileSync(path.join(siteRoot, 'src', 'pages', 'index.astro'), 'utf8');
  assert.match(index, /card-description|description/i, 'Card must show description');
  assert.match(index, /loadSkillBody/, 'Must use loadSkillBody for descriptions');
});

test('D3: restricted skills have no body description on cards', () => {
  const index = fs.readFileSync(path.join(siteRoot, 'src', 'pages', 'index.astro'), 'utf8');
  // Must guard description loading with isRestricted check
  assert.match(index, /isRestricted|restricted/i, 'Must check restricted status for card descriptions');
});

// ─── E. Install-Command Component ───────────────────────────────────

test('E1: InstallCommand component exists', () => {
  assert.ok(
    fs.existsSync(path.join(siteRoot, 'src', 'components', 'InstallCommand.astro')),
    'InstallCommand.astro must exist',
  );
});

test('E2: InstallCommand has copy button with accessible name', () => {
  const comp = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'InstallCommand.astro'), 'utf8');
  assert.match(comp, /<button/, 'Must have a copy button');
  assert.match(comp, /aria-label|aria-labelledby/, 'Copy button must have accessible name');
});

test('E3: InstallCommand has aria-live feedback region', () => {
  const comp = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'InstallCommand.astro'), 'utf8');
  assert.match(comp, /aria-live/, 'Must have aria-live feedback');
});

test('E4: InstallCommand copy button is hidden without JS (progressive enhancement)', () => {
  const comp = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'InstallCommand.astro'), 'utf8');
  // Button should start hidden and JS reveals it
  assert.match(comp, /hidden|display:\s*none|style="[^"]*display/, 'Copy button must start hidden for no-JS');
});

test('E5: InstallCommand uses navigator.clipboard with error handling', () => {
  const comp = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'InstallCommand.astro'), 'utf8');
  assert.match(comp, /navigator\.clipboard/, 'Must use navigator.clipboard');
  assert.match(comp, /catch|\.catch/, 'Must catch clipboard errors');
});

test('E6: skill detail page uses InstallCommand component', () => {
  const detail = fs.readFileSync(
    path.join(siteRoot, 'src', 'pages', 'skills', '[source]', '[skill].astro'),
    'utf8',
  );
  assert.match(detail, /import.*InstallCommand/, 'Skill detail page must import InstallCommand');
  assert.match(detail, /<InstallCommand/, 'Skill detail page must render InstallCommand');
});

test('E7: source page uses InstallCommand component', () => {
  const source = fs.readFileSync(
    path.join(siteRoot, 'src', 'pages', 'sources', '[source].astro'),
    'utf8',
  );
  assert.match(source, /import.*InstallCommand/, 'Source page must import InstallCommand');
  assert.match(source, /<InstallCommand/, 'Source page must render InstallCommand');
});

test('E8: index page uses InstallCommand component', () => {
  const index = fs.readFileSync(
    path.join(siteRoot, 'src', 'pages', 'index.astro'),
    'utf8',
  );
  assert.match(index, /import.*InstallCommand/, 'Index page must import InstallCommand');
  assert.match(index, /<InstallCommand/, 'Index page must render InstallCommand');
});

// ─── C7: No-JS controls hidden ──────────────────────────────────────

test('C7: noscript block contains style that hides .search-box and .filter-controls', () => {
  const search = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'Search.astro'), 'utf8');
  // The noscript element must contain a <style> that hides the interactive controls
  // so they are not operable or misleading when JS is unavailable.
  const noscriptContent = search.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? '';
  assert.match(noscriptContent, /<style/, 'noscript must contain a <style> block');
  assert.match(noscriptContent, /\.search-box/, 'noscript style must target .search-box');
  assert.match(noscriptContent, /\.filter-controls/, 'noscript style must target .filter-controls');
  assert.match(noscriptContent, /display:\s*none|visibility:\s*hidden/, 'noscript style must hide the controls');
});

// ─── E9: InstallCommand timer race ──────────────────────────────────

test('E9: InstallCommand click handler clears prior feedback timer before scheduling a new one', () => {
  const comp = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'InstallCommand.astro'), 'utf8');
  // Must call clearTimeout so a rapid second click cancels the first timer
  assert.match(comp, /clearTimeout\s*\(/, 'Must call clearTimeout to cancel any prior feedback timer');
  // The setTimeout return value must be stored so it can be cleared
  assert.match(comp, /\btimer\s*=\s*setTimeout\s*\(/, 'Must store the setTimeout handle in a variable for later cancellation');
});

// ─── F1: Search async stale-result race ─────────────────────────────

test('F1: doSearch uses a monotonic generation counter to discard stale async results', () => {
  const search = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'Search.astro'), 'utf8');
  // Must declare a generation counter that every doSearch call increments
  assert.match(search, /let\s+generation\s*=\s*0/, 'Must declare a generation counter initialized to 0');
  assert.match(search, /\+\+generation/, 'Must increment generation on every doSearch invocation');
  // After each awaited stage the current generation must be validated
  const staleChecks = (search.match(/gen\s*!==\s*generation|generation\s*!==\s*gen/g) || []).length;
  assert.ok(staleChecks >= 2, `Must check generation at least twice after awaited stages; found ${staleChecks}`);
});

// ─── F2: loadPagefind stale DOM mutation ────────────────────────────

test('F2: loadPagefind must not mutate DOM in catch — stale load errors must not clobber current UI', () => {
  const search = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'Search.astro'), 'utf8');

  const loadPfStart = search.indexOf('async function loadPagefind()');
  const doSearchStart = search.indexOf('async function doSearch()');

  assert.ok(loadPfStart !== -1, 'loadPagefind function must exist');
  assert.ok(doSearchStart !== -1, 'doSearch function must exist');
  assert.ok(doSearchStart > loadPfStart, 'doSearch must be defined after loadPagefind in source');

  // Extract loadPagefind body (everything from its declaration up to doSearch).
  // This is the region that fires outside any doSearch generation scope.
  const loadPfBody = search.slice(loadPfStart, doSearchStart);

  // loadPagefind must NOT set statusEl to an unavailable/error message.
  // A catch block in loadPagefind fires after the import promise rejects — by then
  // the user may have cleared their query (incrementing generation) so the UI is
  // already reset.  Writing to statusEl here unconditionally overwrites that state.
  assert.doesNotMatch(
    loadPfBody,
    /statusEl\s*\.\s*textContent\s*=\s*['"`][^'"`]*unavailable/,
    'loadPagefind must not set statusEl.textContent to the unavailable error (fires without generation check)',
  );

  // loadPagefind must NOT restore fullCatalog visibility inside its own catch.
  assert.doesNotMatch(
    loadPfBody,
    /fullCatalog\s*\.\s*hidden\s*=\s*false/,
    'loadPagefind must not restore fullCatalog.hidden in its own catch (fires without generation check)',
  );

  // The load-unavailable message must live inside doSearch so it can be generation-guarded.
  const unavailableIdx = search.indexOf('unavailable', doSearchStart);
  assert.ok(
    unavailableIdx > doSearchStart,
    'Load-unavailable error message must be handled inside doSearch, not only in loadPagefind',
  );

  // A generation check must appear in doSearch BEFORE the unavailable message
  // so that stale load errors produce no UI mutation.
  const genCheckIdx = search.lastIndexOf('gen !== generation', unavailableIdx);
  assert.ok(
    genCheckIdx > doSearchStart,
    'A generation check (gen !== generation) must appear in doSearch before the load-unavailable message',
  );
});

// ─── Integration: Built HTML checks ─────────────────────────────────

test('INT1: built public skill page has copy button', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(
    path.join(distDir, 'skills', 'azure', 'az-cost-optimize', 'index.html'),
    'utf8',
  );
  assert.match(html, /copy|Copy/i, 'Built page must have copy button');
});

test('INT2: built restricted page has no copy button', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(
    path.join(distDir, 'skills', 'claude', 'docx', 'index.html'),
    'utf8',
  );
  assert.doesNotMatch(html, /navigator\.clipboard/, 'Restricted page must not have clipboard code');
});

test('INT3: built status page has no stale search limitation', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(path.join(distDir, 'status', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /Search\/filter functionality is planned/, 'Status must not have stale limitation');
});

test('INT4: built index page has favicon link', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  assert.match(html, /favicon\.svg/, 'Index must reference favicon');
});

test('INT5: built index page has noscript element', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  assert.match(html, /<noscript/, 'Index must have noscript element');
});

test('INT6: built skill page breadcrumb separators have aria-hidden', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(
    path.join(distDir, 'skills', 'azure', 'az-cost-optimize', 'index.html'),
    'utf8',
  );
  // All <span>/</span> in breadcrumbs should have aria-hidden
  const breadcrumbSeps = html.match(/<span[^>]*>\/(?:&sol;)?<\/span>/g) || [];
  for (const sep of breadcrumbSeps) {
    assert.match(sep, /aria-hidden="true"/, `Breadcrumb separator must have aria-hidden: ${sep}`);
  }
});

test('INT7: built public skill page has card-description with text', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  assert.match(html, /card-description/, 'Index must have card descriptions');
});
