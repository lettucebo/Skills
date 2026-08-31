/**
 * Structural tests for the validate.yml workflow.
 *
 * Covers the least-privilege permission model, the dorny/paths-filter
 * requirement (pull_request runs need `pull-requests: read` because the
 * workflow-level `contents: read` block sets every other scope to none),
 * and preservation of the original `validate` job behaviour alongside the
 * path-filtered E2E job.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'validate.yml');

async function loadValidateWorkflow() {
  return parse(await readFile(workflowPath, 'utf8'));
}

function stepsOf(job) {
  return job?.steps ?? [];
}

// ─── Baseline structure ──────────────────────────────────────────────

test('validate.yml parses as valid YAML and has a name', async () => {
  const wf = await loadValidateWorkflow();
  assert.ok(wf, 'validate.yml must parse as valid YAML');
  assert.ok(wf.name, 'workflow must declare a name');
});

test('validate.yml triggers on pull_request and push', async () => {
  const wf = await loadValidateWorkflow();
  assert.ok('pull_request' in (wf.on ?? {}), 'must trigger on pull_request');
  assert.ok('push' in (wf.on ?? {}), 'must trigger on push');
});

test('validate.yml top-level permissions are read-only contents', async () => {
  const wf = await loadValidateWorkflow();
  const perms = wf.permissions ?? {};
  assert.equal(perms.contents, 'read', 'top-level contents permission must be read');
  assert.equal(perms['pull-requests'], undefined,
    'top-level must not broaden pull-requests for every job');
  assert.equal(perms.packages, undefined, 'top-level must not grant packages');
  assert.equal(perms['id-token'], undefined, 'top-level must not grant id-token');
});

// ─── Finding 1 (CRITICAL): paths-filter needs pull-requests: read ────
//
// `permissions: { contents: read }` at workflow level sets EVERY other scope
// to `none`. dorny/paths-filter on a `pull_request` event calls the GitHub
// "list PR files" REST endpoint, which requires `pull-requests: read`.
// Without it the filter step fails (or silently degrades) on every PR run.

test('validate.yml check-site-changes job grants pull-requests: read', async () => {
  const wf = await loadValidateWorkflow();
  const job = wf.jobs?.['check-site-changes'];
  assert.ok(job, 'check-site-changes job must exist');
  const perms = job.permissions ?? {};
  assert.equal(
    perms['pull-requests'],
    'read',
    'check-site-changes must grant pull-requests: read for dorny/paths-filter on pull_request events',
  );
});

test('validate.yml check-site-changes job re-declares contents: read', async () => {
  const wf = await loadValidateWorkflow();
  const job = wf.jobs?.['check-site-changes'];
  assert.ok(job, 'check-site-changes job must exist');
  const perms = job.permissions ?? {};
  // Job-level `permissions` REPLACES the workflow-level block entirely, so
  // contents: read must be restated or checkout loses read access.
  assert.equal(perms.contents, 'read', 'job-level permissions must restate contents: read');
});

test('validate.yml check-site-changes job grants no write permission', async () => {
  const wf = await loadValidateWorkflow();
  const perms = wf.jobs?.['check-site-changes']?.permissions ?? {};
  const writes = Object.entries(perms).filter(([, value]) => value === 'write');
  assert.deepEqual(writes, [], `check-site-changes must stay read-only; got ${JSON.stringify(perms)}`);
});

test('validate.yml check-site-changes uses dorny/paths-filter with site/catalog/skills paths', async () => {
  const wf = await loadValidateWorkflow();
  const job = wf.jobs?.['check-site-changes'];
  assert.ok(job, 'check-site-changes job must exist');
  const filterStep = stepsOf(job).find((s) => String(s.uses ?? '').startsWith('dorny/paths-filter'));
  assert.ok(filterStep, 'must use dorny/paths-filter');
  assert.ok(filterStep.id, 'paths-filter step must have an id so outputs can be referenced');
  const filters = String(filterStep.with?.filters ?? '');
  for (const p of ['site/**', 'catalog/**', 'skills/**']) {
    assert.match(filters, new RegExp(p.replace(/[*/]/g, '\\$&')), `filters must include ${p}`);
  }
  const output = String(job.outputs?.changed ?? '');
  assert.match(
    output,
    new RegExp(`steps\\.${filterStep.id}\\.outputs\\.`),
    'changed output must be wired to the paths-filter step outputs',
  );
});

// ─── Existing validate behaviour preserved ───────────────────────────

test('validate.yml validate job installs, tests, and runs both validator tiers in default mode', async () => {
  const wf = await loadValidateWorkflow();
  const job = wf.jobs?.validate;
  assert.ok(job, 'validate job must exist');
  const runs = stepsOf(job).map((s) => String(s.run ?? ''));
  assert.ok(runs.some((r) => /npm ci/.test(r)), 'validate must run npm ci');
  assert.ok(runs.some((r) => /npm test/.test(r)), 'validate must run npm test');
  assert.ok(
    runs.some((r) => /node scripts\/validate\.mjs/.test(r)),
    'validate must run node scripts/validate.mjs',
  );
  assert.ok(
    runs.some((r) => /npm run validate:enrichment(?!\s+--\s+--strict)/.test(r)),
    'validate must run the default safety-only enrichment validator',
  );
});

test('validate.yml validate job inherits workflow-level read-only permissions', async () => {
  const wf = await loadValidateWorkflow();
  const job = wf.jobs?.validate;
  assert.ok(job, 'validate job must exist');
  assert.equal(
    job.permissions,
    undefined,
    'validate job must not override the workflow-level read-only permissions',
  );
});

// ─── E2E job ─────────────────────────────────────────────────────────

test('validate.yml e2e job is gated on the paths-filter output', async () => {
  const wf = await loadValidateWorkflow();
  const job = wf.jobs?.e2e;
  assert.ok(job, 'e2e job must exist');
  const needs = Array.isArray(job.needs) ? job.needs : [job.needs].filter(Boolean);
  assert.ok(needs.includes('check-site-changes'), 'e2e must depend on check-site-changes');
  assert.match(
    String(job.if ?? ''),
    /needs\.check-site-changes\.outputs\.changed/,
    'e2e must run only when site/catalog/skills changed',
  );
});

test('validate.yml e2e job installs Playwright Chromium and runs test:e2e', async () => {
  const wf = await loadValidateWorkflow();
  const runs = stepsOf(wf.jobs?.e2e).map((s) => String(s.run ?? ''));
  assert.ok(
    runs.some((r) => /playwright install chromium/.test(r)),
    'e2e must install Playwright Chromium',
  );
  assert.ok(
    runs.some((r) => /npm --prefix site run test:e2e/.test(r)),
    'e2e must run the site test:e2e script',
  );
});

test('validate.yml e2e job does not escalate permissions', async () => {
  const wf = await loadValidateWorkflow();
  const perms = wf.jobs?.e2e?.permissions ?? {};
  const writes = Object.entries(perms).filter(([, value]) => value === 'write');
  assert.deepEqual(writes, [], `e2e must stay read-only; got ${JSON.stringify(perms)}`);
});
