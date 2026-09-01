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

async function writeLock(fixtureRoot, lock) {
  await writeRepoFile(
    fixtureRoot,
    'catalog/skills.lock.json',
    `${JSON.stringify(lock, null, 2)}\n`,
  );
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

test('validateRepository rejects a denylisted path that remains active after release 2.0.0', async () => {
  await withFixture('denylisted-active', async (fixtureRoot) => {
    await createSkill(
      fixtureRoot,
      'skills/claude/docx',
      '---\nname: docx\ndescription: Restricted fixture\n---\n',
    );
    await writeManifest(
      fixtureRoot,
      `
upstreams:
  anthropics:
    repository: anthropics/skills
    reference: refs/heads/main
mappings:
  - path: skills/claude/docx
    upstream: anthropics
    source: skills/docx
orphans: []
local: []
overrides: []
`,
    );
    await writeLock(fixtureRoot, {
      release: '2.0.0',
      generatedAt: '2026-09-02T00:00:00Z',
      counts: { total: 1, mapped: 1, orphan: 0, local: 0 },
      skills: [{
        path: 'skills/claude/docx',
        name: 'docx',
        category: 'mapped',
        version: '1.1.0',
        baseline: 'verified',
        license: 'Proprietary',
        redistributable: false,
        snapshotHash: 'sha256:fixture',
        contentHash: 'sha256:fixture',
        upstream: {
          repository: 'anthropics/skills',
          reference: 'refs/heads/main',
          source: 'skills/docx',
          commit: 'a'.repeat(40),
        },
      }],
    });

    await expectValidationFailure(
      fixtureRoot,
      /denylisted.*skills\/claude\/docx.*must not exist on disk.*active lock entry.*active mapping/is,
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

test('validateRepository accepts broken managed relative markdown links with exact manifest exceptions', async () => {
  await withFixture('accepted-link-exception', async (fixtureRoot) => {
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
linkExceptions:
  - sourcePath: skills/azure/alpha/SKILL.md
    target: references/missing.md
    reason: Upstream fixture intentionally omits this reference.
    upstreamUrl: https://example.invalid/fixtures/repo
`,
    );

    const result = await validateRepository(fixtureRoot);

    assert.equal(result.skillCount, 1);
    assert.equal(result.linkCount, 1);
    assert.equal(result.knownBrokenLinkCount, 1);
    assert.deepEqual(result.warnings, [
      'Known upstream broken link in skills/azure/alpha/SKILL.md: references/missing.md -> skills/azure/alpha/references/missing.md',
    ]);
  });
});

test('validateRepository still rejects broken managed relative markdown links when the manifest exception does not exactly match', async () => {
  await withFixture('non-matching-link-exception', async (fixtureRoot) => {
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
linkExceptions:
  - sourcePath: skills/azure/alpha/SKILL.md
    target: references/other.md
    reason: Does not match the actual broken link.
    upstreamUrl: https://example.invalid/fixtures/repo
`,
    );

    await expectValidationFailure(
      fixtureRoot,
      /Broken relative link in skills\/azure\/alpha\/SKILL\.md: references\/missing\.md -> skills\/azure\/alpha\/references\/missing\.md/,
    );
  });
});

test('validateRepository preserves known broken link classification when manifest has an unrelated validation failure', async () => {
  await withFixture('manifest-failure-known-link', async (fixtureRoot) => {
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
  - path: skills/azure/alpha
    upstream: fixtures
    source: skills/alpha-copy
orphans: []
local: []
overrides: []
linkExceptions:
  - sourcePath: skills/azure/alpha/SKILL.md
    target: references/missing.md
    reason: Known upstream issue should stay classified as known.
    upstreamUrl: https://example.invalid/fixtures/repo
`,
    );

    await assert.rejects(
      validateRepository(fixtureRoot),
      (error) => {
        assert.equal(error?.name, 'ValidationError');
        assert.match(error.message, /covered more than once: skills\/azure\/alpha/);
        assert.doesNotMatch(error.message, /Broken relative link in skills\/azure\/alpha\/SKILL\.md/);
        return true;
      },
    );
  });
});

test('validateRepository preserves known broken link classification when upstream validation fails before mappings', async () => {
  await withFixture('upstream-failure-known-link', async (fixtureRoot) => {
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
upstreams: []
mappings:
  - path: skills/azure/alpha
    upstream: fixtures
    source: skills/alpha
orphans: []
local: []
overrides: []
linkExceptions:
  - sourcePath: skills/azure/alpha/SKILL.md
    target: references/missing.md
    reason: Known upstream issue should stay classified as known.
    upstreamUrl: https://example.invalid/fixtures/repo
`,
    );

    await assert.rejects(
      validateRepository(fixtureRoot),
      (error) => {
        assert.equal(error?.name, 'ValidationError');
        assert.match(error.message, /Manifest upstreams must be an object\./);
        assert.doesNotMatch(error.message, /Broken relative link in skills\/azure\/alpha\/SKILL\.md/);
        return true;
      },
    );
  });
});

test('validateRepository preserves known broken link classification when a later link exception entry is invalid', async () => {
  await withFixture('invalid-later-link-exception', async (fixtureRoot) => {
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
  - path: skills/azure/beta
    upstream: fixtures
    source: skills/beta
orphans: []
local: []
overrides: []
linkExceptions:
  - sourcePath: skills/azure/alpha/SKILL.md
    target: references/missing.md
    reason: Known upstream issue should stay classified as known.
    upstreamUrl: https://example.invalid/fixtures/repo
  - sourcePath: skills/azure/beta/SKILL.md
    target: references/other.md
    reason: ""
    upstreamUrl: https://example.invalid/fixtures/repo
`,
    );

    await assert.rejects(
      validateRepository(fixtureRoot),
      (error) => {
        assert.equal(error?.name, 'ValidationError');
        assert.match(error.message, /linkExceptions\[1\]\.reason must be a non-empty string\./);
        assert.doesNotMatch(error.message, /Broken relative link in skills\/azure\/alpha\/SKILL\.md/);
        return true;
      },
    );
  });
});

test('validateRepository preserves known broken link classification when an earlier link exception entry is invalid', async () => {
  await withFixture('invalid-earlier-link-exception', async (fixtureRoot) => {
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
  - path: skills/azure/beta
    upstream: fixtures
    source: skills/beta
orphans: []
local: []
overrides: []
linkExceptions:
  - sourcePath: skills/azure/beta/SKILL.md
    target: references/other.md
    reason: ""
    upstreamUrl: https://example.invalid/fixtures/repo
  - sourcePath: skills/azure/alpha/SKILL.md
    target: references/missing.md
    reason: Known upstream issue should stay classified as known.
    upstreamUrl: https://example.invalid/fixtures/repo
`,
    );

    await assert.rejects(
      validateRepository(fixtureRoot),
      (error) => {
        assert.equal(error?.name, 'ValidationError');
        assert.match(error.message, /linkExceptions\[0\]\.reason must be a non-empty string\./);
        assert.doesNotMatch(error.message, /Broken relative link in skills\/azure\/alpha\/SKILL\.md/);
        return true;
      },
    );
  });
});

test('validateRepository rejects stale link exceptions when the target now resolves', async () => {
  await withFixture('stale-link-exception-resolved', async (fixtureRoot) => {
    await createSkill(
      fixtureRoot,
      'skills/azure/alpha',
      [
        '---',
        'name: alpha',
        'description: Alpha skill',
        '---',
        '',
        '[Guide](references/guide.md)',
      ].join('\n'),
    );
    await writeRepoFile(
      fixtureRoot,
      'skills/azure/alpha/references/guide.md',
      '# Guide\n',
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
linkExceptions:
  - sourcePath: skills/azure/alpha/SKILL.md
    target: references/guide.md
    reason: Stale once the target exists.
    upstreamUrl: https://example.invalid/fixtures/repo
`,
    );

    await expectValidationFailure(
      fixtureRoot,
      /Stale link exception in skills\/azure\/alpha\/SKILL\.md: references\/guide\.md now resolves to skills\/azure\/alpha\/references\/guide\.md/,
    );
  });
});

test('validateRepository rejects stale link exceptions when the source no longer contains the exact link target', async () => {
  await withFixture('stale-link-exception-missing-link', async (fixtureRoot) => {
    await createSkill(
      fixtureRoot,
      'skills/azure/alpha',
      [
        '---',
        'name: alpha',
        'description: Alpha skill',
        '---',
        '',
        '[Guide](references/guide-v2.md)',
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
linkExceptions:
  - sourcePath: skills/azure/alpha/SKILL.md
    target: references/guide.md
    reason: Stale because the exact link changed.
    upstreamUrl: https://example.invalid/fixtures/repo
`,
    );

    await expectValidationFailure(
      fixtureRoot,
      /Stale link exception in skills\/azure\/alpha\/SKILL\.md: references\/guide\.md no longer exists in the source file/,
    );
  });
});

test('validateRepository does not mark known exceptions as stale when frontmatter validation fails', async () => {
  await withFixture('frontmatter-failure-known-link', async (fixtureRoot) => {
    await createSkill(
      fixtureRoot,
      'skills/azure/alpha',
      [
        '---',
        'name: ""',
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
linkExceptions:
  - sourcePath: skills/azure/alpha/SKILL.md
    target: references/missing.md
    reason: Known upstream issue should stay classified as known.
    upstreamUrl: https://example.invalid/fixtures/repo
`,
    );

    await assert.rejects(
      validateRepository(fixtureRoot),
      (error) => {
        assert.equal(error?.name, 'ValidationError');
        assert.match(error.message, /Frontmatter field "name" must be a non-empty string: skills\/azure\/alpha\/SKILL\.md/);
        assert.doesNotMatch(error.message, /Stale link exception in skills\/azure\/alpha\/SKILL\.md/);
        return true;
      },
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
    assert.equal(result.knownBrokenLinkCount, 0);
    assert.deepEqual(result.warnings, []);
  });
});
