/**
 * Ignore-scope guards for the repository `.gitignore`.
 *
 * `hashDirectory` walks every file inside a vendored skill folder with no
 * awareness of git ignore rules (scripts/lib/hash.mjs), so the lockfile records
 * bytes that git may refuse to stage. Unanchored patterns such as `dist/`,
 * `bin/`, `obj/`, `build/`, `output/` and `*.log` match at ANY depth, which
 * means a future upstream sync that ships e.g. `skills/x/y/dist/bundle.js`
 * would be hashed into the lock but silently dropped from the commit — the
 * committed tree would no longer reproduce `snapshotHash`.
 *
 * These tests use a real throwaway git repository seeded with the repository's
 * own `.gitignore` so the assertions exercise git's actual matching rules
 * rather than a re-implementation of them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const runtimeRoot = path.join(__dirname, '.runtime');

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

async function writeFileEnsured(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

/**
 * Creates a throwaway repository carrying the real `.gitignore`, writes every
 * requested file, and returns the set of paths git would actually track.
 */
async function trackedPaths(files) {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'gitignore-'));

  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'fixture@example.com']);
    git(root, ['config', 'user.name', 'Fixture']);

    await writeFile(
      path.join(root, '.gitignore'),
      await readFile(path.join(repoRoot, '.gitignore'), 'utf8'),
    );

    for (const file of files) {
      await writeFileEnsured(path.join(root, ...file.split('/')), `content of ${file}\n`);
    }

    git(root, ['add', '-A']);

    return new Set(
      git(root, ['ls-files'])
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const VENDORED_ARTIFACTS = [
  'skills/upstream/demo/dist/bundle.js',
  'skills/upstream/demo/build/output.txt',
  'skills/upstream/demo/output/report.txt',
  'skills/upstream/demo/bin/tool.ps1',
  'skills/upstream/demo/obj/intermediate.txt',
  'skills/upstream/demo/scripts/run.log',
  'skills/upstream/demo/.env',
];

const REPOSITORY_ARTIFACTS = [
  'site/dist/index.html',
  'site/.astro/types.d.ts',
  'node_modules/left-pad/index.js',
  'sync-report/plan.json',
  'scripts/test/.runtime/tmp.txt',
  'site/playwright-report/index.html',
  '.env',
  'debug.log',
  'bin/local-tool.exe',
  'dist/site.js',
];

test('GI1: vendored skill artifacts are trackable despite repo-wide build ignores', async () => {
  const tracked = await trackedPaths([...VENDORED_ARTIFACTS, 'skills/upstream/demo/SKILL.md']);

  for (const vendored of VENDORED_ARTIFACTS) {
    assert.ok(
      tracked.has(vendored),
      `${vendored} is hashed into the lockfile but git refuses to track it; ` +
        'scope the ignore rule so it cannot match under skills/**',
    );
  }
});

test('GI2: repository build output and scratch dirs stay ignored', async () => {
  const tracked = await trackedPaths([...REPOSITORY_ARTIFACTS, 'README.md']);

  for (const artifact of REPOSITORY_ARTIFACTS) {
    assert.equal(
      tracked.has(artifact),
      false,
      `${artifact} must stay ignored — un-scoping the skills/** exception must not leak build output`,
    );
  }

  assert.ok(tracked.has('README.md'), 'ordinary repository files must still be tracked');
});

test('GI3: the skills exception is declared explicitly and documented', async () => {
  const gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');

  assert.match(
    gitignore,
    /!\/skills\//,
    'the vendored tree must be re-included explicitly so the intent is reviewable',
  );
  assert.match(
    gitignore,
    /hashDirectory|lockfile|snapshotHash/i,
    'the exception must explain why vendored artifacts have to stay trackable',
  );
});

test('GI4: node_modules stays ignored even under skills/', async () => {
  const tracked = await trackedPaths([
    'skills/upstream/demo/assets/node_modules/pkg/index.js',
    'skills/upstream/demo/SKILL.md',
  ]);

  assert.equal(
    tracked.has('skills/upstream/demo/assets/node_modules/pkg/index.js'),
    false,
    'a dependency tree is never legitimate vendored content; keeping it ignored ' +
      'prevents accidentally committing thousands of files',
  );
  assert.ok(tracked.has('skills/upstream/demo/SKILL.md'));
});
