/**
 * install-page tests — the dedicated /install/ route, the global Install nav
 * link, and the homepage's demotion from an install command block to a compact
 * link. Source-level assertions guard the wiring; dist-based assertions guard
 * the rendered output (skipped when dist/ is absent).
 *
 * All command expectations are derived from the catalog helpers so this suite
 * never restates the current release, source list, or skill count.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCatalog,
  generateRepoInstallCommand,
  generateSourceInstallCommand,
  generateSingleSkillInstallCommand,
} from '../src/lib/catalog.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(siteRoot, '..');
const distDir = path.join(siteRoot, 'dist');
const distExists = fs.existsSync(distDir);

const installPagePath = path.join(siteRoot, 'src', 'components', 'pages', 'InstallPage.astro');
const indexPagePath = path.join(siteRoot, 'src', 'components', 'pages', 'HomePage.astro');
const layoutPath = path.join(siteRoot, 'src', 'layouts', 'Layout.astro');

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

// ─── Source wiring ──────────────────────────────────────────────────

test('install.astro exists', () => {
  assert.ok(fs.existsSync(installPagePath), 'shared InstallPage.astro must exist');
});

test('install.astro uses Layout and InstallCommand', () => {
  const src = read(installPagePath);
  assert.match(src, /import\s+Layout\s+from/, 'install page must import Layout');
  assert.match(src, /import\s+InstallCommand\s+from/, 'install page must import InstallCommand');
  assert.match(src, /<Layout\b/, 'install page must render the Layout');
  assert.match(src, /<InstallCommand\b/, 'install page must render InstallCommand');
});

test('install.astro derives commands through catalog helpers', () => {
  const src = read(installPagePath);
  assert.match(src, /generateRepoInstallCommand\(\)/, 'install page must use generateRepoInstallCommand');
  assert.match(src, /generateSourceInstallCommand\(/, 'install page must use generateSourceInstallCommand');
  assert.match(src, /generateSingleSkillInstallCommand\(/, 'install page must use generateSingleSkillInstallCommand');
  assert.match(src, /catalog\.sources/, 'install page must derive sources from the catalog');
});

test('install.astro handles a catalog with no installable single-skill example', () => {
  const src = read(installPagePath);
  assert.match(
    src,
    /find\(\(s\) => !s\.isRestricted && !s\.isTombstone\) \?\? null/,
    'the example must be selected from installable catalog entries',
  );
  assert.match(
    src,
    /'noInstallableSkill'/,
    'the page must render a clean fallback instead of failing',
  );
});

test('install.astro hardcodes neither the release version nor a source name', () => {
  const src = read(installPagePath);
  assert.doesNotMatch(src, /1\.1\.0/, 'install page must not hardcode the release version');
  assert.doesNotMatch(src, /['"]azure['"]/, 'install page must not hardcode a source name');
  assert.doesNotMatch(src, /['"]claude['"]/, 'install page must not hardcode a restricted source name');
});

test('install.astro renders no restricted warning box or disclosure prose', () => {
  const src = read(installPagePath);
  assert.doesNotMatch(src, /warning-box/, 'install page must not reintroduce a warning box');
  assert.doesNotMatch(src, /non-redistributable/i, 'install page must not restate the removed disclosure');
});

// ─── Homepage demotion ──────────────────────────────────────────────

test('index.astro no longer imports or renders InstallCommand', () => {
  const src = read(indexPagePath);
  assert.doesNotMatch(src, /import\s+InstallCommand\s+from/, 'homepage must not import InstallCommand');
  assert.doesNotMatch(src, /<InstallCommand\b/, 'homepage must not render InstallCommand');
  assert.doesNotMatch(src, /generateRepoInstallCommand/, 'homepage must not build the full-repo command');
});

test('index.astro links to the install page', () => {
  const src = read(indexPagePath);
  assert.match(src, /localizedPath\(locale,\s*'install'\)/, 'homepage must link to the localized install page');
});

// ─── Navigation ─────────────────────────────────────────────────────

test('Layout nav exposes an Install link with aria-current support', () => {
  const src = read(layoutPath);
  assert.match(
    src,
    /href=\{installPath\}/,
    'nav must contain the localized Install link',
  );
  assert.match(
    src,
    /isActive\(installPath\)/,
    'the Install link must set aria-current when active',
  );
});

// ─── Built output ───────────────────────────────────────────────────

test('built install page publishes the full-repo install command', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = read(path.join(distDir, 'en', 'install', 'index.html'));
  assert.match(
    html,
    /npx skills add lettucebo\/Skills#v\d+\.\d+\.\d+ --full-depth/,
    'repository-root command must include --full-depth',
  );
});

test('built install page publishes an unrestricted source command', {
  skip: !distExists && 'dist/ not found',
}, async () => {
  const html = read(path.join(distDir, 'en', 'install', 'index.html'));
  const catalog = await loadCatalog(repoRoot);
  const cleanSource = catalog.sources.find(
    (s) => generateSourceInstallCommand(catalog.skills, s) !== null,
  );
  assert.ok(cleanSource, 'catalog must contain at least one unrestricted source');
  const cmd = generateSourceInstallCommand(catalog.skills, cleanSource!);
  assert.ok(html.includes(cmd!), `install page must publish the clean source command "${cmd}"`);
});

test('built install page includes claude after restricted mirrors become tombstones', {
  skip: !distExists && 'dist/ not found',
}, async () => {
  const html = read(path.join(distDir, 'en', 'install', 'index.html'));
  const catalog = await loadCatalog(repoRoot);
  assert.equal(catalog.counts.restricted, 0);
  assert.ok(
    html.includes('npx skills add lettucebo/Skills/skills/claude#v2.0.0'),
    'claude must offer a bulk install command after restricted mirrors are removed',
  );
  assert.doesNotMatch(html, /warning-box/, 'install page must not render a warning box');
});

test('built install page publishes a single-skill command', {
  skip: !distExists && 'dist/ not found',
}, async () => {
  const html = read(path.join(distDir, 'en', 'install', 'index.html'));
  const catalog = await loadCatalog(repoRoot);
  const installable = catalog.skills.find(
    (s) => !s.isRestricted && !s.isTombstone,
  );
  assert.ok(installable, 'catalog must contain at least one installable skill');
  const escapedName = installable!.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    html,
    new RegExp(`#v\\d+\\.\\d+\\.\\d+@${escapedName}(?:&quot;|") --full-depth`),
    `single-skill command for ${installable!.name} must include --full-depth`,
  );
});

test('all rendered source commands omit repository-root full-depth discovery', {
  skip: !distExists && 'dist/ not found',
}, async () => {
  const html = read(path.join(distDir, 'en', 'install', 'index.html'));
  const catalog = await loadCatalog(repoRoot);
  for (const source of catalog.sources) {
    const command = generateSourceInstallCommand(catalog.skills, source);
    if (command === null) continue;
    assert.ok(html.includes(command), `install page must publish source command for ${source}`);
    assert.doesNotMatch(
      command,
      /--full-depth/,
      `source command for ${source} must not use --full-depth`,
    );
  }
});

test('pending publication notice appears only once on the install page', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = read(path.join(distDir, 'en', 'install', 'index.html'));
  const notices = html.match(/Available after v[^<]+ is published/g) ?? [];
  assert.ok(notices.length <= 1, `install page must not repeat the pending notice; found ${notices.length}`);
});

test('built homepage links to /install/ without an install command block', {
  skip: !distExists && 'dist/ not found',
}, () => {
  const html = read(path.join(distDir, 'en', 'index.html'));
  assert.match(html, /href="\/Skills\/en\/install\/"/, 'homepage must link to the localized install page');
  assert.doesNotMatch(
    html,
    /npx skills add lettucebo\/Skills#v/,
    'homepage must not publish the full-repo install command',
  );
  assert.doesNotMatch(html, /install-block/, 'homepage must not render an install block');
});
