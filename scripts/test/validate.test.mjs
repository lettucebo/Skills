import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateRepository } from '../validate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

async function writeRepoFile(fixtureRoot, relativePath, contents) {
  const absolutePath = path.join(fixtureRoot, ...relativePath.split('/'));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
}

async function createSkill(fixtureRoot, skillPath, skillText) {
  await writeRepoFile(fixtureRoot, `${skillPath}/SKILL.md`, skillText);
}

async function writeManifest(fixtureRoot, content) {
  await writeRepoFile(fixtureRoot, 'catalog/sources.yml', content);
}

async function expectValidationFailure(fixtureRoot, pattern) {
  await assert.rejects(
    validateRepository(fixtureRoot),
    (error) => {
      assert.equal(error?.name, 'ValidationError');
      assert.match(error.message, pattern);
      return true;
    },
  );
}

test('validateRepository rejects skills whose frontmatter name is blank', async () => {
  await withFixture('missing-name', async (fixtureRoot) => {
    await createSkill(
      fixtureRoot,
      'skills/azure/alpha',
      '---\nname: ""\ndescription: Fixture skill\n---\n',
    );
    await writeManifest(
      fixtureRoot,
      `
upstreams:
  fixtures:
    repository: fixtures/repo
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: fixtures
    source: skills/alpha
orphans: []
local: []
overrides: []
`,
    );

    await expectValidationFailure(
      fixtureRoot,
      /Frontmatter field "name" must be a non-empty string: skills\/azure\/alpha\/SKILL\.md/,
    );
  });
});

test('validateRepository rejects skills whose frontmatter description is blank', async () => {
  await withFixture('missing-description', async (fixtureRoot) => {
    await createSkill(
      fixtureRoot,
      'skills/azure/alpha',
      '---\nname: alpha\ndescription: "   "\n---\n',
    );
    await writeManifest(
      fixtureRoot,
      `
upstreams:
  fixtures:
    repository: fixtures/repo
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: fixtures
    source: skills/alpha
orphans: []
local: []
overrides: []
`,
    );

    await expectValidationFailure(
      fixtureRoot,
      /Frontmatter field "description" must be a non-empty string: skills\/azure\/alpha\/SKILL\.md/,
    );
  });
});

test('validateRepository rejects duplicate skill names', async () => {
  await withFixture('duplicate-name', async (fixtureRoot) => {
    await createSkill(
      fixtureRoot,
      'skills/azure/alpha',
      '---\nname: shared-name\ndescription: Alpha skill\n---\n',
    );
    await createSkill(
      fixtureRoot,
      'skills/github/beta',
      '---\nname: shared-name\ndescription: Beta skill\n---\n',
    );
    await writeManifest(
      fixtureRoot,
      `
upstreams:
  fixtures:
    repository: fixtures/repo
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: fixtures
    source: skills/alpha
  - path: skills/github/beta
    upstream: fixtures
    source: skills/beta
orphans: []
local: []
overrides: []
`,
    );

    await expectValidationFailure(
      fixtureRoot,
      /Duplicate skill name "shared-name": skills\/azure\/alpha\/SKILL\.md, skills\/github\/beta\/SKILL\.md/,
    );
  });
});

test('validateRepository rejects broken managed relative markdown links', async () => {
  await withFixture('broken-link', async (fixtureRoot) => {
    await createSkill(
      fixtureRoot,
      'skills/azure/alpha',
      [
        '---',
        'name: alpha',
        'description: Alpha skill',
        '---',
        '',
        '[Broken reference](references/missing.md)',
      ].join('\n'),
    );
    await writeManifest(
      fixtureRoot,
      `
upstreams:
  fixtures:
    repository: fixtures/repo
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: fixtures
    source: skills/alpha
orphans: []
local: []
overrides: []
`,
    );

    await expectValidationFailure(
      fixtureRoot,
      /Broken relative link in skills\/azure\/alpha\/SKILL\.md: references\/missing\.md -> skills\/azure\/alpha\/references\/missing\.md/,
    );
  });
});

test('validateRepository rejects source roots that expose installable SKILL.md files', async () => {
  await withFixture('source-root-skill', async (fixtureRoot) => {
    await createSkill(
      fixtureRoot,
      'skills/azure',
      '---\nname: azure-root\ndescription: Root skill\n---\n',
    );
    await createSkill(
      fixtureRoot,
      'skills/azure/alpha',
      '---\nname: alpha\ndescription: Alpha skill\n---\n',
    );
    await writeManifest(
      fixtureRoot,
      `
upstreams:
  fixtures:
    repository: fixtures/repo
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: fixtures
    source: skills/alpha
orphans:
  - path: skills/azure
local: []
overrides: []
`,
    );

    await expectValidationFailure(
      fixtureRoot,
      /Source root contains installable SKILL\.md: skills\/azure\/SKILL\.md/,
    );
  });
});

test('validateRepository surfaces manifest coverage failures from uncovered skills', async () => {
  await withFixture('uncovered-skill', async (fixtureRoot) => {
    await createSkill(
      fixtureRoot,
      'skills/azure/alpha',
      '---\nname: alpha\ndescription: Alpha skill\n---\n',
    );
    await createSkill(
      fixtureRoot,
      'skills/azure/beta',
      '---\nname: beta\ndescription: Beta skill\n---\n',
    );
    await writeManifest(
      fixtureRoot,
      `
upstreams:
  fixtures:
    repository: fixtures/repo
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: fixtures
    source: skills/alpha
orphans: []
local: []
overrides: []
`,
    );

    await expectValidationFailure(
      fixtureRoot,
      /Uncovered skill paths: skills\/azure\/beta/,
    );
  });
});

test('validateRepository accepts valid managed links, encoded paths, and ignored placeholders', async () => {
  await withFixture('valid-links', async (fixtureRoot) => {
    await createSkill(
      fixtureRoot,
      'skills/azure/alpha',
      [
        '---',
        'name: alpha',
        'description: |',
        '  Multiline description',
        '  stays valid.',
        'metadata:',
        '  owner: fixtures',
        '---',
        '',
        '[Guide](references/guide%20doc.md?raw=1#intro)',
        '[Mail](mailto:alpha@example.com)',
        '[Anchor](#overview)',
        '[Template](references/{{topic}}.md)',
        '',
        '```md',
        '[Code sample link](references/missing.md)',
        '```',
      ].join('\n'),
    );
    await writeRepoFile(
      fixtureRoot,
      'skills/azure/alpha/references/guide doc.md',
      [
        '# Guide',
        '',
        '[Script](../scripts/run.sh)',
        '[Asset](../assets/diagram.png#preview)',
      ].join('\n'),
    );
    await writeRepoFile(fixtureRoot, 'skills/azure/alpha/scripts/run.sh', 'echo ok\n');
    await writeRepoFile(fixtureRoot, 'skills/azure/alpha/assets/diagram.png', 'png\n');
    await writeManifest(
      fixtureRoot,
      `
upstreams:
  fixtures:
    repository: fixtures/repo
    reference: refs/heads/main
mappings:
  - path: skills/azure/alpha
    upstream: fixtures
    source: skills/alpha
orphans: []
local: []
overrides: []
`,
    );

    const result = await validateRepository(fixtureRoot);

    assert.equal(result.skillCount, 1);
    assert.equal(result.linkCount, 3);
  });
});
