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
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashDirectory } from '../lib/hash.mjs';

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

const IGNORED_VENDORED_ARTIFACTS = [
  'skills/upstream/demo/.vscode/settings.json',
  'skills/upstream/demo/.idea/workspace.xml',
  'skills/upstream/demo/__pycache__/module.pyc',
  'skills/upstream/demo/.venv/pyvenv.cfg',
  'skills/upstream/demo/.DS_Store',
  'skills/upstream/demo/profile.user',
  'skills/upstream/demo/.astro/types.d.ts',
  'skills/upstream/demo/demo.egg-info/PKG-INFO',
  'skills/upstream/demo/.pytest_cache/v/cache/nodeids',
  'skills/upstream/demo/Thumbs.db',
  'skills/upstream/demo/Desktop.ini',
  'skills/upstream/demo/editor.swp',
  'skills/upstream/demo/editor.swo',
  'skills/upstream/demo/backup~',
  'skills/upstream/demo/module.pyo',
  'skills/upstream/demo/package.whl',
  'skills/upstream/demo/profile.suo',
  'skills/upstream/demo/venv/pyvenv.cfg',
  'skills/upstream/demo/.mypy_cache/cache.json',
  'skills/upstream/demo/.ruff_cache/cache.json',
  'skills/upstream/demo/.baseline-work-temp/state.json',
  'skills/upstream/demo/.baseline-backup-temp/state.json',
  'skills/upstream/demo/.update-work-temp/state.json',
  'skills/upstream/demo/sync-report/plan.json',
];

const CASE_VARIANT_ARTIFACTS = [
  '.VSCODE/settings.json',
  'NODE_MODULES/pkg/index.js',
  'PROFILE.USER',
  'MODULE.PYC',
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

test('GI4a: unsupported editor and cache artifacts stay ignored under skills/', async () => {
  const tracked = await trackedPaths([
    ...IGNORED_VENDORED_ARTIFACTS,
    'skills/upstream/demo/SKILL.md',
  ]);

  for (const artifact of IGNORED_VENDORED_ARTIFACTS) {
    assert.equal(
      tracked.has(artifact),
      false,
      `${artifact} must remain ignored so staging and hashing cannot claim untrackable bytes`,
    );
  }
  assert.ok(tracked.has('skills/upstream/demo/SKILL.md'));
});

// ─── GI5–GI7: the hash must cover exactly the trackable bytes ───────
//
// GI1–GI4 make git's view match the hash for build output, logs and dotenv.
// The remaining asymmetry is `node_modules`, which stays ignored by design:
// hashing it would claim provenance for bytes the commit can never contain, so
// a fresh clone would fail to reproduce its own `snapshotHash`. The hash must
// therefore exclude it too — the same rule, enforced on both sides.

/** Writes a skill folder fixture and returns its absolute path. */
async function writeSkillFixture(files) {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'hashscope-'));

  for (const [relativePath, content] of Object.entries(files)) {
    await writeFileEnsured(path.join(root, ...relativePath.split('/')), content);
  }

  return root;
}

test('GI5: a vendored node_modules tree does not change the content hash', async () => {
  const base = {
    'SKILL.md': '---\nname: demo\ndescription: demo\n---\n\n# demo\n',
    'references/notes.md': '# notes\n',
  };

  const clean = await writeSkillFixture(base);
  const polluted = await writeSkillFixture({
    ...base,
    'node_modules/left-pad/index.js': 'module.exports = () => {};\n',
    'node_modules/left-pad/package.json': '{"name":"left-pad"}\n',
    'assets/node_modules/nested/index.js': 'nested\n',
  });

  try {
    assert.equal(
      await hashDirectory(polluted),
      await hashDirectory(clean),
      'git refuses to track node_modules, so hashing it would record bytes the commit ' +
        'cannot contain and the committed tree could never reproduce its own lock entry',
    );
  } finally {
    await rm(clean, { recursive: true, force: true });
    await rm(polluted, { recursive: true, force: true });
  }
});

test('GI6: every file the hash covers is a file git will track', async () => {
  const { collectHashableFiles } = await import('../lib/hash.mjs');

  const files = {
    'SKILL.md': '---\nname: demo\ndescription: demo\n---\n\n# demo\n',
    'references/notes.md': '# notes\n',
    'dist/bundle.js': 'built\n',
    'build/output.txt': 'built\n',
    'output/report.txt': 'built\n',
    'bin/tool.ps1': 'tool\n',
    'obj/intermediate.txt': 'obj\n',
    'scripts/run.log': 'log\n',
    '.env': 'PUBLIC_UPSTREAM_SAMPLE=1\n',
    'node_modules/left-pad/index.js': 'dep\n',
    '.vscode/settings.json': '{}\n',
    '.idea/workspace.xml': '<project />\n',
    '__pycache__/module.pyc': 'cache\n',
    '.venv/pyvenv.cfg': 'home = fixture\n',
    '.DS_Store': 'metadata\n',
    'profile.user': 'user settings\n',
    '.astro/types.d.ts': 'declare const fixture: true;\n',
    'demo.egg-info/PKG-INFO': 'Metadata-Version: 2.1\n',
    '.pytest_cache/v/cache/nodeids': '[]\n',
    'Thumbs.db': 'thumbnail\n',
    'Desktop.ini': '[.ShellClassInfo]\n',
    'editor.swp': 'swap\n',
    'editor.swo': 'swap\n',
    'backup~': 'backup\n',
    'module.pyo': 'cache\n',
    'package.whl': 'wheel\n',
    'profile.suo': 'user options\n',
    'venv/pyvenv.cfg': 'home = fixture\n',
    '.mypy_cache/cache.json': '{}\n',
    '.ruff_cache/cache.json': '{}\n',
    '.baseline-work-temp/state.json': '{}\n',
    '.baseline-backup-temp/state.json': '{}\n',
    '.update-work-temp/state.json': '{}\n',
    'sync-report/plan.json': '{}\n',
    '.VSCODE/settings.json': '{}\n',
    'NODE_MODULES/pkg/index.js': 'dependency\n',
    'PROFILE.USER': 'user settings\n',
    'MODULE.PYC': 'cache\n',
  };

  const fixture = await writeSkillFixture(files);

  try {
    const hashed = await collectHashableFiles(fixture);
    const tracked = await trackedPaths(
      Object.keys(files).map((file) => `skills/upstream/demo/${file}`),
    );

    for (const relativePath of hashed) {
      assert.ok(
        tracked.has(`skills/upstream/demo/${relativePath}`),
        `${relativePath} is hashed into the lockfile but git refuses to track it — ` +
          'the committed tree could not reproduce its own snapshotHash',
      );
    }

    assert.ok(hashed.includes('SKILL.md'));
    assert.ok(hashed.includes('.env'), 'public upstream dotenv files are tracked, so they hash');
    assert.equal(
      hashed.some((file) => file.split('/').includes('node_modules')),
      false,
      'node_modules is ignored by git, so it must be excluded from the hash as well',
    );
    for (const ignored of IGNORED_VENDORED_ARTIFACTS) {
      const relativePath = ignored.replace('skills/upstream/demo/', '');
      assert.equal(
        hashed.includes(relativePath),
        false,
        `${relativePath} is ignored by git and must not be hashed`,
      );
    }
    for (const artifact of CASE_VARIANT_ARTIFACTS) {
      assert.equal(
        hashed.includes(artifact),
        false,
        `${artifact} must be excluded consistently on case-sensitive and case-insensitive hosts`,
      );
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('GI7: hashing rejects every symbolic link with its relative path', async (t) => {
  const fixture = await writeSkillFixture({
    'SKILL.md': '---\nname: demo\ndescription: demo\n---\n\n# demo\n',
  });
  const linkPath = path.join(fixture, 'linked-skill.md');

  try {
    try {
      await symlink('SKILL.md', linkPath);
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`symbolic links cannot be created on this host: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      hashDirectory(fixture),
      /symbolic link.*linked-skill\.md/i,
      'a link must not be silently omitted from the provenance hash',
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('GI8: the ignore-exclusion rule is declared once and shared', async () => {
  const { HASH_EXCLUDED_DIRECTORIES } = await import('../lib/hash.mjs');

  assert.ok(
    HASH_EXCLUDED_DIRECTORIES instanceof Set,
    'the excluded directory names must be exported so staging and hashing cannot drift',
  );
  assert.deepEqual(
    [...HASH_EXCLUDED_DIRECTORIES].sort(),
    [
      '.astro',
      '.git',
      '.idea',
      '.mypy_cache',
      '.pytest_cache',
      '.ruff_cache',
      '.venv',
      '.vscode',
      '__pycache__',
      'node_modules',
      'sync-report',
      'venv',
    ],
  );

  const gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.match(
    gitignore,
    /node_modules\/ is deliberately NOT re-included/,
    'the .gitignore must keep documenting why node_modules is the one directory the ' +
      'skills/** exception does not cover',
  );
});
