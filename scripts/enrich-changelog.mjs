import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CHANGELOG_PROMPT,
  CHANGELOG_PROMPT_ID,
  collectSkillHistory,
  summarizeSkillHistory,
} from './lib/changelog.mjs';
import {
  ENRICHMENT_SCHEMA_VERSION,
  assertValidEnrichmentArtifact,
  createArtifactFreshnessKey,
  createLocaleSignature,
  enrichmentArtifactPath,
  isArtifactFresh,
  isEligibleForEnrichment,
} from './lib/enrichment.mjs';
import { resolveCloneRef, resolveRepositoryUrl } from './lib/git-source.mjs';
import { hashText } from './lib/hash.mjs';
import { COPILOT_CLI_CONTRACT, createCopilotRunner } from './lib/llm.mjs';
import {
  OPENCC_CONVERTER_ID,
  createZhCnLocaleArtifact,
} from './lib/localization.mjs';
import { pruneEnrichment } from './prune-enrichment.mjs';
import {
  collectEnrichmentArtifacts,
  validateEnrichment,
} from './validate-enrichment.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);

export const CHANGELOG_GENERATOR_VERSION = 1;
export const CHANGELOG_LLM_TIMEOUT_MS = 300_000;
export const CHANGELOG_PROMPT_HASH = hashText(CHANGELOG_PROMPT);

function expectedLocaleSignatures(generatorVersion = CHANGELOG_GENERATOR_VERSION) {
  return {
    en: createLocaleSignature({
      locale: 'en',
      schemaVersion: ENRICHMENT_SCHEMA_VERSION,
      producer: 'llm',
      promptId: CHANGELOG_PROMPT_ID,
      promptHash: CHANGELOG_PROMPT_HASH,
      model: COPILOT_CLI_CONTRACT.model,
      generatorVersion,
      cliContract: COPILOT_CLI_CONTRACT,
    }),
    'zh-tw': createLocaleSignature({
      locale: 'zh-tw',
      schemaVersion: ENRICHMENT_SCHEMA_VERSION,
      producer: 'llm',
      promptId: CHANGELOG_PROMPT_ID,
      promptHash: CHANGELOG_PROMPT_HASH,
      model: COPILOT_CLI_CONTRACT.model,
      generatorVersion,
      cliContract: COPILOT_CLI_CONTRACT,
    }),
    'zh-cn': createLocaleSignature({
      locale: 'zh-cn',
      schemaVersion: ENRICHMENT_SCHEMA_VERSION,
      producer: 'opencc',
      promptId: CHANGELOG_PROMPT_ID,
      promptHash: CHANGELOG_PROMPT_HASH,
      converterVersion: OPENCC_CONVERTER_ID,
      generatorVersion,
      cliContract: COPILOT_CLI_CONTRACT,
    }),
  };
}

function isNewestFirst(commits) {
  let previous = Number.POSITIVE_INFINITY;
  for (const commit of commits) {
    const current = Date.parse(commit.date);
    if (!Number.isFinite(current) || current > previous) return false;
    previous = current;
  }
  return true;
}

function repositoryWebUrl(repository) {
  const cloneUrl = resolveRepositoryUrl(repository);
  const match = cloneUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (!match) {
    throw new Error(`Changelog commit links require a GitHub repository: ${repository}.`);
  }
  return `https://github.com/${match[1].replace(/\.git$/i, '')}`;
}

function localizedContent({ skill, history, summaries, locale }) {
  const baseUrl = repositoryWebUrl(skill.upstream.repository);
  return {
    commits: history.commits.map((commit) => ({
      sha: commit.sha,
      date: commit.date,
      subject: commit.subject,
      url: `${baseUrl}/commit/${commit.sha}`,
      pathAtCommit: commit.pathAtCommit,
      resolvedVia: commit.resolvedVia,
      ...(commit.transition ? { transition: commit.transition } : {}),
      summary: summaries.get(commit.sha)?.[locale],
    })),
    ...(history.truncatedAt ? { truncatedAt: history.truncatedAt } : {}),
  };
}

function restoreUntranslatedMetadata(converted, source) {
  return {
    ...converted,
    commits: converted.commits.map((commit, index) => ({
      ...commit,
      sha: source.commits[index].sha,
      date: source.commits[index].date,
      subject: source.commits[index].subject,
      url: source.commits[index].url,
      pathAtCommit: source.commits[index].pathAtCommit,
      resolvedVia: source.commits[index].resolvedVia,
      ...(source.commits[index].transition
        ? { transition: source.commits[index].transition }
        : {}),
    })),
    ...(source.truncatedAt ? { truncatedAt: source.truncatedAt } : {}),
  };
}

export function createChangelogArtifact({
  skill,
  history,
  summaries,
  generatorVersion = CHANGELOG_GENERATOR_VERSION,
}) {
  const signatures = expectedLocaleSignatures(generatorVersion);
  const enContent = localizedContent({ skill, history, summaries, locale: 'en' });
  const zhTwContent = localizedContent({
    skill,
    history,
    summaries,
    locale: 'zh-tw',
  });
  const zhCn = createZhCnLocaleArtifact({
    content: zhTwContent,
    promptId: CHANGELOG_PROMPT_ID,
    promptHash: CHANGELOG_PROMPT_HASH,
    generatorVersion,
    cliContract: COPILOT_CLI_CONTRACT,
  });
  zhCn.content = restoreUntranslatedMetadata(zhCn.content, zhTwContent);

  const artifact = {
    path: skill.path,
    schemaVersion: ENRICHMENT_SCHEMA_VERSION,
    freshnessKey: createArtifactFreshnessKey('changelog', skill),
    locales: {
      en: {
        signature: signatures.en,
        producer: 'llm',
        model: COPILOT_CLI_CONTRACT.model,
        promptHash: CHANGELOG_PROMPT_HASH,
        generatorVersion,
        content: enContent,
      },
      'zh-tw': {
        signature: signatures['zh-tw'],
        producer: 'llm',
        model: COPILOT_CLI_CONTRACT.model,
        promptHash: CHANGELOG_PROMPT_HASH,
        generatorVersion,
        content: zhTwContent,
      },
      'zh-cn': zhCn,
    },
  };
  return assertValidEnrichmentArtifact('changelog', artifact);
}

export function isChangelogArtifactCurrent(
  artifact,
  skill,
  { generatorVersion = CHANGELOG_GENERATOR_VERSION } = {},
) {
  try {
    assertValidEnrichmentArtifact('changelog', artifact);
    if (!isArtifactFresh('changelog', artifact, skill)) return false;
    if (!isNewestFirst(artifact.locales.en.content.commits)) return false;
    const signatures = expectedLocaleSignatures(generatorVersion);
    return (
      artifact.locales.en.signature === signatures.en &&
      artifact.locales.en.model === COPILOT_CLI_CONTRACT.model &&
      artifact.locales.en.promptHash === CHANGELOG_PROMPT_HASH &&
      artifact.locales.en.generatorVersion === generatorVersion &&
      artifact.locales['zh-tw'].signature === signatures['zh-tw'] &&
      artifact.locales['zh-tw'].model === COPILOT_CLI_CONTRACT.model &&
      artifact.locales['zh-tw'].promptHash === CHANGELOG_PROMPT_HASH &&
      artifact.locales['zh-tw'].generatorVersion === generatorVersion &&
      artifact.locales['zh-cn'].signature === signatures['zh-cn'] &&
      artifact.locales['zh-cn'].converterVersion === OPENCC_CONVERTER_ID &&
      artifact.locales['zh-cn'].generatorVersion === generatorVersion
    );
  } catch {
    return false;
  }
}

async function defaultRunGit(args, options = {}) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

export async function cloneFullUpstream({
  repository,
  reference,
  destination,
  runGit,
}) {
  const ref = resolveCloneRef(reference);
  await runGit([
    'clone',
    '--no-checkout',
    '--single-branch',
    '--branch',
    ref,
    '--config',
    'core.autocrlf=false',
    '--',
    resolveRepositoryUrl(repository),
    destination,
  ]);
  return { dir: destination, ref };
}

export function parseChangelogArgs(args) {
  let check = false;
  let skill = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--check') {
      check = true;
    } else if (argument === '--skill') {
      if (skill !== null) {
        throw new Error('--skill may be provided only once.');
      }
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--skill requires a path or name value.');
      }
      skill = value;
      index += 1;
    } else {
      throw new Error(`Unknown enrich:changelog argument: ${argument}.`);
    }
  }
  return { check, skill };
}

async function writeAtomicJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeChangelogArtifact({ repoRoot, artifact }) {
  const target = enrichmentArtifactPath(repoRoot, 'changelog', artifact.path);
  await writeAtomicJson(target, artifact);
  return target;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readArtifactIfPresent(repoRoot, skillPath) {
  const artifactPath = enrichmentArtifactPath(
    repoRoot,
    'changelog',
    skillPath,
  );
  try {
    return JSON.parse(await readFile(artifactPath, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function directorySize(directory) {
  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(entryPath);
    } else {
      total += (await lstat(entryPath)).size;
    }
  }
  return total;
}

function selectEligibleSkills(lock, selector) {
  const eligible = lock.skills.filter((entry) =>
    isEligibleForEnrichment('changelog', entry),
  );
  if (selector === null) return eligible;
  const selected = eligible.filter(
    (entry) => entry.path === selector || entry.name === selector,
  );
  if (selected.length === 0) {
    throw new Error(`Unknown changelog skill selector: ${selector}.`);
  }
  if (selected.length > 1) {
    throw new Error(`Ambiguous changelog skill name: ${selector}. Use its path.`);
  }
  return selected;
}

function upstreamKey(skill) {
  return JSON.stringify([
    skill.upstream.repository,
    skill.upstream.reference,
  ]);
}

function groupByUpstream(skills) {
  const groups = new Map();
  for (const skill of skills) {
    const key = upstreamKey(skill);
    const group = groups.get(key) ?? {
      repository: skill.upstream.repository,
      reference: skill.upstream.reference,
      skills: [],
    };
    group.skills.push(skill);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function restrictedPathsByUpstream(skills) {
  const paths = new Map();
  for (const skill of skills) {
    if (skill.redistributable !== false || !skill.upstream) continue;
    const key = upstreamKey(skill);
    const groupPaths = paths.get(key) ?? new Set();
    groupPaths.add(`${skill.upstream.source}/SKILL.md`);
    paths.set(key, groupPaths);
  }
  return paths;
}

async function assertCompleteCurrentSet(repoRoot, eligible) {
  const expected = new Map(eligible.map((skill) => [skill.path, skill]));
  const collection = await collectEnrichmentArtifacts({
    repoRoot,
    kind: 'changelog',
  });
  const actual = new Map(
    collection.artifacts.map((entry) => [entry.artifact.path, entry.artifact]),
  );
  const errors = [];
  for (const [skillPath, targetSkill] of expected) {
    const artifact = actual.get(skillPath);
    if (!artifact) {
      errors.push(`missing ${skillPath}`);
    } else if (!isChangelogArtifactCurrent(artifact, targetSkill)) {
      errors.push(`stale or signature-mismatched ${skillPath}`);
    }
  }
  for (const skillPath of actual.keys()) {
    if (!expected.has(skillPath)) errors.push(`unexpected ${skillPath}`);
  }
  if (errors.length > 0) {
    throw new Error(`Changelog artifact set is incomplete: ${errors.join('; ')}.`);
  }
}

export async function generateChangelogs({
  repoRoot = defaultRepoRoot,
  check = false,
  skillSelector = null,
  runner = createCopilotRunner({
    tempRoot: path.join(defaultRepoRoot, 'scripts', 'test', '.runtime', 'llm'),
    timeoutMs: CHANGELOG_LLM_TIMEOUT_MS,
  }),
  runGit = defaultRunGit,
  workRoot = path.join(
    repoRoot,
    `.changelog-work-${process.pid}-${Date.now()}`,
  ),
  cloneRepository = (input) => cloneFullUpstream({ ...input, runGit }),
  collectHistory = ({ repoDir, skill, blockedSourcePaths }) =>
    collectSkillHistory({
      repoDir,
      pinnedCommit: skill.upstream.commit,
      sourcePath: `${skill.upstream.source}/SKILL.md`,
      blockedSourcePaths,
      runGit,
    }),
  summarizeHistory = ({
    skill,
    history,
    repoDir,
    restrictedSourcePaths,
  }) =>
    summarizeSkillHistory({
      skill,
      history,
      repoDir,
      runner,
      restrictedSourcePaths,
    }),
} = {}) {
  const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
  const manifestPath = path.join(
    repoRoot,
    'catalog',
    'enrichment',
    'manifest.json',
  );
  const lock = await readJson(lockPath);
  const manifest = await readJson(manifestPath);
  const allEligible = lock.skills.filter((entry) =>
    isEligibleForEnrichment('changelog', entry),
  );
  const selected = selectEligibleSkills(lock, skillSelector);
  const groups = groupByUpstream(selected);
  const restrictedPaths = restrictedPathsByUpstream(lock.skills);
  const metrics = {
    eligible: selected.length,
    generated: 0,
    cacheHits: 0,
    clonedUpstreams: 0,
    skippedUpstreams: 0,
    runnerCalls: 0,
    cloneBytes: 0,
    cloneTimeMs: 0,
    copilotTimeMs: 0,
    model: COPILOT_CLI_CONTRACT.model,
    upstreams: [],
  };

  if (check && skillSelector === null && manifest.enabled.changelog !== true) {
    throw new Error('Changelog enrichment is disabled in the manifest.');
  }

  try {
    let cloneIndex = 0;
    for (const group of groups) {
      const blockedSourcePaths = restrictedPaths.get(JSON.stringify([
        group.repository,
        group.reference,
      ])) ?? new Set();
      const artifacts = await Promise.all(
        group.skills.map(async (targetSkill) => ({
          skill: targetSkill,
          artifact: await readArtifactIfPresent(repoRoot, targetSkill.path),
        })),
      );
      const pending = artifacts.filter(
        ({ skill: targetSkill, artifact }) =>
          !isChangelogArtifactCurrent(artifact, targetSkill),
      );
      metrics.cacheHits += artifacts.length - pending.length;

      if (pending.length === 0) {
        metrics.skippedUpstreams += 1;
        metrics.upstreams.push({
          repository: group.repository,
          skills: group.skills.length,
          cloned: false,
          skipped: true,
          bytes: 0,
          durationMs: 0,
        });
        continue;
      }
      if (check) {
        throw new Error(
          `Changelog artifacts are stale or signature-mismatched: ` +
            `${pending.map(({ skill: targetSkill }) => targetSkill.path).join(', ')}.`,
        );
      }

      const destination = path.join(workRoot, `upstream-${cloneIndex}`);
      cloneIndex += 1;
      await mkdir(workRoot, { recursive: true });
      const cloneStarted = performance.now();
      const clone = await cloneRepository({
        repository: group.repository,
        reference: group.reference,
        destination,
      });
      const cloneDuration = Math.round(performance.now() - cloneStarted);
      const cloneBytes = await directorySize(clone.dir);
      metrics.clonedUpstreams += 1;
      metrics.cloneTimeMs += cloneDuration;
      metrics.cloneBytes += cloneBytes;
      metrics.upstreams.push({
        repository: group.repository,
        skills: group.skills.length,
        cloned: true,
        skipped: false,
        bytes: cloneBytes,
        durationMs: cloneDuration,
      });

      const generationResults = await Promise.allSettled(
        pending.map(async ({ skill: targetSkill }) => {
          const history = await collectHistory({
            repoDir: clone.dir,
            skill: targetSkill,
            blockedSourcePaths,
          });
          const copilotStarted = performance.now();
          const summaries = await summarizeHistory({
            skill: targetSkill,
            history,
            repoDir: clone.dir,
            restrictedSourcePaths: blockedSourcePaths,
          });
          metrics.copilotTimeMs += Math.round(performance.now() - copilotStarted);
          metrics.runnerCalls += 1;
          const artifact = createChangelogArtifact({
            skill: targetSkill,
            history,
            summaries,
          });
          await writeChangelogArtifact({ repoRoot, artifact });
          metrics.generated += 1;
        }),
      );
      const failed = generationResults.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    }

    if (check) {
      if (skillSelector === null) {
        await assertCompleteCurrentSet(repoRoot, allEligible);
      }
      return metrics;
    }

    if (skillSelector === null) {
      await pruneEnrichment({ repoRoot });
      await assertCompleteCurrentSet(repoRoot, allEligible);
      const previousManifest = structuredClone(manifest);
      manifest.enabled.changelog = true;
      await writeAtomicJson(manifestPath, manifest);
      try {
        await validateEnrichment({ repoRoot, strict: true });
      } catch (error) {
        await writeAtomicJson(manifestPath, previousManifest);
        throw error;
      }
    }
    return metrics;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseChangelogArgs(process.argv.slice(2));
  const result = await generateChangelogs({
    check: options.check,
    skillSelector: options.skill,
  });
  console.log(
    `Changelog enrichment ${options.check ? 'check passed' : 'completed'} ` +
      `(${result.eligible} eligible, ${result.generated} generated, ` +
      `${result.cacheHits} cache hits, ${result.clonedUpstreams} clones, ` +
      `${result.skippedUpstreams} upstream skips, ${result.cloneBytes} clone bytes, ` +
      `${result.cloneTimeMs}ms cloning, ${result.runnerCalls} Copilot calls using ` +
      `${result.model} in ${result.copilotTimeMs}ms).`,
  );
  for (const upstream of result.upstreams) {
    console.log(
      `- ${upstream.repository}: ${upstream.skipped ? 'skipped' : 'cloned'}, ` +
        `${upstream.skills} skills, ${upstream.bytes} bytes, ${upstream.durationMs}ms`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
