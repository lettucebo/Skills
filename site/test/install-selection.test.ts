import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildMultiSkillInstallCommand,
  getInstallableSkillNames,
  parseStoredSelection,
} from '../src/lib/install-selection.ts';
import {
  findRepoRoot,
  generateMultiSkillInstallCommand,
  loadCatalog,
  RELEASE_VERSION,
} from '../src/lib/catalog.ts';

const options = { owner: 'lettucebo', repo: 'Skills', version: '2.0.1' };

test('builds one stable command for multiple selected skills', () => {
  assert.equal(
    buildMultiSkillInstallCommand(['beta', 'alpha', 'beta'], options),
    'npx skills add "lettucebo/Skills#v2.0.1" --full-depth --skill alpha --skill beta',
  );
  assert.equal(buildMultiSkillInstallCommand([], options), null);
});

test('rejects invalid skill names instead of generating shell syntax', () => {
  assert.throws(
    () => buildMultiSkillInstallCommand(['alpha', '--all'], options),
    /Invalid skill name/,
  );
});

test('filters removed and restricted skills from the installable allow-list', () => {
  assert.deepEqual(getInstallableSkillNames([
    { name: 'allowed', isRestricted: false, isTombstone: false },
    { name: 'private', isRestricted: true, isTombstone: false },
    { name: 'removed', isRestricted: false, isTombstone: true },
    { name: '--all', isRestricted: false, isTombstone: false },
  ]), ['allowed']);
});

test('restores only unique allow-listed names from storage', () => {
  assert.deepEqual(
    parseStoredSelection('["allowed","private","allowed","removed"]', ['allowed']),
    ['allowed'],
  );
  assert.throws(() => parseStoredSelection('not json', ['allowed']));
  assert.throws(() => parseStoredSelection('{"name":"allowed"}', ['allowed']), /Invalid stored selection/);
  assert.deepEqual(parseStoredSelection('["--all","allowed"]', ['allowed']), ['allowed']);
});

test('catalog command accepts public skills and refuses restricted or missing names', async () => {
  const catalog = await loadCatalog(findRepoRoot());
  const publicSkill = catalog.skills.find((skill) => !skill.isRestricted && !skill.isTombstone)!;
  const restricted = catalog.skills.find((skill) => skill.isRestricted)!;
  assert.equal(
    generateMultiSkillInstallCommand([publicSkill.name], catalog.skills),
    `npx skills add "lettucebo/Skills#v${RELEASE_VERSION}" --full-depth --skill ${publicSkill.name}`,
  );
  assert.throws(() => generateMultiSkillInstallCommand([restricted.name], catalog.skills), /restricted or unknown/);
  assert.throws(() => generateMultiSkillInstallCommand(['not-a-skill'], catalog.skills), /restricted or unknown/);
});

test('built homepage allow-lists exclude every restricted skill in each locale', async (context) => {
  const dist = path.join(findRepoRoot(), 'site', 'dist');
  if (!fs.existsSync(dist)) {
    context.skip('Build the site before running dist assertions');
    return;
  }
  const catalog = await loadCatalog(findRepoRoot());
  const restricted = catalog.skills.filter((skill) => skill.isRestricted).map((skill) => skill.name);
  assert.ok(restricted.length > 0, 'fixture must include restricted skills');
  for (const locale of ['en', 'zh-tw', 'zh-cn']) {
    const html = fs.readFileSync(path.join(dist, locale, 'index.html'), 'utf8');
    const attribute = html.match(/data-installable-names="([^"]*)"/)?.[1];
    assert.ok(attribute, `${locale} must render a selection allow-list`);
    const names: string[] = JSON.parse(attribute.replaceAll('&#34;', '"'));
    for (const name of restricted) {
      assert.equal(names.includes(name), false, `${locale} must exclude ${name}`);
    }
  }
});
