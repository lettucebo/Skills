import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSkillFrontmatter } from './lib/frontmatter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, '..');

export const SKILLS_CLI_SPEC = 'skills@1.5.1';
export const SMOKE_AGENT = 'github-copilot';
export const RENAMED_SKILL_NAMES = [
  'claude-mcp-builder',
  'microsoft-mcp-builder',
  'claude-skill-creator',
  'microsoft-skill-creator',
];
export const REQUIRED_ADD_OPTIONS = ['--agent', '--skill', '--yes', '--copy', '--full-depth'];

const VERSION_REF_PATTERN = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function buildPublishedSource({
  repository = 'lettucebo/Skills',
  ref,
  subpath,
  skillName,
} = {}) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedRef = normalizeRef(ref);
  const normalizedSubpath = normalizeOptionalSubpath(subpath);
  const normalizedSkillName = normalizeOptionalSkillName(skillName);
  const target = normalizedSubpath
    ? `${normalizedRepository}/${normalizedSubpath}`
    : normalizedRepository;

  return `${target}#${normalizedRef}${normalizedSkillName ? `@${normalizedSkillName}` : ''}`;
}

export async function createSmokePlan({
  repoRoot = defaultRepoRoot,
  ref = 'main',
  cliSpec = SKILLS_CLI_SPEC,
  agent = SMOKE_AGENT,
} = {}) {
  const lock = await loadCatalogLock(repoRoot);
  const allExpectedNames = getExpectedNames(lock.skills);
  const azureExpectedNames = getExpectedNames(
    lock.skills.filter((entry) => entry.path.startsWith('skills/azure/')),
  );
  const singleSkillExpectedNames = getExpectedNames(
    lock.skills.filter((entry) => entry.name === 'az-cost-optimize'),
  );

  if (allExpectedNames.length !== lock.counts?.total) {
    throw new Error(
      `catalog/skills.lock.json count mismatch: expected ${lock.counts?.total}, found ${allExpectedNames.length} unique skill names.`,
    );
  }

  for (const requiredName of RENAMED_SKILL_NAMES) {
    if (!allExpectedNames.includes(requiredName)) {
      throw new Error(`Missing renamed skill in catalog/skills.lock.json: ${requiredName}`);
    }
  }

  return {
    repoRoot,
    cliSpec,
    agent,
    lockRelease: lock.release,
    publishedExamples: {
      repo: buildPublishedSource({ ref }),
      azureSubpath: buildPublishedSource({ ref, subpath: 'skills/azure' }),
      singleSkill: buildPublishedSource({ ref, skillName: 'az-cost-optimize' }),
    },
    cases: [
      buildSmokeCase({
        cliSpec,
        agent,
        name: 'full-repo',
        sourcePath: repoRoot,
        expectedNames: allExpectedNames,
        skillArgs: ['--skill', '*'],
        extraArgs: ['--full-depth'],
        requiredNames: RENAMED_SKILL_NAMES,
      }),
      buildSmokeCase({
        cliSpec,
        agent,
        name: 'azure-subpath',
        sourcePath: path.join(repoRoot, 'skills', 'azure'),
        expectedNames: azureExpectedNames,
        skillArgs: ['--skill', '*'],
      }),
      buildSmokeCase({
        cliSpec,
        agent,
        name: 'single-skill',
        sourcePath: repoRoot,
        expectedNames: singleSkillExpectedNames,
        skillArgs: ['--skill', 'az-cost-optimize'],
        extraArgs: ['--full-depth'],
      }),
    ],
  };
}

function buildSmokeCase({
  cliSpec,
  agent,
  name,
  sourcePath,
  expectedNames,
  skillArgs,
  extraArgs = [],
  requiredNames = [],
}) {
  return {
    name,
    sourcePath,
    expectedNames,
    requiredNames,
    argv: [
      '--yes',
      cliSpec,
      'add',
      sourcePath,
      '--agent',
      agent,
      '--copy',
      '-y',
      ...skillArgs,
      ...extraArgs,
    ],
  };
}

async function loadCatalogLock(repoRoot) {
  const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
  const lockText = await readFile(lockPath, 'utf8');
  const lock = JSON.parse(lockText);

  if (!Array.isArray(lock.skills)) {
    throw new Error('catalog/skills.lock.json must contain a skills array.');
  }

  return lock;
}

function getExpectedNames(entries) {
  return Array.from(new Set(
    entries
      .filter((entry) => entry.category !== 'removed')
      .map((entry) => entry.name),
  )).sort(compareStrings);
}

function normalizeRepository(repository) {
  if (typeof repository !== 'string' || repository.trim() === '') {
    throw new Error('Repository must be a non-empty string.');
  }

  const trimmed = repository.trim().replace(/\/+$/, '');

  if (trimmed.includes('#')) {
    throw new Error('Repository must not include # fragments; pass ref separately.');
  }

  if (/@v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed)) {
    throw new Error('Use #<ref> for git references; @<name> is reserved for skill filters.');
  }

  return trimmed;
}

function normalizeRef(ref) {
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new Error('ref must be a non-empty string.');
  }

  const trimmed = ref.trim();

  if (trimmed.includes('#') || trimmed.includes('@')) {
    throw new Error(`Invalid ref "${trimmed}".`);
  }

  return trimmed;
}

function normalizeOptionalSubpath(subpath) {
  if (subpath == null) {
    return '';
  }

  if (typeof subpath !== 'string' || subpath.trim() === '') {
    throw new Error('subpath must be a non-empty string when provided.');
  }

  return subpath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function normalizeOptionalSkillName(skillName) {
  if (skillName == null) {
    return '';
  }

  if (typeof skillName !== 'string' || skillName.trim() === '') {
    throw new Error('skillName must be a non-empty string when provided.');
  }

  const trimmed = skillName.trim();

  if (VERSION_REF_PATTERN.test(trimmed)) {
    throw new Error(
      `Skill filter "${trimmed}" looks like a git ref; use #${trimmed} instead of @${trimmed}.`,
    );
  }

  if (trimmed.includes('#') || trimmed.includes('@')) {
    throw new Error(`Invalid skill filter "${trimmed}".`);
  }

  return trimmed;
}

async function runSmokePlan(plan) {
  const helpText = inspectPinnedAddHelp(plan.cliSpec);
  const supportedAddOptions = assertRequiredAddOptions(helpText, plan.cliSpec);
  const results = [];

  for (const smokeCase of plan.cases) {
    results.push(await runSmokeCase(plan.repoRoot, smokeCase));
  }

  return {
    cliSpec: plan.cliSpec,
    agent: plan.agent,
    lockRelease: plan.lockRelease,
    supportedAddOptions,
    publishedExamples: plan.publishedExamples,
    results,
  };
}

function inspectPinnedAddHelp(cliSpec) {
  const spawnRequest = buildSpawnRequest(['--yes', cliSpec, '--help']);
  const commandResult = spawnSync(spawnRequest.command, spawnRequest.args, {
    cwd: defaultRepoRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: spawnRequest.windowsVerbatimArguments,
  });

  if (commandResult.status !== 0) {
    throw new Error(
      [
        `Unable to inspect ${cliSpec} --help before smoke execution.`,
        commandResult.error?.message && `Error: ${commandResult.error.message}`,
        commandResult.stderr?.trim() && `stderr:\n${commandResult.stderr.trim()}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  return commandResult.stdout;
}

async function runSmokeCase(repoRoot, smokeCase) {
  const runtimeRoot = path.join(repoRoot, 'scripts', 'test', '.runtime');
  const runtimeProject = path.join(
    runtimeRoot,
    `smoke-npx-${smokeCase.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  await mkdir(runtimeProject, { recursive: true });
  await writeFile(
    path.join(runtimeProject, 'package.json'),
    JSON.stringify({ name: `smoke-${smokeCase.name}`, private: true }, null, 2),
  );

  try {
    const spawnRequest = buildSpawnRequest(smokeCase.argv);
    const commandResult = spawnSync(spawnRequest.command, spawnRequest.args, {
      cwd: runtimeProject,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      windowsVerbatimArguments: spawnRequest.windowsVerbatimArguments,
    });

    if (commandResult.status !== 0) {
      throw new Error(formatCommandFailure(commandResult, smokeCase));
    }

    const installedNames = await collectInstalledSkillNames(runtimeProject);

    assertExactNames(installedNames, smokeCase.expectedNames, smokeCase.name);
    assertRequiredNames(installedNames, smokeCase.requiredNames, smokeCase.name);

    return {
      name: smokeCase.name,
      sourcePath: smokeCase.sourcePath,
      expectedCount: smokeCase.expectedNames.length,
      installedCount: installedNames.length,
      installedNames,
    };
  } finally {
    await rm(runtimeProject, { recursive: true, force: true });
  }
}

export function buildSpawnRequest(argv, { platform = process.platform } = {}) {
  if (platform === 'win32') {
    const npmCliPath = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const [yesFlag, cliSpec, ...rest] = argv;

    if (yesFlag !== '--yes' || typeof cliSpec !== 'string' || cliSpec.trim() === '') {
      throw new Error(`Windows smoke execution expects argv to start with ["--yes", "<cliSpec>"], received: ${JSON.stringify(argv)}`);
    }

    return {
      command: process.execPath,
      args: [npmCliPath, 'exec', '--yes', `--package=${cliSpec}`, '--', 'skills', ...rest],
    };
  }

  return {
    command: 'npx',
    args: argv,
  };
}

function formatCommandFailure(commandResult, smokeCase) {
  const combinedOutput = [commandResult.stdout, commandResult.stderr]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .join('\n');
  const tail = combinedOutput
    .split(/\r?\n/)
    .slice(-40)
    .join('\n');

  return [
    `Smoke case "${smokeCase.name}" failed with exit code ${commandResult.status ?? 'null'}.`,
    `Command: ${formatDisplayCommand(smokeCase.argv)}`,
    tail && `Output tail:\n${tail}`,
    commandResult.error?.message && `Error: ${commandResult.error.message}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatDisplayCommand(argv) {
  const spawnRequest = buildSpawnRequest(argv);
  return `${spawnRequest.command} ${spawnRequest.args.join(' ')}`;
}

async function collectInstalledSkillNames(runtimeProject) {
  const skillsRoot = path.join(runtimeProject, '.agents', 'skills');
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const installedNames = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillFilePath = path.join(skillsRoot, entry.name, 'SKILL.md');
    const skillText = await readFile(skillFilePath, 'utf8');
    const frontmatter = parseSkillFrontmatter(skillText, skillFilePath);
    installedNames.push(frontmatter.name);
  }

  return installedNames.sort(compareStrings);
}

function assertExactNames(actualNames, expectedNames, caseName) {
  if (actualNames.length !== expectedNames.length) {
    throw new Error(
      `Smoke case "${caseName}" installed ${actualNames.length} skills, expected ${expectedNames.length}.`,
    );
  }

  for (let index = 0; index < expectedNames.length; index += 1) {
    if (actualNames[index] !== expectedNames[index]) {
      throw new Error(
        `Smoke case "${caseName}" mismatch at index ${index}: expected ${expectedNames[index]}, received ${actualNames[index]}.`,
      );
    }
  }
}

function assertRequiredNames(installedNames, requiredNames, caseName) {
  for (const requiredName of requiredNames) {
    if (!installedNames.includes(requiredName)) {
      throw new Error(`Smoke case "${caseName}" is missing required skill ${requiredName}.`);
    }
  }
}

export function assertRequiredAddOptions(helpText, cliSpec = SKILLS_CLI_SPEC) {
  const addOptionsSection = extractAddOptionsSection(helpText);
  const missingOptions = REQUIRED_ADD_OPTIONS.filter((flag) => !addOptionsSection.includes(flag));

  if (missingOptions.length > 0) {
    throw new Error(
      `Pinned ${cliSpec} add flags missing from --help: ${missingOptions.join(', ')}`,
    );
  }

  return REQUIRED_ADD_OPTIONS;
}

function extractAddOptionsSection(helpText) {
  const normalizedHelp = stripAnsi(helpText);
  const marker = 'Add Options:';
  const markerIndex = normalizedHelp.indexOf(marker);

  if (markerIndex < 0) {
    return '';
  }

  const afterMarker = normalizedHelp.slice(markerIndex + marker.length);
  const nextSectionMatch = afterMarker.match(/\n[A-Z][A-Za-z ]+:\n/);
  const sectionEnd = nextSectionMatch ? nextSectionMatch.index : afterMarker.length;

  return afterMarker.slice(0, sectionEnd);
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

export function parseCliArgs(argv) {
  const options = { ref: 'main' };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith('-')) {
      options.ref = arg;
      continue;
    }

    if (arg === '--ref') {
      options.ref = requireCliValue(arg, argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--source') {
      options.source = requireCliValue(arg, argv[index + 1]);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function requireCliValue(flag, value) {
  if (typeof value !== 'string' || value.trim() === '' || value.startsWith('-')) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

async function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const plan = await createSmokePlan({
      repoRoot: options.source ? path.resolve(options.source) : defaultRepoRoot,
      ref: options.ref,
    });
    const summary = await runSmokePlan(plan);

    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
