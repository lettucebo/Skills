/**
 * Homepage status-line partition guards.
 *
 * The homepage used to render `total · counts.mapped · counts.orphan ·
 * counts.restricted`, but those buckets must remain disjoint even when a
 * future active mapped entry becomes restricted.
 *
 * The status page keeps its own mapped wording while the homepage line remains
 * a partition.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeStatusPartition,
  findRepoRoot,
  loadCatalog,
} from '../src/lib/catalog.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const repoRoot = findRepoRoot(siteRoot);
const distIndex = path.join(siteRoot, 'dist', 'en', 'index.html');

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test('SP1: the status partition sums to the catalog total', async () => {
  const catalog = await loadCatalog(repoRoot);
  const partition = computeStatusPartition(catalog.skills);

  assert.equal(
    partition.synced + partition.frozen + partition.local + partition.restricted,
    partition.total,
    'every non-tombstone skill must land in exactly one bucket',
  );
  assert.equal(partition.total, catalog.counts.total);
});

test('SP2: the partition is derived independently from the lock file', async () => {
  const lock = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'catalog', 'skills.lock.json'), 'utf8'),
  ) as { skills: Array<{ category: string; redistributable?: boolean }> };

  const expected = { synced: 0, frozen: 0, local: 0, restricted: 0 };
  for (const entry of lock.skills) {
    if (entry.category === 'removed') continue;
    if (entry.redistributable === false) expected.restricted += 1;
    else if (entry.category === 'orphan') expected.frozen += 1;
    else if (entry.category === 'local') expected.local += 1;
    else expected.synced += 1;
  }

  const catalog = await loadCatalog(repoRoot);
  const partition = computeStatusPartition(catalog.skills);

  assert.deepEqual(
    {
      synced: partition.synced,
      frozen: partition.frozen,
      local: partition.local,
      restricted: partition.restricted,
    },
    expected,
  );
});

test('SP3: the homepage renders the partition, not the overlapping mapped count', () => {
  const source = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'pages', 'HomePage.astro'), 'utf8');
  const statusLine = source.slice(source.indexOf('<section class="hero">'), source.indexOf('</section>'));

  assert.doesNotMatch(
    statusLine,
    /counts\.mapped/,
    'counts.mapped overlaps counts.restricted and must not appear in the homepage status line',
  );
  assert.match(statusLine, /partition\.synced/);
  assert.match(statusLine, /partition\.frozen/);
  assert.match(statusLine, /partition\.restricted/);
});

test('SP4: the status page keeps its mapped-entry semantics', () => {
  const source = fs.readFileSync(path.join(siteRoot, 'src', 'components', 'pages', 'StatusPage.astro'), 'utf8');

  assert.match(
    source,
    /counts\.mapped/,
    'the status page intentionally reports the number of mapped lock entries',
  );
});

test('SP5: rendered badges match the rendered status line', { skip: !fs.existsSync(distIndex) }, async () => {
  const html = fs.readFileSync(distIndex, 'utf8');
  const catalog = await loadCatalog(repoRoot);
  const partition = computeStatusPartition(catalog.skills);

  assert.equal(countOccurrences(html, 'badge--synced'), partition.synced);
  assert.equal(countOccurrences(html, 'badge--frozen'), partition.frozen);
  assert.equal(countOccurrences(html, 'badge--restricted'), partition.restricted);
  assert.equal(countOccurrences(html, 'badge--local'), partition.local);

  const statusText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.ok(
    statusText.includes(`${partition.total} total`),
    'the rendered status line must show the catalog total',
  );
  assert.ok(
    statusText.includes(`${partition.synced} synced`),
    `the rendered status line must show ${partition.synced} synced`,
  );
  assert.ok(
    statusText.includes(`${partition.frozen} frozen`),
    `the rendered status line must show ${partition.frozen} frozen`,
  );
  assert.ok(
    statusText.includes(`${partition.restricted} restricted`),
    `the rendered status line must show ${partition.restricted} restricted`,
  );
});
