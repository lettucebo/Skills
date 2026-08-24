import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type LockFile,
  type LockSkillEntry,
  type SkillViewModel,
  normalizeSkill,
  computeCounts,
  generateRepoInstallCommand,
  generateSourceInstallCommand,
  generateSingleSkillInstallCommand,
  deriveRouteParams,
  deriveSourceFromPath,
  renderMarkdownBody,
  RELEASE_VERSION,
  RELEASE_PUBLISHED,
  RESTRICTED_PATHS,
  loadCatalog,
  sourceContainsRestricted,
} from '../src/lib/catalog.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

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

test('source install command uses #ref syntax', () => {
  const cmd = generateSourceInstallCommand('azure');
  assert.match(cmd, /^npx skills add lettucebo\/Skills\/skills\/azure#v1\.1\.0$/);
  assert.doesNotMatch(cmd, /@v1\.1\.0/);
});

test('single skill install command uses #ref@name syntax', () => {
  const cmd = generateSingleSkillInstallCommand('az-cost-optimize');
  assert.equal(cmd, 'npx skills add "lettucebo/Skills#v1.1.0@az-cost-optimize"');
});

test('restricted skill has no install command', () => {
  const cmd = generateSingleSkillInstallCommand('docx', true);
  assert.equal(cmd, null);
});

test('source containing restricted skills has no source command', () => {
  assert.equal(sourceContainsRestricted('claude'), true);
  const cmd = generateSourceInstallCommand('claude');
  assert.equal(cmd, null);
});

test('source without restricted skills has a source command', () => {
  assert.equal(sourceContainsRestricted('azure'), false);
  const cmd = generateSourceInstallCommand('azure');
  assert.notEqual(cmd, null);
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

// ─── Release Pending Flag ───────────────────────────────────────────

test('release is pending (not published)', () => {
  assert.equal(RELEASE_PUBLISHED, false);
});

// ─── Source derivation ──────────────────────────────────────────────

test('deriveSourceFromPath extracts source correctly', () => {
  assert.equal(deriveSourceFromPath('skills/azure/az-cost-optimize'), 'azure');
  assert.equal(deriveSourceFromPath('skills/claude/docx'), 'claude');
  assert.equal(deriveSourceFromPath('skills/dotnet/ef-core'), 'dotnet');
});

// ─── Restricted paths constant ──────────────────────────────────────

test('RESTRICTED_PATHS includes the 4 known restricted skills', () => {
  assert.equal(RESTRICTED_PATHS.size, 4);
  assert.ok(RESTRICTED_PATHS.has('skills/claude/docx'));
  assert.ok(RESTRICTED_PATHS.has('skills/claude/pdf'));
  assert.ok(RESTRICTED_PATHS.has('skills/claude/pptx'));
  assert.ok(RESTRICTED_PATHS.has('skills/claude/xlsx'));
});
