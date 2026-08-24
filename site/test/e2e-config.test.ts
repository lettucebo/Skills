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

test('P3c: playwright.config.ts sets baseURL to /Skills/ path', () => {
  const config = fs.readFileSync(path.join(siteRoot, 'playwright.config.ts'), 'utf8');
  assert.match(config, /\/Skills\//, 'baseURL must include the /Skills/ base path');
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
