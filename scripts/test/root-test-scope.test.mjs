/**
 * Structural guards for the ROOT `npm test` discovery scope.
 *
 * Node's test runner auto-discovers `**\/*.test.{js,mjs,cjs,ts,mts,cts}` from
 * the current working directory when `node --test` is invoked with no path
 * arguments. From Node 22.18 (and all of Node 24) TypeScript test files are
 * discovered too, so a bare `node --test` at the repository root also picks up
 * `site/test/*.test.ts` and `site/src/**\/*.test.ts`.
 *
 * The `validate` and `sync` workflows install ONLY the root dependencies
 * (`npm ci` at the repository root). The site tests import site-only packages
 * (`marked`, `astro`, `tsx`), so an unscoped root `npm test` fails in CI while
 * passing on a developer machine that happens to have `site/node_modules`.
 *
 * These tests pin the discovery scope structurally instead of re-running the
 * whole suite: every path argument of the root `test` script must resolve
 * inside `scripts/test`, and no site test file may fall inside those roots.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const rootPkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);
const sitePkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'site', 'package.json'), 'utf8'),
);

/** Path (non-flag) arguments of the root `test` script, excluding `node`. */
function testScriptPathArgs() {
  const script = String(rootPkg.scripts?.test ?? '');
  return script
    .split(/\s+/)
    .filter(Boolean)
    .slice(1) // drop the `node` executable
    .filter((token) => !token.startsWith('-'))
    .map((token) => token.replace(/^["']|["']$/g, ''));
}

/**
 * Converts a `node --test` positional (a path or a `*` / `**` glob) into an
 * anchored RegExp over repo-relative posix paths, mirroring how Node expands
 * the pattern itself.
 */
function patternToRegExp(pattern) {
  let out = '';

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];

    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          out += '(?:[^/]*/)*';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }

    if (ch === '?') {
      out += '[^/]';
      continue;
    }

    out += ch.replace(/[.+^${}()|[\]\\]/, '\\$&');
  }

  return new RegExp(`^${out}$`);
}

/** Recursively collects every `*.test.*` file below `dir`, skipping node_modules. */
function collectTestFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(full, out);
    } else if (/\.test\.[cm]?[jt]s$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Repo-relative posix path. */
function rel(file) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

test('RTS1: the root test script passes explicit path arguments (never a bare `node --test`)', () => {
  const script = String(rootPkg.scripts?.test ?? '');
  assert.match(script, /^node --test\b/, 'root test script must invoke the Node test runner');
  assert.ok(
    testScriptPathArgs().length > 0,
    `root test script must scope discovery with explicit paths; got "${script}". ` +
      'A bare `node --test` walks the whole repository and picks up site/**/*.test.ts.',
  );
});

test('RTS2: the root test script selects exactly the scripts/test suite', () => {
  const args = testScriptPathArgs();
  const matchers = args.map(patternToRegExp);
  const allTestFiles = collectTestFiles(repoRoot).map(rel);

  const selected = allTestFiles.filter((file) => matchers.some((re) => re.test(file)));
  const expected = allTestFiles.filter((file) => file.startsWith('scripts/test/'));

  assert.ok(expected.length > 0, 'expected root test files under scripts/test/');
  assert.deepEqual(
    selected.slice().sort(),
    expected.slice().sort(),
    `root test script patterns ${JSON.stringify(args)} must select exactly the scripts/test suite`,
  );
});

test('RTS2b: every root test pattern is rooted at scripts/test', () => {
  for (const arg of testScriptPathArgs()) {
    const staticPrefix = arg.split(/[*?[]/)[0];
    assert.ok(
      staticPrefix.startsWith('scripts/test'),
      `root test pattern "${arg}" must be rooted at scripts/test; got prefix "${staticPrefix}"`,
    );
  }
  assert.ok(
    fs.existsSync(path.join(repoRoot, 'scripts', 'test')),
    'scripts/test must exist',
  );
});

test('RTS3: no site test file falls inside the root discovery roots', () => {
  const matchers = testScriptPathArgs().map(patternToRegExp);
  const siteTests = collectTestFiles(path.join(repoRoot, 'site')).map(rel);

  assert.ok(siteTests.length > 0, 'expected site test files to exist');

  for (const file of siteTests) {
    for (const matcher of matchers) {
      assert.ok(
        !matcher.test(file),
        `site test ${file} must not be discovered by the root test script`,
      );
    }
  }
});

test('RTS4: site tests depend on packages the root install does not provide', () => {
  const rootDeps = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
  const siteDeps = { ...sitePkg.dependencies, ...sitePkg.devDependencies };

  for (const pkgName of ['marked', 'astro', 'tsx']) {
    assert.ok(siteDeps[pkgName], `site package.json must declare ${pkgName}`);
    assert.ok(
      !rootDeps[pkgName],
      `root package.json must not declare ${pkgName}; running site tests from the root install is unsupported`,
    );
  }
});

test('RTS5: site unit tests still run in CI through their own site-scoped job', () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'validate.yml'),
    'utf8',
  );

  assert.match(
    workflow,
    /npm --prefix site (ci|install)/,
    'validate.yml must install the site dependencies for the site test job',
  );
  assert.match(
    workflow,
    /npm --prefix site test/,
    'validate.yml must execute the site unit tests separately from the root suite',
  );
});
