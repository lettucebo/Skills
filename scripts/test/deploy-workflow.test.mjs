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
  // Must not depend on tag events for deployment.
  assert.equal(wf.on?.create, undefined, 'must not trigger on create event');

  // Assert on the parsed trigger section rather than the raw text: the build job
  // legitimately uses `fetch-tags: true` so it can resolve the publication state
  // of the release tag, which a raw /tags:/ scan would flag as a false positive.
  for (const [event, config] of Object.entries(wf.on ?? {})) {
    if (!config || typeof config !== 'object') continue;
    assert.equal(config.tags, undefined, `trigger "${event}" must not filter on tags`);
    assert.equal(
      config['tags-ignore'],
      undefined,
      `trigger "${event}" must not filter on tags-ignore`,
    );
  }
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

test('deploy-site.yml build job has only the permissions required to read and configure Pages', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const buildJob = wf.jobs?.build;
  assert.ok(buildJob, 'build job must exist');
  const perms = buildJob.permissions ?? {};
  assert.equal(perms.contents, 'read', 'build must retain contents: read');
  assert.equal(perms.pages, 'write', 'configure-pages requires Pages write access');
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

test('deploy-site.yml fails closed with a documented prerequisite when Pages is not enabled', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const steps = wf.jobs?.build?.steps ?? [];
  const preflight = steps.find((step) => /Verify GitHub Pages is enabled/.test(String(step.name ?? '')));
  const configure = steps.find((step) =>
    String(step.uses ?? '').startsWith('actions/configure-pages@v6'),
  );

  assert.ok(preflight, 'a Pages 404 must produce a clear operator-facing prerequisite');
  assert.match(String(preflight.run ?? ''), /gh api.*\/pages/s);
  assert.match(String(preflight.run ?? ''), /GITHUB_TOKEN.*cannot.*enable/i);
  assert.match(String(preflight.run ?? ''), /Settings.*Pages|enable Pages manually/i);
  assert.equal(preflight.env?.GH_TOKEN, '${{ github.token }}');
  assert.ok(configure, 'the official Pages configuration action must remain present');
  assert.equal(
    configure.with?.enablement,
    false,
    'configure-pages@v6 documents that enablement=true requires a non-GITHUB_TOKEN credential',
  );
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
  assert.equal(
    uploadStep.with?.['include-hidden-files'],
    false,
    'Pages artifact policy must explicitly exclude hidden files until the site needs them',
  );
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

test('sync.yml deploy requires an applied update', async () => {
  const wf = await loadWorkflow('sync.yml');
  const deployJob = wf.jobs?.deploy;
  assert.ok(deployJob, 'sync.yml must have a deploy job');

  // Must depend on the update job
  const needs = Array.isArray(deployJob.needs)
    ? deployJob.needs
    : [deployJob.needs].filter(Boolean);
  assert.ok(needs.includes('update'), 'sync deploy must depend on update job');

  // A successful update job may be a no-op, which has no new tree to deploy.
  // GITHUB_TOKEN pushes still cannot trigger a downstream workflow, so the
  // reusable caller must gate on the engine output instead of a tag event.
  const condition = String(deployJob.if ?? '');
  assert.match(
    condition,
    /needs\.update\.result/,
    'condition must gate on update result',
  );
  assert.match(
    condition,
    /needs\.update\.outputs\.applied/,
    'deploy must exclude a successful no-op update job',
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

// ─── Finding 1: post-sync SHA must be the deployed tree ─────────────
//
// A reusable workflow inherits the CALLER's original event context, so
// `github.sha` inside deploy-site.yml is the pre-sync commit even after the
// sync update job pushes a new one. GITHUB_TOKEN pushes never trigger a second
// workflow run, so without an explicit ref the applied sync is never deployed.

function stepsOf(job) {
  return job?.steps ?? [];
}

function findStepIndex(steps, predicate) {
  return steps.findIndex(predicate);
}

/**
 * Minimal evaluator for the `${{ a || b }}` fallback expression used by the
 * build checkout. Mirrors GitHub Actions semantics: an undefined/empty
 * left-hand operand falls through to the right-hand operand.
 */
function evaluateFallbackExpression(expression, context) {
  const body = String(expression).trim().replace(/^\$\{\{/, '').replace(/\}\}$/, '').trim();
  const operands = body.split('||').map((part) => part.trim());
  for (const operand of operands) {
    const value = operand
      .split('.')
      .reduce((scope, key) => (scope === undefined || scope === null ? undefined : scope[key]), context);
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return '';
}

test('deploy-site.yml declares an optional string ref input for workflow_call', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const call = wf.on?.workflow_call;
  assert.ok(call && typeof call === 'object', 'workflow_call must declare inputs');
  const refInput = call.inputs?.ref;
  assert.ok(refInput, 'workflow_call must declare a "ref" input so callers can pin the built commit');
  assert.equal(refInput.type, 'string', 'ref input must be typed as string');
  assert.notEqual(refInput.required, true, 'ref input must be optional');
});

test('deploy-site.yml build checkout pins the ref with an event-safe fallback', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const steps = stepsOf(wf.jobs?.build);
  const checkout = steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout'));
  assert.ok(checkout, 'build job must have a checkout step');
  const ref = String(checkout.with?.ref ?? '');
  assert.match(ref, /inputs\.ref/, 'checkout must honour the workflow_call ref input');
  assert.match(ref, /github\.sha/, 'checkout must fall back to the triggering event SHA');
});

test('deploy-site.yml checkout ref resolves to the caller ref, else the event SHA', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const steps = stepsOf(wf.jobs?.build);
  const checkout = steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout'));
  assert.ok(checkout, 'build job must have a checkout step');
  const ref = checkout.with?.ref;
  assert.ok(ref, 'checkout must declare a ref');

  // workflow_call with an explicit post-sync SHA builds that SHA.
  assert.equal(
    evaluateFallbackExpression(ref, { inputs: { ref: 'post-sync-sha' }, github: { sha: 'pre-sync-sha' } }),
    'post-sync-sha',
    'a caller-supplied ref must win',
  );

  // push / pull_request builds keep the current event SHA (inputs is empty).
  assert.equal(
    evaluateFallbackExpression(ref, { inputs: {}, github: { sha: 'event-sha' } }),
    'event-sha',
    'push and pull_request builds must retain the triggering event SHA',
  );
});

test('sync.yml update job exposes a head_sha output wired to a step', async () => {
  const wf = await loadWorkflow('sync.yml');
  const updateJob = wf.jobs?.update;
  assert.ok(updateJob, 'sync.yml must have an update job');
  const headSha = String(updateJob.outputs?.head_sha ?? '');
  assert.match(
    headSha,
    /steps\.[A-Za-z0-9_-]+\.outputs\.head_sha/,
    'update job must expose head_sha from a step output',
  );

  const stepId = headSha.match(/steps\.([A-Za-z0-9_-]+)\.outputs\.head_sha/)?.[1];
  const steps = stepsOf(updateJob);
  assert.ok(
    steps.some((s) => s.id === stepId),
    `update job must contain the step "${stepId}" that produces head_sha`,
  );
});

test('sync.yml resolves the pushed HEAD sha after commit and tag, for applied and no-op runs', async () => {
  const wf = await loadWorkflow('sync.yml');
  const updateJob = wf.jobs?.update;
  assert.ok(updateJob, 'sync.yml must have an update job');
  const steps = stepsOf(updateJob);

  const headSha = String(updateJob.outputs?.head_sha ?? '');
  const stepId = headSha.match(/steps\.([A-Za-z0-9_-]+)\.outputs\.head_sha/)?.[1];
  const headIndex = findStepIndex(steps, (s) => s.id === stepId);
  assert.ok(headIndex >= 0, 'the head_sha step must exist');

  const commitIndex = findStepIndex(steps, (s) => /git tag/.test(String(s.run ?? '')));
  assert.ok(commitIndex >= 0, 'update job must have a commit-and-tag step');
  assert.ok(
    headIndex > commitIndex,
    'head_sha must be resolved AFTER the commit/tag push so it names the deployed tree',
  );

  const headStep = steps[headIndex];
  assert.match(String(headStep.run ?? ''), /git rev-parse HEAD/, 'head_sha must come from git rev-parse HEAD');
  assert.match(String(headStep.run ?? ''), /GITHUB_OUTPUT/, 'head_sha must be written to $GITHUB_OUTPUT');
  assert.doesNotMatch(
    String(headStep.if ?? ''),
    /applied/,
    'head_sha must also be produced for a no-op apply, not only when applied == true',
  );
});

test('sync.yml deploy passes the resolved head sha to deploy-site.yml', async () => {
  const wf = await loadWorkflow('sync.yml');
  const deployJob = wf.jobs?.deploy;
  assert.ok(deployJob, 'sync.yml must have a deploy job');
  assert.match(
    String(deployJob.with?.ref ?? ''),
    /needs\.update\.outputs\.head_sha/,
    'sync deploy must build the commit produced by the update job',
  );
});

test('sync.yml still calls deploy-site.yml exactly once', async () => {
  const wf = await loadWorkflow('sync.yml');
  const callers = Object.values(wf.jobs ?? {}).filter((job) =>
    /deploy-site\.yml/.test(String(job.uses ?? '')),
  );
  assert.equal(callers.length, 1, 'exactly one job may call deploy-site.yml (no duplicate deploys)');
});

// ─── Build provenance: last-updated indicator ───────────────────────
//
// The site advertises when it was built and from which commit. Because a
// reusable workflow inherits the CALLER's event context, `github.sha` is the
// PRE-sync commit even after checkout pins a newer `inputs.ref`. The built
// commit must therefore be resolved from the worktree with `git rev-parse HEAD`
// AFTER checkout, not read from `github.sha`.

test('deploy-site.yml resolves the built commit via git rev-parse HEAD after checkout', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const steps = stepsOf(wf.jobs?.build);

  const checkoutIndex = findStepIndex(steps, (s) =>
    String(s.uses ?? '').startsWith('actions/checkout'),
  );
  assert.ok(checkoutIndex >= 0, 'build job must have a checkout step');

  const metaIndex = findStepIndex(steps, (s) => /git rev-parse HEAD/.test(String(s.run ?? '')));
  assert.ok(metaIndex >= 0, 'build job must resolve the built commit with git rev-parse HEAD');
  assert.ok(
    metaIndex > checkoutIndex,
    'the built commit must be resolved AFTER checkout so it names the checked-out tree',
  );
  const buildIndex = findStepIndex(
    steps,
    (s) => /npm run build/.test(String(s.run ?? '')) && s['working-directory'] === 'site',
  );
  const testIndex = findStepIndex(
    steps,
    (s) => /npm test/.test(String(s.run ?? '')) && s['working-directory'] === 'site',
  );
  const uploadIndex = findStepIndex(
    steps,
    (s) => String(s.uses ?? '').startsWith('actions/upload-pages-artifact'),
  );
  assert.ok(
    metaIndex < buildIndex && metaIndex < testIndex,
    'build metadata must be resolved before the site build and tests consume it',
  );
  assert.ok(
    buildIndex < testIndex,
    'the site build must precede site tests so built-output assertions cannot skip',
  );
  assert.ok(
    testIndex < uploadIndex,
    'site tests must pass before the Pages artifact is uploaded',
  );

  const metaStep = steps[metaIndex];
  assert.equal(metaStep.id, 'buildinfo', 'metadata consumers must reference the producing step id');
  assert.match(
    String(metaStep.run ?? ''),
    /GITHUB_OUTPUT/,
    'the resolved commit must be written to $GITHUB_OUTPUT',
  );
  assert.match(
    String(metaStep.run ?? ''),
    /time=\$\(date -u \+%Y-%m-%dT%H:%M:%SZ\)/,
    'the metadata step must emit a UTC RFC3339 build time',
  );
});

test('deploy-site.yml exports SITE_BUILD_COMMIT and SITE_BUILD_TIME to the site build step', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const steps = stepsOf(wf.jobs?.build);
  const buildStep = steps.find(
    (s) => /npm run build/.test(String(s.run ?? '')) && s['working-directory'] === 'site',
  );
  assert.ok(buildStep, 'build job must run npm run build in site/');
  const env = buildStep.env ?? {};
  assert.ok(env.SITE_BUILD_COMMIT, 'build step must export SITE_BUILD_COMMIT');
  assert.ok(env.SITE_BUILD_TIME, 'build step must export SITE_BUILD_TIME');
});

test('deploy-site.yml exports the same build provenance to the site test step', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const steps = stepsOf(wf.jobs?.build);
  const testStep = steps.find(
    (s) => /npm test/.test(String(s.run ?? '')) && s['working-directory'] === 'site',
  );
  assert.ok(testStep, 'build job must run the site test suite');
  const env = testStep.env ?? {};
  assert.ok(env.SITE_BUILD_COMMIT, 'test step must export SITE_BUILD_COMMIT');
  assert.ok(env.SITE_BUILD_TIME, 'test step must export SITE_BUILD_TIME');
});

test('deploy-site.yml uses identical SITE_BUILD_* expressions for the build and test steps', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const steps = stepsOf(wf.jobs?.build);
  const buildStep = steps.find(
    (s) => /npm run build/.test(String(s.run ?? '')) && s['working-directory'] === 'site',
  );
  const testStep = steps.find(
    (s) => /npm test/.test(String(s.run ?? '')) && s['working-directory'] === 'site',
  );
  assert.ok(buildStep && testStep, 'both the site build and test steps must exist');

  // The build must be tested with the SAME provenance it was stamped with, so
  // the rendered footer/status the tests assert against match the deployed tree.
  assert.equal(
    buildStep.env?.SITE_BUILD_COMMIT,
    testStep.env?.SITE_BUILD_COMMIT,
    'SITE_BUILD_COMMIT must be identical between the build and test steps',
  );
  assert.equal(
    buildStep.env?.SITE_BUILD_TIME,
    testStep.env?.SITE_BUILD_TIME,
    'SITE_BUILD_TIME must be identical between the build and test steps',
  );
  assert.equal(
    buildStep.env?.SITE_BUILD_COMMIT,
    '${{ steps.buildinfo.outputs.commit }}',
    'both consumers must use the checked-out commit output',
  );
  assert.equal(
    buildStep.env?.SITE_BUILD_TIME,
    '${{ steps.buildinfo.outputs.time }}',
    'both consumers must use the single UTC timestamp output',
  );
});

test('deploy-site.yml does NOT derive the built commit from github.sha', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const steps = stepsOf(wf.jobs?.build);

  for (const label of ['build', 'test']) {
    const step = steps.find(
      (s) =>
        s['working-directory'] === 'site' &&
        new RegExp(label === 'build' ? 'npm run build' : 'npm test').test(String(s.run ?? '')),
    );
    assert.ok(step, `build job must have a site ${label} step`);
    const commitEnv = String(step.env?.SITE_BUILD_COMMIT ?? '');
    assert.doesNotMatch(
      commitEnv,
      /github\.sha/,
      `SITE_BUILD_COMMIT in the ${label} step must not come from the pre-sync github.sha`,
    );
    assert.match(
      commitEnv,
      /steps\.[A-Za-z0-9_-]+\.outputs\.commit/,
      `SITE_BUILD_COMMIT in the ${label} step must come from the resolved git rev-parse output`,
    );
  }
});
