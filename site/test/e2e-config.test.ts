/**
 * Structural tests for E2E (Playwright) setup.
 * These verify that package.json, playwright.config.ts, and e2e spec files
 * are correctly configured before running the live browser tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');

// ─── P1: @playwright/test devDependency ──────────────────────────────

test('P1: @playwright/test is in devDependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(siteRoot, 'package.json'), 'utf8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(
    allDeps['@playwright/test'],
    '@playwright/test must be in dependencies or devDependencies',
  );
});

// ─── P2: test:e2e script ─────────────────────────────────────────────

test('P2: test:e2e script exists and runs build before playwright', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(siteRoot, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['test:e2e'], 'test:e2e script must exist in package.json');
  // Must run build (which includes postbuild/pagefind) before playwright
  assert.match(
    pkg.scripts['test:e2e'],
    /build/,
    'test:e2e must invoke build (including postbuild/pagefind) before playwright runs',
  );
  assert.match(
    pkg.scripts['test:e2e'],
    /playwright/,
    'test:e2e must invoke playwright test runner',
  );
});

test('P2b: test:e2e build step precedes playwright invocation', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(siteRoot, 'package.json'), 'utf8'));
  const script = pkg.scripts['test:e2e'];
  assert.ok(script, 'test:e2e script must exist');
  const buildIdx = script.indexOf('build');
  const playwrightIdx = script.indexOf('playwright');
  assert.ok(
    buildIdx < playwrightIdx,
    `build must appear before playwright in test:e2e script; got: "${script}"`,
  );
});

// ─── P3: playwright.config.ts ────────────────────────────────────────

test('P3: playwright.config.ts exists in site/', () => {
  assert.ok(
    fs.existsSync(path.join(siteRoot, 'playwright.config.ts')),
    'playwright.config.ts must exist in site/',
  );
});

test('P3b: playwright.config.ts defines a webServer block', () => {
  const config = fs.readFileSync(path.join(siteRoot, 'playwright.config.ts'), 'utf8');
  assert.match(config, /webServer/, 'playwright.config.ts must define webServer');
  assert.match(config, /astro.*preview|preview.*astro/, 'webServer must start astro preview');
  // Must use explicit host binding to avoid IPv6/IPv4 resolution issues
  assert.match(config, /127\.0\.0\.1/, 'webServer must bind to 127.0.0.1 explicitly');
});

test('P3c: playwright.config.ts sets baseURL to the root-based English route', () => {
  const config = fs.readFileSync(path.join(siteRoot, 'playwright.config.ts'), 'utf8');
  assert.match(config, /127\.0\.0\.1:\$\{PORT\}\/en\//, 'baseURL must include the /en/ locale path');
});

test('P3d: playwright.config.ts uses Chrome channel locally and Chromium in CI', () => {
  const config = fs.readFileSync(path.join(siteRoot, 'playwright.config.ts'), 'utf8');
  // Local must use system Chrome channel (no hardcoded user paths)
  assert.match(config, /chrome/, 'config must reference chrome channel for local use');
  // CI or conditional check must also handle Chromium (installed by workflow)
  assert.match(config, /CI|chromium/, 'config must handle CI-specific browser (chromium or CI env check)');
  // No hardcoded user-specific executable paths
  assert.doesNotMatch(
    config,
    /C:\\Users\\|\/home\/[a-z]/,
    'config must not contain hardcoded user-specific executable paths',
  );
});

test('P3e: playwright.config.ts specifies outputDir outside source tree', () => {
  const config = fs.readFileSync(path.join(siteRoot, 'playwright.config.ts'), 'utf8');
  assert.match(config, /outputDir|output/, 'playwright.config.ts must specify an output directory');
});

test('P3f: playwright.config.ts uses the dedicated E2E port 4331 by default', () => {
  const config = fs.readFileSync(path.join(siteRoot, 'playwright.config.ts'), 'utf8');
  // 4321 is Astro's default dev/preview port; reusing it risks binding to an
  // unrelated dev server that serves a different build. 4330 is the documented
  // default of several local proxy/debug tools, so the suite uses 4331.
  assert.doesNotMatch(
    config,
    /\b4321\b/,
    'playwright.config.ts must not use Astro default port 4321 (an unrelated dev server may own it)',
  );
  assert.doesNotMatch(
    config,
    /Number\(process\.env\.E2E_PORT\) \|\| 4330\b/,
    'the E2E default port moved off 4330 to reduce collisions with other local tooling',
  );
  assert.match(config, /\b4331\b/, 'playwright.config.ts must default to the dedicated E2E port 4331');
});

test('P3g: playwright.config.ts allows a port override via environment variable', () => {
  const config = fs.readFileSync(path.join(siteRoot, 'playwright.config.ts'), 'utf8');
  assert.match(
    config,
    /process\.env\.E2E_PORT/,
    'playwright.config.ts must honour an E2E_PORT environment override',
  );
});

test('P3h: playwright.config.ts never reuses an existing web server', () => {
  const config = fs.readFileSync(path.join(siteRoot, 'playwright.config.ts'), 'utf8');
  assert.match(
    config,
    /reuseExistingServer:\s*false/,
    'reuseExistingServer must be false so tests always run against the freshly built dist',
  );
  assert.doesNotMatch(
    config,
    /reuseExistingServer:\s*!isCI/,
    'reuseExistingServer must not depend on CI — a stale local preview would serve a different build',
  );
});

test('P3i: playwright.config.ts serves the built dist via astro preview', () => {
  const config = fs.readFileSync(path.join(siteRoot, 'playwright.config.ts'), 'utf8');
  assert.match(config, /preview/, 'webServer must run astro preview (deterministic dist output)');
  assert.doesNotMatch(
    config,
    /astro(\.cmd)?['"`\s]+dev\b/,
    'webServer must not run the dev server — E2E must test the built dist',
  );
});

// ─── P4: e2e spec files ──────────────────────────────────────────────

test('P4: e2e/ directory exists with spec files', () => {
  const e2eDir = path.join(siteRoot, 'e2e');
  assert.ok(fs.existsSync(e2eDir), 'site/e2e/ directory must exist');
  const specs = fs.readdirSync(e2eDir).filter(f => f.endsWith('.spec.ts'));
  assert.ok(specs.length >= 4, `Must have at least 4 spec files; found: ${specs.join(', ')}`);
});

test('P4b: health spec exists for internal-link checks', () => {
  assert.ok(
    fs.existsSync(path.join(siteRoot, 'e2e', 'health.spec.ts')),
    'site/e2e/health.spec.ts must exist for request-based link health checks',
  );
});

test('P4c: search spec exists for search/filter interactions', () => {
  assert.ok(
    fs.existsSync(path.join(siteRoot, 'e2e', 'search.spec.ts')),
    'site/e2e/search.spec.ts must exist for search/filter interaction tests',
  );
});

test('P4d: restricted spec exists for restricted-skill boundary checks', () => {
  assert.ok(
    fs.existsSync(path.join(siteRoot, 'e2e', 'restricted.spec.ts')),
    'site/e2e/restricted.spec.ts must exist for restricted-skill DOM boundary checks',
  );
});

test('P4e: a11y spec exists for accessibility checks', () => {
  assert.ok(
    fs.existsSync(path.join(siteRoot, 'e2e', 'a11y.spec.ts')),
    'site/e2e/a11y.spec.ts must exist for skip-link, contrast, and responsive checks',
  );
});

// ─── P5: gitignore covers test artifacts ─────────────────────────────
test('P5: .gitignore excludes playwright result/report directories', () => {
  const root = path.resolve(siteRoot, '..');
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  // Check either site-level or repo-level gitignore covers playwright output dirs
  const siteGitignore = fs.existsSync(path.join(siteRoot, '.gitignore'))
    ? fs.readFileSync(path.join(siteRoot, '.gitignore'), 'utf8')
    : '';
  const combined = gitignore + siteGitignore;
  assert.match(
    combined,
    /playwright-results|test-results|playwright-report/,
    '.gitignore must exclude playwright test artifact directories',
  );
});

// ─── P6: spec strength guards ────────────────────────────────────────
//
// These guard against the specific weak-assertion regressions found in the
// D8 review: dead helpers, vacuous "if (count) then assert" passes, fixed
// sleeps instead of settled-state waits, and destination-agnostic
// click-through checks that the homepage would also satisfy.

function readSpec(name: string): string {
  return fs.readFileSync(path.join(siteRoot, 'e2e', name), 'utf8');
}

test('P6a: a11y spec contains no unused nearestOpaqueBg helper', () => {
  const spec = readSpec('a11y.spec.ts');
  assert.doesNotMatch(
    spec,
    /function nearestOpaqueBg|const nearestOpaqueBg/,
    'the page-level nearestOpaqueBg helper was dead code and duplicated contrast logic — remove it',
  );
});

test('P6b: a11y spec proves hidden cards use the hidden attribute and visible cards keep AA contrast', () => {
  const spec = readSpec('a11y.spec.ts');
  assert.match(
    spec,
    /hidden cards use the hidden attribute/,
    'the unified-search a11y test must prove filtered-out cards set the hidden property, not visual-only CSS',
  );
  assert.match(
    spec,
    /--cp-surface/,
    'visible card contrast test must compare the card text against the resolved --cp-surface token',
  );
});

test('P6c: a11y no-JS tests assert exact element counts before hidden', () => {
  const spec = readSpec('a11y.spec.ts');
  for (const selector of ['.search-box', '.filter-controls', '.install-copy-btn']) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      spec,
      new RegExp(`toHaveCount\\(1\\)[\\s\\S]{0,400}?${escaped}|${escaped}[\\s\\S]{0,400}?toHaveCount\\(1\\)`),
      `no-JS test for ${selector} must assert it exists exactly once before asserting it is hidden`,
    );
  }
  assert.doesNotMatch(
    spec,
    /if\s*\(\(await [A-Za-z]+\.count\(\)\)\s*>\s*0\)/,
    'no-JS tests must not use optional "if count > 0" guards that pass vacuously when the element is missing',
  );
});

test('P6d: search spec asserts the settled no-results status message', () => {
  const spec = readSpec('search.spec.ts');
  const helpers = fs.readFileSync(path.join(siteRoot, 'e2e', '_helpers.ts'), 'utf8');
  assert.match(
    helpers,
    /No matching skills found\./,
    'the settled no-results status text must be pinned to what Search.astro renders',
  );
  assert.match(
    spec,
    /NO_RESULTS_STATUS/,
    'no-results test must assert the exact settled status message, not just an empty result list',
  );
});

test('P6e: search spec has no fixed-sleep waits', () => {
  const spec = readSpec('search.spec.ts');
  assert.doesNotMatch(
    spec,
    /waitForTimeout/,
    'search spec must use web-first assertions / settled-state waits instead of fixed timeouts',
  );
});

test('P6f: search click-through asserts a skill detail destination path', () => {
  const spec = readSpec('search.spec.ts');
  assert.match(
    spec,
    /SKILL_DETAIL_PATH_RE/,
    'click-through test must match the destination against a localized skill path',
  );
  assert.match(
    spec,
    /not\.toBe\('\/en\/'\)/,
    'click-through test must explicitly assert the homepage does not satisfy it',
  );
});

test('P6g: search filter tests validate every result row, not just the count', () => {
  const spec = readSpec('search.spec.ts');
  assert.match(
    spec,
    /assertEveryResultMatches/,
    'filter tests must validate metadata of every rendered result against the selected filter values',
  );
});

test('P6h: search spec covers a combined multi-filter case', () => {
  const spec = readSpec('search.spec.ts');
  assert.match(
    spec,
    /combined source \+ license \+ origin/i,
    'search spec must include a combined source+license+origin filter case',
  );
});

test('P6i: generation-guard test compares against a control result set', () => {
  const spec = readSpec('search.spec.ts');
  assert.match(
    spec,
    /disjoint/i,
    'the rapid-input test must assert the two queries have disjoint result sets',
  );
  assert.match(
    spec,
    /finalControl|finalTitles/,
    'the rapid-input test must compare rendered titles against the final query control set',
  );
});

test('P6j: health spec asserts page-specific titles, not a generic "Skills" substring', () => {
  const spec = readSpec('health.spec.ts');
  assert.doesNotMatch(
    spec,
    /toContain\('Skills'\)/,
    'a generic "Skills" substring is satisfied by every page and by the base path — assert real titles',
  );
  assert.match(spec, /Catalog \| Skills Registry/, 'homepage must be identified by its exact <title>');
  assert.match(spec, /Registry Status/, 'status page must be identified by its exact <h1>');
});

test('P6k: health spec covers 404 handling', () => {
  const spec = readSpec('health.spec.ts');
  assert.match(spec, /toBe\(404\)/, 'health spec must assert real 404 responses for unknown paths');
});

test('P6l: removed proprietary route spec asserts 404 and no copy affordance', () => {
  const spec = readSpec('restricted.spec.ts');
  assert.doesNotMatch(
    spec,
    /if \(count > 0\)/,
    'restricted spec must not use an optional guard that passes when the element is absent AND when it is present-but-visible',
  );
  assert.match(
    spec,
    /install-copy-btn'\)\)\.toHaveCount\(0\)/,
    'removed pages must render no copy button at all',
  );
  assert.match(spec, /response\?\.status\(\)\)\.toBe\(404\)/);
});

test('P6m: _helpers.ts carries no dead settled-status helper', () => {
  const helpers = fs.readFileSync(path.join(siteRoot, 'e2e', '_helpers.ts'), 'utf8');
  assert.doesNotMatch(
    helpers,
    /SETTLED_STATUS/,
    'SETTLED_STATUS was only consumed by the unused waitForSettledSearch helper — remove both',
  );
  assert.doesNotMatch(
    helpers,
    /waitForSettledSearch/,
    'waitForSettledSearch is dead code: every spec waits through waitForRenderedResults instead',
  );
});

test('P6n: the fault-injected overlap test proves the two queries announce different counts', () => {
  const spec = readSpec('search.spec.ts');
  const start = spec.indexOf('a slow first search cannot overwrite');
  assert.ok(start > -1, 'the fault-injected overlap test must exist');
  const block = spec.slice(start);

  assert.match(
    block,
    /firstStatus/,
    'the overlap test must capture the first query status so a stale announcement is detectable',
  );
  assert.match(
    block,
    /not\.toBe\(firstStatus\)/,
    'the overlap test waits on the final status text; if both queries announce the same count the ' +
      'wait can be satisfied by the stale render, so the counts must be asserted different',
  );
});
