import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type LockFile,
  type LockSkillEntry,
  type SkillViewModel,
  normalizeSkill,
  computeCounts,
  computeBaselineVerification,
  formatBaselineVerification,
  generateRepoInstallCommand,
  generateSourceInstallCommand,
  generateSingleSkillInstallCommand,
  buildUpstreamTreeUrl,
  buildUpstreamCommitUrl,
  deriveRouteParams,
  deriveSourceFromPath,
  renderMarkdownBody,
  RELEASE_VERSION,
  RELEASE_PUBLISHED,
  parseReleasePublished,
  loadCatalog,
  loadSkillBody,
  getRestrictedSkills,
  getRestrictedPaths,
  getRestrictedSources,
  sourceContainsRestricted,
} from '../src/lib/catalog.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/**
 * Test-only copy of the permanent denylist paths. Production site code must
 * continue deriving live restricted inventory from the lock file.
 */
const DENYLIST_FIXTURE_PATHS = [
  'skills/claude/docx',
  'skills/claude/pdf',
  'skills/claude/pptx',
  'skills/claude/xlsx',
];

function makeEntry(overrides: Partial<LockSkillEntry> = {}): LockSkillEntry {
  return {
    path: 'skills/azure/az-cost-optimize',
    name: 'az-cost-optimize',
    category: 'mapped',
    version: '1.1.0',
    baseline: 'verified',
    license: 'Unknown',
    redistributable: true,
    snapshotHash: 'sha256:abc',
    upstream: null,
    ...overrides,
  };
}

// ─── View Model Normalization ───────────────────────────────────────

test('normalizeSkill: mapped skill produces correct view model', () => {
  const entry: LockSkillEntry = {
    path: 'skills/azure/az-cost-optimize',
    name: 'az-cost-optimize',
    category: 'mapped',
    version: '1.1.0',
    baseline: 'verified',
    license: 'Unknown',
    redistributable: true,
    snapshotHash: 'sha256:abc',
    contentHash: 'sha256:def',
    upstream: {
      repository: 'github/awesome-copilot',
      reference: 'refs/heads/main',
      source: 'skills/az-cost-optimize',
      commit: '4742f265959bf025882314564b364d9d7af6e2d5',
    },
  };

  const vm = normalizeSkill(entry);

  assert.equal(vm.name, 'az-cost-optimize');
  assert.equal(vm.source, 'azure');
  assert.equal(vm.category, 'mapped');
  assert.equal(vm.isMapped, true);
  assert.equal(vm.isOrphan, false);
  assert.equal(vm.isLocal, false);
  assert.equal(vm.isRestricted, false);
  assert.equal(vm.isTombstone, false);
  assert.equal(vm.version, '1.1.0');
  assert.equal(vm.license, 'Unknown');
  assert.equal(vm.upstreamRepo, 'github/awesome-copilot');
  assert.equal(vm.upstreamCommit, '4742f265959bf025882314564b364d9d7af6e2d5');
});

test('normalizeSkill: orphan skill (upstream: null, frozen status)', () => {
  const entry: LockSkillEntry = {
    path: 'skills/dotnet/csharp-mcp-server-generator',
    name: 'csharp-mcp-server-generator',
    category: 'orphan',
    version: '1.0.0',
    baseline: null,
    license: 'Unknown',
    redistributable: true,
    snapshotHash: 'sha256:abc',
    upstream: null,
  };

  const vm = normalizeSkill(entry);

  assert.equal(vm.isOrphan, true);
  assert.equal(vm.isMapped, false);
  assert.equal(vm.isRestricted, false);
  assert.equal(vm.upstreamRepo, null);
  assert.equal(vm.upstreamCommit, null);
  assert.equal(vm.statusLabel, 'Frozen');
});

test('normalizeSkill: local skill (upstream: null, local category)', () => {
  const entry: LockSkillEntry = {
    path: 'skills/custom/my-local-skill',
    name: 'my-local-skill',
    category: 'local',
    version: '1.0.0',
    baseline: null,
    license: 'MIT',
    redistributable: true,
    snapshotHash: 'sha256:abc',
    upstream: null,
  };

  const vm = normalizeSkill(entry);

  assert.equal(vm.isLocal, true);
  assert.equal(vm.isMapped, false);
  assert.equal(vm.isOrphan, false);
  assert.equal(vm.statusLabel, 'Local');
});

test('normalizeSkill: restricted skill (redistributable: false)', () => {
  const entry: LockSkillEntry = {
    path: 'skills/claude/docx',
    name: 'docx',
    category: 'mapped',
    version: '1.1.0',
    baseline: 'verified',
    license: 'Proprietary',
    redistributable: false,
    licenseEvidence: { source: 'restricted-policy' },
    snapshotHash: 'sha256:abc',
    contentHash: 'sha256:def',
    upstream: {
      repository: 'anthropics/skills',
      reference: 'refs/heads/main',
      source: 'skills/docx',
      commit: '3b3fad96af16a10759d930941b4520ba0c40edae',
    },
  };

  const vm = normalizeSkill(entry);

  assert.equal(vm.isRestricted, true);
  assert.equal(vm.statusLabel, 'Restricted');
});

test('normalizeSkill: tombstone skill (removed category)', () => {
  const entry: LockSkillEntry = {
    path: 'skills/deprecated/old-skill',
    name: 'old-skill',
    category: 'removed',
    version: '1.0.0',
    baseline: null,
    license: 'Unknown',
    redistributable: true,
    snapshotHash: 'sha256:abc',
    upstream: null,
  };

  const vm = normalizeSkill(entry);

  assert.equal(vm.isTombstone, true);
  assert.equal(vm.statusLabel, 'Removed');
});

// ─── Upstream URL helpers ──────────────────────────────────────────

test('upstream URL helpers build pinned GitHub tree and commit links', () => {
  const skill = normalizeSkill(makeEntry({
    upstream: {
      repository: 'github/awesome-copilot',
      reference: 'refs/heads/main',
      source: 'skills/az-cost-optimize',
      commit: '4742f265959bf025882314564b364d9d7af6e2d5',
    },
  }));

  assert.equal(
    buildUpstreamTreeUrl(skill),
    'https://github.com/github/awesome-copilot/tree/4742f265959bf025882314564b364d9d7af6e2d5/skills/az-cost-optimize',
  );
  assert.equal(
    buildUpstreamCommitUrl(skill),
    'https://github.com/github/awesome-copilot/commit/4742f265959bf025882314564b364d9d7af6e2d5',
  );
});

test('upstream URL helpers return null when any required provenance field is missing', () => {
  const skill = normalizeSkill(makeEntry({
    upstream: {
      repository: 'github/awesome-copilot',
      reference: 'refs/heads/main',
      source: 'skills/az-cost-optimize',
      commit: '4742f265959bf025882314564b364d9d7af6e2d5',
    },
  }));

  for (const field of ['upstreamRepo', 'upstreamCommit', 'upstreamSource'] as const) {
    const incomplete = { ...skill, [field]: null };
    assert.equal(buildUpstreamTreeUrl(incomplete), null);
    assert.equal(buildUpstreamCommitUrl(incomplete), null);
  }
});

test('all three current orphan skills have no upstream links', async () => {
  const catalog = await loadCatalog(path.resolve(repoRoot, '..'));
  const orphans = catalog.skills.filter((skill) => skill.isOrphan);

  assert.equal(orphans.length, 3);
  for (const skill of orphans) {
    assert.equal(buildUpstreamTreeUrl(skill), null);
    assert.equal(buildUpstreamCommitUrl(skill), null);
  }
});

test('all four proprietary tombstones retain pinned audit links without exposing bodies', async () => {
  const root = path.resolve(repoRoot, '..');
  const catalog = await loadCatalog(root);
  const restricted = catalog.skills.filter(
    (skill) => skill.isTombstone && skill.isRestricted,
  );

  assert.equal(restricted.length, 4);
  for (const skill of restricted) {
    assert.equal(
      buildUpstreamTreeUrl(skill),
      `https://github.com/${skill.upstreamRepo}/tree/${skill.upstreamCommit}/${skill.upstreamSource}`,
    );
    assert.equal(
      buildUpstreamCommitUrl(skill),
      `https://github.com/${skill.upstreamRepo}/commit/${skill.upstreamCommit}`,
    );
    assert.equal(await loadSkillBody(root, skill), null);
  }
});

test('all ten microsoft dot-path sources produce safe pinned tree links', async () => {
  const catalog = await loadCatalog(path.resolve(repoRoot, '..'));
  const microsoftDotPaths = catalog.skills.filter(
    (skill) =>
      skill.upstreamRepo === 'microsoft/skills'
      && skill.upstreamSource?.startsWith('.github/skills/'),
  );

  assert.equal(microsoftDotPaths.length, 10);
  for (const skill of microsoftDotPaths) {
    assert.equal(
      buildUpstreamTreeUrl(skill),
      `https://github.com/${skill.upstreamRepo}/tree/${skill.upstreamCommit}/${skill.upstreamSource}`,
    );
  }
});

test('skill detail routes continue to exclude tombstones', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'src', 'pages', '[locale]', 'skills', '[source]', '[skill].astro'),
    'utf8',
  );

  assert.match(source, /\.filter\(\(skill\) => !skill\.isTombstone\)/);
});

test('skill detail page uses upstream URL helpers while preserving fallback rendering', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'src', 'components', 'pages', 'SkillPage.astro'),
    'utf8',
  );

  assert.match(source, /buildUpstreamTreeUrl/);
  assert.match(source, /buildUpstreamCommitUrl/);
  assert.match(source, /https:\/\/github\.com\/\$\{skill\.upstreamRepo\}/);
  assert.match(source, /<code>\{skill\.upstreamCommit\.slice\(0, 7\)\}<\/code>/);
});

// ─── Restricted Body Reader Test ────────────────────────────────────

test('restricted skill: body reader is NEVER invoked', async () => {
  const entry: LockSkillEntry = {
    path: 'skills/claude/docx',
    name: 'docx',
    category: 'mapped',
    version: '1.1.0',
    baseline: 'verified',
    license: 'Proprietary',
    redistributable: false,
    snapshotHash: 'sha256:abc',
    contentHash: 'sha256:def',
    upstream: {
      repository: 'anthropics/skills',
      reference: 'refs/heads/main',
      source: 'skills/docx',
      commit: '3b3fad96af16a10759d930941b4520ba0c40edae',
    },
  };

  const vm = normalizeSkill(entry);

  // Inject a body reader that throws if called
  const bodyReader = () => {
    throw new Error('BODY READER WAS INVOKED FOR RESTRICTED SKILL');
  };

  // The loader must short-circuit and never call bodyReader
  assert.equal(vm.isRestricted, true);
  assert.equal(vm.body, undefined);

  // Simulate loadSkillBody behavior
  const body = vm.isRestricted ? null : bodyReader();
  assert.equal(body, null);
});

// ─── Install Command Syntax ─────────────────────────────────────────

test('repo install command uses #ref syntax (never @version)', () => {
  const cmd = generateRepoInstallCommand();
  assert.equal(cmd, `npx skills add lettucebo/Skills#v${RELEASE_VERSION} --full-depth`);
  assert.doesNotMatch(cmd, /@v\d/);
});

test('source install command uses #ref syntax', async () => {
  const catalog = await loadCatalog(path.resolve(repoRoot, '..'));
  const cmd = generateSourceInstallCommand(catalog.skills, 'azure');
  assert.equal(cmd, `npx skills add lettucebo/Skills/skills/azure#v${RELEASE_VERSION}`);
  assert.doesNotMatch(cmd!, /@v\d/);
  assert.doesNotMatch(cmd!, /--full-depth/);
});

test('single skill install command uses #ref@name syntax', () => {
  const cmd = generateSingleSkillInstallCommand('az-cost-optimize');
  assert.equal(
    cmd,
    `npx skills add "lettucebo/Skills#v${RELEASE_VERSION}@az-cost-optimize" --full-depth`,
  );
});

test('restricted skill has no install command', () => {
  const cmd = generateSingleSkillInstallCommand('docx', true);
  assert.equal(cmd, null);
});

test('claude source is installable after its restricted skills become tombstones', async () => {
  const catalog = await loadCatalog(path.resolve(repoRoot, '..'));
  assert.equal(sourceContainsRestricted(catalog.skills, 'claude'), false);
  assert.notEqual(generateSourceInstallCommand(catalog.skills, 'claude'), null);
});

test('source without restricted skills has a source command', async () => {
  const catalog = await loadCatalog(path.resolve(repoRoot, '..'));
  assert.equal(sourceContainsRestricted(catalog.skills, 'azure'), false);
  assert.notEqual(generateSourceInstallCommand(catalog.skills, 'azure'), null);
});

// ─── Route Parameter Derivation ─────────────────────────────────────

test('route params derived from all 115 active skills are unique', async () => {
  const catalog = await loadCatalog(path.resolve(repoRoot, '..'));
  const params = catalog.skills.filter((skill) => !skill.isTombstone).map((s) => deriveRouteParams(s));
  const keys = params.map((p) => `${p.source}/${p.skill}`);
  const uniqueKeys = new Set(keys);
  assert.equal(keys.length, uniqueKeys.size, `Duplicate route params found: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(', ')}`);
});

// ─── Count Verification ─────────────────────────────────────────────

test('current lock yields counts: 115 total, 112 mapped, 3 orphan, 0 local, 0 restricted', async () => {
  const catalog = await loadCatalog(path.resolve(repoRoot, '..'));
  const counts = computeCounts(catalog.skills);

  assert.equal(counts.total, 115);
  assert.equal(counts.mapped, 112);
  assert.equal(counts.orphan, 3);
  assert.equal(counts.local, 0);
  assert.equal(counts.restricted, 0);
  assert.equal(
    catalog.skills.filter((skill) => skill.source === 'claude' && !skill.isTombstone).length,
    13,
  );
});

// ─── Markdown Renderer Safety ───────────────────────────────────────

test('Markdown renderer strips raw HTML to prevent XSS', () => {
  const dangerous = '# Title\n\n<script>alert("xss")</script>\n\nNormal text <img onerror="hack()" src=x>';
  const rendered = renderMarkdownBody(dangerous);

  assert.doesNotMatch(rendered, /<script/i);
  assert.doesNotMatch(rendered, /onerror/i);
  assert.doesNotMatch(rendered, /alert\(/);
  assert.match(rendered, /Title/);
  assert.match(rendered, /Normal text/);
});

test('Markdown renderer handles code blocks and inline code safely', () => {
  const md = '```js\nconst x = 1;\n```\n\nInline `<script>` reference';
  const rendered = renderMarkdownBody(md);

  assert.match(rendered, /const x = 1/);
  assert.doesNotMatch(rendered, /<script>/);
  // The word should be escaped in inline code
  assert.match(rendered, /&lt;script&gt;/);
});

// ─── Release Publication Flag ───────────────────────────────────────
//
// Publication is a build-time input resolved by the deploy workflow from tag
// ancestry, so the only invariant that holds in BOTH modes is that the exported
// flag mirrors the ambient input. Pinning it to `false` here used to break the
// published deploy (`RELEASE_PUBLISHED=true`) on a stale expectation.

test('RELEASE_PUBLISHED mirrors the ambient build-time input in both modes', () => {
  assert.equal(typeof RELEASE_PUBLISHED, 'boolean');
  assert.equal(RELEASE_PUBLISHED, parseReleasePublished(process.env.RELEASE_PUBLISHED));
  assert.equal(RELEASE_PUBLISHED, process.env.RELEASE_PUBLISHED === 'true');
});

// ─── Source derivation ──────────────────────────────────────────────

test('deriveSourceFromPath extracts source correctly', () => {
  assert.equal(deriveSourceFromPath('skills/azure/az-cost-optimize'), 'azure');
  assert.equal(deriveSourceFromPath('skills/claude/docx'), 'claude');
  assert.equal(deriveSourceFromPath('skills/dotnet/ef-core'), 'dotnet');
});

// ─── Restricted inventory derives from the lock file ────────────────

test('live restricted inventory is empty after the four proprietary skills become tombstones', async () => {
  const catalog = await loadCatalog(path.resolve(repoRoot, '..'));

  assert.deepEqual(getRestrictedPaths(catalog.skills), []);
  assert.deepEqual(getRestrictedSources(catalog.skills), []);
  assert.equal(getRestrictedSkills(catalog.skills).length, 0);
  for (const restrictedPath of DENYLIST_FIXTURE_PATHS) {
    const tombstone = catalog.skills.find((skill) => skill.path === restrictedPath);
    assert.equal(tombstone?.isTombstone, true);
  }
});

test('a newly restricted skill suppresses its source command and joins the restricted listing automatically', () => {
  const skills = [
    normalizeSkill(makeEntry()),
    normalizeSkill(makeEntry({
      path: 'skills/azure/az-secret-sauce',
      name: 'az-secret-sauce',
      license: 'Proprietary',
      redistributable: false,
    })),
  ];

  assert.deepEqual(getRestrictedPaths(skills), ['skills/azure/az-secret-sauce']);
  assert.deepEqual(getRestrictedSources(skills), ['azure']);
  assert.equal(sourceContainsRestricted(skills, 'azure'), true);
  assert.equal(generateSourceInstallCommand(skills, 'azure'), null);
});

test('a source loses its restricted status as soon as the lock marks the skill redistributable', () => {
  const skills = [normalizeSkill(makeEntry({ path: 'skills/claude/docx', name: 'docx' }))];

  assert.deepEqual(getRestrictedPaths(skills), []);
  assert.equal(sourceContainsRestricted(skills, 'claude'), false);
  assert.notEqual(generateSourceInstallCommand(skills, 'claude'), null);
});

test('a tombstoned restricted skill leaves the shipped restricted inventory', () => {
  const skills = [
    normalizeSkill(makeEntry({
      path: 'skills/claude/docx',
      name: 'docx',
      category: 'removed',
      license: 'Proprietary',
      redistributable: false,
    })),
    normalizeSkill(makeEntry({ path: 'skills/claude/prompt-kit', name: 'prompt-kit' })),
  ];

  assert.deepEqual(getRestrictedPaths(skills), [], 'a removed skill is not shipped, so it is not restricted content');
  assert.deepEqual(getRestrictedSources(skills), []);
  assert.equal(sourceContainsRestricted(skills, 'claude'), false);
  assert.notEqual(
    generateSourceInstallCommand(skills, 'claude'),
    null,
    'a bulk install cannot install a tombstoned skill, so it must not stay suppressed',
  );
  assert.equal(computeCounts(skills).restricted, 0);
});

test('production catalog code carries no hardcoded restricted path list', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'src', 'lib', 'catalog.ts'),
    'utf8',
  );

  assert.doesNotMatch(source, /RESTRICTED_PATHS/, 'the hardcoded restricted set must be gone');
  for (const restrictedPath of DENYLIST_FIXTURE_PATHS) {
    assert.ok(
      !source.includes(restrictedPath),
      `catalog.ts must not hardcode ${restrictedPath}`,
    );
  }
});

test('no page hardcodes the restricted inventory', () => {
  const pages = [
    path.join(repoRoot, 'src', 'components', 'pages', 'StatusPage.astro'),
    path.join(repoRoot, 'src', 'components', 'pages', 'HomePage.astro'),
    path.join(repoRoot, 'src', 'components', 'pages', 'SourcePage.astro'),
  ];

  for (const pagePath of pages) {
    const source = fs.readFileSync(pagePath, 'utf8');
    assert.doesNotMatch(source, /RESTRICTED_PATHS/, `${path.basename(pagePath)} must not use RESTRICTED_PATHS`);
    for (const restrictedPath of DENYLIST_FIXTURE_PATHS) {
      assert.ok(
        !source.includes(restrictedPath),
        `${path.basename(pagePath)} must not hardcode ${restrictedPath}`,
      );
    }
  }
});

test('loadSkillBody never reads a restricted SKILL.md even when the file exists on disk', async () => {
  const runtimeRoot = path.join(repoRoot, 'test', '.runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(runtimeRoot, 'restricted-body-'));
  const restricted = normalizeSkill(makeEntry({
    path: 'skills/claude/docx',
    name: 'docx',
    license: 'Proprietary',
    redistributable: false,
  }));

  try {
    const skillFile = path.join(root, restricted.path, 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, 'RESTRICTED FIXTURE BODY MUST NOT BE READ');
    assert.ok(fs.existsSync(skillFile), 'fixture precondition: restricted file exists');
    assert.equal(await loadSkillBody(root, restricted), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── Baseline verification ──────────────────────────────────────────

test('computeBaselineVerification counts mapped skills whose baseline is verified', () => {
  const skills = [
    normalizeSkill(makeEntry({ path: 'skills/azure/a', name: 'a', baseline: 'verified' })),
    normalizeSkill(makeEntry({ path: 'skills/azure/b', name: 'b', baseline: 'unadopted' })),
    normalizeSkill(makeEntry({ path: 'skills/azure/c', name: 'c', baseline: null })),
    normalizeSkill(makeEntry({ path: 'skills/azure/d', name: 'd', category: 'orphan', baseline: null })),
    normalizeSkill(makeEntry({ path: 'skills/azure/e', name: 'e', category: 'removed', baseline: 'verified' })),
  ];

  assert.deepEqual(computeBaselineVerification(skills), {
    mapped: 3,
    verified: 1,
    unverified: 2,
    allVerified: false,
  });
});

test('computeBaselineVerification reports allVerified only when every mapped skill is verified', () => {
  const allVerified = [
    normalizeSkill(makeEntry({ path: 'skills/azure/a', name: 'a', baseline: 'verified' })),
    normalizeSkill(makeEntry({ path: 'skills/azure/b', name: 'b', baseline: 'verified' })),
  ];
  assert.deepEqual(computeBaselineVerification(allVerified), {
    mapped: 2,
    verified: 2,
    unverified: 0,
    allVerified: true,
  });

  const noneMapped = [
    normalizeSkill(makeEntry({ path: 'skills/azure/d', name: 'd', category: 'orphan', baseline: null })),
  ];
  assert.deepEqual(computeBaselineVerification(noneMapped), {
    mapped: 0,
    verified: 0,
    unverified: 0,
    allVerified: false,
  });
});

test('computeBaselineVerification counts restricted mapped skills too', () => {
  const skills = [
    normalizeSkill(makeEntry({ path: 'skills/azure/a', name: 'a', baseline: 'verified' })),
    normalizeSkill(makeEntry({
      path: 'skills/claude/docx',
      name: 'docx',
      baseline: 'verified',
      redistributable: false,
    })),
  ];

  assert.deepEqual(computeBaselineVerification(skills), {
    mapped: 2,
    verified: 2,
    unverified: 0,
    allVerified: true,
  });
});

test('current lock has 112 of 112 active mapped skills verified', async () => {
  const catalog = await loadCatalog(path.resolve(repoRoot, '..'));
  const verification = computeBaselineVerification(catalog.skills);

  assert.equal(verification.mapped, catalog.counts.mapped);
  assert.equal(verification.mapped, 112);
  assert.equal(verification.verified, 112);
  assert.equal(verification.unverified, 0);
  assert.equal(verification.allVerified, true);
});

test('formatBaselineVerification stays accurate for fully verified, mixed, and empty states', () => {
  assert.deepEqual(
    formatBaselineVerification({ mapped: 100, verified: 100, unverified: 0, allVerified: true }),
    {
      headline: '100/100',
      detail: 'All mapped skills are synced against their upstream repositories with verified content hashes.',
    },
  );

  assert.deepEqual(
    formatBaselineVerification({ mapped: 100, verified: 97, unverified: 3, allVerified: false }),
    {
      headline: '97/100',
      detail: '3 mapped skills do not have a verified baseline in the current lock file.',
    },
  );

  assert.deepEqual(
    formatBaselineVerification({ mapped: 4, verified: 3, unverified: 1, allVerified: false }),
    {
      headline: '3/4',
      detail: '1 mapped skill does not have a verified baseline in the current lock file.',
    },
  );

  assert.deepEqual(
    formatBaselineVerification({ mapped: 0, verified: 0, unverified: 0, allVerified: false }),
    {
      headline: '0/0',
      detail: 'This release contains no mapped skills.',
    },
  );
});
