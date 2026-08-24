/**
 * Structural tests for the deploy-site.yml workflow.
 *
 * Validates triggers, permissions, official Pages actions, PR build-only
 * guard, main deployment, sync integration (not tag-based), Pagefind
 * build command, and Astro base path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const workflowDir = path.join(repoRoot, '.github', 'workflows');

async function loadWorkflow(name) {
  const content = await readFile(path.join(workflowDir, name), 'utf8');
  return parse(content);
}

// ─── deploy-site.yml — Triggers ─────────────────────────────────────

test('deploy-site.yml exists and is valid YAML', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  assert.ok(wf, 'deploy-site.yml must parse as valid YAML');
  assert.ok(wf.name, 'workflow must have a name');
});

test('deploy-site.yml triggers on push to main', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const push = wf.on?.push ?? wf.on?.['push'];
  assert.ok(push, 'must trigger on push');
  const branches = push.branches ?? [];
  assert.ok(branches.includes('main'), 'push trigger must filter to main branch');
});

test('deploy-site.yml triggers on pull_request', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const pr = wf.on?.pull_request;
  assert.notEqual(pr, undefined, 'must trigger on pull_request');
});

test('deploy-site.yml triggers on workflow_call (reusable)', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const call = wf.on?.workflow_call;
  assert.notEqual(call, undefined, 'must trigger on workflow_call for sync integration');
});

test('deploy-site.yml does NOT trigger on tag creation events', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const raw = await readFile(path.join(workflowDir, 'deploy-site.yml'), 'utf8');
  // Must not depend on tag events for deployment
  assert.equal(wf.on?.create, undefined, 'must not trigger on create event');
  assert.doesNotMatch(raw, /tags:/m, 'must not filter on tags');
});

// ─── deploy-site.yml — Official Pages Actions ──────────────────────

test('deploy-site.yml uses official GitHub Pages actions', async () => {
  const raw = await readFile(path.join(workflowDir, 'deploy-site.yml'), 'utf8');
  assert.match(raw, /actions\/configure-pages@/, 'must use actions/configure-pages');
  assert.match(raw, /actions\/upload-pages-artifact@/, 'must use actions/upload-pages-artifact');
  assert.match(raw, /actions\/deploy-pages@/, 'must use actions/deploy-pages');
});

// ─── deploy-site.yml — Permissions (Least Privilege) ────────────────

test('deploy-site.yml top-level permissions are read-only', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const perms = wf.permissions ?? {};
  // Top-level must be restrictive — only contents: read or equivalent
  assert.equal(perms.contents, 'read', 'top-level contents permission must be read');
  assert.equal(perms.pages, undefined, 'top-level must not grant pages write');
  assert.equal(perms['id-token'], undefined, 'top-level must not grant id-token write');
});

test('deploy-site.yml build job does NOT have pages/id-token write', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const buildJob = wf.jobs?.build;
  assert.ok(buildJob, 'build job must exist');
  const perms = buildJob.permissions ?? {};
  // Build job must not escalate permissions
  assert.notEqual(perms.pages, 'write', 'build must not have pages: write');
  assert.notEqual(perms['id-token'], 'write', 'build must not have id-token: write');
});

test('deploy-site.yml deploy job has pages: write and id-token: write', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const deployJob = wf.jobs?.deploy;
  assert.ok(deployJob, 'deploy job must exist');
  const perms = deployJob.permissions ?? {};
  assert.equal(perms.pages, 'write', 'deploy must have pages: write');
  assert.equal(perms['id-token'], 'write', 'deploy must have id-token: write');
});

// ─── deploy-site.yml — PR Build-Only ────────────────────────────────

test('deploy-site.yml deploy job is skipped on pull_request', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const deployJob = wf.jobs?.deploy;
  assert.ok(deployJob, 'deploy job must exist');
  const condition = deployJob.if ?? '';
  // Condition must exclude pull_request events from deployment
  assert.match(
    String(condition),
    /pull_request/,
    'deploy job if-condition must reference pull_request to exclude PR builds',
  );
});

test('deploy-site.yml deploy job depends on build', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const deployJob = wf.jobs?.deploy;
  assert.ok(deployJob, 'deploy job must exist');
  const needs = Array.isArray(deployJob.needs)
    ? deployJob.needs
    : [deployJob.needs].filter(Boolean);
  assert.ok(needs.includes('build'), 'deploy must depend on build job');
});

// ─── deploy-site.yml — Concurrency ─────────────────────────────────

test('deploy-site.yml has a concurrency group for Pages deployment', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  assert.ok(wf.concurrency, 'must define concurrency');
  const group = wf.concurrency?.group ?? wf.concurrency;
  assert.ok(group, 'concurrency must specify a group');
});

// ─── deploy-site.yml — Build Step: Pagefind + Astro ─────────────────

test('deploy-site.yml build includes npm run build in site directory', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const buildJob = wf.jobs?.build;
  assert.ok(buildJob, 'build job must exist');
  const steps = buildJob.steps ?? [];

  // Check that there is a step running npm run build in the site directory
  const hasSiteBuild = steps.some(
    (s) =>
      s.run?.includes('npm run build') &&
      (s['working-directory'] === 'site' || s.run.includes('cd site')),
  );
  assert.ok(hasSiteBuild, 'build job must run npm run build in site/ (which includes postbuild pagefind)');
});

test('deploy-site.yml uploads site/dist as pages artifact', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const buildJob = wf.jobs?.build;
  assert.ok(buildJob, 'build job must exist');
  const steps = buildJob.steps ?? [];

  const uploadStep = steps.find(
    (s) => s.uses && s.uses.startsWith('actions/upload-pages-artifact'),
  );
  assert.ok(uploadStep, 'must have upload-pages-artifact step');
  assert.equal(uploadStep.with?.path, 'site/dist', 'must upload site/dist directory');
});

test('Astro base remains /Skills (not rewritten by workflow)', async () => {
  const raw = await readFile(path.join(workflowDir, 'deploy-site.yml'), 'utf8');
  // The workflow must NOT override Astro base path via environment or args
  assert.doesNotMatch(
    raw,
    /ASTRO_BASE|--base\b/i,
    'workflow must not override Astro base path',
  );
});

// ─── deploy-site.yml — Environment ──────────────────────────────────

test('deploy-site.yml deploy job uses github-pages environment', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const deployJob = wf.jobs?.deploy;
  assert.ok(deployJob, 'deploy job must exist');
  const env = deployJob.environment;
  const envName = typeof env === 'string' ? env : env?.name;
  assert.equal(envName, 'github-pages', 'deploy must target github-pages environment');
});

// ─── sync.yml — Integration ─────────────────────────────────────────

test('sync.yml has a deploy job that calls deploy-site.yml', async () => {
  const wf = await loadWorkflow('sync.yml');
  const deployJob = wf.jobs?.deploy;
  assert.ok(deployJob, 'sync.yml must have a deploy job');
  assert.match(
    deployJob.uses ?? '',
    /deploy-site\.yml/,
    'sync deploy job must call deploy-site.yml as a reusable workflow',
  );
});

test('sync.yml deploy runs after every successful update without applied gate', async () => {
  const wf = await loadWorkflow('sync.yml');
  const deployJob = wf.jobs?.deploy;
  assert.ok(deployJob, 'sync.yml must have a deploy job');

  // Must depend on the update job
  const needs = Array.isArray(deployJob.needs)
    ? deployJob.needs
    : [deployJob.needs].filter(Boolean);
  assert.ok(needs.includes('update'), 'sync deploy must depend on update job');

  // Condition must gate on update success — but must NOT gate on applied output.
  // GITHUB_TOKEN pushes do not trigger downstream workflows (GitHub recursive-run
  // protection), so skipping deploy when applied=true would silently suppress all
  // post-apply deployments. Deploy must run after every successful update.
  const condition = String(deployJob.if ?? '');
  assert.match(
    condition,
    /needs\.update\.result/,
    'condition must gate on update result',
  );
  assert.doesNotMatch(
    condition,
    /needs\.update\.outputs\.applied/,
    'deploy must not gate on applied output — GITHUB_TOKEN push never triggers deploy-site.yml',
  );
});

test('sync.yml deploy comment does not claim GITHUB_TOKEN push triggers deploy-site', async () => {
  const raw = await readFile(path.join(workflowDir, 'sync.yml'), 'utf8');
  // The comment must not falsely claim a GITHUB_TOKEN push will trigger
  // deploy-site.yml — GitHub recursive-run protection prevents this entirely.
  assert.doesNotMatch(
    raw,
    /push event triggers deploy-site/i,
    'comment must not claim GITHUB_TOKEN push triggers deploy-site.yml (recursive-run protection prevents this)',
  );
});

test('sync.yml deploy does not rely on tag-created events', async () => {
  const wf = await loadWorkflow('sync.yml');
  const deployJob = wf.jobs?.deploy;
  assert.ok(deployJob, 'sync.yml must have a deploy job');
  const condition = String(deployJob.if ?? '');
  const uses = deployJob.uses ?? '';

  // Must not reference tag creation or release events
  assert.doesNotMatch(condition, /tags?_created|release/i, 'must not rely on tag events');
  assert.doesNotMatch(uses, /release/i, 'must not reference release workflow');
});

test('sync.yml deploy job has pages and id-token permissions', async () => {
  const wf = await loadWorkflow('sync.yml');
  const deployJob = wf.jobs?.deploy;
  assert.ok(deployJob, 'sync.yml must have a deploy job');
  const perms = deployJob.permissions ?? {};
  assert.equal(perms.pages, 'write', 'sync deploy must grant pages: write');
  assert.equal(perms['id-token'], 'write', 'sync deploy must grant id-token: write');
});
