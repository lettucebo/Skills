import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowsDir = path.resolve(__dirname, '..', '..', '.github', 'workflows');

// Reviewed against each upstream action.yml and latest release on 2026-08-31.
// This is an approval list, not a live upstream-version check.
const APPROVED_NODE24_ACTION_MAJORS = new Map([
  ['actions/checkout', 'v7'],
  ['actions/setup-node', 'v7'],
  ['actions/upload-artifact', 'v7'],
  ['actions/github-script', 'v9'],
  ['actions/configure-pages', 'v6'],
  ['actions/upload-pages-artifact', 'v5'],
  ['actions/deploy-pages', 'v5'],
  ['dorny/paths-filter', 'v4'],
]);

test('workflows use the approved Node 24 major for every external JavaScript action', async () => {
  const seen = new Set();
  const workflowFiles = (await readdir(workflowsDir))
    .filter((filename) => /\.ya?ml$/i.test(filename))
    .sort();

  for (const filename of workflowFiles) {
    const source = await readFile(path.join(workflowsDir, filename), 'utf8');
    for (const match of source.matchAll(/uses:\s+([^@\s]+)@([^\s]+)/g)) {
      const [, action, ref] = match;
      const expected = APPROVED_NODE24_ACTION_MAJORS.get(action);
      assert.ok(expected, `${filename} uses an unreviewed external action: ${action}@${ref}`);
      seen.add(action);
      assert.equal(ref, expected, `${filename} must use ${action}@${expected}`);
    }
  }

  assert.deepEqual(
    [...seen].sort(),
    [...APPROVED_NODE24_ACTION_MAJORS.keys()].sort(),
    'the version contract must cover every external JavaScript action used by the workflows',
  );
});
