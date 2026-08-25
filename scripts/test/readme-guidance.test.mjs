/**
 * README user-guidance guards.
 *
 * The README is the first thing a user reads, and before publication it was
 * actively misleading:
 *
 *  - "方法二：使用 npx 安裝器" told the reader to run
 *    `npx skills add microsoft/skills`, which installs an unrelated upstream
 *    repository rather than this registry.
 *  - The hand-maintained per-source tables had drifted from the lock file
 *    (e.g. cloudflare listed 9 skills while the generated block and the lock
 *    both say 13), so the same document disagreed with itself.
 *  - The contribution steps asked contributors to update those tables instead
 *    of declaring the skill in `catalog/sources.yml` and running the validator.
 *
 * Everything asserted here is derived from `catalog/skills.lock.json`, so a
 * future sync bump cannot silently invalidate the README again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

async function readReadme() {
  return readFile(path.join(repoRoot, 'README.md'), 'utf8');
}

async function readLock() {
  return JSON.parse(
    await readFile(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
  );
}

/** README text with the generated `<!-- CATALOG:START -->` block removed. */
function handWritten(readme) {
  const start = readme.indexOf('<!-- CATALOG:START -->');
  const end = readme.indexOf('<!-- CATALOG:END -->');
  if (start === -1 || end === -1) return readme;
  return readme.slice(0, start) + readme.slice(end);
}

test('RM1: the README never points users at an unrelated upstream repository', async () => {
  const readme = await readReadme();
  assert.doesNotMatch(
    readme,
    /npx skills add\s+microsoft\/skills/,
    'the install instructions must install THIS registry, not microsoft/skills',
  );
});

test('RM2: the README documents all three install scopes pinned to the lock release', async () => {
  const readme = await readReadme();
  const lock = await readLock();
  const tag = `v${lock.release}`;

  assert.match(
    readme,
    new RegExp(`npx skills add lettucebo/Skills#${tag.replace(/\./g, '\\.')}(?!/)`),
    `README must show the full-repository install pinned to ${tag}`,
  );
  assert.match(
    readme,
    new RegExp(`npx skills add lettucebo/Skills/skills/[a-z0-9-]+#${tag.replace(/\./g, '\\.')}`),
    `README must show the single-source install pinned to ${tag}`,
  );
  assert.match(
    readme,
    new RegExp(`npx skills add "lettucebo/Skills#${tag.replace(/\./g, '\\.')}@`),
    `README must show the single-skill install pinned to ${tag}`,
  );
});

test('RM3: the README never advertises a release version other than the lock release', async () => {
  const readme = await readReadme();
  const lock = await readLock();

  const versions = [...readme.matchAll(/Skills(?:\/[a-z0-9/-]+)?#v(\d+\.\d+\.\d+)/g)].map(
    (m) => m[1],
  );
  assert.ok(versions.length > 0, 'README must contain at least one pinned install command');

  for (const version of versions) {
    assert.equal(
      version,
      lock.release,
      `README pins v${version} but catalog/skills.lock.json declares ${lock.release}`,
    );
  }
});

test('RM4: the README warns that the release tag is not published yet', async () => {
  const readme = await readReadme();
  const lock = await readLock();

  assert.match(
    readme,
    new RegExp(`v${lock.release.replace(/\./g, '\\.')}[^\\n]*尚未`),
    'the README must state that the release tag is not yet pushed, so the install command fails today',
  );
});

test('RM5: no hand-maintained per-source skill tables shadow the generated catalog', async () => {
  const readme = await readReadme();
  const body = handWritten(readme);

  const perSourceHeadings = [...body.matchAll(/^###\s+([a-z0-9-]+)（\d+\s*個）\s*$/gm)];
  assert.deepEqual(
    perSourceHeadings.map((m) => m[1]),
    [],
    'per-source skill tables duplicate generated content and drift from the lock file — ' +
      'link to the catalog site / skills.lock.json instead',
  );
});

test('RM6: every source count stated by hand agrees with the lock file', async () => {
  const readme = await readReadme();
  const lock = await readLock();
  const body = handWritten(readme);

  const counts = new Map();
  for (const skill of lock.skills) {
    const source = skill.path.split('/')[1];
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }

  for (const match of body.matchAll(/([a-z0-9-]+)（(\d+)\s*個）/g)) {
    const [, source, stated] = match;
    if (!counts.has(source)) continue;
    assert.equal(
      Number(stated),
      counts.get(source),
      `README states ${source} has ${stated} skills; the lock file says ${counts.get(source)}`,
    );
  }
});

test('RM7: contribution steps point at the manifest and the validator', async () => {
  const readme = await readReadme();

  assert.match(
    readme,
    /catalog\/sources\.yml/,
    'adding a skill starts by declaring it in catalog/sources.yml',
  );
  assert.match(
    readme,
    /node scripts\/validate\.mjs/,
    'contributors must be told to run the repository validator',
  );
  assert.doesNotMatch(
    readme,
    /更新本 README 的收錄清單/,
    'the收錄清單 is generated from the lock file; contributors must not hand-edit it',
  );
});

test('RM8: the generated catalog block is still present and is the single source of truth', async () => {
  const readme = await readReadme();
  assert.match(readme, /<!-- CATALOG:START -->/);
  assert.match(readme, /<!-- CATALOG:END -->/);
  assert.match(
    readme,
    /自動產生，請勿手動編輯/,
    'the generated block must keep its do-not-edit notice',
  );
});
