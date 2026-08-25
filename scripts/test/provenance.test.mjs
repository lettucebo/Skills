/**
 * Provenance invariants for the verified upstream baseline.
 *
 * These assertions encode source-of-truth decisions that were established by
 * inspecting the upstream repositories directly. They exist so a future edit
 * cannot silently reintroduce an unreproducible mapping.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BASELINE_RELEASE, BASELINE_VERSION } from '../lib/baseline.mjs';
import { loadManifest } from '../lib/manifest.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = path.join(repoRoot, 'catalog', 'sources.yml');

/**
 * Skills that microsoft/skills genuinely publishes. Their installable copies
 * live under `.github/skills/<name>`, not `skills/<name>`.
 */
const MICROSOFT_OWNED_SKILLS = [
  'cloud-solution-architect',
  'continual-learning',
  'copilot-sdk',
  'entra-agent-id',
  'frontend-design-review',
  'github-issue-creator',
  'mcp-builder',
  'microsoft-docs',
  'podcast-generation',
  'skill-creator',
];

/**
 * Vendored under `skills/microsoft/` but absent from microsoft/skills. The local
 * content is byte-identical to github/awesome-copilot, which is the real source.
 */
const REATTRIBUTED_TO_AWESOME_COPILOT = [
  'microsoft-agent-framework',
  'microsoft-code-reference',
];

/**
 * Every formal skill directory published by cloudflare/skills. The registry
 * mirrors this set exactly.
 */
const CLOUDFLARE_UPSTREAM_SKILLS = [
  'agents-sdk',
  'cloudflare',
  'cloudflare-email-service',
  'cloudflare-one',
  'cloudflare-one-migrations',
  'durable-objects',
  'sandbox-migrate-to-next',
  'sandbox-next',
  'sandbox-stable',
  'turnstile-spin',
  'web-perf',
  'workers-best-practices',
  'wrangler',
];

test('microsoft mappings use the canonical .github/skills source root', async () => {
  const manifest = await loadManifest(manifestPath);
  const microsoftMappings = manifest.mappings.filter(
    (mapping) => mapping.upstream === 'microsoft',
  );

  assert.deepEqual(
    microsoftMappings.map((mapping) => mapping.source).sort(),
    MICROSOFT_OWNED_SKILLS.map((name) => `.github/skills/${name}`).sort(),
  );
});

test('skills absent from microsoft/skills are attributed to their real upstream', async () => {
  const manifest = await loadManifest(manifestPath);

  for (const name of REATTRIBUTED_TO_AWESOME_COPILOT) {
    const mapping = manifest.mappings.find(
      (entry) => entry.path === `skills/microsoft/${name}`,
    );

    assert.ok(mapping, `expected a mapping for skills/microsoft/${name}`);
    assert.equal(mapping.upstream, 'awesome-copilot');
    assert.equal(mapping.source, `skills/${name}`);
  }
});

test('cloudflare mirrors every formal upstream skill directory exactly once', async () => {
  const manifest = await loadManifest(manifestPath);
  const cloudflareMappings = manifest.mappings.filter(
    (mapping) => mapping.upstream === 'cloudflare',
  );

  assert.deepEqual(
    cloudflareMappings.map((mapping) => mapping.source).sort(),
    CLOUDFLARE_UPSTREAM_SKILLS.map((name) => `skills/${name}`).sort(),
  );
});

test('cloudflare folder names match upstream skill names one-to-one', async () => {
  const manifest = await loadManifest(manifestPath);
  const cloudflareMappings = manifest.mappings.filter(
    (mapping) => mapping.upstream === 'cloudflare',
  );

  for (const mapping of cloudflareMappings) {
    assert.equal(
      mapping.path,
      `skills/cloudflare/${mapping.source.slice('skills/'.length)}`,
      `${mapping.path} diverges from its upstream folder name`,
    );
  }
});

test('no override renames a local skill folder away from upstream', async () => {
  const manifest = await loadManifest(manifestPath);

  for (const override of manifest.overrides) {
    assert.notEqual(
      override.transform,
      'rename-local-skill',
      `override ${override.path} keeps a stale local folder name`,
    );
  }
});

test('no mapping depends on an unimplemented command-to-skill transform', async () => {
  const manifest = await loadManifest(manifestPath);

  for (const mapping of manifest.mappings) {
    assert.ok(
      mapping.source.startsWith('skills/') || mapping.source.startsWith('.github/skills/')
        || mapping.source.startsWith('plugins/'),
      `mapping ${mapping.path} has a non-skill source: ${mapping.source}`,
    );
  }

  for (const override of manifest.overrides) {
    assert.notEqual(
      override.transform,
      'command-to-skill',
      `override ${override.path} still declares an unimplemented transform`,
    );
  }
});

test('the registry covers 116 mapped skills and 3 frozen orphans', async () => {
  const manifest = await loadManifest(manifestPath);

  assert.equal(manifest.mappings.length, 116);
  assert.equal(manifest.orphans.length, 3);
});

test('the verified baseline publishes the approved 1.1.0 release', () => {
  assert.equal(BASELINE_RELEASE, '1.1.0');
  assert.equal(BASELINE_VERSION, '1.1.0');
});
