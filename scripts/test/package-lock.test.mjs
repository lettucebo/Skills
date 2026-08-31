import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

test('package lock does not pin dependencies to workstation-only registry hosts', async () => {
  const lock = JSON.parse(await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'));

  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    if (!packagePath) continue;
    assert.doesNotMatch(
      String(entry.resolved ?? ''),
      /pkgs\.visualstudio\.com|packagefeedproxy\.microsoft\.io/i,
      `${packagePath} must remain installable by GitHub-hosted workflows`,
    );
    assert.match(
      String(entry.integrity ?? ''),
      /^sha512-/,
      `${packagePath} must use SHA-512 integrity`,
    );
  }
});
