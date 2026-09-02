import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  LicenseEvidenceError,
  resolvePinnedMappedLicenses,
  validateLicenseBundle,
  writeLicenseBundle,
} from '../lib/license.mjs';
import { renderNotice } from '../catalog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.join(__dirname, '.runtime');

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

async function writeFileEnsured(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function createUpstream(workspace) {
  const root = path.join(workspace, 'upstream');
  await mkdir(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@example.com']);
  git(root, ['config', 'user.name', 'Fixture']);

  const mit = Buffer.from(
    'MIT License\n\nCopyright (c) Pinned Fixture\n\nPermission is hereby granted, free of charge.\n',
  );
  await writeFileEnsured(path.join(root, 'LICENSE'), mit);
  await writeFileEnsured(
    path.join(root, 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: Fixture alpha\n---\n',
  );
  await writeFileEnsured(
    path.join(root, 'skills', 'beta', 'SKILL.md'),
    '---\nname: beta\ndescription: Fixture beta\n---\n',
  );
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'pinned']);
  const pinnedCommit = git(root, ['rev-parse', 'HEAD']);

  await writeFile(
    path.join(root, 'LICENSE'),
    'Apache License\nVersion 2.0, January 2004\n',
  );
  git(root, ['add', 'LICENSE']);
  git(root, ['commit', '-q', '-m', 'head changed license']);
  const headCommit = git(root, ['rev-parse', 'HEAD']);

  return { root, url: pathToFileURL(root).href, mit, pinnedCommit, headCommit };
}

function manifestFor(url) {
  return {
    upstreams: {
      demo: {
        repository: url,
        reference: 'refs/heads/main',
      },
    },
    mappings: [
      { path: 'skills/demo/alpha', upstream: 'demo', source: 'skills/alpha' },
      { path: 'skills/demo/beta', upstream: 'demo', source: 'skills/beta' },
    ],
  };
}

function lockFor(url, commit) {
  return {
    skills: ['alpha', 'beta'].map((name) => ({
      path: `skills/demo/${name}`,
      name,
      category: 'mapped',
      version: '1.0.0',
      baseline: 'verified',
      license: 'Unknown',
      redistributable: true,
      contentHash: `sha256:${'1'.repeat(64)}`,
      snapshotHash: `sha256:${'2'.repeat(64)}`,
      upstream: {
        repository: url,
        reference: 'refs/heads/main',
        source: `skills/${name}`,
        commit,
      },
    })),
  };
}

test('pinned license resolution reads the pinned commit instead of newer ref HEAD', async () => {
  await mkdir(runtimeRoot, { recursive: true });
  const workspace = await mkdtemp(path.join(runtimeRoot, 'pinned-license-'));
  try {
    const upstream = await createUpstream(workspace);
    assert.notEqual(upstream.pinnedCommit, upstream.headCommit);

    const result = await resolvePinnedMappedLicenses({
      manifest: manifestFor(upstream.url),
      lock: lockFor(upstream.url, upstream.pinnedCommit),
      workspace: path.join(workspace, 'work'),
    });

    assert.equal(result.resolvedByPath.get('skills/demo/alpha').license, 'MIT');
    assert.equal(
      result.resolvedByPath.get('skills/demo/alpha').licenseEvidence.commit,
      upstream.pinnedCommit,
    );
    assert.equal(result.rootLicenses.length, 1);
    assert.equal(result.rootLicenses[0].content.compare(upstream.mit), 0);
    assert.equal(
      result.rootLicenses[0].hash,
      `sha256:${createHash('sha256').update(upstream.mit).digest('hex')}`,
    );
    assert.equal(result.summary.fetchedGroups, 1);
    assert.equal(result.summary.distinctPinnedCommits, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('pinned license resolution deduplicates root evidence shared by skills', async () => {
  await mkdir(runtimeRoot, { recursive: true });
  const workspace = await mkdtemp(path.join(runtimeRoot, 'dedup-license-'));
  try {
    const upstream = await createUpstream(workspace);
    const result = await resolvePinnedMappedLicenses({
      manifest: manifestFor(upstream.url),
      lock: lockFor(upstream.url, upstream.pinnedCommit),
      workspace: path.join(workspace, 'work'),
    });

    assert.equal(result.rootLicenses.length, 1);
    assert.deepEqual(
      [...result.resolvedByPath.values()].map((entry) => entry.licenseEvidence.hash),
      [result.rootLicenses[0].hash, result.rootLicenses[0].hash],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('pinned license resolution rejects a commit that is not reachable from the declared ref', async () => {
  await mkdir(runtimeRoot, { recursive: true });
  const workspace = await mkdtemp(path.join(runtimeRoot, 'unreachable-license-'));
  try {
    const upstream = await createUpstream(workspace);
    git(upstream.root, ['checkout', '-q', '-b', 'side', upstream.pinnedCommit]);
    await writeFile(path.join(upstream.root, 'LICENSE'), 'MIT License\nside branch\n');
    git(upstream.root, ['add', 'LICENSE']);
    git(upstream.root, ['commit', '-q', '-m', 'side only']);
    const sideCommit = git(upstream.root, ['rev-parse', 'HEAD']);
    git(upstream.root, ['checkout', '-q', 'main']);

    await assert.rejects(
      resolvePinnedMappedLicenses({
        manifest: manifestFor(upstream.url),
        lock: lockFor(upstream.url, sideCommit),
        workspace: path.join(workspace, 'work'),
      }),
      (error) =>
        error instanceof LicenseEvidenceError &&
        /not reachable from declared ref/.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('license bundle preserves exact bytes and writes deterministic deduplicated metadata', async () => {
  await mkdir(runtimeRoot, { recursive: true });
  const workspace = await mkdtemp(path.join(runtimeRoot, 'license-bundle-'));
  try {
    const content = Buffer.from('MIT License\r\n\r\nCopyright (c) Exact Bytes\r\n');
    const hash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    const evidence = {
      license: 'MIT',
      filename: 'LICENSE',
      path: 'LICENSE',
      hash,
      content,
      repository: 'example/repo',
      reference: 'refs/heads/main',
      commit: 'a'.repeat(40),
    };
    const destination = path.join(workspace, 'catalog', 'licenses');

    const metadata = await writeLicenseBundle(destination, [evidence, evidence], {
      release: '2.0.1',
    });

    assert.equal(metadata.licenses.length, 1);
    assert.equal(metadata.release, '2.0.1');
    assert.deepEqual(Object.keys(metadata.licenses[0]), [
      'repository',
      'reference',
      'commit',
      'license',
      'sourcePath',
      'hash',
      'bundlePath',
    ]);
    assert.equal(
      (await readFile(path.join(destination, metadata.licenses[0].bundlePath))).compare(content),
      0,
    );
    assert.equal(
      JSON.parse(await readFile(path.join(destination, 'index.json'), 'utf8')).licenses.length,
      1,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('NOTICE identifies every bundled upstream root license and links its exact text', () => {
  const lock = {
    skills: [
      {
        path: 'skills/demo/alpha',
        category: 'mapped',
        license: 'MIT',
        redistributable: true,
        upstream: {
          repository: 'example/repo',
          reference: 'refs/heads/main',
          commit: 'a'.repeat(40),
        },
      },
    ],
  };
  const bundle = {
    release: '2.0.1',
    licenses: [
      {
        repository: 'example/repo',
        reference: 'refs/heads/main',
        commit: 'a'.repeat(40),
        license: 'MIT',
        sourcePath: 'LICENSE',
        hash: `sha256:${'b'.repeat(64)}`,
        bundlePath: 'example--repo--LICENSE',
      },
    ],
  };

  const notice = renderNotice(lock, { licenseBundle: bundle });
  assert.match(notice, /catalog\/licenses\/index\.json/);
  assert.match(notice, /example\/repo/);
  assert.match(notice, /MIT/);
  assert.match(notice, /catalog\/licenses\/example--repo--LICENSE/);
  assert.match(notice, new RegExp('a'.repeat(40)));
});

test('license bundle validation rejects traversal and byte/hash corruption', async () => {
  await mkdir(runtimeRoot, { recursive: true });
  const workspace = await mkdtemp(path.join(runtimeRoot, 'validate-license-bundle-'));
  try {
    const destination = path.join(workspace, 'catalog', 'licenses');
    const content = Buffer.from('MIT License\nexact\n');
    const evidence = {
      license: 'MIT',
      filename: 'LICENSE',
      path: 'LICENSE',
      hash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      content,
      repository: 'example/repo',
      reference: 'refs/heads/main',
      commit: 'a'.repeat(40),
    };
    const metadata = await writeLicenseBundle(destination, [evidence], {
      release: '2.0.1',
    });
    const lock = {
      release: '2.0.1',
      skills: [
        {
          license: 'MIT',
          licenseEvidence: {
            source: 'upstream-root:LICENSE',
            repository: evidence.repository,
            reference: evidence.reference,
            commit: evidence.commit,
            path: evidence.path,
            hash: evidence.hash,
          },
        },
        {
          license: 'MIT',
          licenseEvidence: {
            source: 'upstream-root:LICENSE',
            repository: evidence.repository,
            reference: evidence.reference,
            commit: evidence.commit,
            path: evidence.path,
            hash: evidence.hash,
          },
        },
      ],
    };
    await validateLicenseBundle(workspace, lock);

    lock.skills[0].license = 'Apache-2.0';
    await assert.rejects(
      validateLicenseBundle(workspace, lock),
      (error) =>
        error instanceof LicenseEvidenceError &&
        /license classification mismatch/.test(error.message),
    );
    lock.skills[0].license = 'MIT';

    await writeFile(
      path.join(destination, metadata.licenses[0].bundlePath),
      'truncated',
    );
    await assert.rejects(
      validateLicenseBundle(workspace, lock),
      (error) =>
        error instanceof LicenseEvidenceError &&
        /hash mismatch/.test(error.message),
    );

    await writeFile(
      path.join(destination, metadata.licenses[0].bundlePath),
      content,
    );
    metadata.licenses[0].commit = '../../escape';
    await writeFile(
      path.join(destination, 'index.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    await assert.rejects(
      validateLicenseBundle(workspace, lock),
      (error) =>
        error instanceof LicenseEvidenceError &&
        /evidence commit must be a 40-character SHA/.test(error.message),
    );

    metadata.licenses[0].commit = evidence.commit;
    metadata.licenses[0].bundlePath = '../../README.md';
    await writeFile(
      path.join(destination, 'index.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    await assert.rejects(
      validateLicenseBundle(workspace, lock),
      (error) =>
        error instanceof LicenseEvidenceError &&
        /bundlePath must be a filename/.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('pinned proprietary evidence reports the registry destination path', async () => {
  await mkdir(runtimeRoot, { recursive: true });
  const workspace = await mkdtemp(path.join(runtimeRoot, 'proprietary-path-'));
  try {
    const upstream = await createUpstream(workspace);
    await writeFileEnsured(
      path.join(upstream.root, 'skills', 'alpha', 'LICENSE'),
      'Copyright Anthropic PBC. All rights reserved.\n',
    );
    git(upstream.root, ['add', '-A']);
    git(upstream.root, ['commit', '-q', '-m', 'proprietary skill terms']);
    const commit = git(upstream.root, ['rev-parse', 'HEAD']);

    await assert.rejects(
      resolvePinnedMappedLicenses({
        manifest: manifestFor(upstream.url),
        lock: lockFor(upstream.url, commit),
        workspace: path.join(workspace, 'work'),
      }),
      (error) =>
        error instanceof LicenseEvidenceError &&
        /skills\/demo\/alpha/.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('git attributes preserve exact license evidence bytes on checkout', async () => {
  const attributes = await readFile(
    path.resolve(__dirname, '..', '..', '.gitattributes'),
    'utf8',
  );
  assert.match(attributes, /^catalog\/licenses\/\*\* -text$/m);
});
