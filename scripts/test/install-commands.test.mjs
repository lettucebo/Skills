import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  assertRequiredAddOptions,
  buildPublishedSource,
  buildSpawnRequest,
  createSmokePlan,
  parseCliArgs,
  REQUIRED_ADD_OPTIONS,
  SKILLS_CLI_SPEC,
} from '../smoke-npx.mjs';

test('buildPublishedSource builds the repository release source with #ref syntax', () => {
  assert.equal(
    buildPublishedSource({ ref: 'v1.0.0' }),
    'lettucebo/Skills#v1.0.0',
  );
});

test('buildPublishedSource builds the subpath release source with #ref syntax', () => {
  assert.equal(
    buildPublishedSource({
      ref: 'v1.0.0',
      subpath: 'skills/azure',
    }),
    'lettucebo/Skills/skills/azure#v1.0.0',
  );
});

test('buildPublishedSource builds the single-skill release source with #ref syntax', () => {
  assert.equal(
    buildPublishedSource({
      ref: 'v1.0.0',
      skillName: 'az-cost-optimize',
    }),
    'lettucebo/Skills#v1.0.0@az-cost-optimize',
  );
});

test('buildPublishedSource rejects misplaced @vX.Y.Z version syntax', () => {
  assert.throws(
    () =>
      buildPublishedSource({
        repository: 'lettucebo/Skills@v1.0.0',
        ref: 'main',
      }),
    /Use #<ref> for git references; @<name> is reserved for skill filters\./,
  );

  assert.throws(
    () =>
      buildPublishedSource({
        ref: 'main',
        skillName: 'v1.0.0',
      }),
    /Skill filter "v1\.0\.0" looks like a git ref; use #v1\.0\.0 instead of @v1\.0\.0\./,
  );
});

test('createSmokePlan pins the CLI package and local smoke coverage', async () => {
  const plan = await createSmokePlan();

  assert.equal(plan.cliSpec, SKILLS_CLI_SPEC);
  assert.equal(plan.cases.length, 3);

  assert.deepEqual(
    plan.cases.map((entry) => ({
      name: entry.name,
      sourcePathSuffix: entry.sourcePath.replace(plan.repoRoot, '').replace(/\\/g, '/'),
      expectedCount: entry.expectedNames.length,
      includesFullDepth: entry.argv.includes('--full-depth'),
    })),
    [
      {
        name: 'full-repo',
        sourcePathSuffix: '',
        expectedCount: 119,
        includesFullDepth: true,
      },
      {
        name: 'azure-subpath',
        sourcePathSuffix: '/skills/azure',
        expectedCount: 9,
        includesFullDepth: false,
      },
      {
        name: 'single-skill',
        sourcePathSuffix: '',
        expectedCount: 1,
        includesFullDepth: true,
      },
    ],
  );
});

test('parseCliArgs accepts the npm forwarded positional ref form', () => {
  assert.deepEqual(parseCliArgs(['main']), {
    ref: 'main',
  });
});

test('parseCliArgs rejects flags that are missing values', () => {
  assert.throws(
    () => parseCliArgs(['--source']),
    /--source requires a value/,
  );

  assert.throws(
    () => parseCliArgs(['--ref']),
    /--ref requires a value/,
  );
});

test('parseCliArgs rejects option tokens as flag values', () => {
  assert.throws(
    () => parseCliArgs(['--source', '--ref', 'main']),
    /--source requires a value/,
  );

  assert.throws(
    () => parseCliArgs(['--ref', '--source', 'C:\\repo']),
    /--ref requires a value/,
  );
});

test('buildSpawnRequest uses npm exec through node.exe on Windows', () => {
  const expectedNpmCliPath = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );

  assert.deepEqual(
    buildSpawnRequest(['--yes', 'skills@1.5.1', '--version'], { platform: 'win32' }),
    {
      command: process.execPath,
      args: [
        expectedNpmCliPath,
        'exec',
        '--yes',
        '--package=skills@1.5.1',
        '--',
        'skills',
        '--version',
      ],
    },
  );
});

test('buildSpawnRequest preserves Windows local paths with shell metacharacters literally', () => {
  const expectedNpmCliPath = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  const request = buildSpawnRequest(
    ['--yes', 'skills@1.5.1', 'add', 'C:\\foo&bar\\%TEMP%\\repo', '--skill', '*'],
    { platform: 'win32' },
  );

  assert.equal(request.command, process.execPath);
  assert.equal(request.args[0], expectedNpmCliPath);
  assert.deepEqual(request.args.slice(1, 6), ['exec', '--yes', '--package=skills@1.5.1', '--', 'skills']);
  assert.deepEqual(request.args.slice(6), ['add', 'C:\\foo&bar\\%TEMP%\\repo', '--skill', '*']);
});

test('assertRequiredAddOptions accepts the pinned noninteractive add flags from help output', () => {
  const helpText = `
Add Options:
  -g, --global           Install skill globally (user-level) instead of project-level
  -a, --agent <agents>   Specify agents to install to (use '*' for all agents)
  -s, --skill <skills>   Specify skill names to install (use '*' for all skills)
  -y, --yes              Skip confirmation prompts
  --copy                 Copy files instead of symlinking to agent directories
  --all                  Shorthand for --skill '*' --agent '*' -y
  --full-depth           Search all subdirectories even when a root SKILL.md exists
`;

  assert.deepEqual(assertRequiredAddOptions(helpText), REQUIRED_ADD_OPTIONS);
});

test('assertRequiredAddOptions rejects pinned smoke flags that are missing from help output', () => {
  const helpText = `
Add Options:
  -g, --global           Install skill globally (user-level) instead of project-level
  -a, --agent <agents>   Specify agents to install to (use '*' for all agents)
  -s, --skill <skills>   Specify skill names to install (use '*' for all skills)
  -y, --yes              Skip confirmation prompts
`;

  assert.throws(
    () => assertRequiredAddOptions(helpText),
    /Pinned skills@1\.5\.1 add flags missing from --help: --copy, --full-depth/,
  );
});

test('assertRequiredAddOptions only trusts the Add Options section', () => {
  const helpText = `
Update Options:
  -y, --yes              Skip scope prompt (auto-detect: project if in a project, else global)

Add Options:
  -g, --global           Install skill globally (user-level) instead of project-level
  -s, --skill <skills>   Specify skill names to install (use '*' for all skills)
  --copy                 Copy files instead of symlinking to agent directories
  --full-depth           Search all subdirectories even when a root SKILL.md exists

Remove Options:
  -a, --agent <agents>   Remove from specific agents (use '*' for all agents)
`;

  assert.throws(
    () => assertRequiredAddOptions(helpText),
    /Pinned skills@1\.5\.1 add flags missing from --help: --agent, --yes/,
  );
});
