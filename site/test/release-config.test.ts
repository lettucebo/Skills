/**
 * Release configuration tests.
 *
 * Two invariants used to be hardcoded in `src/lib/catalog.ts`:
 *
 *   1. `RELEASE_VERSION = '1.1.0'` — a copy of `catalog/skills.lock.json`
 *      `release`, which silently goes stale the moment a sync bumps the lock.
 *   2. `RELEASE_PUBLISHED = false` — permanently pending, so the site would
 *      keep warning "available after v… is published" forever after the tag
 *      was actually pushed.
 *
 * Both are now derived: the version from the lock file at load time, the
 * publication flag from an explicit build-time `RELEASE_PUBLISHED` input.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  RELEASE_VERSION,
  RELEASE_PUBLISHED,
  parseReleasePublished,
  generateRepoInstallCommand,
  generateSourceInstallCommand,
  generateSingleSkillInstallCommand,
  type SkillViewModel,
} from '../src/lib/catalog.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(siteRoot, '..');

const catalogSource = fs.readFileSync(
  path.join(siteRoot, 'src', 'lib', 'catalog.ts'),
  'utf8',
);
const lock = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
) as { release: string };

// ─── R1–R2: version derives from the lock ───────────────────────────

test('R1: RELEASE_VERSION equals the lock file release', () => {
  assert.equal(
    RELEASE_VERSION,
    lock.release,
    'the site release must be read from catalog/skills.lock.json, not copied by hand',
  );
});

test('R2: catalog.ts does not hardcode a release version literal', () => {
  assert.doesNotMatch(
    catalogSource,
    /RELEASE_VERSION\s*(:[^=]*)?=\s*['"`]\d/,
    'RELEASE_VERSION must be derived from the lock file, never assigned a literal version',
  );
  assert.match(
    catalogSource,
    /skills\.lock\.json/,
    'catalog.ts must read catalog/skills.lock.json to derive the release',
  );
});

test('R3: install commands embed the lock release, so a sync bump propagates automatically', () => {
  const skills: SkillViewModel[] = [];
  assert.ok(
    generateRepoInstallCommand().endsWith(`#v${lock.release} --full-depth`),
    `repo install command must pin v${lock.release}; got ${generateRepoInstallCommand()}`,
  );
  assert.ok(
    generateSourceInstallCommand(skills, 'azure')?.endsWith(`#v${lock.release}`),
    'source install command must pin the lock release',
  );
  assert.ok(
    generateSingleSkillInstallCommand('az-cost-optimize')?.includes(`#v${lock.release}@`) &&
      generateSingleSkillInstallCommand('az-cost-optimize')?.endsWith('" --full-depth'),
    'single-skill install command must pin the lock release',
  );
});

// ─── R4–R6: publication is an explicit build-time input ─────────────

test('R4: parseReleasePublished only accepts an explicit "true"', () => {
  assert.equal(parseReleasePublished('true'), true);
  assert.equal(parseReleasePublished('false'), false);
  assert.equal(parseReleasePublished(undefined), false, 'the local default must be pending');
  assert.equal(parseReleasePublished(''), false);
  assert.equal(parseReleasePublished('TRUE'), false, 'only the exact lowercase literal counts');
  assert.equal(parseReleasePublished('1'), false);
  assert.equal(parseReleasePublished('yes'), false);
});

test('R5: catalog.ts does not hardcode the publication flag', () => {
  assert.doesNotMatch(
    catalogSource,
    /RELEASE_PUBLISHED\s*(:[^=]*)?=\s*(true|false)\b/,
    'RELEASE_PUBLISHED must come from the build-time input, never a hardcoded boolean',
  );
  assert.match(
    catalogSource,
    /process\.env\.RELEASE_PUBLISHED/,
    'RELEASE_PUBLISHED must read the RELEASE_PUBLISHED build-time environment input',
  );
});

test('R6: the exported flag mirrors the ambient build-time input', () => {
  assert.equal(RELEASE_PUBLISHED, parseReleasePublished(process.env.RELEASE_PUBLISHED));
});

/** Imports catalog.ts in a child process with a controlled environment. */
function readFlagWithEnv(value: string | undefined): boolean {
  const env = { ...process.env };
  if (value === undefined) delete env.RELEASE_PUBLISHED;
  else env.RELEASE_PUBLISHED = value;

  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      "import('./src/lib/catalog.ts').then((m) => console.log(JSON.stringify(m.RELEASE_PUBLISHED)))",
    ],
    { cwd: siteRoot, env, encoding: 'utf8' },
  );

  assert.equal(
    result.status,
    0,
    `child import failed: ${result.stderr}`,
  );
  return JSON.parse(result.stdout.trim());
}

test('R7: pending mode — no RELEASE_PUBLISHED input means the release is unpublished', () => {
  assert.equal(readFlagWithEnv(undefined), false);
  assert.equal(readFlagWithEnv('false'), false);
});

test('R8: published mode — RELEASE_PUBLISHED=true flips the site into published mode', () => {
  assert.equal(readFlagWithEnv('true'), true);
});

// ─── R10: no test may re-pin the flag to a literal ──────────────────
//
// A suite that asserts `RELEASE_PUBLISHED === false` passes locally and fails
// in exactly the situation the derivation exists for: a deploy that correctly
// injects `RELEASE_PUBLISHED=true`. The published-mode CI job would then fail
// on a stale test rather than on a real defect, so the pin is banned outright.

test('R10: no site test pins RELEASE_PUBLISHED to a literal boolean', () => {
  const testDir = path.join(siteRoot, 'test');
  const offenders: string[] = [];

  for (const entry of fs.readdirSync(testDir)) {
    if (!entry.endsWith('.ts')) continue;

    const source = fs.readFileSync(path.join(testDir, entry), 'utf8');
    const lines = source.split('\n');

    lines.forEach((line, index) => {
      if (/assert\.\w+\(\s*RELEASE_PUBLISHED\s*,\s*(true|false)\s*\)/.test(line)) {
        offenders.push(`${entry}:${index + 1}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    'RELEASE_PUBLISHED is a build-time input; assert it against the ambient input ' +
      `(parseReleasePublished(process.env.RELEASE_PUBLISHED)), never a literal — ${offenders.join(', ')}`,
  );
});

// ─── R9: consumers read the derived values, not literals ────────────

test('R9: site pages and components consume the derived release constants', () => {
  const consumers = [
    path.join(siteRoot, 'src', 'components', 'pages', 'HomePage.astro'),
    path.join(siteRoot, 'src', 'components', 'pages', 'StatusPage.astro'),
    path.join(siteRoot, 'src', 'components', 'InstallCommand.astro'),
  ];

  for (const file of consumers) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(
      source,
      /RELEASE_PUBLISHED/,
      `${path.basename(file)} must branch on the derived RELEASE_PUBLISHED flag`,
    );
    assert.doesNotMatch(
      source,
      /v1\.1\.0/,
      `${path.basename(file)} must not hardcode a release version string`,
    );
  }
});
