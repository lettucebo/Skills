import { execFileSync } from 'node:child_process';
import { readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSkillFrontmatter } from './lib/frontmatter.mjs';
import { loadManifest } from './lib/manifest.mjs';
import { hashDirectory } from './lib/hash.mjs';
import {
  buildBootstrapHistory,
  historyFileName,
  validateBootstrapHistory,
} from './lib/history.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, '..');

const BOOTSTRAP_RELEASE = '1.0.0';
const BOOTSTRAP_VERSION = '1.0.0';

const README_MARKER_START = '<!-- CATALOG:START -->';
const README_MARKER_END = '<!-- CATALOG:END -->';

/**
 * Skills whose upstream terms are proprietary and therefore not
 * redistributable. This set is intentionally explicit rather than inferred, so
 * the registry never accidentally relabels restricted content as shareable.
 */
export const RESTRICTED_SKILL_PATHS = new Set([
  'skills/claude/docx',
  'skills/claude/pdf',
  'skills/claude/pptx',
  'skills/claude/xlsx',
]);

const SOURCE_META = {
  azure: { description: 'Azure 雲端架構、部署、定價、DevOps', doc: '—' },
  chrome: { description: 'Chrome DevTools 偵錯與效能分析', doc: '—' },
  claude: { description: 'Claude API、文件生成、創意工具（PDF/PPTX/XLSX 等）', doc: '—' },
  cloudflare: {
    description: 'Cloudflare Workers、Durable Objects、Agents SDK',
    doc: '[README](skills/cloudflare/README.md)',
  },
  dotnet: { description: 'C# 測試（NUnit/xUnit/MSTest/TUnit）、EF Core、NuGet、非同步', doc: '—' },
  github: { description: 'GitHub Issues、PR、CodeQL、Dependabot、gh CLI', doc: '—' },
  gtm: { description: 'GTM 技術整合、產品策略、企業銷售、AI GTM', doc: '—' },
  microsoft: {
    description: 'Azure SDK、AI Foundry、Copilot SDK、MCP Builder',
    doc: '[README](skills/microsoft/README.md)',
  },
  'power-platform': {
    description: 'Power BI（DAX、模型、報表）、Power Apps、Fabric Lakehouse',
    doc: '—',
  },
  tampermonkey: { description: 'Tampermonkey 使用者腳本開發（API、安全、除錯）', doc: '—' },
  vscode: { description: '重構、規格撰寫、README 生成、安全審查、Git commit', doc: '—' },
};

export function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Resolves a skill's license without inference.
 *
 * Resolution order: explicit restricted set -> local LICENSE.txt -> frontmatter
 * `license` field. Anything unresolved stays `Unknown` so the registry never
 * falsely claims a permissive license.
 */
export async function resolveLicense(repoRoot, skillPath, frontmatter) {
  if (RESTRICTED_SKILL_PATHS.has(skillPath)) {
    return { license: 'Proprietary', redistributable: false };
  }

  const licenseFilePath = path.join(repoRoot, ...skillPath.split('/'), 'LICENSE.txt');
  const fromFile = await detectLicenseFromFile(licenseFilePath);

  if (fromFile) {
    return { license: fromFile, redistributable: true };
  }

  const fromFrontmatter = normalizeFrontmatterLicense(frontmatter?.license);

  if (fromFrontmatter) {
    return { license: fromFrontmatter, redistributable: true };
  }

  return { license: 'Unknown', redistributable: true };
}

async function detectLicenseFromFile(licenseFilePath) {
  let text;

  try {
    text = await readFile(licenseFilePath, 'utf8');
  } catch {
    return null;
  }

  if (/\bMIT License\b/i.test(text)) {
    return 'MIT';
  }

  if (/\bApache License\b/i.test(text)) {
    return 'Apache-2.0';
  }

  if (/anthropic/i.test(text) && /all rights reserved/i.test(text)) {
    return 'Proprietary';
  }

  return null;
}

function normalizeFrontmatterLicense(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (/^mit\b/i.test(trimmed)) {
    return 'MIT';
  }

  if (/apache/i.test(trimmed)) {
    return 'Apache-2.0';
  }

  if (/proprietary/i.test(trimmed)) {
    return 'Proprietary';
  }

  return null;
}

/**
 * Builds the deterministic lockfile and per-skill history documents from a
 * validated manifest. This function performs no filesystem writes and no git
 * access, so it is fully testable in isolation.
 */
export async function buildCatalog({ manifest, repoRoot, commitTimestamp, previous }) {
  const skillInputs = await collectSkillInputs(manifest, repoRoot);
  const skills = [];

  for (const input of skillInputs) {
    const skillAbsoluteDir = path.join(repoRoot, ...input.path.split('/'));
    const frontmatter = await readFrontmatter(skillAbsoluteDir);
    const snapshotHash = await hashDirectory(skillAbsoluteDir);
    const { license, redistributable } = await resolveLicense(
      repoRoot,
      input.path,
      frontmatter,
    );

    skills.push({
      path: input.path,
      name: frontmatter.name,
      category: input.category,
      version: BOOTSTRAP_VERSION,
      baseline: input.category === 'mapped' ? 'unverified' : null,
      license,
      redistributable,
      snapshotHash,
      upstream: input.upstream,
    });
  }

  skills.sort(byPath);

  const counts = countByCategory(skills);
  const semanticLock = { release: BOOTSTRAP_RELEASE, counts, skills };
  const generatedAt = resolveGeneratedAt(semanticLock, previous?.lock, commitTimestamp);
  const lock = { release: BOOTSTRAP_RELEASE, generatedAt, counts, skills };

  const historyFiles = [];
  const historyPathByFilename = new Map();

  for (const skill of skills) {
    const filename = historyFileName(skill.path);
    const existingPath = historyPathByFilename.get(filename);

    if (existingPath && existingPath !== skill.path) {
      throw new Error(
        `Refusing to generate ambiguous history filename ${JSON.stringify(filename)} for both ` +
          `${JSON.stringify(existingPath)} and ${JSON.stringify(skill.path)}.`,
      );
    }

    historyPathByFilename.set(filename, skill.path);
    historyFiles.push({
      path: skill.path,
      filename,
      content: buildBootstrapHistory({
        skill,
        commitTimestamp,
        previousHistory: previous?.historyByPath?.get(skill.path),
      }),
    });
  }

  historyFiles.sort((left, right) => compareStrings(left.filename, right.filename));

  return { lock, historyFiles };
}

function resolveGeneratedAt(semanticLock, previousLock, commitTimestamp) {
  if (previousLock && typeof previousLock.generatedAt === 'string') {
    const previousSemantic = {
      release: previousLock.release,
      counts: previousLock.counts,
      skills: previousLock.skills,
    };

    if (JSON.stringify(previousSemantic) === JSON.stringify(semanticLock)) {
      return previousLock.generatedAt;
    }
  }

  return commitTimestamp;
}

async function collectSkillInputs(manifest, repoRoot) {
  const inputs = [];

  for (const mapping of manifest.mappings) {
    const upstream = manifest.upstreams[mapping.upstream];
    inputs.push({
      path: mapping.path,
      category: 'mapped',
      upstream: {
        repository: upstream.repository,
        reference: upstream.reference,
        source: mapping.source,
        commit: null,
      },
    });
  }

  for (const orphan of manifest.orphans) {
    inputs.push({ path: orphan.path, category: 'orphan', upstream: null });
  }

  for (const localEntry of manifest.local) {
    const localSkillPaths = await collectExistingSkillPaths(repoRoot, localEntry.root);

    for (const localSkillPath of localSkillPaths) {
      inputs.push({ path: localSkillPath, category: 'local', upstream: null });
    }
  }

  return inputs;
}

async function collectExistingSkillPaths(repoRoot, relativeRoot) {
  const absoluteRoot = path.join(repoRoot, ...relativeRoot.split('/'));
  const collected = [];

  try {
    await walkSkillTree(absoluteRoot, repoRoot, collected);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  return collected.sort(compareStrings);
}

async function walkSkillTree(currentPath, repoRoot, collected) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
    collected.push(toPosixPath(path.relative(repoRoot, currentPath)));
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await walkSkillTree(path.join(currentPath, entry.name), repoRoot, collected);
    }
  }
}

async function readFrontmatter(skillAbsoluteDir) {
  const skillFilePath = path.join(skillAbsoluteDir, 'SKILL.md');
  const skillText = await readFile(skillFilePath, 'utf8');
  return parseSkillFrontmatter(skillText, `${toPosixPath(skillAbsoluteDir)}/SKILL.md`);
}

function countByCategory(skills) {
  const counts = { total: skills.length, mapped: 0, orphan: 0, local: 0 };

  for (const skill of skills) {
    counts[skill.category] += 1;
  }

  return counts;
}

function byPath(left, right) {
  return compareStrings(left.path, right.path);
}

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

function toPosixPath(value) {
  return value.replace(/\\/g, '/');
}

// --- Bootstrap CLI orchestration (filesystem + git) ---------------------------

async function bootstrap(repoRoot) {
  const manifest = await loadManifest(path.join(repoRoot, 'catalog', 'sources.yml'));
  const previous = await readPreviousState(repoRoot);
  const { commitTimestamp } = readGitCommit(repoRoot);
  const { lock, historyFiles } = await buildCatalog({
    manifest,
    repoRoot,
    commitTimestamp,
    previous,
  });

  assertNoProtectedHistoryDeletes(previous.historyFiles, historyFiles);
  await writeLockfile(repoRoot, lock);
  await writeHistoryFiles(repoRoot, historyFiles);
  await writeNotice(repoRoot, lock);
  await updateReadme(repoRoot, lock);

  return lock;
}

async function readPreviousState(repoRoot) {
  const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
  let lock;

  try {
    lock = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    lock = undefined;
  }

  const historyByPath = new Map();
  const historyFiles = [];
  const historyDir = path.join(repoRoot, 'catalog', 'history');

  try {
    const entries = await readdir(historyDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }

      const historyPath = path.join(historyDir, entry.name);
      const historyRelativePath = toPosixPath(path.relative(repoRoot, historyPath));
      let content;

      try {
        content = JSON.parse(await readFile(historyPath, 'utf8'));
      } catch (error) {
        throw new Error(
          `Refusing to load malformed history file ${historyRelativePath}: ${error.message}`,
        );
      }

      if (typeof content?.path !== 'string' || content.path.length === 0) {
        throw new Error(
          `Refusing to load malformed history file ${historyRelativePath}: expected a string path.`,
        );
      }

      if (historyFileName(content.path) !== entry.name) {
        throw new Error(
          `Refusing to load malformed history file ${historyRelativePath}: expected path ` +
            `${JSON.stringify(content.path)} to encode to ${JSON.stringify(entry.name)}.`,
        );
      }

      historyByPath.set(content.path, content);
      historyFiles.push({ filename: entry.name, content });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    // No previous history directory.
  }

  return { lock, historyByPath, historyFiles };
}

function assertNoProtectedHistoryDeletes(previousHistoryFiles, nextHistoryFiles) {
  const nextHistoryByFilename = new Map(
    nextHistoryFiles.map((file) => [file.filename, file.path]),
  );

  for (const previousHistoryFile of previousHistoryFiles ?? []) {
    const nextPath = nextHistoryByFilename.get(previousHistoryFile.filename);

    if (nextPath) {
      if (previousHistoryFile.content.path !== nextPath) {
        throw new Error(
          `Refusing to overwrite release history file catalog/history/${previousHistoryFile.filename}: ` +
            `existing path ${JSON.stringify(previousHistoryFile.content.path)} conflicts with ` +
            `generated path ${JSON.stringify(nextPath)}.`,
        );
      }

      continue;
    }

    validateBootstrapHistory(previousHistoryFile.content.path, previousHistoryFile.content);
  }
}

function readGitCommit(repoRoot) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
    .toString()
    .trim();
  const commitTimestamp = execFileSync('git', ['show', '-s', '--format=%aI', 'HEAD'], {
    cwd: repoRoot,
  })
    .toString()
    .trim();

  return { commit, commitTimestamp };
}

async function writeLockfile(repoRoot, lock) {
  const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, serialize(lock));
}

async function writeHistoryFiles(repoRoot, historyFiles) {
  const historyDir = path.join(repoRoot, 'catalog', 'history');
  await mkdir(historyDir, { recursive: true });

  const expectedFileNames = new Set(historyFiles.map((file) => file.filename));

  const existingEntries = await readdir(historyDir, { withFileTypes: true });

  for (const entry of existingEntries) {
    if (entry.isFile() && entry.name.endsWith('.json') && !expectedFileNames.has(entry.name)) {
      await rm(path.join(historyDir, entry.name), { force: true });
    }
  }

  for (const file of historyFiles) {
    await writeFile(path.join(historyDir, file.filename), serialize(file.content));
  }
}

async function writeNotice(repoRoot, lock) {
  await writeFile(path.join(repoRoot, 'NOTICE'), renderNotice(lock));
}

function renderNotice(lock) {
  const lines = [];
  lines.push('# NOTICE');
  lines.push('');
  lines.push(
    'This repository is a curated registry that vendors third-party AI agent skills.',
  );
  lines.push(
    'Each vendored skill retains its original upstream license. This NOTICE is generated',
  );
  lines.push(
    'deterministically from `catalog/skills.lock.json`; do not edit it by hand.',
  );
  lines.push('');

  lines.push('## Provenance by upstream');
  lines.push('');
  lines.push('| Upstream repository | Reference | Skills |');
  lines.push('|---------------------|-----------|:------:|');

  const upstreamGroups = new Map();

  for (const skill of lock.skills) {
    if (!skill.upstream) {
      continue;
    }

    const key = `${skill.upstream.repository}\u0000${skill.upstream.reference}`;
    upstreamGroups.set(key, (upstreamGroups.get(key) ?? 0) + 1);
  }

  for (const key of [...upstreamGroups.keys()].sort(compareStrings)) {
    const [repository, reference] = key.split('\u0000');
    lines.push(`| ${repository} | ${reference} | ${upstreamGroups.get(key)} |`);
  }
  lines.push('');

  lines.push('## License summary');
  lines.push('');
  lines.push('| License | Skills |');
  lines.push('|---------|:------:|');

  const licenseCounts = new Map();

  for (const skill of lock.skills) {
    licenseCounts.set(skill.license, (licenseCounts.get(skill.license) ?? 0) + 1);
  }

  for (const license of [...licenseCounts.keys()].sort(compareStrings)) {
    lines.push(`| ${license} | ${licenseCounts.get(license)} |`);
  }
  lines.push('');

  const restrictedSkills = lock.skills
    .filter((skill) => !skill.redistributable)
    .sort(byPath);

  lines.push('## Restricted skills');
  lines.push('');
  lines.push(
    'The following skills are marked `redistributable: false`. Their proprietary terms',
  );
  lines.push(
    'are preserved in each skill\'s own `LICENSE.txt`; this NOTICE does not reproduce the',
  );
  lines.push('full license body. Consult the linked terms before reusing them.');
  lines.push('');

  if (restrictedSkills.length === 0) {
    lines.push('_None._');
  } else {
    for (const skill of restrictedSkills) {
      lines.push(`- **${skill.path}** — Restricted (${skill.license}); see \`${skill.path}/LICENSE.txt\`.`);
    }
  }
  lines.push('');

  lines.push('## Orphan skills');
  lines.push('');
  lines.push(
    'These skills have no verified upstream source repository and are tracked as orphans:',
  );
  lines.push('');

  const orphanSkills = lock.skills.filter((skill) => skill.category === 'orphan').sort(byPath);

  if (orphanSkills.length === 0) {
    lines.push('_None._');
  } else {
    for (const skill of orphanSkills) {
      lines.push(`- ${skill.path}`);
    }
  }
  lines.push('');

  lines.push('## Local modifications');
  lines.push('');
  lines.push(
    '- Mapped skills currently record `upstream.commit: null` and `baseline: "unverified"`.',
  );
  lines.push(
    '  The `snapshotHash` describes the bytes vendored today, not a verified upstream commit.',
  );
  lines.push(
    '- Any future frontmatter source/version stamps added by this registry are local',
  );
  lines.push('  modifications to the upstream files, not upstream-provided metadata.');
  lines.push(
    '- Bootstrap `firstSeen` timestamps are derived from the current git commit author',
  );
  lines.push('  timestamp because no deterministic per-path upstream history exists yet.');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function updateReadme(repoRoot, lock) {
  const readmePath = path.join(repoRoot, 'README.md');
  const readmeText = await readFile(readmePath, 'utf8');
  const startIndex = readmeText.indexOf(README_MARKER_START);
  const endIndex = readmeText.indexOf(README_MARKER_END);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(
      `README.md must contain ${README_MARKER_START} and ${README_MARKER_END} markers.`,
    );
  }

  const before = readmeText.slice(0, startIndex + README_MARKER_START.length);
  const after = readmeText.slice(endIndex);
  const generated = renderReadmeCatalog(lock);

  await writeFile(readmePath, `${before}\n${generated}\n${after}`);
}

function renderReadmeCatalog(lock) {
  const folders = new Map();

  for (const skill of lock.skills) {
    const folder = skill.path.split('/')[1];
    folders.set(folder, (folders.get(folder) ?? 0) + 1);
  }

  const sortedFolders = [...folders.keys()].sort(compareStrings);
  const lines = [];

  lines.push(`共 **${lock.counts.total} 個技能**，來自 ${sortedFolders.length} 個來源。`);
  lines.push('');
  lines.push('> 以下統計由 `scripts/catalog.mjs` 依 `catalog/skills.lock.json` 自動產生，請勿手動編輯。');
  lines.push('>');
  lines.push('> 目前所有 mapped 技能的 `baseline` 為 `unverified`，代表 lockfile 記錄的是目前 vendored 的內容快照（`snapshotHash`），尚未對應到已驗證的上游 commit。');
  lines.push('');
  lines.push('| 來源 | 數量 | 說明 | 文件 |');
  lines.push('|------|:----:|------|------|');

  for (const folder of sortedFolders) {
    const meta = SOURCE_META[folder] ?? { description: '—', doc: '—' };
    lines.push(
      `| [${folder}](skills/${folder}/) | ${folders.get(folder)} | ${meta.description} | ${meta.doc} |`,
    );
  }

  return lines.join('\n');
}

async function main() {
  const shouldBootstrap = process.argv.includes('--bootstrap');

  if (!shouldBootstrap) {
    console.error('Usage: node scripts/catalog.mjs --bootstrap');
    process.exitCode = 1;
    return;
  }

  try {
    const lock = await bootstrap(defaultRepoRoot);
    console.log(
      `Generated catalog for ${lock.counts.total} skills ` +
        `(${lock.counts.mapped} mapped, ${lock.counts.orphan} orphan, ${lock.counts.local} local).`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
