import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLinkExceptionKey } from '../lib/links.mjs';
import { loadManifest } from '../lib/manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const runtimeRoot = path.join(__dirname, '.runtime');

async function withFixture(name, run) {
  const fixtureRoot = path.join(
    runtimeRoot,
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  await mkdir(fixtureRoot, { recursive: true });

  try {
    return await run(fixtureRoot);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function writeManifest(fixtureRoot, content) {
  const manifestPath = path.join(fixtureRoot, 'catalog', 'sources.yml');
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, content);
  return manifestPath;
}

async function createSkill(fixtureRoot, relativeSkillPath) {
  const skillDir = path.join(fixtureRoot, relativeSkillPath);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: fixture-skill\ndescription: Fixture skill\n---\n',
  );
}

async function countExistingLocalSkills(root, localEntries) {
  let total = 0;

  for (const entry of localEntries) {
    const absoluteRoot = path.join(root, entry.root);

    try {
      total += await countSkillMarkdownFiles(absoluteRoot);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return total;
}

async function countSkillMarkdownFiles(root) {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      total += await countSkillMarkdownFiles(absolutePath);
      continue;
    }

    if (entry.isFile() && entry.name === 'SKILL.md') {
      total += 1;
    }
  }

  return total;
}

test('loadManifest rejects mappings that reference unknown upstreams', async () => {
  await withFixture('missing-upstream', async (fixtureRoot) => {
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'));

    const manifestPath = await writeManifest(
      fixtureRoot,
      `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: missing-upstream
    source: skills/alpha
orphans: []
local: []
overrides: []
`,
    );

    await assert.rejects(
      loadManifest(manifestPath),
      /Unknown upstream "missing-upstream"/,
    );
  });
});

test('loadManifest rejects duplicate coverage in mappings', async () => {
  await withFixture('duplicate-mapping', async (fixtureRoot) => {
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'));

    const manifestPath = await writeManifest(
      fixtureRoot,
      `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: awesome-copilot
    source: skills/alpha
  - path: skills/azure/alpha
    upstream: awesome-copilot
    source: skills/alpha-copy
orphans: []
local: []
overrides: []
`,
    );

    await assert.rejects(
      loadManifest(manifestPath),
      /covered more than once: skills\/azure\/alpha/,
    );
  });
});

test('loadManifest rejects overrides whose declared source disagrees with the mapping source', async () => {
  await withFixture('override-source-mismatch', async (fixtureRoot) => {
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'));

    const manifestPath = await writeManifest(
      fixtureRoot,
      `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: awesome-copilot
    source: skills/alpha
orphans: []
local: []
overrides:
  - path: skills/azure/alpha
    transform: rename-local-skill
    source: skills/beta
`,
    );

    await assert.rejects(
      loadManifest(manifestPath),
      /Override source mismatch for skills\/azure\/alpha: expected skills\/alpha, received skills\/beta/,
    );
  });
});

test('loadManifest rejects the same skill path across categories', async () => {
  await withFixture('multi-category', async (fixtureRoot) => {
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'));

    const manifestPath = await writeManifest(
      fixtureRoot,
      `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: awesome-copilot
    source: skills/alpha
orphans:
  - path: skills/azure/alpha
    note: Intentional orphan
local: []
overrides: []
`,
    );

    await assert.rejects(
      loadManifest(manifestPath),
      /covered more than once: skills\/azure\/alpha/,
    );
  });
});

test('loadManifest rejects uncovered skills', async () => {
  await withFixture('uncovered-skill', async (fixtureRoot) => {
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'));
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'beta'));

    const manifestPath = await writeManifest(
      fixtureRoot,
      `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: awesome-copilot
    source: skills/alpha
orphans: []
local: []
overrides: []
`,
    );

    await assert.rejects(
      loadManifest(manifestPath),
      /Uncovered skill paths: skills\/azure\/beta/,
    );
  });
});

test('loadManifest rejects duplicate link exception keys', async () => {
  await withFixture('duplicate-link-exception', async (fixtureRoot) => {
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'));

    const manifestPath = await writeManifest(
      fixtureRoot,
      `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: awesome-copilot
    source: skills/alpha
orphans: []
local: []
overrides: []
linkExceptions:
  - sourcePath: skills/azure/alpha/SKILL.md
    target: references/missing.md
    reason: First declaration.
    upstreamUrl: https://example.invalid/awesome-copilot
  - sourcePath: skills/azure/alpha/SKILL.md
    target: references/missing.md
    reason: Duplicate declaration.
    upstreamUrl: https://example.invalid/awesome-copilot
`,
    );

    await assert.rejects(
      loadManifest(manifestPath),
      /Link exception declared more than once: skills\/azure\/alpha\/SKILL\.md -> references\/missing\.md/,
    );
  });
});

test('loadManifest rejects absolute link exception source paths', async () => {
  await withFixture('absolute-link-exception-source', async (fixtureRoot) => {
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'));

    const manifestPath = await writeManifest(
      fixtureRoot,
      `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: awesome-copilot
    source: skills/alpha
orphans: []
local: []
overrides: []
linkExceptions:
  - sourcePath: /skills/azure/alpha/SKILL.md
    target: references/missing.md
    reason: Invalid absolute source path.
    upstreamUrl: https://example.invalid/awesome-copilot
`,
    );

    await assert.rejects(
      loadManifest(manifestPath),
      /linkExceptions\[0\]\.sourcePath must be a repository-relative path\./,
    );
  });
});

test('loadManifest rejects non-relative link exception targets', async () => {
  await withFixture('absolute-link-exception-target', async (fixtureRoot) => {
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'));

    const manifestPath = await writeManifest(
      fixtureRoot,
      `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: awesome-copilot
    source: skills/alpha
orphans: []
local: []
overrides: []
linkExceptions:
  - sourcePath: skills/azure/alpha/SKILL.md
    target: https://example.invalid/missing.md
    reason: Invalid absolute target.
    upstreamUrl: https://example.invalid/awesome-copilot
`,
    );

    await assert.rejects(
      loadManifest(manifestPath),
      /linkExceptions\[0\]\.target must be a relative link target\./,
    );
  });
});

test('loadManifest rejects link exceptions without reasons', async () => {
  await withFixture('missing-link-exception-reason', async (fixtureRoot) => {
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'));

    const manifestPath = await writeManifest(
      fixtureRoot,
      `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: awesome-copilot
    source: skills/alpha
orphans: []
local: []
overrides: []
linkExceptions:
  - sourcePath: skills/azure/alpha/SKILL.md
    target: references/missing.md
    reason: ""
    upstreamUrl: https://example.invalid/awesome-copilot
`,
    );

    await assert.rejects(
      loadManifest(manifestPath),
      /linkExceptions\[0\]\.reason must be a non-empty string\./,
    );
  });
});

test('loadManifest rejects link exceptions whose source file does not exist', async () => {
  await withFixture('missing-link-exception-source-file', async (fixtureRoot) => {
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'));

    const manifestPath = await writeManifest(
      fixtureRoot,
      `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: awesome-copilot
    source: skills/alpha
orphans: []
local: []
overrides: []
linkExceptions:
  - sourcePath: skills/azure/alpha/references/missing.md
    target: references/also-missing.md
    reason: Source file is absent.
    upstreamUrl: https://example.invalid/awesome-copilot
`,
    );

    await assert.rejects(
      loadManifest(manifestPath),
      /Link exception source file does not exist: skills\/azure\/alpha\/references\/missing\.md/,
    );
  });
});

test('createLinkExceptionKey builds the manifest and validator match key', () => {
  assert.equal(
    createLinkExceptionKey('skills/azure/alpha/SKILL.md', 'references/missing.md'),
    'skills/azure/alpha/SKILL.md -> references/missing.md',
  );
});

test('loadManifest rejects link exceptions whose source path is outside any discovered skill root', async () => {
  await withFixture('link-exception-non-skill-source', async (fixtureRoot) => {
    await createSkill(fixtureRoot, path.join('skills', 'azure', 'alpha'));
    await writeFile(path.join(fixtureRoot, 'README.md'), '# Fixture repo\n');

    const manifestPath = await writeManifest(
      fixtureRoot,
      `
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: awesome-copilot
    source: skills/alpha
orphans: []
local: []
overrides: []
linkExceptions:
  - sourcePath: README.md
    target: references/missing.md
    reason: Invalid non-skill source path.
    upstreamUrl: https://example.invalid/awesome-copilot
`,
    );

    await assert.rejects(
      loadManifest(manifestPath),
      /Link exception sourcePath is outside any discovered skill root: README\.md/,
    );
  });
});

test('loadManifest accepts the repository manifest with exact 119-skill coverage', async () => {
  const manifestPath = path.join(repoRoot, 'catalog', 'sources.yml');
  const manifest = await loadManifest(manifestPath);
  const localCoverage = await countExistingLocalSkills(repoRoot, manifest.local);
  const coveredSkills =
    manifest.mappings.length + manifest.orphans.length + localCoverage;

  assert.equal(manifest.mappings.length, 116);
  assert.equal(manifest.orphans.length, 3);
  assert.equal(manifest.linkExceptions.length, 3);
  assert.equal(localCoverage, 0);
  assert.equal(coveredSkills, 119);
  assert.equal(
    manifest.local.map((entry) => entry.root).join(','),
    'skills/lettucebo',
  );
  assert.deepEqual(
    manifest.linkExceptions
      .map((entry) => createLinkExceptionKey(entry.sourcePath, entry.target))
      .sort(),
    [
      'skills/cloudflare/cloudflare/references/durable-objects/README.md -> ../websockets/README.md',
      'skills/cloudflare/cloudflare/references/tunnel/README.md -> ../access/',
      'skills/cloudflare/cloudflare/references/tunnel/README.md -> ../warp/',
    ],
  );

  const manifestText = await readFile(manifestPath, 'utf8');
  assert.match(manifestText, /path: skills\/vscode\/code-review/);
});
