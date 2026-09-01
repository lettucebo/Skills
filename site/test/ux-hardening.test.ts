/**
 * UX hardening tests — contrast, accessibility, navigation, search UX,
 * catalog cards, install-command component, and progressive enhancement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_VERSION } from '../src/lib/catalog.ts';

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

// ─── Token-driven contrast helpers ──────────────────────────────────

const globalCssPath = path.join(siteRoot, 'src', 'styles', 'global.css');

function readGlobalCss(): string {
  return fs.readFileSync(globalCssPath, 'utf8');
}

/** Reads the custom-property declarations of a theme block from global.css. */
function readThemeTokens(theme: 'light' | 'dark'): Record<string, string> {
  const css = readGlobalCss();
  const selector = theme === 'light' ? ':root' : 'html\\[data-theme="dark"\\]';
  const block = css.match(new RegExp(`${selector} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(block, `global.css must declare a ${theme} theme block`);

  const tokens: Record<string, string> = {};
  for (const line of block![1].split('\n')) {
    const declaration = line.match(/^\s*(--[a-z0-9-]+):\s*([^;]+);/i);
    if (declaration) tokens[declaration[1]] = declaration[2].trim();
  }
  return tokens;
}

/** Alpha-composites `rgba(r, g, b, a)` over an opaque hex backdrop. */
function compositeOver(color: string, backdrop: string): string {
  const rgba = color.match(/^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/);
  if (!rgba) return color;

  const alpha = Number(rgba[4]);
  const base = backdrop.replace(/^#/, '');
  const out = [0, 1, 2].map((i) => {
    const fg = Number(rgba[i + 1]);
    const bg = parseInt(base.slice(i * 2, i * 2 + 2), 16);
    return Math.round(alpha * fg + (1 - alpha) * bg);
  });
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Resolves a background token to an opaque hex value over a page backdrop. */
function resolveBackground(
  tokens: Record<string, string>,
  token: string,
  backdropToken: string,
): string {
  const backdrop = tokens[backdropToken];
  assert.ok(backdrop, `missing backdrop token ${backdropToken}`);
  const value = tokens[token];
  assert.ok(value, `missing background token ${token}`);
  return compositeOver(value, backdrop);
}

/** Returns the declaration body of a CSS rule so token wiring can be asserted. */
function readRule(selector: string, css: string = readGlobalCss()): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(rule, `CSS rule for "${selector}" must exist`);
  return rule![1];
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

// ─── A10+. Complete AA text-contrast coverage ───────────────────────

test('A10: both themes define the dedicated accessible text tokens', () => {
  const expected = {
    light: {
      '--cp-success-text': '#147337',
      '--cp-danger-text': '#b91c1c',
      '--cp-accent-text': '#b11f4b',
      '--cp-muted-text': '#5c5c5c',
    },
    dark: {
      '--cp-success-text': '#4ade80',
      '--cp-danger-text': '#fca5a5',
      '--cp-accent-text': '#ffb3c1',
      '--cp-muted-text': '#b0b0b0',
    },
  };

  for (const theme of ['light', 'dark'] as const) {
    const tokens = readThemeTokens(theme);
    for (const [token, value] of Object.entries(expected[theme])) {
      assert.equal(tokens[token], value, `${theme} ${token} must be ${value}`);
    }
  }

  // The no-JS dark fallback must carry the same accessible tokens.
  const css = readGlobalCss();
  const fallback = css.match(/html:not\(\[data-theme\]\) \{([\s\S]*?)\n  \}/);
  assert.ok(fallback, 'the prefers-color-scheme dark fallback block must exist');
  for (const [token, value] of Object.entries(expected.dark)) {
    assert.match(
      fallback![1],
      new RegExp(`${token}:\\s*${value}`),
      `the no-JS dark fallback must define ${token}: ${value}`,
    );
  }
});

test('A11: original Clawpilot source tokens are preserved for decorative use', () => {
  const light = readThemeTokens('light');
  const dark = readThemeTokens('dark');

  assert.equal(light['--cp-success'], '#16a34a');
  assert.equal(light['--cp-danger'], '#dc2626');
  assert.equal(light['--cp-accent'], '#b11f4b');
  assert.equal(light['--cp-text-muted'], '#5c5c5c');
  assert.equal(dark['--cp-success'], '#4ade80');
  assert.equal(dark['--cp-danger'], '#f87171');
  assert.equal(dark['--cp-accent'], '#fd8ea1');
  assert.equal(dark['--cp-text-muted'], '#919191');

  // Decorative border/background use of the source tokens stays untouched.
  assert.match(readRule('.badge--pending'), /border:\s*1px solid var\(--cp-warning\)/);
});

test('A12: badge, warning and version text use the accessible text tokens', () => {
  assert.match(readRule('.badge--synced'), /color:\s*var\(--cp-success-text\)/);
  assert.match(readRule('.badge--restricted'), /color:\s*var\(--cp-danger-text\)/);
  assert.match(readRule('.badge--version'), /color:\s*var\(--cp-accent-text\)/);
  assert.match(readRule('.badge--frozen'), /color:\s*var\(--cp-muted-text\)/);
});

test('A13: small muted text surfaces use --cp-muted-text everywhere', () => {
  for (const selector of [
    '.nav-links a',
    '.card-meta',
    '.breadcrumbs',
    '.detail-meta',
    '.timeline-kind',
    '.source-meta',
    '.status-stat .stat-label',
    '.site-footer',
    '.install-copy-btn',
  ]) {
    assert.match(
      readRule(selector),
      /color:\s*var\(--cp-muted-text\)/,
      `${selector} must use the accessible muted text token`,
    );
  }

  const searchCss = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'Search.astro'), 'utf8');
  for (const selector of ['.search-status', '.search-input::placeholder']) {
    assert.match(
      readRule(selector, searchCss),
      /color:\s*var\(--cp-muted-text\)/,
      `${selector} must use the accessible muted text token`,
    );
  }

  // No shipped source may still paint text with the low-contrast source token.
  const shippedFiles = [
    globalCssPath,
    path.join(siteRoot, 'src', 'components', 'Search.astro'),
    path.join(siteRoot, 'src', 'components', 'InstallCommand.astro'),
    path.join(siteRoot, 'src', 'layouts', 'Layout.astro'),
    path.join(siteRoot, 'src', 'components', 'pages', 'HomePage.astro'),
    path.join(siteRoot, 'src', 'components', 'pages', 'StatusPage.astro'),
    path.join(siteRoot, 'src', 'components', 'pages', 'SourcePage.astro'),
    path.join(siteRoot, 'src', 'components', 'pages', 'SkillPage.astro'),
  ];
  for (const file of shippedFiles) {
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      content,
      /color:\s*var\(--cp-text-muted\)/,
      `${path.basename(file)} must not paint text with --cp-text-muted`,
    );
  }
});

test('A14: every normal-text surface meets AA (>=4.5:1) in both themes', () => {
  /**
   * fg/bg are token names; `bg` is alpha-composited over each page backdrop so
   * translucent badge tints are measured as they actually render.
   */
  const cases = [
    { label: 'body text', fg: '--cp-text', bg: '--cp-bg' },
    { label: 'body text on surface', fg: '--cp-text', bg: '--cp-surface' },
    { label: 'body text on soft surface', fg: '--cp-text', bg: '--cp-surface-soft' },
    { label: 'info-box body', fg: '--cp-text', bg: '--cp-accent-soft' },
    { label: 'search mark', fg: '--cp-text', bg: '--cp-highlight' },
    { label: 'link', fg: '--cp-link-text', bg: '--cp-bg' },
    { label: 'link on surface', fg: '--cp-link-text', bg: '--cp-surface' },
    { label: 'link on hovered row (badge--local)', fg: '--cp-link-text', bg: '--cp-surface-soft' },
    { label: 'muted text', fg: '--cp-muted-text', bg: '--cp-bg' },
    { label: 'muted text on surface', fg: '--cp-muted-text', bg: '--cp-surface' },
    { label: 'muted text on hovered row (badge--frozen)', fg: '--cp-muted-text', bg: '--cp-surface-soft' },
    { label: 'soft text (card description, excerpt)', fg: '--cp-text-soft', bg: '--cp-bg' },
    { label: 'soft text on surface', fg: '--cp-text-soft', bg: '--cp-surface' },
    { label: 'badge--version', fg: '--cp-accent-text', bg: '--cp-accent-soft' },
    { label: 'badge--synced', fg: '--cp-success-text', bg: '--cp-accent-soft' },
    { label: 'badge--restricted / warning strong', fg: '--cp-danger-text', bg: '--cp-highlight' },
    { label: 'badge--pending', fg: '--cp-warning-text', bg: '--cp-highlight' },
    { label: 'pending note', fg: '--cp-warning-text', bg: '--cp-surface-soft' },
  ];

  const failures: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    const tokens = readThemeTokens(theme);
    for (const backdrop of ['--cp-bg', '--cp-surface', '--cp-surface-soft']) {
      for (const testCase of cases) {
        const fg = tokens[testCase.fg];
        assert.ok(fg, `missing ${theme} token ${testCase.fg}`);
        const bg = resolveBackground(tokens, testCase.bg, backdrop);
        const ratio = contrastRatio(fg, bg);
        if (ratio < 4.5) {
          failures.push(
            `${theme}: ${testCase.label} (${testCase.fg} ${fg} on ${testCase.bg} over ${backdrop} = ${bg}) = ${ratio.toFixed(2)}:1`,
          );
        }
      }
    }
  }

  assert.deepEqual(failures, [], `WCAG AA failures:\n${failures.join('\n')}`);
});

test('A15: hover backdrops use opaque tokens to prevent composite stacking', () => {
  assert.match(
    readRule('.skill-table tr:hover'),
    /background:\s*var\(--cp-hover-surface\)/,
    'table row hover must use the opaque --cp-hover-surface token',
  );

  assert.match(
    readRule('.badge--local'),
    /background:\s*var\(--cp-surface-soft\)/,
    'badge--local text is a link colour and needs an opaque backdrop for AA',
  );
});

// ─── B. Accurate UI Content and Navigation ──────────────────────────

test('B1: status page does not contain stale Pagefind/search limitation', () => {
  const status = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'pages', 'StatusPage.astro'), 'utf8');
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
    path.join(siteRoot, 'src', 'components', 'pages', 'SkillPage.astro'),
    'utf8',
  );
  const sourcePage = fs.readFileSync(
    path.join(siteRoot, 'src', 'components', 'pages', 'SourcePage.astro'),
    'utf8',
  );
  assert.match(skillPage, /aria-hidden="true"/, 'Skill page breadcrumb separators need aria-hidden');
  assert.match(sourcePage, /aria-hidden="true"/, 'Source page breadcrumb separators need aria-hidden');
});

test('B6: landing page stats include restricted count explicitly', () => {
  const index = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'pages', 'HomePage.astro'), 'utf8');
  // The restricted count is now sourced from computeStatusPartition() so the
  // headline stats form a true partition (see status-partition.test.ts); it is
  // still rendered explicitly.
  assert.match(index, /partition\.restricted/, 'Landing page must display the restricted count');
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
  assert.match(search, /'searchRequiresJs'/, 'noscript must use the localized JavaScript requirement message');
});

test('C4: no-JS dark theme CSS fallback for html:not([data-theme])', () => {
  const css = fs.readFileSync(path.join(siteRoot, 'src', 'styles', 'global.css'), 'utf8');
  assert.match(css, /prefers-color-scheme:\s*dark/, 'Must have prefers-color-scheme: dark');
  assert.match(css, /html:not\(\[data-theme\]\)/, 'Must target html:not([data-theme]) for no-JS fallback');
});

test('C5: search JS toggles individual card visibility, not a separate list', () => {
  const search = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'Search.astro'), 'utf8');
  // The unified search hides non-matching existing cards instead of building a
  // second result list or hiding the whole catalog section.
  assert.match(search, /card\.hidden|\[data-skill-card\]/, 'Search JS must control individual card visibility');
  assert.doesNotMatch(search, /search-result-list/, 'the separate runtime result list must not exist');
});

test('C6: search renders all results, not sliced to 20', () => {
  const search = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'Search.astro'), 'utf8');
  assert.doesNotMatch(search, /slice\(0,\s*20\)/, 'Must not slice results to 20');
});

// ─── D. Catalog Cards ──────────────────────────────────────────────

test('D1: card link is a block link filling card area', () => {
  const index = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'pages', 'HomePage.astro'), 'utf8');
  // The card should have a block link containing title, meta, and description
  const css = fs.readFileSync(path.join(siteRoot, 'src', 'styles', 'global.css'), 'utf8');
  assert.match(css, /\.card\s+a|\.card-link/, 'Must have card link styling for block hit area');
});

test('D2: card renders description for non-restricted skills', () => {
  const index = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'pages', 'HomePage.astro'), 'utf8');
  assert.match(index, /card-description|description/i, 'Card must show description');
  assert.match(index, /loadSkillBody/, 'Must use loadSkillBody for descriptions');
});

test('D3: restricted skills have no body description on cards', () => {
  const index = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'pages', 'HomePage.astro'), 'utf8');
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
    path.join(siteRoot, 'src', 'components', 'pages', 'SkillPage.astro'),
    'utf8',
  );
  assert.match(detail, /import.*InstallCommand/, 'Skill detail page must import InstallCommand');
  assert.match(detail, /<InstallCommand/, 'Skill detail page must render InstallCommand');
});

test('E7: source page uses InstallCommand component', () => {
  const source = fs.readFileSync(
    path.join(siteRoot, 'src', 'components', 'pages', 'SourcePage.astro'),
    'utf8',
  );
  assert.match(source, /import.*InstallCommand/, 'Source page must import InstallCommand');
  assert.match(source, /<InstallCommand/, 'Source page must render InstallCommand');
});

test('E8: install page uses InstallCommand component and index does not', () => {
  const install = fs.readFileSync(
    path.join(siteRoot, 'src', 'components', 'pages', 'InstallPage.astro'),
    'utf8',
  );
  assert.match(install, /import.*InstallCommand/, 'Install page must import InstallCommand');
  assert.match(install, /<InstallCommand/, 'Install page must render InstallCommand');

  const index = fs.readFileSync(
    path.join(siteRoot, 'src', 'components', 'pages', 'HomePage.astro'),
    'utf8',
  );
  assert.doesNotMatch(index, /<InstallCommand/, 'Index page must not render InstallCommand');
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
  const doSearchStart = search.indexOf('async function doSearch');

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

  // doSearch must invoke the unavailable-state renderer inside its
  // generation-guarded catch path; the message text itself may live in a
  // side-effect-free formatting helper.
  const unavailableIdx = search.indexOf('announceUnavailable(', doSearchStart);
  assert.ok(
    unavailableIdx > doSearchStart,
    'Load-unavailable UI must be handled inside doSearch, not loadPagefind',
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
    path.join(distDir, 'en', 'skills', 'azure', 'az-cost-optimize', 'index.html'),
    'utf8',
  );
  assert.match(html, /copy|Copy/i, 'Built page must have copy button');
});

test('INT2: removed proprietary page is not built', {
  skip: !distExists && 'dist/ not found',
}, () => {
  assert.equal(
    fs.existsSync(path.join(distDir, 'en', 'skills', 'claude', 'docx', 'index.html')),
    false,
  );
});

test('INT3: built status page has no stale search limitation', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(path.join(distDir, 'en', 'status', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /Search\/filter functionality is planned/, 'Status must not have stale limitation');
});

test('INT4: built index page has favicon link', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(path.join(distDir, 'en', 'index.html'), 'utf8');
  assert.match(html, /favicon\.svg/, 'Index must reference favicon');
});

test('INT5: built index page has noscript element', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(path.join(distDir, 'en', 'index.html'), 'utf8');
  assert.match(html, /<noscript/, 'Index must have noscript element');
});

test('INT6: built skill page breadcrumb separators have aria-hidden', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(
    path.join(distDir, 'en', 'skills', 'azure', 'az-cost-optimize', 'index.html'),
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
  const html = fs.readFileSync(path.join(distDir, 'en', 'index.html'), 'utf8');
  assert.match(html, /card-description/, 'Index must have card descriptions');
});

// ─── H. Full-repo install command ───────────────────────────────────

/** The full-registry section of the install page, from its heading to its closing tag. */
function readInstallSection(): string {
  const install = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'pages', 'InstallPage.astro'), 'utf8');
  const start = install.indexOf('<InstallCommand');
  assert.ok(start !== -1, 'install.astro must render an InstallCommand');
  return install;
}

test('H1: the full-repo install command is kept as a supported path', () => {
  const section = readInstallSection();
  assert.match(section, /<InstallCommand command=\{repoCmd\}/, 'repo-level command must stay on the install page');
});

test('INT8: built install page publishes the full-repo install command without a restricted disclosure', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(path.join(distDir, 'en', 'install', 'index.html'), 'utf8');

  assert.ok(
    html.includes(`npx skills add lettucebo/Skills#v${RELEASE_VERSION}`),
    'the full-repo install command must still be published',
  );
  // The restricted licensing disclosure was intentionally removed; guard that it
  // does not creep back onto the install page.
  assert.doesNotMatch(html, /warning-box/, 'the install page must not render a warning box');
  assert.doesNotMatch(
    html,
    /includes\s+\d+\s+restricted skill/,
    'the removed restricted disclosure must not reappear',
  );
  assert.doesNotMatch(
    html,
    /proprietary, non-redistributable skill/,
    'the removed non-redistributable disclosure must not reappear',
  );
});

test('INT8b: built landing page no longer publishes the full-repo install command', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(path.join(distDir, 'en', 'index.html'), 'utf8');
  assert.doesNotMatch(
    html,
    /npx skills add lettucebo\/Skills#v/,
    'the landing page must delegate install commands to the install page',
  );
  assert.match(html, /href="\/Skills\/en\/install\/"/, 'the landing page must link to the localized install page');
});

test('INT9: built claude source page publishes a bulk install command after removal', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(path.join(distDir, 'en', 'sources', 'claude', 'index.html'), 'utf8');
  assert.ok(
    html.includes(`npx skills add lettucebo/Skills/skills/claude#v${RELEASE_VERSION}`),
    'claude must offer a bulk install command after restricted mirrors are removed',
  );
  assert.match(
    html,
    /install-block/,
    'claude source page must render an install block',
  );
  assert.match(
    html,
    /install-copy-btn/,
    'claude source page must render an install copy button',
  );
});

test('INT10: built source page for a clean source keeps its bulk install command', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(path.join(distDir, 'en', 'sources', 'azure', 'index.html'), 'utf8');
  assert.ok(
    html.includes(`npx skills add lettucebo/Skills/skills/azure#v${RELEASE_VERSION}`),
    'sources without restricted skills must keep their bulk install command',
  );
});

// ─── I. Real baseline verification reporting ────────────────────────

test('I1: status page computes verified baselines instead of restating the mapped count', () => {
  const status = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'pages', 'StatusPage.astro'), 'utf8');

  assert.doesNotMatch(
    status,
    /\{counts\.mapped\}\/\{counts\.mapped\}/,
    'the verified ratio must not be a tautology built from the mapped count',
  );
  assert.match(
    status,
    /computeBaselineVerification/,
    'the status page must compute baseline verification from the lock',
  );
});

test('I2: status page renders the summary sentence from the computed verification', () => {
  const status = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'pages', 'StatusPage.astro'), 'utf8');

  assert.doesNotMatch(
    status,
    /All mapped skills are synced against their upstream repositories with verified content hashes\./,
    'the detail sentence must not be hardcoded to the all-verified case',
  );
  assert.match(
    status,
    /baselineDetail/,
    'the detail sentence must come from the computed verification',
  );
});

test('I3: status page lists restricted skills derived from the lock', () => {
  const status = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'pages', 'StatusPage.astro'), 'utf8');

  assert.doesNotMatch(status, /RESTRICTED_PATHS/, 'the hardcoded restricted set must be gone');
  assert.match(
    status,
    /getRestrictedSkills|getRestrictedPaths/,
    'the restricted listing must derive from the lock-backed view models',
  );
});

test('INT11: built status page reports the real verified/mapped ratio', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(path.join(distDir, 'en', 'status', 'index.html'), 'utf8');
  const lock = JSON.parse(
    fs.readFileSync(path.resolve(siteRoot, '..', 'catalog', 'skills.lock.json'), 'utf8'),
  );
  const mapped = lock.skills.filter((s: { category: string }) => s.category === 'mapped');
  const verified = mapped.filter((s: { baseline: string | null }) => s.baseline === 'verified');

  assert.match(
    html,
    new RegExp(`${verified.length}\\s*/\\s*${mapped.length}</strong>\\s*mapped skills have verified baselines`),
    'the status page must report the computed verified ratio',
  );
});

test('INT12: built status page omits an empty restricted inventory section', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = fs.readFileSync(path.join(distDir, 'en', 'status', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /Restricted Skills \(/);
  assert.doesNotMatch(html, /skills\/claude\/(?:docx|pdf|pptx|xlsx)/);
});

// ─── J. Links inside tinted info boxes ──────────────────────────────

test('J2: info-box links use --cp-accent-text with persistent underline', () => {
  const rule = readRule('.info-box a');
  assert.match(rule, /color:\s*var\(--cp-accent-text\)/, '.info-box a must use --cp-accent-text');
  assert.match(rule, /text-decoration:\s*underline/, '.info-box a must have persistent underline');
});

test('J4: info-box link text meets AA on accent-soft over both backdrops', () => {
  const failures: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    const tokens = readThemeTokens(theme);
    const fg = tokens['--cp-accent-text'];
    assert.ok(fg, `missing ${theme} --cp-accent-text`);
    for (const backdrop of ['--cp-bg', '--cp-surface'] as const) {
      const bg = resolveBackground(tokens, '--cp-accent-soft', backdrop);
      const ratio = contrastRatio(fg, bg);
      if (ratio < 4.5) {
        failures.push(`${theme}: --cp-accent-text (${fg}) on --cp-accent-soft over ${backdrop} (${bg}) = ${ratio.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(failures, [], `WCAG AA failures:\n${failures.join('\n')}`);
});

// ─── K. Opaque hover/badge tokens and perceptible hover ─────────────

test('K1: both themes define opaque badge and hover surface tokens', () => {
  const expected = {
    light: {
      '--cp-badge-soft-bg': '#f9edf1',
      '--cp-badge-highlight-bg': '#f6e4e9',
      '--cp-hover-surface': '#e6e1da',
    },
    dark: {
      '--cp-badge-soft-bg': '#47373a',
      '--cp-badge-highlight-bg': '#423537',
      '--cp-hover-surface': '#494546',
    },
  };
  for (const theme of ['light', 'dark'] as const) {
    const tokens = readThemeTokens(theme);
    for (const [token, value] of Object.entries(expected[theme])) {
      assert.equal(tokens[token], value, `${theme} ${token} must be ${value}`);
    }
  }
});

test('K2: no-JS dark fallback includes opaque badge and hover surface tokens', () => {
  const css = readGlobalCss();
  const fallback = css.match(/html:not\(\[data-theme\]\) \{([\s\S]*?)\n  \}/);
  assert.ok(fallback, 'the prefers-color-scheme dark fallback block must exist');
  const expected = {
    '--cp-badge-soft-bg': '#47373a',
    '--cp-badge-highlight-bg': '#423537',
    '--cp-hover-surface': '#494546',
  };
  for (const [token, value] of Object.entries(expected)) {
    assert.match(
      fallback![1],
      new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*${value}`),
      `the no-JS dark fallback must define ${token}: ${value}`,
    );
  }
});

test('K3: badge--version and badge--synced use --cp-badge-soft-bg', () => {
  assert.match(readRule('.badge--version'), /background:\s*var\(--cp-badge-soft-bg\)/);
  assert.match(readRule('.badge--synced'), /background:\s*var\(--cp-badge-soft-bg\)/);
});

test('K4: badge--pending and badge--restricted use --cp-badge-highlight-bg', () => {
  assert.match(readRule('.badge--pending'), /background:\s*var\(--cp-badge-highlight-bg\)/);
  assert.match(readRule('.badge--restricted'), /background:\s*var\(--cp-badge-highlight-bg\)/);
});

test('K5: skill-table tr:hover uses --cp-hover-surface', () => {
  assert.match(
    readRule('.skill-table tr:hover'),
    /background:\s*var\(--cp-hover-surface\)/,
  );
});

test('K6: search-input focus uses the accent outline token', () => {
  const searchCss = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'Search.astro'), 'utf8');
  assert.match(
    readRule('.search-input:focus', searchCss),
    /outline:\s*2px solid var\(--cp-accent\)/,
    'the search input focus ring must use the accent token',
  );
});

test('K7: table row hover has a distinct accent inset indicator', () => {
  const css = readGlobalCss();
  // Table row hover: indicator lives on td:first-child (border-left-color) because
  // inset box-shadow on <tr> is unreliable in Firefox with border-collapse: collapse.
  const tdFirst = readRule('.skill-table tr:hover td:first-child', css);
  assert.match(
    tdFirst,
    /border-left-color:\s*var\(--cp-accent\)/,
    'table row hover must set border-left-color: var(--cp-accent) on td:first-child',
  );
});

test('K8: catalog card hover keeps AA text contrast on the surface', () => {
  const css = readGlobalCss();
  // Cards are Astro-rendered and keep their normal --cp-text/--cp-surface colours
  // on hover (only border/box-shadow change), so no colour override is required.
  assert.match(
    readRule('.card:hover', css),
    /border-color:\s*var\(--cp-accent\)/,
    'card hover must surface an accent border indicator',
  );
});

test('K9: normal text on opaque badge backgrounds meets AA (>=4.5:1)', () => {
  const failures: string[] = [];
  const cases = [
    { label: 'badge--version text', fg: '--cp-accent-text', bg: '--cp-badge-soft-bg' },
    { label: 'badge--synced text', fg: '--cp-success-text', bg: '--cp-badge-soft-bg' },
    { label: 'badge--pending text', fg: '--cp-warning-text', bg: '--cp-badge-highlight-bg' },
    { label: 'badge--restricted text', fg: '--cp-danger-text', bg: '--cp-badge-highlight-bg' },
  ];
  for (const theme of ['light', 'dark'] as const) {
    const tokens = readThemeTokens(theme);
    for (const testCase of cases) {
      const fg = tokens[testCase.fg];
      const bg = tokens[testCase.bg];
      assert.ok(fg, `missing ${theme} token ${testCase.fg}`);
      assert.ok(bg, `missing ${theme} token ${testCase.bg}`);
      const ratio = contrastRatio(fg, bg);
      if (ratio < 4.5) {
        failures.push(`${theme}: ${testCase.label} (${testCase.fg}=${fg} on ${testCase.bg}=${bg}) = ${ratio.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(failures, [], `WCAG AA failures on opaque badge bgs:\n${failures.join('\n')}`);
});

test('K10: normal text on hover surface meets AA (>=4.5:1)', () => {
  const failures: string[] = [];
  // Only --cp-text is tested because muted/soft text is overridden to --cp-text
  // on hover (K8), and links have persistent underline as non-color affordance.
  for (const theme of ['light', 'dark'] as const) {
    const tokens = readThemeTokens(theme);
    const bg = tokens['--cp-hover-surface'];
    assert.ok(bg, `missing ${theme} --cp-hover-surface`);
    const fg = tokens['--cp-text'];
    assert.ok(fg, `missing ${theme} --cp-text`);
    const ratio = contrastRatio(fg, bg);
    if (ratio < 4.5) {
      failures.push(`${theme}: --cp-text=${fg} on --cp-hover-surface=${bg} = ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failures, [], `WCAG AA failures on hover surface:\n${failures.join('\n')}`);
});

test('K11: focus-visible is preserved on the search input', () => {
  const searchCss = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'Search.astro'), 'utf8');
  assert.match(
    readRule('.search-input:focus', searchCss),
    /outline:\s*2px solid var\(--cp-accent\)/,
    'the search input focus ring must be preserved',
  );
});

test('K12: reduced-motion applies to the search input', () => {
  const searchCss = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'Search.astro'), 'utf8');
  assert.match(searchCss, /prefers-reduced-motion/, 'must have reduced-motion media query');
  assert.match(searchCss, /search-input/, 'reduced-motion must cover search-input');
});

test('K13: forced-colors covers hover indicators', () => {
  const css = readGlobalCss();
  assert.match(css, /forced-colors:\s*active/, 'must have forced-colors: active');
  // The hover indicator (box-shadow or border) must adapt in forced-colors mode
  assert.match(css, /\.skill-table tr:hover|tr:hover/, 'forced-colors block must address hover');
});

// ─── K14–K17: Hovered/focused row link contrast fix ──────────────────

test('K14: --cp-link-text on --cp-hover-surface fails AA — defect evidence', () => {
  // Documents that default link text (#0067b8 light / #5aafff dark) measured
  // against the hover surface falls below 4.5:1. The fix overrides to --cp-text
  // inside hover/focus-within rows (K15).
  const checks = [
    { theme: 'light', fg: '#0067b8', bg: '#e6e1da' },
    { theme: 'dark',  fg: '#5aafff', bg: '#494546' },
  ] as const;
  for (const { theme, fg, bg } of checks) {
    const ratio = contrastRatio(fg, bg);
    assert.ok(
      ratio < 4.5,
      `${theme}: --cp-link-text (${fg}) on --cp-hover-surface (${bg}) = ${ratio.toFixed(2)}:1; expected < 4.5 to confirm defect`,
    );
  }
});

test('K15: skill-table hover/focus-within links use --cp-text with persistent underline', () => {
  const css = readGlobalCss();
  const hoverA = readRule('.skill-table tr:hover a', css);
  assert.match(hoverA, /color:\s*var\(--cp-text\)/, '.skill-table tr:hover a must use --cp-text');
  assert.match(hoverA, /text-decoration:\s*underline/, '.skill-table tr:hover a must have persistent underline');
  const focusA = readRule('.skill-table tr:focus-within a', css);
  assert.match(focusA, /color:\s*var\(--cp-text\)/, '.skill-table tr:focus-within a must use --cp-text');
  assert.match(focusA, /text-decoration:\s*underline/, '.skill-table tr:focus-within a must have persistent underline');
});

test('K16: skill-table tr:focus-within gets same hover surface and accent indicator', () => {
  const css = readGlobalCss();
  const focusRow = readRule('.skill-table tr:focus-within', css);
  assert.match(
    focusRow,
    /background:\s*var\(--cp-hover-surface\)/,
    '.skill-table tr:focus-within must use --cp-hover-surface',
  );
  // Indicator lives on td:first-child (border-left-color) not on tr (box-shadow).
  assert.match(
    readRule('.skill-table tr:focus-within td:first-child', css),
    /border-left-color:\s*var\(--cp-accent\)/,
    '.skill-table tr:focus-within td:first-child must have border-left-color: var(--cp-accent)',
  );
});

test('K17: forced-colors block covers tr:focus-within alongside tr:hover', () => {
  const css = readGlobalCss();
  const forcedSection = css.slice(css.indexOf('@media (forced-colors: active)'));
  assert.ok(forcedSection.length > 0, 'forced-colors block must exist');
  assert.match(forcedSection, /tr:focus-within/, 'forced-colors block must cover tr:focus-within');
});

// ─── K18–K19: Cross-browser table hover indicator ─────────────────

test('K18: skill-table cross-browser indicator: tr:hover must not use box-shadow under border-collapse; td:first-child must carry the accent border-left-color', () => {
  const css = readGlobalCss();
  // Under border-collapse: collapse, inset box-shadow on <tr> is not reliably
  // rendered in Firefox. The indicator must use border-left-color on td:first-child.
  const trHover = readRule('.skill-table tr:hover', css);
  assert.doesNotMatch(
    trHover,
    /box-shadow:/,
    '.skill-table tr:hover must not use box-shadow (unreliable in Firefox with border-collapse: collapse)',
  );
  const tdHover = readRule('.skill-table tr:hover td:first-child', css);
  assert.match(
    tdHover,
    /border-left-color:\s*var\(--cp-accent\)/,
    '.skill-table tr:hover td:first-child must use border-left-color: var(--cp-accent)',
  );
  const tdFocus = readRule('.skill-table tr:focus-within td:first-child', css);
  assert.match(
    tdFocus,
    /border-left-color:\s*var\(--cp-accent\)/,
    '.skill-table tr:focus-within td:first-child must use border-left-color: var(--cp-accent)',
  );
});

test('K19: skill-table first-column cells reserve 3px left border in rest state to prevent layout shift on hover', () => {
  const css = readGlobalCss();
  // A 3px transparent border is pre-allocated so that activating the accent
  // indicator on hover/focus only changes color, never width — no layout shift.
  assert.match(
    readRule('.skill-table th:first-child', css),
    /border-left:\s*3px solid transparent/,
    '.skill-table th:first-child must reserve 3px transparent left border in rest state',
  );
  assert.match(
    readRule('.skill-table td:first-child', css),
    /border-left:\s*3px solid transparent/,
    '.skill-table td:first-child must reserve 3px transparent left border in rest state',
  );
});

// ─── C8: noscript filter-controls specificity (Defect #4) ────────────

test('C8: noscript .filter-controls rule must override Astro-scoped display:flex via !important', () => {
  const search = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'Search.astro'), 'utf8');
  // Astro scoped CSS emits .filter-controls[data-astro-cid-*]{display:flex} (specificity 0,2,0).
  // The noscript <style> rule .filter-controls{display:none} has specificity 0,1,0 — it loses.
  // Using !important is the minimal, reliable override for a no-JS fallback stylesheet.
  const noscriptContent = search.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? '';
  assert.match(
    noscriptContent,
    /\.filter-controls\s*\{[^}]*display:\s*none\s*!important/,
    'noscript must use "display: none !important" for .filter-controls to win over Astro-scoped specificity',
  );
});

// ─── E10: install-block mobile overflow (Defect #5) ─────────────────

test('E10: global.css mobile breakpoint addresses .install-block code overflow at 375px', () => {
  const css = fs.readFileSync(path.join(siteRoot, 'src', 'styles', 'global.css'), 'utf8');
  // .install-block code { white-space: nowrap } causes document scrollWidth > clientWidth
  // at 375px viewport. The max-width:640px media query must override this.
  const mobileStart = css.indexOf('@media (max-width: 640px)');
  assert.ok(mobileStart !== -1, 'global.css must have @media (max-width: 640px)');
  const afterMobile = css.slice(mobileStart);
  assert.match(
    afterMobile,
    /\.install-block\s+code|install-block[\s\S]{0,300}\.install-block\s+code/,
    '@media (max-width: 640px) must include a .install-block code rule to prevent horizontal overflow at 375px',
  );
});

// ─── E11: nav-links must flex-wrap to prevent overflow at 375px ───────────────

test('E11: .nav-links in global.css has flex-wrap: wrap to prevent overflow at 375px', () => {
  const css = fs.readFileSync(path.join(siteRoot, 'src', 'styles', 'global.css'), 'utf8');
  // The Sources section on the homepage renders a <ul class="nav-links"> with up to
  // 11 source names. Without flex-wrap the items form a single flex row that extends
  // far beyond the 375 px viewport (measured: scrollWidth=714px at clientWidth=360px).
  // flex-wrap: wrap allows items to reflow without overflow.
  assert.match(
    readRule('.nav-links', css),
    /flex-wrap:\s*wrap/,
    '.nav-links must declare flex-wrap: wrap to prevent horizontal overflow at 375px',
  );
});
