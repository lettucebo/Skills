/**
 * Structural tests for the release-publication and sync-automation seams.
 *
 * Three defects are pinned here:
 *
 *  - deploy-site.yml deployed a site whose "published" state was a hardcoded
 *    `false`, so install commands would stay marked pending forever.
 *  - sync.yml ran the dry-run job for an explicit `dry_run=false` dispatch,
 *    because the condition only excluded `baseline`.
 *  - the daily cron was armed while `v1.1.0` was still unpublished, so every
 *    scheduled run would fail the tag/lock reconciliation guard and reopen the
 *    tracking issue.
 *
 * The GitHub-expression evaluator below keeps the job conditions honest as a
 * truth table instead of a substring match.
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
  return parse(await readFile(path.join(workflowDir, name), 'utf8'));
}

// ─── Minimal GitHub Actions expression evaluator ────────────────────
//
// Supports the subset the sync workflow uses: `&&`, `||`, `!`, `==`, `!=`,
// parentheses, single-quoted strings, and dotted context lookups. A missing
// context value is null, which is falsy — exactly how `inputs.dry_run`
// behaves on a `schedule` event.

function evaluateExpression(expression, context) {
  const body = String(expression)
    .trim()
    .replace(/^\$\{\{/, '')
    .replace(/\}\}$/, '')
    .trim();

  const tokens = body.match(/'(?:[^']|'')*'|&&|\|\||==|!=|!|\(|\)|[A-Za-z0-9_.$-]+/g) ?? [];
  let index = 0;

  const peek = () => tokens[index];
  const next = () => tokens[index++];

  function truthy(value) {
    return !(value === false || value === null || value === undefined || value === '' || value === 0);
  }

  function lookup(pathExpression) {
    return pathExpression.split('.').reduce(
      (scope, key) => (scope === null || scope === undefined ? null : scope[key] ?? null),
      context,
    );
  }

  function parsePrimary() {
    const token = next();

    if (token === '(') {
      const value = parseOr();
      const closing = next();
      assert.equal(closing, ')', `unbalanced parentheses in expression: ${body}`);
      return value;
    }

    if (token === '!') {
      return !truthy(parsePrimary());
    }

    if (token.startsWith("'")) {
      return token.slice(1, -1).replace(/''/g, "'");
    }

    if (token === 'true') return true;
    if (token === 'false') return false;

    return lookup(token);
  }

  function parseComparison() {
    let left = parsePrimary();

    while (peek() === '==' || peek() === '!=') {
      const operator = next();
      const right = parsePrimary();
      const equal = (left ?? null) === (right ?? null);
      left = operator === '==' ? equal : !equal;
    }

    return left;
  }

  function parseAnd() {
    let left = parseComparison();
    while (peek() === '&&') {
      next();
      const right = parseComparison();
      left = truthy(left) ? right : left;
    }
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (peek() === '||') {
      next();
      const right = parseAnd();
      left = truthy(left) ? left : right;
    }
    return left;
  }

  const result = parseOr();
  assert.equal(index, tokens.length, `unparsed tokens in expression: ${body}`);
  return truthy(result);
}

test('expression evaluator sanity: operators, precedence and missing context', () => {
  assert.equal(evaluateExpression("${{ a == 'x' && b }}", { a: 'x', b: true }), true);
  assert.equal(evaluateExpression("${{ a == 'x' && b }}", { a: 'y', b: true }), false);
  assert.equal(evaluateExpression('${{ !a }}', {}), true);
  assert.equal(evaluateExpression('${{ a || b }}', { a: false, b: true }), true);
  assert.equal(
    evaluateExpression("${{ (x == 's' && v == 'true') || (x == 'd' && !i.b) }}", {
      x: 'd',
      i: {},
    }),
    true,
  );
});

// ─── B6: dry-run must not run for an explicit dry_run=false ─────────

const dispatch = (dry_run, baseline, vars = {}) => ({
  github: { event_name: 'workflow_dispatch' },
  inputs: { dry_run, baseline },
  vars,
});

const schedule = (vars = {}) => ({
  github: { event_name: 'schedule' },
  inputs: null,
  vars,
});

async function jobCondition(jobName) {
  const wf = await loadWorkflow('sync.yml');
  const job = wf.jobs?.[jobName];
  assert.ok(job, `sync.yml must define the ${jobName} job`);
  return String(job.if ?? '');
}

test('SY1: dry-run job runs only for an explicit dry_run=true dispatch', async () => {
  const condition = await jobCondition('dry-run');

  assert.equal(
    evaluateExpression(condition, dispatch(true, false)),
    true,
    'dry_run=true, baseline=false must plan',
  );
  assert.equal(
    evaluateExpression(condition, dispatch(false, false)),
    false,
    'dry_run=false, baseline=false is an APPLY request — the dry-run job must not also run',
  );
  assert.equal(
    evaluateExpression(condition, dispatch(false, true)),
    false,
    'a baseline apply must not run the dry-run job',
  );
  assert.equal(
    evaluateExpression(condition, schedule()),
    false,
    'the daily schedule must not run the dry-run job',
  );
});

test('SY2: baseline job runs only for baseline=true with dry_run=false', async () => {
  const condition = await jobCondition('baseline-apply');

  assert.equal(evaluateExpression(condition, dispatch(false, true)), true);
  assert.equal(evaluateExpression(condition, dispatch(true, true)), false);
  assert.equal(evaluateExpression(condition, dispatch(false, false)), false);
  assert.equal(evaluateExpression(condition, schedule()), false);
});

// ─── B5: the daily cron is gated on an explicit repository variable ──

test('SY3: the schedule only applies updates when SKILLS_SYNC_ENABLED is exactly "true"', async () => {
  const condition = await jobCondition('update');

  assert.equal(
    evaluateExpression(condition, schedule({ SKILLS_SYNC_ENABLED: 'true' })),
    true,
    'an enabled repository variable must allow the scheduled apply',
  );
  assert.equal(
    evaluateExpression(condition, schedule()),
    false,
    'an unset SKILLS_SYNC_ENABLED must skip the scheduled apply — a missing release tag would ' +
      'otherwise fail reconciliation on every cron tick and spam the tracking issue',
  );
  assert.equal(
    evaluateExpression(condition, schedule({ SKILLS_SYNC_ENABLED: 'false' })),
    false,
  );
  assert.equal(
    evaluateExpression(condition, schedule({ SKILLS_SYNC_ENABLED: 'TRUE' })),
    false,
    'only the exact lowercase literal enables the schedule',
  );
});

test('SY4: manual apply dispatch stays available regardless of the cron gate', async () => {
  const condition = await jobCondition('update');

  assert.equal(
    evaluateExpression(condition, dispatch(false, false)),
    true,
    'an operator-triggered apply must not require the cron variable',
  );
  assert.equal(evaluateExpression(condition, dispatch(true, false)), false);
  assert.equal(evaluateExpression(condition, dispatch(false, true)), false);
});

test('SY5: the daily schedule trigger is retained', async () => {
  const wf = await loadWorkflow('sync.yml');
  const cron = wf.on?.schedule;
  assert.ok(Array.isArray(cron) && cron.length > 0, 'the daily cron trigger must be kept');
  assert.match(String(cron[0].cron), /^\S+ \S+ \S+ \S+ \S+$/, 'cron must be a 5-field schedule');
});

test('SY6: enabling the cron is documented for operators', async () => {
  const raw = await readFile(path.join(workflowDir, 'sync.yml'), 'utf8');
  assert.match(
    raw,
    /SKILLS_SYNC_ENABLED/,
    'sync.yml must reference the gate variable',
  );

  const readme = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
  assert.match(
    readme,
    /SKILLS_SYNC_ENABLED/,
    'README must document how to enable the daily sync after the release tag is published',
  );
});

// ─── B4/B7: deploy-site resolves publication and tests before build ──

function stepsOf(job) {
  return job?.steps ?? [];
}

function stepIndex(steps, predicate) {
  return steps.findIndex(predicate);
}

const isSiteTestStep = (s) =>
  /npm (--prefix site )?test\b/.test(String(s.run ?? '')) &&
  (String(s.run).includes('--prefix site') || s['working-directory'] === 'site');

const isSiteBuildStep = (s) =>
  /npm run build/.test(String(s.run ?? '')) &&
  (String(s.run).includes('--prefix site') || s['working-directory'] === 'site');

const isUploadStep = (s) => String(s.uses ?? '').startsWith('actions/upload-pages-artifact');

test('DP1: deploy-site build checkout fetches full history and tags', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const checkout = stepsOf(wf.jobs?.build).find((s) =>
    String(s.uses ?? '').startsWith('actions/checkout'),
  );
  assert.ok(checkout, 'build job must check out the repository');
  assert.equal(checkout.with?.['fetch-depth'], 0, 'tag ancestry needs the full history');
  assert.equal(checkout.with?.['fetch-tags'], true, 'the release tag must be fetched');
});

test('DP2: deploy-site resolves publication from the lock release and tag ancestry', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const steps = stepsOf(wf.jobs?.build);
  const resolver = steps.find((s) => /published=/.test(String(s.run ?? '')));

  assert.ok(resolver, 'build job must compute a published flag');
  assert.ok(resolver.id, 'the resolver step needs an id so later steps can read its output');

  const script = String(resolver.run);
  assert.match(script, /skills\.lock\.json/, 'the tag name must come from the lock release');
  assert.match(script, /refs\/tags/, 'the resolver must look the release tag up by ref');
  assert.match(
    script,
    /merge-base --is-ancestor/,
    'a tag that is not an ancestor of the built commit does not publish this tree',
  );
  assert.match(script, /GITHUB_OUTPUT/, 'the flag must be exported as a step output');
});

test('DP3: deploy-site builds, then tests the built site, then uploads the artifact', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const steps = stepsOf(wf.jobs?.build);

  const buildIdx = stepIndex(steps, isSiteBuildStep);
  const testIdx = stepIndex(steps, isSiteTestStep);
  const uploadIdx = stepIndex(steps, isUploadStep);

  assert.ok(buildIdx >= 0, 'deploy-site must build the site');
  assert.ok(testIdx >= 0, 'deploy-site must run the site unit tests');
  assert.ok(uploadIdx >= 0, 'deploy-site must upload the Pages artifact');

  assert.ok(
    buildIdx < testIdx,
    'the site suite contains dist-dependent guards that silently SKIP when dist/ is absent; ' +
      'a clean CI checkout must build (Astro + Pagefind) before the tests run',
  );
  assert.ok(
    testIdx < uploadIdx,
    'a GITHUB_TOKEN-triggered sync deploy must not upload an artifact whose tests never ran',
  );
});

test('DP6: the Pagefind postbuild runs exactly once, through the single build step', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const steps = stepsOf(wf.jobs?.build);

  assert.equal(
    steps.filter(isSiteBuildStep).length,
    1,
    'a second `npm run build` would re-run the pagefind postbuild over the same dist for no gain',
  );
  assert.equal(
    steps.filter((s) => /pagefind/i.test(String(s.run ?? ''))).length,
    0,
    'pagefind must stay wired through the site postbuild script, never invoked a second time',
  );
});

test('DP4: the resolved publication flag is passed to both the tests and the build', async () => {
  const wf = await loadWorkflow('deploy-site.yml');
  const steps = stepsOf(wf.jobs?.build);
  const resolver = steps.find((s) => /published=/.test(String(s.run ?? '')));
  assert.ok(resolver?.id, 'the resolver step must have an id');

  const expected = new RegExp(`steps\\.${resolver.id}\\.outputs\\.published`);

  for (const [label, predicate] of [
    ['site unit tests', isSiteTestStep],
    ['site build', isSiteBuildStep],
  ]) {
    const step = steps.find(predicate);
    assert.ok(step, `deploy-site must have a ${label} step`);
    assert.match(
      String(step.env?.RELEASE_PUBLISHED ?? ''),
      expected,
      `${label} must receive RELEASE_PUBLISHED from the resolver step`,
    );
  }
});

test('DP5: publication is never hardcoded in the workflow', async () => {
  const raw = await readFile(path.join(workflowDir, 'deploy-site.yml'), 'utf8');
  assert.doesNotMatch(
    raw,
    /RELEASE_PUBLISHED:\s*(true|false|'true'|'false'|"true"|"false")\s*$/m,
    'RELEASE_PUBLISHED must be resolved from the repository state, not pinned in the workflow',
  );
});
