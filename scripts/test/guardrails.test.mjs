import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadManifest, ManifestValidationError } from '../lib/manifest.mjs';
import {
  assertNoDestinationCollisions,
  assertNoPathTraversal,
  buildDeletionGroups,
  classifyDiff,
  commitMessageForDiffClass,
  COMMIT_MESSAGES,
  evaluateDeletionGuard,
  evaluateDeletionGuards,
  GuardrailError,
  upstreamGroupKey,
} from '../lib/guardrails.mjs';
import {
  formatVersion,
  nextVersion,
  parseVersion,
  planRelease,
  readCurrentVersion,
  ReleaseError,
  tagExists,
} from '../lib/release.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.join(__dirname, '.runtime');
const repoRoot = path.resolve(__dirname, '..', '..');

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

async function createSkill(fixtureRoot, relativeSkillPath) {
  const skillDir = path.join(fixtureRoot, ...relativeSkillPath.split('/'));
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: fixture-skill\ndescription: Fixture skill\n---\n',
  );
}

async function writeManifest(fixtureRoot, content) {
  const manifestPath = path.join(fixtureRoot, 'catalog', 'sources.yml');
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, content);
  return manifestPath;
}

// ---------------------------------------------------------------------------
// classifyDiff — precedence major > minor > patch > none
// ---------------------------------------------------------------------------

test('classifyDiff returns major when anything is removed, renamed, or restructured', () => {
  assert.equal(classifyDiff({ removed: ['a'], added: ['b'], changed: ['c'] }), 'major');
  assert.equal(classifyDiff({ renamed: ['a'], added: ['b'] }), 'major');
  assert.equal(classifyDiff({ restructured: ['a'], changed: ['c'] }), 'major');
});

test('classifyDiff returns minor when only additions exist', () => {
  assert.equal(classifyDiff({ added: ['b'], changed: ['c'] }), 'minor');
});

test('classifyDiff returns patch when only changes exist', () => {
  assert.equal(classifyDiff({ changed: ['c'] }), 'patch');
});

test('classifyDiff returns none for an empty change set', () => {
  assert.equal(classifyDiff({}), 'none');
  assert.equal(
    classifyDiff({ added: [], changed: [], removed: [], renamed: [], restructured: [] }),
    'none',
  );
});

test('classifyDiff accepts numeric counts as well as arrays', () => {
  assert.equal(classifyDiff({ removed: 2 }), 'major');
  assert.equal(classifyDiff({ added: 1 }), 'minor');
  assert.equal(classifyDiff({ changed: 1 }), 'patch');
  assert.equal(classifyDiff({ removed: 0, added: 0, changed: 0 }), 'none');
});

// ---------------------------------------------------------------------------
// commitMessageForDiffClass — exact generated messages
// ---------------------------------------------------------------------------

test('commitMessageForDiffClass returns the exact conventional messages', () => {
  assert.equal(commitMessageForDiffClass('major'), 'feat(skills)!: sync upstream changes');
  assert.equal(commitMessageForDiffClass('minor'), 'feat(skills): sync new upstream skills');
  assert.equal(commitMessageForDiffClass('patch'), 'fix(skills): sync upstream updates');
  assert.equal(commitMessageForDiffClass('none'), null);
});

test('COMMIT_MESSAGES mirrors the exact conventional messages', () => {
  assert.equal(COMMIT_MESSAGES.major, 'feat(skills)!: sync upstream changes');
  assert.equal(COMMIT_MESSAGES.minor, 'feat(skills): sync new upstream skills');
  assert.equal(COMMIT_MESSAGES.patch, 'fix(skills): sync upstream updates');
  assert.equal(COMMIT_MESSAGES.none, null);
});

test('commitMessageForDiffClass throws for an unknown diff class', () => {
  assert.throws(() => commitMessageForDiffClass('bogus'), GuardrailError);
});

// ---------------------------------------------------------------------------
// evaluateDeletionGuard — deletion thresholds
// ---------------------------------------------------------------------------

test('evaluateDeletionGuard allows a group with no removals', () => {
  const result = evaluateDeletionGuard({ upstream: 'demo', declared: 12, removed: 0 });
  assert.equal(result.blocked, false);
  assert.equal(result.status, 'ok');
  assert.equal(result.ratio, 0);
});

test('evaluateDeletionGuard allows exactly 30% removal for a large group', () => {
  const result = evaluateDeletionGuard({ upstream: 'demo', declared: 10, removed: 3 });
  assert.equal(result.blocked, false);
  assert.equal(result.status, 'ok');
  assert.equal(result.ratio, 0.3);
});

test('evaluateDeletionGuard blocks removal above 30% for a large group', () => {
  const result = evaluateDeletionGuard({ upstream: 'demo', declared: 10, removed: 4 });
  assert.equal(result.blocked, true);
  assert.equal(result.status, 'deletion-threshold-exceeded');
});

test('evaluateDeletionGuard blocks any removal for a small group (<10)', () => {
  const removed = evaluateDeletionGuard({ upstream: 'demo', declared: 9, removed: 1 });
  assert.equal(removed.blocked, true);
  assert.equal(removed.status, 'small-group-removal');

  const clean = evaluateDeletionGuard({ upstream: 'demo', declared: 9, removed: 0 });
  assert.equal(clean.blocked, false);
});

test('evaluateDeletionGuard never translates an unavailable upstream into a removal', () => {
  const result = evaluateDeletionGuard({
    upstream: 'demo',
    declared: 12,
    removed: 12,
    available: false,
  });
  assert.equal(result.status, 'upstream-unavailable');
  assert.equal(result.blocked, true);
  assert.equal(result.removed, 0);
  assert.equal(result.ratio, null);
});

test('evaluateDeletionGuard rejects a removed count larger than the declared size', () => {
  assert.throws(
    () => evaluateDeletionGuard({ upstream: 'demo', declared: 5, removed: 6 }),
    GuardrailError,
  );
});

test('evaluateDeletionGuards aggregates the blocked flag across groups', () => {
  const safe = evaluateDeletionGuards([
    { upstream: 'a', declared: 12, removed: 3 },
    { upstream: 'b', declared: 20, removed: 0 },
  ]);
  assert.equal(safe.blocked, false);
  assert.equal(safe.groups.length, 2);

  const blocked = evaluateDeletionGuards([
    { upstream: 'a', declared: 12, removed: 3 },
    { upstream: 'b', declared: 4, removed: 1 },
  ]);
  assert.equal(blocked.blocked, true);
});

// ---------------------------------------------------------------------------
// buildDeletionGroups — the ONE grouping shared by plan and apply
// ---------------------------------------------------------------------------

const twoReferenceManifest = {
  upstreams: {
    demo: { repository: 'acme/skills', reference: 'refs/heads/main' },
    legacy: { repository: 'acme/skills', reference: 'refs/tags/v1' },
  },
  mappings: [],
};

function mappedEntry(skillPath, reference) {
  return {
    path: skillPath,
    category: 'mapped',
    upstream: { repository: 'acme/skills', reference },
  };
}

test('buildDeletionGroups splits one repository mapped at two references', () => {
  const lock = {
    skills: [
      ...Array.from({ length: 12 }, (_, i) => mappedEntry(`skills/demo/m${i}`, 'refs/heads/main')),
      ...Array.from({ length: 12 }, (_, i) => mappedEntry(`skills/legacy/l${i}`, 'refs/tags/v1')),
    ],
  };

  const manifest = {
    ...twoReferenceManifest,
    // Five `demo` mappings are undeclared; every `legacy` mapping is kept.
    mappings: [
      ...Array.from({ length: 7 }, (_, i) => ({
        path: `skills/demo/m${i + 5}`,
        upstream: 'demo',
        source: `skills/m${i + 5}`,
      })),
      ...Array.from({ length: 12 }, (_, i) => ({
        path: `skills/legacy/l${i}`,
        upstream: 'legacy',
        source: `skills/l${i}`,
      })),
    ],
  };

  assert.deepEqual(buildDeletionGroups({ manifest, lock }), [
    { upstream: 'demo', declared: 12, removed: 5, available: true },
    { upstream: 'legacy', declared: 12, removed: 0, available: true },
  ]);

  assert.equal(
    evaluateDeletionGuards(buildDeletionGroups({ manifest, lock })).blocked,
    true,
    '5/12 exceeds the 30% threshold — merging the two references into 5/24 would hide it',
  );
});

test('buildDeletionGroups names each group after its manifest upstream', () => {
  const lock = { skills: [mappedEntry('skills/demo/a', 'refs/heads/main')] };

  assert.deepEqual(
    buildDeletionGroups({ manifest: { ...twoReferenceManifest, mappings: [] }, lock }),
    [{ upstream: 'demo', declared: 1, removed: 1, available: true }],
  );
});

test('buildDeletionGroups falls back to the repository when no manifest upstream matches', () => {
  const lock = { skills: [mappedEntry('skills/gone/a', 'refs/heads/dropped')] };

  assert.deepEqual(
    buildDeletionGroups({ manifest: { upstreams: {}, mappings: [] }, lock }),
    [{ upstream: 'acme/skills', declared: 1, removed: 1, available: true }],
  );
});

test('buildDeletionGroups only emits empty manifest upstreams when the planner asks', () => {
  const lock = { skills: [] };
  const manifest = {
    ...twoReferenceManifest,
    mappings: [{ path: 'skills/demo/a', upstream: 'demo', source: 'skills/a' }],
  };

  assert.deepEqual(buildDeletionGroups({ manifest, lock }), []);
  assert.deepEqual(buildDeletionGroups({ manifest, lock, includeUnmappedUpstreams: true }), [
    { upstream: 'demo', declared: 0, removed: 0, available: true },
  ]);
});

test('buildDeletionGroups carries clone availability through unchanged', () => {
  const lock = { skills: [mappedEntry('skills/demo/a', 'refs/heads/main')] };
  const manifest = {
    ...twoReferenceManifest,
    mappings: [{ path: 'skills/demo/a', upstream: 'demo', source: 'skills/a' }],
  };

  assert.deepEqual(
    buildDeletionGroups({
      manifest,
      lock,
      availableByName: new Map([['demo', false]]),
    }),
    [{ upstream: 'demo', declared: 1, removed: 0, available: false }],
  );
});

test('upstreamGroupKey distinguishes references of the same repository', () => {
  assert.notEqual(
    upstreamGroupKey('acme/skills', 'refs/heads/main'),
    upstreamGroupKey('acme/skills', 'refs/tags/v1'),
  );
  assert.equal(
    upstreamGroupKey('acme/skills', 'refs/heads/main'),
    upstreamGroupKey('acme/skills', 'refs/heads/main'),
  );
});

test('the planner and the apply both consume the shared grouping helper', async () => {
  const sources = {
    'scripts/sync.mjs': await readFile(path.join(repoRoot, 'scripts', 'sync.mjs'), 'utf8'),
    'scripts/lib/baseline.mjs': await readFile(
      path.join(repoRoot, 'scripts', 'lib', 'baseline.mjs'),
      'utf8',
    ),
  };

  for (const [file, source] of Object.entries(sources)) {
    assert.match(
      source,
      /buildDeletionGroups/,
      `${file} must group deletions through lib/guardrails.mjs`,
    );
    assert.doesNotMatch(
      source,
      /skill\.upstream\?\.repository \?\? 'unknown'/,
      `${file} must not re-derive a grouping key; a repository-only key merges two references ` +
        'of the same repository and halves the removal ratio',
    );
    assert.doesNotMatch(
      source,
      /^function buildDeletionGroups\(/m,
      `${file} must import the shared helper, never re-declare it`,
    );
  }
});

// ---------------------------------------------------------------------------
// assertNoPathTraversal — defense in depth
// ---------------------------------------------------------------------------

test('assertNoPathTraversal accepts legitimate nested paths', () => {
  assert.equal(
    assertNoPathTraversal('skills/tampermonkey/tampermonkey', 'source'),
    'skills/tampermonkey/tampermonkey',
  );
  assert.equal(
    assertNoPathTraversal('plugins/tampermonkey/skills/tampermonkey', 'source'),
    'plugins/tampermonkey/skills/tampermonkey',
  );
});

test('assertNoPathTraversal rejects a plain ".." segment', () => {
  assert.throws(() => assertNoPathTraversal('skills/../evil', 'source'), GuardrailError);
});

test('assertNoPathTraversal rejects percent-encoded ".." segments', () => {
  assert.throws(() => assertNoPathTraversal('skills/%2e%2e/evil', 'source'), GuardrailError);
  assert.throws(() => assertNoPathTraversal('%2E%2E/evil', 'source'), GuardrailError);
});

test('assertNoPathTraversal rejects mixed-separator traversal', () => {
  assert.throws(() => assertNoPathTraversal('skills\\..\\evil', 'source'), GuardrailError);
  assert.throws(() => assertNoPathTraversal('skills%5c..%5cevil', 'source'), GuardrailError);
});

test('assertNoPathTraversal rejects invalid percent-encoding', () => {
  assert.throws(() => assertNoPathTraversal('skills/%zz/evil', 'source'), GuardrailError);
});

// ---------------------------------------------------------------------------
// assertNoDestinationCollisions — duplicate / overlap detection
// ---------------------------------------------------------------------------

test('assertNoDestinationCollisions accepts distinct, non-overlapping roots', () => {
  assert.doesNotThrow(() =>
    assertNoDestinationCollisions([
      'skills/azure/alpha',
      'skills/tampermonkey/tampermonkey',
      'skills/claude/mcp-builder',
    ]),
  );
});

test('assertNoDestinationCollisions rejects exact duplicate destinations', () => {
  assert.throws(
    () => assertNoDestinationCollisions(['skills/azure/alpha', 'skills/azure/alpha']),
    GuardrailError,
  );
});

test('assertNoDestinationCollisions rejects parent/child overlapping roots', () => {
  assert.throws(
    () => assertNoDestinationCollisions(['skills/foo', 'skills/foo/bar']),
    GuardrailError,
  );
});

// ---------------------------------------------------------------------------
// manifest integration — traversal + overlap rejected, nesting preserved
// ---------------------------------------------------------------------------

test('loadManifest rejects a mapping source containing an encoded ".." segment', async () => {
  await withFixture('manifest-traversal', async (fixtureRoot) => {
    await createSkill(fixtureRoot, 'skills/foo');
    const manifestPath = await writeManifest(
      fixtureRoot,
      [
        'upstreams:',
        '  demo:',
        '    repository: github/demo',
        '    reference: refs/heads/main',
        'mappings:',
        '  - path: skills/foo',
        '    upstream: demo',
        '    source: skills/%2e%2e/evil',
        'orphans: []',
        'local: []',
        'overrides: []',
        'linkExceptions: []',
        '',
      ].join('\n'),
    );

    await assert.rejects(
      loadManifest(manifestPath),
      (error) => error instanceof ManifestValidationError && /\.\./.test(error.message),
    );
  });
});

test('loadManifest rejects parent/child overlapping destination mappings', async () => {
  await withFixture('manifest-overlap', async (fixtureRoot) => {
    await createSkill(fixtureRoot, 'skills/foo');
    await createSkill(fixtureRoot, 'skills/foo/bar');
    const manifestPath = await writeManifest(
      fixtureRoot,
      [
        'upstreams:',
        '  demo:',
        '    repository: github/demo',
        '    reference: refs/heads/main',
        'mappings:',
        '  - path: skills/foo',
        '    upstream: demo',
        '    source: skills/foo',
        '  - path: skills/foo/bar',
        '    upstream: demo',
        '    source: skills/foo-bar',
        'orphans: []',
        'local: []',
        'overrides: []',
        'linkExceptions: []',
        '',
      ].join('\n'),
    );

    await assert.rejects(
      loadManifest(manifestPath),
      (error) =>
        error instanceof ManifestValidationError && /overlap/i.test(error.message),
    );
  });
});

test('loadManifest preserves a legitimate nested skill path', async () => {
  await withFixture('manifest-nested', async (fixtureRoot) => {
    await createSkill(fixtureRoot, 'skills/tampermonkey/tampermonkey');
    const manifestPath = await writeManifest(
      fixtureRoot,
      [
        'upstreams:',
        '  demo:',
        '    repository: github/demo',
        '    reference: refs/heads/main',
        'mappings:',
        '  - path: skills/tampermonkey/tampermonkey',
        '    upstream: demo',
        '    source: plugins/tampermonkey/skills/tampermonkey',
        'orphans: []',
        'local: []',
        'overrides: []',
        'linkExceptions: []',
        '',
      ].join('\n'),
    );

    const manifest = await loadManifest(manifestPath);
    assert.deepEqual(manifest.mappings.map((m) => m.path), [
      'skills/tampermonkey/tampermonkey',
    ]);
    assert.equal(manifest.mappings[0].source, 'plugins/tampermonkey/skills/tampermonkey');
  });
});

// ---------------------------------------------------------------------------
// release.mjs — SemVer parsing and bumping
// ---------------------------------------------------------------------------

test('parseVersion parses valid versions and strips a leading v', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseVersion('v10.0.4'), { major: 10, minor: 0, patch: 4 });
});

test('parseVersion rejects invalid versions', () => {
  assert.throws(() => parseVersion('1.2'), ReleaseError);
  assert.throws(() => parseVersion('1.2.3.4'), ReleaseError);
  assert.throws(() => parseVersion('1.2.x'), ReleaseError);
  assert.throws(() => parseVersion('latest'), ReleaseError);
});

test('formatVersion renders the canonical dotted string', () => {
  assert.equal(formatVersion({ major: 2, minor: 0, patch: 0 }), '2.0.0');
});

test('nextVersion bumps according to the diff class from v1.0.0', () => {
  assert.equal(nextVersion('1.0.0', 'major'), '2.0.0');
  assert.equal(nextVersion('1.0.0', 'minor'), '1.1.0');
  assert.equal(nextVersion('1.0.0', 'patch'), '1.0.1');
  assert.equal(nextVersion('1.0.0', 'none'), null);
});

test('nextVersion resets lower components on a higher bump', () => {
  assert.equal(nextVersion('1.4.7', 'major'), '2.0.0');
  assert.equal(nextVersion('1.4.7', 'minor'), '1.5.0');
  assert.equal(nextVersion('1.4.7', 'patch'), '1.4.8');
});

// ---------------------------------------------------------------------------
// release.mjs — git-backed helpers with an injected runGit
// ---------------------------------------------------------------------------

function stubGit(handlers) {
  return async (args) => {
    const key = args.join(' ');
    for (const [pattern, output] of handlers) {
      if (pattern.test(key)) {
        return typeof output === 'function' ? output(args) : output;
      }
    }
    throw new Error(`Unexpected git invocation: ${key}`);
  };
}

test('readCurrentVersion returns the highest semantic tag and ignores others', async () => {
  const runGit = stubGit([[/^tag /, 'v1.0.0\nv1.2.0\nv1.10.0\nnightly\n']]);
  assert.equal(await readCurrentVersion({ runGit }), '1.10.0');
});

test('readCurrentVersion throws when no semantic tag exists', async () => {
  const runGit = stubGit([[/^tag /, 'nightly\nlatest\n']]);
  await assert.rejects(readCurrentVersion({ runGit }), ReleaseError);
});

test('tagExists reports presence based on an exact match', async () => {
  const present = stubGit([[/^tag --list v2\.0\.0/, 'v2.0.0\n']]);
  const absent = stubGit([[/^tag --list v2\.0\.0/, '']]);
  assert.equal(await tagExists('v2.0.0', { runGit: present }), true);
  assert.equal(await tagExists('v2.0.0', { runGit: absent }), false);
});

test('planRelease computes the next tag and commit message from the baseline', async () => {
  const runGit = stubGit([
    [/^tag --list v\*/, 'v1.0.0\n'],
    [/^tag --list v1\.1\.0/, ''],
  ]);
  const plan = await planRelease({ diffClass: 'minor', runGit });
  assert.equal(plan.currentVersion, '1.0.0');
  assert.equal(plan.nextVersion, '1.1.0');
  assert.equal(plan.nextTag, 'v1.1.0');
  assert.equal(plan.commitMessage, 'feat(skills): sync new upstream skills');
});

test('planRelease returns a no-op for the none diff class without querying tags', async () => {
  const runGit = stubGit([[/^tag --list v\*/, 'v1.0.0\n']]);
  const plan = await planRelease({ diffClass: 'none', runGit });
  assert.equal(plan.nextVersion, null);
  assert.equal(plan.nextTag, null);
  assert.equal(plan.commitMessage, null);
});

test('planRelease refuses to reuse an already-existing next tag', async () => {
  const runGit = stubGit([
    [/^tag --list v\*/, 'v1.0.0\n'],
    [/^tag --list v2\.0\.0/, 'v2.0.0\n'],
  ]);
  await assert.rejects(planRelease({ diffClass: 'major', runGit }), ReleaseError);
});

test('planRelease rejects an invalid current version', async () => {
  const runGit = stubGit([[/^tag/, '']]);
  await assert.rejects(
    planRelease({ diffClass: 'minor', currentVersion: 'not-a-version', runGit }),
    ReleaseError,
  );
});

// ---------------------------------------------------------------------------
// Shared protected-root guard (Finding 4)
//
// The protected-root rule used to live in sync.mjs and was therefore applied by
// dry-run planning ONLY. It must be a shared guardrail so plan and apply share
// one implementation and cannot diverge.
// ---------------------------------------------------------------------------

test('guardrails exports the protected-root primitives', async () => {
  const guardrails = await import('../lib/guardrails.mjs');

  assert.ok(
    Array.isArray(guardrails.ALWAYS_PROTECTED_ROOTS),
    'guardrails must export ALWAYS_PROTECTED_ROOTS',
  );
  assert.ok(
    guardrails.ALWAYS_PROTECTED_ROOTS.includes('skills/lettucebo'),
    'skills/lettucebo must always be protected',
  );
  assert.equal(typeof guardrails.buildProtectedRoots, 'function');
  assert.equal(typeof guardrails.assertWritableSkillPath, 'function');
  assert.equal(typeof guardrails.SyncProtectionError, 'function');
});

test('buildProtectedRoots protects skills/lettucebo even with no local declaration', async () => {
  const { buildProtectedRoots } = await import('../lib/guardrails.mjs');

  assert.deepEqual(buildProtectedRoots({}), ['skills/lettucebo']);
  assert.deepEqual(buildProtectedRoots({ local: [] }), ['skills/lettucebo']);
  assert.deepEqual(
    buildProtectedRoots({ local: [{ root: 'skills/private' }] }).sort(),
    ['skills/lettucebo', 'skills/private'],
  );
});

test('assertWritableSkillPath rejects the protected root and its descendants', async () => {
  const { assertWritableSkillPath, buildProtectedRoots, SyncProtectionError } =
    await import('../lib/guardrails.mjs');

  const roots = buildProtectedRoots({ local: [] });

  assert.throws(
    () => assertWritableSkillPath('skills/lettucebo', roots),
    (error) => error instanceof SyncProtectionError,
  );
  assert.throws(
    () => assertWritableSkillPath('skills/lettucebo/evil', roots),
    (error) => error instanceof SyncProtectionError,
  );
  assert.doesNotThrow(() => assertWritableSkillPath('skills/azure/az-cost-optimize', roots));
  // A sibling directory that merely shares a prefix is NOT protected.
  assert.doesNotThrow(() => assertWritableSkillPath('skills/lettucebo-public/x', roots));
});

test('sync.mjs re-exports the shared protected-root guard (single implementation)', async () => {
  const guardrails = await import('../lib/guardrails.mjs');
  const sync = await import('../sync.mjs');

  assert.equal(
    sync.assertWritableSkillPath,
    guardrails.assertWritableSkillPath,
    'sync must reuse the shared guardrail, not keep a private copy',
  );
  assert.equal(
    sync.SyncProtectionError,
    guardrails.SyncProtectionError,
    'sync must reuse the shared error type',
  );
});
