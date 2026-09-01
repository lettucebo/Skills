import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadCatalog } from '../lib/catalog.ts';
import {
  getLegacyRedirectEntries,
  getLocalizedRouteEntries,
  localizedSourcePaths,
  localizedSkillPaths,
} from './routes.ts';

const repoRoot = path.resolve(process.cwd(), '..');

test('route expansion emits exactly 390 localized pages and 130 legacy redirects', async () => {
  const catalog = await loadCatalog(repoRoot);
  const localized = getLocalizedRouteEntries(catalog);
  const redirects = getLegacyRedirectEntries(catalog);

  assert.equal(localized.length, 390);
  assert.equal(redirects.length, 130);
  assert.equal(localized.length + redirects.length, 520);
});

test('each locale emits exactly 115 skill pages and 12 source pages', async () => {
  const catalog = await loadCatalog(repoRoot);

  assert.equal(catalog.skills.filter((skill) => !skill.isTombstone).length, 115);
  assert.equal(catalog.sources.length, 12);
  for (const locale of ['en', 'zh-tw', 'zh-cn'] as const) {
    assert.equal(localizedSkillPaths(catalog, locale).length, 115);
    assert.equal(localizedSourcePaths(catalog, locale).length, 12);
  }
});

test('every legacy route maps to the exact English logical target', async () => {
  const catalog = await loadCatalog(repoRoot);
  const redirects = getLegacyRedirectEntries(catalog);
  const mapping = new Map(redirects.map(({ from, to }) => [from, to]));

  assert.equal(mapping.get('/Skills/'), '/Skills/en/');
  assert.equal(mapping.get('/Skills/install/'), '/Skills/en/install/');
  assert.equal(mapping.get('/Skills/status/'), '/Skills/en/status/');
  assert.equal(
    mapping.get('/Skills/sources/microsoft/'),
    '/Skills/en/sources/microsoft/',
  );
  assert.equal(
    mapping.get('/Skills/skills/azure/az-cost-optimize/'),
    '/Skills/en/skills/azure/az-cost-optimize/',
  );

  for (const [from, to] of mapping) {
    assert.equal(to, from.replace('/Skills/', '/Skills/en/'));
  }
});
