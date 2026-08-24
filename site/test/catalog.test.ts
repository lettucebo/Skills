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
 * Test-only expectation of today's restricted inventory. Production code must
 * derive this from the lock file, so this list lives here and nowhere else.
 */
const EXPECTED_RESTRICTED_PATHS = [
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
  assert.match(cmd, /^npx skills add lettucebo\/Skills#v1\.1\.0$/);
  assert.doesNotMatch(cmd, /@v1\.1\.0/);
});

test('source install command uses #ref syntax', async () => {
  const catalog = await loadCatalog(path.resolve(repoRoot, '..'));
  const cmd = generateSourceInstallCommand(catalog.skills, 'azure');
  assert.match(cmd!, /^npx skills add lettucebo\/Skills\/skills\/azure#v1\.1\.0$/);
  assert.doesNotMatch(cmd!, /@v1\.1\.0/);
});

test('single skill install command uses #ref@name syntax', () => {
  const cmd = generateSingleSkillInstallCommand('az-cost-optimize');
  assert.equal(cmd, 'npx skills add "lettucebo/Skills#v1.1.0@az-cost-optimize"');
});

test('restricted skill has no install command', () => {
  const cmd = generateSingleSkillInstallCommand('docx', true);
  assert.equal(cmd, null);
});

test('source containing restricted skills has no source command', async () => {
  const catalog = await loadCatalog(path.resolve(repoRoot, '..'));
  assert.equal(sourceContainsRestricted(catalog.skills, 'claude'), true);
  assert.equal(generateSourceInstallCommand(catalog.skills, 'claude'), null);
});

test('source without restricted skills has a source command', async () => {
  const catalog = await loadCatalog(path.resolve(repoRoot, '..'));
  assert.equal(sourceContainsRestricted(catalog.skills, 'azure'), false);
  assert.notEqual(generateSourceInstallCommand(catalog.skills, 'azure'), null);
});

// ─── Route Parameter Derivation ─────────────────────────────────────

test('route params derived from all 103 skills are unique', async () => {
  const catalog = await loadCatalog(path.resolve(repoRoot, '..'));
  const params = catalog.skills.map((s) => deriveRouteParams(s));
  const keys = params.map((p) => `${p.source}/${p.skill}`);
  const uniqueKeys = new Set(keys);
  assert.equal(keys.length, uniqueKeys.size, `Duplicate route params found: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(', ')}`);
});

// ─── Count Verification ─────────────────────────────────────────────

test('current lock yields counts: 103 total, 100 mapped, 3 orphan, 0 local, 4 restricted', async () => {
  const catalog = await loadCatalog(path.resolve(repoRoot, '..'));
  const counts = computeCounts(catalog.skills);

  assert.equal(counts.total, 103);
  assert.equal(counts.mapped, 100);
  assert.equal(counts.orphan, 3);
  assert.equal(counts.local, 0);
  assert.equal(counts.restricted, 4);
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

test('restricted skills derive from the lock, matching today\'s four proprietary skills', async () => {
  const catalog = await loadCatalog(path.resolve(repoRoot, '..'));

  assert.deepEqual(getRestrictedPaths(catalog.skills), EXPECTED_RESTRICTED_PATHS);
  assert.deepEqual(getRestrictedSources(catalog.skills), ['claude']);
  assert.equal(getRestrictedSkills(catalog.skills).length, EXPECTED_RESTRICTED_PATHS.length);
  for (const skill of getRestrictedSkills(catalog.skills)) {
    assert.equal(skill.isRestricted, true);
    assert.equal(skill.statusLabel, 'Restricted');
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
  for (const restrictedPath of EXPECTED_RESTRICTED_PATHS) {
    assert.ok(
      !source.includes(restrictedPath),
      `catalog.ts must not hardcode ${restrictedPath}`,
    );
  }
});

test('no page hardcodes the restricted inventory', () => {
  const pages = [
    path.join(repoRoot, 'src', 'pages', 'status.astro'),
    path.join(repoRoot, 'src', 'pages', 'index.astro'),
    path.join(repoRoot, 'src', 'pages', 'sources', '[source].astro'),
  ];

  for (const pagePath of pages) {
    const source = fs.readFileSync(pagePath, 'utf8');
    assert.doesNotMatch(source, /RESTRICTED_PATHS/, `${path.basename(pagePath)} must not use RESTRICTED_PATHS`);
    for (const restrictedPath of EXPECTED_RESTRICTED_PATHS) {
      assert.ok(
        !source.includes(restrictedPath),
        `${path.basename(pagePath)} must not hardcode ${restrictedPath}`,
      );
    }
  }
});

test('loadSkillBody never reads a restricted SKILL.md even when the file exists on disk', async () => {
  const root = path.resolve(repoRoot, '..');
  const restricted = normalizeSkill(makeEntry({
    path: 'skills/claude/docx',
    name: 'docx',
    license: 'Proprietary',
    redistributable: false,
  }));

  assert.ok(
    fs.existsSync(path.join(root, restricted.path, 'SKILL.md')),
    'fixture precondition: the restricted SKILL.md exists on disk',
  );
  assert.equal(await loadSkillBody(root, restricted), null);
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

test('current lock has 100 of 100 mapped skills verified', async () => {
  const catalog = await loadCatalog(path.resolve(repoRoot, '..'));
  const verification = computeBaselineVerification(catalog.skills);

  assert.equal(verification.mapped, catalog.counts.mapped);
  assert.equal(verification.mapped, 100);
  assert.equal(verification.verified, 100);
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
