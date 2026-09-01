/**
 * Tests for the build-info module and its rendering in the footer and status
 * page. The module resolves build provenance (time + commit) at build time and
 * must fail soft: never throw, and never let a hostile env var inject markup
 * into the commit URL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const layoutPath = path.resolve(__dirname, '../src/layouts/Layout.astro');
const statusPath = path.resolve(__dirname, '../src/components/pages/StatusPage.astro');
const layoutSource = fs.readFileSync(layoutPath, 'utf-8');
const statusSource = fs.readFileSync(statusPath, 'utf-8');

const modulePath = '../src/lib/build-info.ts';

/**
 * Re-imports build-info.ts with a fresh module registry so each case observes
 * the env vars set for it. Node's ESM loader caches by URL, so a cache-busting
 * query string forces re-evaluation of the module's top-level constants.
 */
async function importFresh() {
  return import(`${modulePath}?t=${Date.now()}-${Math.random()}`);
}

// ─── Rendering: footer ──────────────────────────────────────────────

test('Layout.astro renders a <time datetime> element in the footer', () => {
  assert.match(
    layoutSource,
    /<time datetime=\{BUILD_TIME\}>/,
    'footer must render the build time inside a <time datetime> element',
  );
});

test('Layout.astro footer commit link targets github.com/lettucebo/Skills/commit/', () => {
  // The URL literal lives in build-info.ts; the layout references it by name.
  const buildInfoSource = fs.readFileSync(
    path.resolve(__dirname, '../src/lib/build-info.ts'),
    'utf-8',
  );
  assert.match(
    buildInfoSource,
    /https:\/\/github\.com\/\$\{REPO_OWNER\}\/\$\{REPO_NAME\}\/commit\//,
    'commit URL must point at github.com/<owner>/<repo>/commit/',
  );
  assert.match(
    layoutSource,
    /href=\{BUILD_COMMIT_URL\}/,
    'footer commit link must use BUILD_COMMIT_URL',
  );
  assert.match(layoutSource, /rel="noopener noreferrer"/);
});

test('Layout.astro contains no hardcoded literal date string', () => {
  assert.doesNotMatch(
    layoutSource,
    /\b\d{4}-\d{2}-\d{2}\b/,
    'the build time must come from the module, not a literal date',
  );
});

// ─── Rendering: status page ─────────────────────────────────────────

test('status.astro distinguishes registry sync time from site build time', () => {
  assert.match(statusSource, /'siteBuiltLabel'/, 'status page must localize the site build label');
  assert.match(statusSource, /'registrySynced'/, 'status page must localize the registry sync label');
  assert.match(
    statusSource,
    /datetime=\{BUILD_TIME\}/,
    'status page must render the site build time from the module',
  );
  assert.match(
    statusSource,
    /datetime=\{catalog\.generatedAt\}/,
    'status page must render the registry sync time from the lock file',
  );
});

test('status.astro contains no hardcoded literal date string', () => {
  assert.doesNotMatch(
    statusSource,
    /\b\d{4}-\d{2}-\d{2}\b/,
    'the build/sync times must come from data, not a literal date',
  );
});

// ─── Module: graceful degradation and sanitisation ──────────────────

test('build-info degrades to null when SITE_BUILD_COMMIT is an empty string', async () => {
  const original = process.env.SITE_BUILD_COMMIT;
  process.env.SITE_BUILD_COMMIT = '';
  try {
    const mod = await importFresh();
    assert.equal(mod.BUILD_COMMIT, null);
    assert.equal(mod.BUILD_COMMIT_SHORT, null);
    assert.equal(mod.BUILD_COMMIT_URL, null);
  } finally {
    if (original === undefined) delete process.env.SITE_BUILD_COMMIT;
    else process.env.SITE_BUILD_COMMIT = original;
  }
});

test('build-info rejects a non-SHA SITE_BUILD_COMMIT to null (no injection)', async () => {
  for (const hostile of ['; rm -rf /', 'not-a-sha', '<script>alert(1)</script>', 'abc']) {
    const original = process.env.SITE_BUILD_COMMIT;
    process.env.SITE_BUILD_COMMIT = hostile;
    try {
      const mod = await importFresh();
      assert.equal(mod.BUILD_COMMIT, null, `"${hostile}" must be rejected to null`);
      assert.equal(mod.BUILD_COMMIT_URL, null);
    } finally {
      if (original === undefined) delete process.env.SITE_BUILD_COMMIT;
      else process.env.SITE_BUILD_COMMIT = original;
    }
  }
});

test('build-info rejects abbreviated/oversized SHAs — exact 40 hex only', async () => {
  const full = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const cases = [
    'a1b2c3d', // 7-char short
    full.slice(0, 12), // common abbreviation length
    full.slice(0, 39), // one short of full
    full + 'a', // 41 chars
    `${full}\n${full}`, // two SHAs
  ];
  for (const value of cases) {
    const original = process.env.SITE_BUILD_COMMIT;
    process.env.SITE_BUILD_COMMIT = value;
    try {
      const mod = await importFresh();
      assert.equal(
        mod.BUILD_COMMIT,
        null,
        `abbreviated/invalid SHA ${JSON.stringify(value)} must be rejected (exact 40 hex required)`,
      );
      assert.equal(mod.BUILD_COMMIT_URL, null);
    } finally {
      if (original === undefined) delete process.env.SITE_BUILD_COMMIT;
      else process.env.SITE_BUILD_COMMIT = original;
    }
  }
});

test('build-info accepts a full 40-hex SHA: URL uses 40, display uses first 7', async () => {
  const original = process.env.SITE_BUILD_COMMIT;
  process.env.SITE_BUILD_COMMIT = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678'; // upper-case tolerated
  try {
    const mod = await importFresh();
    assert.equal(mod.BUILD_COMMIT, 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    assert.equal(mod.BUILD_COMMIT_SHORT, 'a1b2c3d');
    assert.equal(
      mod.BUILD_COMMIT_URL,
      'https://github.com/lettucebo/Skills/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    );
  } finally {
    if (original === undefined) delete process.env.SITE_BUILD_COMMIT;
    else process.env.SITE_BUILD_COMMIT = original;
  }
});

// ─── Module: strict build-time validation ───────────────────────────

test('build-info accepts the workflow RFC3339 UTC contract (seconds, optional .sss)', async () => {
  const original = process.env.SITE_BUILD_TIME;
  try {
    process.env.SITE_BUILD_TIME = '2026-08-30T09:35:00Z';
    let mod = await importFresh();
    assert.equal(mod.BUILD_TIME, '2026-08-30T09:35:00.000Z');
    assert.equal(mod.formatUtc(mod.BUILD_TIME), '2026-08-30 09:35 UTC');

    process.env.SITE_BUILD_TIME = '2026-08-30T09:35:21.123Z';
    mod = await importFresh();
    assert.equal(mod.BUILD_TIME, '2026-08-30T09:35:21.123Z');
  } finally {
    if (original === undefined) delete process.env.SITE_BUILD_TIME;
    else process.env.SITE_BUILD_TIME = original;
  }
});

test('build-info rejects permissive/invalid timestamps and falls back to now()', async () => {
  const canonical = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const invalid = [
    'not-a-real-time',
    '2026', // bare year, Date() would accept
    '0', // epoch integer, Date() would accept
    '2026-02-30T09:35:00Z', // impossible calendar date, Date() rolls forward
    '2026-13-01T00:00:00Z', // month 13
    '2026-08-30T09:35:00', // missing Z
    '2026-08-30T09:35:00+02:00', // non-UTC offset
    '2026-08-30T09:35:00.12Z', // two fractional digits, not exactly 3
    '2026-08-30 09:35:00Z', // space instead of T
  ];
  for (const value of invalid) {
    const original = process.env.SITE_BUILD_TIME;
    process.env.SITE_BUILD_TIME = value;
    try {
      const before = Date.now();
      const mod = await importFresh();
      const after = Date.now();
      assert.match(
        mod.BUILD_TIME,
        canonical,
        `invalid ${JSON.stringify(value)} must fall back to a canonical now() ISO string`,
      );
      const fallbackTime = new Date(mod.BUILD_TIME).getTime();
      assert.ok(
        fallbackTime >= before && fallbackTime <= after,
        `invalid ${JSON.stringify(value)} must use the current time, not Date() normalisation`,
      );
    } finally {
      if (original === undefined) delete process.env.SITE_BUILD_TIME;
      else process.env.SITE_BUILD_TIME = original;
    }
  }
});

// ─── Module: git resolution is root-scoped (nested-tarball guard) ────

test('build-info returns null for a no-git tarball nested in an unrelated parent repo', async () => {
  // Simulate a source export (no `.git`) that still ships catalog/skills.lock.json,
  // unpacked inside an unrelated parent git repository. Resolving the commit from
  // git must NOT inherit the parent repo's HEAD.
  const tmpRoot = fs.mkdtempSync(path.join(__dirname, '.tmp-nested-'));
  const parentRepo = path.join(tmpRoot, 'parent-repo');
  const tarball = path.join(parentRepo, 'exported-tree');
  const originalCommit = process.env.SITE_BUILD_COMMIT;
  const originalCwd = process.cwd();
  try {
    fs.mkdirSync(path.join(tarball, 'catalog'), { recursive: true });
    // findRepoRoot only checks existence, but catalog.ts parses `release` on load;
    // a minimal valid lock keeps a first-time module load from throwing.
    fs.writeFileSync(
      path.join(tarball, 'catalog', 'skills.lock.json'),
      JSON.stringify({ release: '0.0.0', generatedAt: '2026-01-01T00:00:00.000Z', counts: {}, skills: [] }),
    );
    // Parent is a real git repo; the tarball dir is NOT.
    execFileSync('git', ['init', '-q'], { cwd: parentRepo });
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-qm',
        'root',
      ],
      { cwd: parentRepo },
    );

    // The git fallback path only runs when SITE_BUILD_COMMIT is unset.
    delete process.env.SITE_BUILD_COMMIT;
    process.chdir(tarball);
    const mod = await importFresh();
    assert.equal(
      mod.BUILD_COMMIT,
      null,
      'a no-git tarball nested in a parent repo must not inherit the parent HEAD',
    );
    assert.equal(mod.BUILD_COMMIT_URL, null);
  } finally {
    process.chdir(originalCwd);
    if (originalCommit === undefined) delete process.env.SITE_BUILD_COMMIT;
    else process.env.SITE_BUILD_COMMIT = originalCommit;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── Built output: footer + status render real build metadata ───────

const distDir = path.resolve(__dirname, '../dist');
const distExists = fs.existsSync(distDir);

function readDist(rel: string): string | null {
  const p = path.join(distDir, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}

function authoritativeBuiltCommit(): string | null {
  const fromEnv = process.env.SITE_BUILD_COMMIT?.trim().toLowerCase();
  if (fromEnv && /^[0-9a-f]{40}$/.test(fromEnv)) return fromEnv;
  return null;
}

function assertCommitAnchor(scope: string, label: string): void {
  const match = scope.match(
    /<a href="https:\/\/github\.com\/lettucebo\/Skills\/commit\/([0-9a-f]{40})" rel="noopener noreferrer"><code>([0-9a-f]{7})<\/code><\/a>/,
  );
  assert.ok(match, `${label} must render a complete commit anchor`);
  assert.equal(match[2], match[1].slice(0, 7), `${label} short SHA must match its URL`);

  const authoritative = authoritativeBuiltCommit();
  if (authoritative) {
    assert.equal(match[1], authoritative, `${label} must link to SITE_BUILD_COMMIT`);
  }
}

test('built footer renders a semantic <time> and a matching commit link', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = readDist('en/index.html');
  assert.ok(html, 'built homepage must exist');
  const footer = html.slice(html.indexOf('<footer'));
  const timeMatch = footer.match(/<time datetime="([^"]+Z)"[^>]*>([^<]*UTC)<\/time>/);
  assert.ok(timeMatch, 'footer must contain a <time datetime="…Z">… UTC</time> element');
  assert.ok(!Number.isNaN(new Date(timeMatch![1]).getTime()), 'footer datetime must be a valid instant');

  assertCommitAnchor(footer, 'footer');
});

test('built status page distinguishes Site built from Registry synced', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = readDist('en/status/index.html');
  assert.ok(html, 'built status page must exist');
  const mainStart = html.indexOf('<main');
  const footerStart = html.indexOf('<footer');
  assert.ok(mainStart >= 0 && footerStart > mainStart, 'status output must contain main before footer');
  const main = html.slice(mainStart, footerStart);
  assert.match(main, /Site built/, 'status page must label the site build time');
  assert.match(main, /Registry synced/, 'status page must label the registry sync time');
  const times = main.match(/<time datetime="[^"]+Z"[^>]*>[^<]*<\/time>/g) ?? [];
  assert.ok(
    times.length >= 2,
    'status page must render distinct <time> elements for build and sync',
  );
  assertCommitAnchor(main, 'status page');
});
