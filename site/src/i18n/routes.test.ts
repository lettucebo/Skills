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

test('route expansion emits exactly 918 localized pages and 306 legacy redirects', async () => {
  const catalog = await loadCatalog(repoRoot);
  const localized = getLocalizedRouteEntries(catalog);
  const redirects = getLegacyRedirectEntries(catalog);

  assert.equal(localized.length, 918);
  assert.equal(redirects.length, 306);
  assert.equal(localized.length + redirects.length, 1224);
});

test('each locale emits exactly 289 skill pages and 14 source pages', async () => {
  const catalog = await loadCatalog(repoRoot);

  assert.equal(catalog.skills.filter((skill) => !skill.isTombstone).length, 289);
  assert.equal(catalog.sources.length, 14);
  for (const locale of ['en', 'zh-tw', 'zh-cn'] as const) {
    assert.equal(localizedSkillPaths(catalog, locale).length, 289);
    assert.equal(localizedSourcePaths(catalog, locale).length, 14);
  }
});

test('every legacy route maps to the exact English logical target', async () => {
  const catalog = await loadCatalog(repoRoot);
  const redirects = getLegacyRedirectEntries(catalog);
  const mapping = new Map(redirects.map(({ from, to }) => [from, to]));

  assert.equal(mapping.get('/'), '/en/');
  assert.equal(mapping.get('/install/'), '/en/install/');
  assert.equal(mapping.get('/status/'), '/en/status/');
  assert.equal(
    mapping.get('/sources/microsoft/'),
    '/en/sources/microsoft/',
  );
  assert.equal(
    mapping.get('/skills/azure/az-cost-optimize/'),
    '/en/skills/azure/az-cost-optimize/',
  );

  for (const [from, to] of mapping) {
    assert.equal(to, from === '/' ? '/en/' : from.replace('/', '/en/'));
  }
});
