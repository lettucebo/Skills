/**
 * Upstream apply engines: baseline verification and daily update.
 *
 * Both engines are deliberately conservative: they refuse unless the working
 * tree is clean, every mapped upstream is available, and every mapped skill can
 * be staged. All work happens in a staging area first, and the live repository
 * is only mutated through an all-or-nothing directory swap that is rolled back
 * on any post-apply failure. Orphan and local skills are never modified.
 *
 * The engines never create git commits or tags — that is the workflow's job.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloneUpstream, GitCloneError } from './git-source.mjs';
import {
  assertMappingsWritable,
  assertWritableSkillPath,
  buildDeletionGroups,
  classifyDiff,
  commitMessageForDiffClass,
  evaluateDeletionGuards,
} from './guardrails.mjs';
import {
  copyHashableDirectory,
  hashDirectory,
} from './hash.mjs';
import { assertClonePathBoundary } from './path-boundary.mjs';
import { historyFileName } from './history.mjs';
import {
  LicenseEvidenceError,
  readRootLicenseEvidence,
  resolvePinnedMappedLicenses,
  validateLicenseBundle,
  writeLicenseBundle,
} from './license.mjs';
import { loadManifest } from './manifest.mjs';
import { parseSkillFrontmatter } from './frontmatter.mjs';
import { parseVersion, formatVersion, planRelease, readCurrentVersion, tagExists, assertTagReconciled } from './release.mjs';
import { transformStaged } from '../transform.mjs';
import { renderNotice, renderReadme, resolveLicense, serialize } from '../catalog.mjs';
import { collectLicenseEvidenceErrors, validateRepository } from '../validate.mjs';

const execFileAsync = promisify(execFile);

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The baseline turns the unverified `v1.0.0` bootstrap snapshot into a verified
 * upstream baseline and completes the Cloudflare full mirror.
 *
 * `1.1.0` is a deliberate, user-approved one-time SemVer exception: the mirror
 * drops two obsolete command-derived skills, which would normally force a major
 * bump, but `v1.0.0` was explicitly published as an unverified snapshot rather
 * than a provenance claim. From `v1.1.0` onward the normal rule resumes and any
 * skill removal increments the major version. The existing `v1.0.0` tag is never
 * moved; the tag for this release is created by a later task after the commit
 * lands.
 */
export const BASELINE_RELEASE = '1.1.0';
export const BASELINE_VERSION = '1.1.0';
export const BASELINE_HISTORY_KIND = 'baseline-verified';
export const ADDED_SKILL_VERSION = '1.0.0';
export const APPLY_LOCK_FILE = '.skills-sync-apply.lock';
export const TRANSACTION_JOURNAL_FILE = '.skills-sync-transaction.json';
export const DEPROPRIETIZE_RELEASE = '2.0.0';
export const DEPROPRIETIZE_COMMIT_MESSAGE =
  'feat(skills)!: remove proprietary skill mirrors';
export const LICENSE_REFRESH_RELEASE = '2.0.1';
export const LICENSE_REFRESH_COMMIT_MESSAGE =
  'fix(catalog): refresh upstream license metadata';
export const DEPROPRIETIZE_PATHS = Object.freeze([
  'skills/claude/docx',
  'skills/claude/pdf',
  'skills/claude/pptx',
  'skills/claude/xlsx',
]);

/**
 * Files and directories the swap replaces atomically. Order is irrelevant to
 * correctness because backups are taken before any placement.
 */
export const SWAP_TARGETS = [
  { rel: 'skills', kind: 'dir' },
  { rel: 'catalog/history', kind: 'dir' },
  { rel: 'catalog/licenses', kind: 'dir' },
  { rel: 'catalog/sources.yml', kind: 'file' },
  { rel: 'catalog/skills.lock.json', kind: 'file' },
  { rel: 'NOTICE', kind: 'file' },
  { rel: 'README.md', kind: 'file' },
];
export const LICENSE_REFRESH_SWAP_TARGETS = Object.freeze([
  { rel: 'catalog/history', kind: 'dir' },
  { rel: 'catalog/licenses', kind: 'dir' },
  { rel: 'catalog/skills.lock.json', kind: 'file' },
  { rel: 'NOTICE', kind: 'file' },
  { rel: 'README.md', kind: 'file' },
]);
const LEGACY_SIX_SWAP_TARGETS = SWAP_TARGETS.filter(
  (target) => target.rel !== 'catalog/licenses',
);
const LEGACY_FIVE_SWAP_TARGETS = LEGACY_SIX_SWAP_TARGETS.filter(
  (target) => target.rel !== 'catalog/sources.yml',
);

export class BaselineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BaselineError';
  }
}

export function assertLicenseEvidenceMigrationComplete(lock) {
  const release = parseVersion(lock.release);
  if (release.major < 2) {
    return;
  }
  if (lock.licenseEvidenceVersion !== 1) {
    throw new BaselineError(
      'Refusing ordinary sync: license evidence migration is incomplete; run --refresh-licenses first.',
    );
  }
  for (const skill of lock.skills ?? []) {
    if (!skill.licenseEvidence) {
      throw new BaselineError(
        `Refusing ordinary sync: ${skill.path} has no license evidence; run --refresh-licenses first.`,
      );
    }
  }
}

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function buildLicenseRefreshLock({
  lock,
  resolvedByPath,
  release,
  generatedAt,
}) {
  const resolved =
    resolvedByPath instanceof Map
      ? resolvedByPath
      : new Map(Object.entries(resolvedByPath ?? {}));
  const changedPaths = [];

  const skills = lock.skills.map((skill) => {
    const nextLicense = resolved.get(skill.path);
    if (!nextLicense) {
      throw new BaselineError(
        `License refresh did not resolve evidence for ${skill.path}.`,
      );
    }

    if (skill.license !== 'Unknown' && nextLicense.license === 'Unknown') {
      throw new BaselineError(
        `Refusing license refresh downgrade for ${skill.path}: known license ${skill.license} to Unknown at unchanged pinned provenance.`,
      );
    }

    const changed =
      skill.license !== nextLicense.license ||
      skill.redistributable !== nextLicense.redistributable ||
      !sameJson(skill.licenseEvidence, nextLicense.licenseEvidence);
    if (changed) {
      changedPaths.push(skill.path);
    }

    return {
      ...skill,
      license: nextLicense.license,
      redistributable: nextLicense.redistributable,
      licenseEvidence: nextLicense.licenseEvidence,
    };
  });

  return {
    lock: {
      release,
      generatedAt,
      licenseEvidenceVersion: 1,
      counts: { ...lock.counts },
      skills,
    },
    changedPaths: changedPaths.sort(),
  };
}

export function appendLicenseRefreshHistory(history, { release, before, after }) {
  const newEvidence = after.licenseEvidence ?? null;
  const entry = {
    release,
    kind: 'license-refresh',
    version: before.version,
    upstreamCommit: before.upstream?.commit ?? null,
    diffUrl: null,
    oldLicense: before.license,
    newLicense: after.license,
    oldRedistributable: before.redistributable,
    newRedistributable: after.redistributable,
    oldEvidence: before.licenseEvidence ?? null,
    newEvidence,
    evidenceCommit: newEvidence?.commit ?? before.upstream?.commit ?? null,
    evidenceHash: newEvidence?.hash ?? null,
  };
  return { ...history, entries: [...history.entries, entry] };
}

export function assertDeproprietizePreconditions({ lock, manifest }) {
  if (lock.release !== BASELINE_RELEASE) {
    throw new BaselineError(
      `Refusing deproprietize migration: lock release is ${lock.release}; expected ${BASELINE_RELEASE}.`,
    );
  }

  for (const skillPath of DEPROPRIETIZE_PATHS) {
    const matchingSkills = lock.skills.filter((skill) => skill.path === skillPath);
    if (matchingSkills.length !== 1) {
      throw new BaselineError(
        `Refusing deproprietize migration: expected exactly one active lock entry for ${skillPath}.`,
      );
    }

    const [skill] = matchingSkills;
    if (skill.category !== 'mapped') {
      throw new BaselineError(
        `Refusing deproprietize migration: ${skillPath} category is ${skill.category}; expected mapped.`,
      );
    }
    if (skill.redistributable !== false) {
      throw new BaselineError(
        `Refusing deproprietize migration: ${skillPath} redistributable must be false.`,
      );
    }
    if (skill.license !== 'Proprietary') {
      throw new BaselineError(
        `Refusing deproprietize migration: ${skillPath} license is ${skill.license}; expected Proprietary.`,
      );
    }
    if (skill.version !== BASELINE_VERSION) {
      throw new BaselineError(
        `Refusing deproprietize migration: ${skillPath} version is ${skill.version}; expected ${BASELINE_VERSION}.`,
      );
    }
    if (skill.baseline !== 'verified') {
      throw new BaselineError(
        `Refusing deproprietize migration: ${skillPath} baseline is ${skill.baseline}; expected verified.`,
      );
    }
    if (typeof skill.contentHash !== 'string' || !skill.contentHash.startsWith('sha256:')) {
      throw new BaselineError(
        `Refusing deproprietize migration: ${skillPath} contentHash is missing or invalid.`,
      );
    }
    if (typeof skill.snapshotHash !== 'string' || !skill.snapshotHash.startsWith('sha256:')) {
      throw new BaselineError(
        `Refusing deproprietize migration: ${skillPath} snapshotHash is missing or invalid.`,
      );
    }
    if (!/^[0-9a-f]{40}$/i.test(skill.upstream?.commit ?? '')) {
      throw new BaselineError(
        `Refusing deproprietize migration: ${skillPath} upstream commit is missing or invalid.`,
      );
    }
    if (
      skill.upstream?.repository !== 'anthropics/skills' ||
      skill.upstream?.reference !== manifest.upstreams.anthropics?.reference ||
      skill.upstream?.source !== `skills/${path.posix.basename(skillPath)}`
    ) {
      throw new BaselineError(
        `Refusing deproprietize migration: ${skillPath} has an unexpected upstream tuple.`,
      );
    }

    const mappings = manifest.mappings.filter((mapping) => mapping.path === skillPath);
    if (
      mappings.length !== 1 ||
      mappings[0].upstream !== 'anthropics' ||
      mappings[0].source !== `skills/${path.posix.basename(skillPath)}`
    ) {
      throw new BaselineError(
        `Refusing deproprietize migration: expected exact anthropics mapping for ${skillPath}.`,
      );
    }
  }
}

async function assertDeproprietizeHistory(repoRoot, lock) {
  for (const skillPath of DEPROPRIETIZE_PATHS) {
    const lockSkill = lock.skills.find((skill) => skill.path === skillPath);
    const { content } = await readHistoryDoc(repoRoot, skillPath);
    const last = content.entries.at(-1);

    for (const [field, actual, expected] of [
      ['kind', last?.kind, BASELINE_HISTORY_KIND],
      ['release', last?.release, BASELINE_RELEASE],
      ['version', last?.version, BASELINE_VERSION],
      ['upstreamCommit', last?.upstreamCommit, lockSkill.upstream.commit],
      ['contentHash', last?.contentHash, lockSkill.contentHash],
    ]) {
      if (actual !== expected) {
        throw new BaselineError(
          `Refusing deproprietize migration: history for ${skillPath} has ${field} ` +
            `${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`,
        );
      }
    }
  }
}

export function buildDeproprietizedLock({ lock, generatedAt }) {
  const removedSet = new Set(DEPROPRIETIZE_PATHS);
  const skills = lock.skills
    .map((skill) =>
      removedSet.has(skill.path)
        ? {
            ...skill,
            category: 'removed',
            removedIn: DEPROPRIETIZE_RELEASE,
            removalReason:
              'Removed proprietary material to prevent proprietary redistribution.',
          }
        : skill,
    )
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const activeSkills = skills.filter((skill) => skill.category !== 'removed');
  const counts = { total: activeSkills.length, mapped: 0, orphan: 0, local: 0 };
  for (const skill of activeSkills) {
    counts[skill.category] += 1;
  }

  return {
    release: DEPROPRIETIZE_RELEASE,
    generatedAt,
    counts,
    skills,
  };
}

export function removeDeproprietizedMappings(manifestText) {
  let next = manifestText;
  const newline = manifestText.includes('\r\n') ? '\r\n' : '\n';

  for (const skillPath of DEPROPRIETIZE_PATHS) {
    const skillName = path.posix.basename(skillPath);
    const block =
      `  - path: ${skillPath}${newline}` +
      `    upstream: anthropics${newline}` +
      `    source: skills/${skillName}${newline}`;

    if (!next.includes(block)) {
      throw new BaselineError(
        `Refusing deproprietize migration: manifest text does not contain the exact mapping block for ${skillPath}.`,
      );
    }
    next = next.replace(block, '');
  }

  return next;
}

/**
 * Rebuilds the lockfile with every mapped skill promoted to a verified
 * baseline.
 *
 * Mapped entries gain the resolved upstream `commit`, the pre-stamp
 * `contentHash` (the verified upstream content identity), the post-stamp
 * `snapshotHash` (the vendored bytes), the baseline `version`, and the
 * authoritative frontmatter `name` read from the staged content. Adopting the
 * staged name matters when upstream renames a skill: the bootstrap lock derived
 * its name from the stale vendored copy. Orphan and local entries pass through
 * untouched so an orphan keeps `upstream: null`.
 * Refuses if a mapped skill is missing from `staged`, or if `staged` names a
 * path that is not a mapped skill, so the transition can never be partial.
 */
export function buildVerifiedLock({ lock, staged, release = BASELINE_RELEASE, generatedAt }) {
  const stagedMap = staged instanceof Map ? staged : new Map(Object.entries(staged));
  const mappedPaths = new Set(
    lock.skills.filter((skill) => skill.category === 'mapped').map((skill) => skill.path),
  );

  for (const stagedPath of stagedMap.keys()) {
    if (!mappedPaths.has(stagedPath)) {
      throw new BaselineError(
        `Refusing to verify a path that is not a mapped skill: ${stagedPath}`,
      );
    }
  }

  const skills = lock.skills.map((skill) => {
    if (skill.category !== 'mapped') {
      return skill;
    }

    const stagedEntry = stagedMap.get(skill.path);

    if (!stagedEntry) {
      throw new BaselineError(`Mapped skill was not staged for baseline: ${skill.path}`);
    }
    if (
      !stagedEntry.repository ||
      !stagedEntry.reference ||
      !stagedEntry.source ||
      !stagedEntry.commit
    ) {
      throw new BaselineError(`Mapped skill is missing upstream tuple: ${skill.path}`);
    }

    return {
      path: skill.path,
      name: stagedEntry.name ?? skill.name,
      category: skill.category,
      version: release,
      baseline: 'verified',
      license: stagedEntry.license ?? skill.license,
      redistributable: stagedEntry.redistributable ?? skill.redistributable,
      licenseEvidence: stagedEntry.licenseEvidence ?? skill.licenseEvidence,
      snapshotHash: stagedEntry.snapshotHash,
      contentHash: stagedEntry.contentHash,
      upstream: {
        repository: stagedEntry.repository,
        reference: stagedEntry.reference,
        source: stagedEntry.source,
        commit: stagedEntry.commit,
      },
    };
  });

  return {
    release,
    generatedAt,
    ...(lock.licenseEvidenceVersion
      ? { licenseEvidenceVersion: lock.licenseEvidenceVersion }
      : {}),
    counts: lock.counts,
    skills,
  };
}

/**
 * Appends a baseline-verification entry to a skill's history without erasing
 * its bootstrap entry.
 *
 * Returns a new document (the input is never mutated). The append is idempotent:
 * re-verifying against the same upstream commit and content hash returns the
 * document unchanged so repeated runs do not accumulate duplicate entries.
 */
export function appendBaselineHistoryEntry(history, { release, version, upstreamCommit, contentHash }) {
  if (!Array.isArray(history?.entries) || history.entries.length === 0) {
    throw new BaselineError(
      `Refusing to append baseline history to ${history?.path ?? 'unknown skill'}: no bootstrap entry present.`,
    );
  }

  if (history.entries[0].kind !== 'bootstrap') {
    throw new BaselineError(
      `Refusing to append baseline history to ${history.path}: first entry must remain bootstrap.`,
    );
  }

  const entry = {
    release,
    kind: BASELINE_HISTORY_KIND,
    version,
    upstreamCommit,
    diffUrl: null,
    contentHash,
  };

  const last = history.entries[history.entries.length - 1];

  if (
    last.kind === BASELINE_HISTORY_KIND &&
    last.upstreamCommit === upstreamCommit &&
    last.contentHash === contentHash
  ) {
    return { ...history, entries: [...history.entries] };
  }

  return { ...history, entries: [...history.entries, entry] };
}

async function defaultReadGitStatus(repoRoot) {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'status', '--porcelain'], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function lstatOrNull(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function resolveGitDirectories(repoRoot) {
  const dotGit = path.join(repoRoot, '.git');
  const dotGitInfo = await lstatOrNull(dotGit);
  let gitDir;

  if (dotGitInfo?.isDirectory()) {
    gitDir = dotGit;
  } else if (dotGitInfo?.isFile()) {
    const pointer = await readFile(dotGit, 'utf8');
    const match = /^gitdir:\s*(.+)\s*$/m.exec(pointer);
    if (!match) {
      throw new BaselineError(`Refusing to apply: invalid git directory pointer at ${dotGit}.`);
    }
    gitDir = path.resolve(repoRoot, match[1]);
  } else {
    throw new BaselineError(`Refusing to apply: ${repoRoot} is not a Git working tree.`);
  }

  const commonDirPointer = path.join(gitDir, 'commondir');
  let commonGitDir = gitDir;
  try {
    const commonDir = (await readFile(commonDirPointer, 'utf8')).trim();
    if (commonDir) {
      commonGitDir = path.resolve(gitDir, commonDir);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  return { gitDir, commonGitDir };
}

export async function createApplyWorkRoot(repoRoot, kind) {
  const prefix = kind === 'baseline'
    ? '.baseline-work-'
    : kind === 'update'
      ? '.update-work-'
      : kind === 'deproprietize'
        ? '.deproprietize-work-'
        : kind === 'license-refresh'
          ? '.license-refresh-work-'
      : null;

  if (!prefix) {
    throw new BaselineError(`Unknown apply work root kind: ${kind}`);
  }

  return mkdtemp(path.join(repoRoot, prefix));
}

async function syncDirectory(directoryPath) {
  // Windows does not allow opening directories as file handles for fsync.
  if (process.platform === 'win32') {
    return;
  }

  const handle = await open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const windowsMoveFileWriteThroughScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace SkillsSync {
  public static class NativeMethods {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool MoveFileEx(string source, string destination, int flags);
  }
}
'@

$flags = 0x1 -bor 0x8
if (-not [SkillsSync.NativeMethods]::MoveFileEx(
  $env:SKILLS_SYNC_RENAME_SOURCE,
  $env:SKILLS_SYNC_RENAME_DESTINATION,
  $flags
)) {
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw [ComponentModel.Win32Exception]::new($errorCode)
}
`;

const windowsMoveFileWriteThroughServiceScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace SkillsSync {
  public static class NativeMethods {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool MoveFileEx(string source, string destination, int flags);
  }
}
'@

$flags = 0x1 -bor 0x8
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $request = $line.Split("\`t", 3)
  $id = $request[0]
  try {
    $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($request[1]))
    $destination = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($request[2]))
    if (-not [SkillsSync.NativeMethods]::MoveFileEx($source, $destination, $flags)) {
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw [ComponentModel.Win32Exception]::new($errorCode)
    }
    [Console]::Out.WriteLine("$id\`tOK")
  } catch {
    $message = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message))
    [Console]::Out.WriteLine("$id\`tERROR\`t$message")
  }
}
`;

class WindowsWriteThroughRenameService {
  constructor() {
    this.pending = new Map();
    this.nextId = 1;
    this.failure = null;
    this.stderr = '';
    this.child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        windowsMoveFileWriteThroughServiceScript,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );

    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const [id, status, encodedMessage] = line.split('\t', 3);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (status === 'OK') {
        pending.resolve();
        return;
      }
      const message = encodedMessage
        ? Buffer.from(encodedMessage, 'base64').toString('utf8')
        : 'unknown Windows MoveFileEx failure';
      pending.reject(new BaselineError(`Durable journal rename failed: ${message}`));
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code) => {
      if (code !== 0) {
        this.fail(
          new BaselineError(
            `Durable journal rename service exited with code ${code ?? 'unknown'}: ${this.stderr}`,
          ),
        );
      }
    });
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  rename(sourcePath, destinationPath) {
    if (this.failure) {
      return Promise.reject(this.failure);
    }

    const id = String(this.nextId);
    this.nextId += 1;
    const request = [
      id,
      Buffer.from(sourcePath, 'utf8').toString('base64'),
      Buffer.from(destinationPath, 'utf8').toString('base64'),
    ].join('\t');

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${request}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close() {
    this.child.stdin.end();
  }
}

function createJournalRenamer() {
  return process.platform === 'win32' ? new WindowsWriteThroughRenameService() : null;
}

async function durableRename(sourcePath, destinationPath) {
  if (process.platform !== 'win32') {
    await rename(sourcePath, destinationPath);
    return;
  }

  try {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        windowsMoveFileWriteThroughScript,
      ],
      {
        env: {
          ...process.env,
          SKILLS_SYNC_RENAME_SOURCE: sourcePath,
          SKILLS_SYNC_RENAME_DESTINATION: destinationPath,
        },
        windowsHide: true,
      },
    );
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new BaselineError(
        'Refusing to apply: durable journal updates on Windows require powershell.exe.',
      );
    }
    throw error;
  }
}

async function syncPathTree(targetPath) {
  const info = await lstat(targetPath);
  if (info.isDirectory()) {
    const entries = await readdir(targetPath);
    for (const entry of entries) {
      await syncPathTree(path.join(targetPath, entry));
    }
    await syncDirectory(targetPath);
    return;
  }

  const handle = await open(targetPath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncSwapTargets(rootPath, targets = SWAP_TARGETS) {
  for (const target of targets) {
    await syncPathTree(path.join(rootPath, ...target.rel.split('/')));
  }
}

async function durableTargetRename(sourcePath, destinationPath) {
  if (process.platform === 'win32') {
    await durableRename(sourcePath, destinationPath);
    return;
  }

  await rename(sourcePath, destinationPath);
  await syncDirectory(path.dirname(sourcePath));
  if (path.dirname(sourcePath) !== path.dirname(destinationPath)) {
    await syncDirectory(path.dirname(destinationPath));
  }
}

export async function writeAtomicJson(
  filePath,
  value,
  { syncDirectory: syncDirectoryOp = syncDirectory, renameOp = durableRename } = {},
) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporaryPath, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameOp(temporaryPath, filePath);
  await syncDirectoryOp(path.dirname(filePath));
}

async function acquireApplyLock(commonGitDir) {
  const lockPath = path.join(commonGitDir, APPLY_LOCK_FILE);
  const owner = {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
  };

  try {
    const handle = await open(lockPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }

    let existing;
    try {
      existing = JSON.parse(await readFile(lockPath, 'utf8'));
    } catch {
      throw new BaselineError(
        `Refusing to apply: ${lockPath} already exists and cannot be safely identified. ` +
          'Verify no sync is running, then remove the stale lock manually.',
      );
    }

    throw new BaselineError(
      `Refusing to apply: another sync apply holds ${lockPath} ` +
        `(pid ${existing?.pid ?? 'unknown'} on ${existing?.hostname ?? 'unknown'}). ` +
        'Automatic stale-lock reclamation is disabled to preserve exclusive ownership; ' +
        'verify the owner is gone, then remove the stale lock manually.',
    );
  }

  return {
    path: lockPath,
    async release() {
      let current;
      try {
        current = JSON.parse(await readFile(lockPath, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return;
        }
        throw error;
      }

      if (current?.token !== owner.token) {
        throw new BaselineError(
          `Refusing to release ${lockPath}: lock ownership changed while applying. ` +
            'Inspect the active lock before retrying.',
        );
      }

      await rm(lockPath);
    },
  };
}

function buildTransaction({
  repoRoot,
  candidateRoot,
  backupRoot,
  workRoot,
  journalPath,
  renameOp,
  targetRenameOp,
  expectedSnapshots,
  targets = SWAP_TARGETS,
}) {
  return {
    version: 2,
    status: 'swapping',
    repoRoot,
    candidateRoot,
    backupRoot,
    workRoot,
    journalPath,
    renameOp,
    targetRenameOp,
    definitions: targets,
    targets: targets.map((target) => ({
      ...target,
      live: path.join(repoRoot, ...target.rel.split('/')),
      backup: path.join(backupRoot, ...target.rel.split('/')),
      candidate: path.join(candidateRoot, ...target.rel.split('/')),
      expectedSnapshot: expectedSnapshots?.get(target.rel) ?? null,
      phase: 'live',
    })),
  };
}

async function writeTransaction(transaction) {
  const { journalPath, renameOp, targetRenameOp, definitions, ...content } = transaction;
  await writeAtomicJson(journalPath, content, { renameOp });
}

function assertValidTransaction(transaction, journalPath) {
  if (
    ![1, 2].includes(transaction?.version) ||
    !['swapping', 'validated'].includes(transaction.status) ||
    !Array.isArray(transaction.targets) ||
    typeof transaction.repoRoot !== 'string' ||
    typeof transaction.candidateRoot !== 'string' ||
    typeof transaction.backupRoot !== 'string'
  ) {
    throw new BaselineError(
      `Refusing to recover: transaction journal ${journalPath} is malformed. ` +
        'Inspect it and restore the repository from the recorded backup before retrying.',
    );
  }

  const recordedShape = transaction.targets.map((target) => target?.rel).join('\0');
  const currentShape = SWAP_TARGETS.map((target) => target.rel).join('\0');
  const legacySixShape = LEGACY_SIX_SWAP_TARGETS.map((target) => target.rel).join('\0');
  const legacyFiveShape = LEGACY_FIVE_SWAP_TARGETS.map((target) => target.rel).join('\0');
  const licenseRefreshShape = LICENSE_REFRESH_SWAP_TARGETS
    .map((target) => target.rel)
    .join('\0');
  const targetDefinitions = recordedShape === currentShape
    ? SWAP_TARGETS
    : recordedShape === legacySixShape
      ? LEGACY_SIX_SWAP_TARGETS
      : recordedShape === legacyFiveShape
        ? LEGACY_FIVE_SWAP_TARGETS
        : recordedShape === licenseRefreshShape
          ? LICENSE_REFRESH_SWAP_TARGETS
          : null;

  if (!targetDefinitions) {
    throw new BaselineError(
      `Refusing to recover: transaction journal ${journalPath} has an unknown target set. ` +
        'Inspect it and restore the repository from the recorded backup before retrying.',
    );
  }

  for (const [index, target] of targetDefinitions.entries()) {
    const recorded = transaction.targets[index];
    const expectedLive = path.resolve(transaction.repoRoot, ...target.rel.split('/'));
    const expectedBackup = path.resolve(transaction.backupRoot, ...target.rel.split('/'));
    const expectedCandidate = path.resolve(transaction.candidateRoot, ...target.rel.split('/'));
    if (
      recorded?.rel !== target.rel ||
      recorded.kind !== target.kind ||
      path.resolve(recorded.live) !== expectedLive ||
      path.resolve(recorded.backup) !== expectedBackup ||
      path.resolve(recorded.candidate) !== expectedCandidate ||
      (recorded.expectedSnapshot !== undefined &&
        recorded.expectedSnapshot !== null &&
        (recorded.expectedSnapshot.kind !== target.kind ||
          typeof recorded.expectedSnapshot.hash !== 'string')) ||
      (transaction.version === 2 &&
        (recorded.expectedSnapshot === undefined || recorded.expectedSnapshot === null)) ||
      !['live', 'moving-to-backup', 'backed-up', 'placing-candidate', 'placed'].includes(
        recorded.phase,
      )
    ) {
      throw new BaselineError(
        `Refusing to recover: transaction journal ${journalPath} has invalid target ${target.rel}. ` +
          'Inspect it and restore the repository from the recorded backup before retrying.',
      );
    }
  }
}

async function removeTransactionArtifacts(transaction, journalPath) {
  await rm(transaction.backupRoot, { recursive: true, force: true });
  await rm(transaction.candidateRoot, { recursive: true, force: true });
  await rm(journalPath, { force: true });
}

function updateExactBytes(digest, bytes) {
  digest.update(String(bytes.length), 'utf8');
  digest.update('\0');
  digest.update(bytes);
}

function updateExactHash(digest, value) {
  updateExactBytes(digest, Buffer.from(value, 'utf8'));
}

async function hashExactTarget(targetPath) {
  const digest = createHash('sha256');

  async function visit(currentPath) {
    const info = await lstat(currentPath);
    const relativePath = path.relative(targetPath, currentPath).replace(/\\/g, '/') || '.';
    const mode = String(info.mode & 0o7777);

    if (info.isDirectory()) {
      updateExactHash(digest, 'directory');
      updateExactHash(digest, relativePath);
      updateExactHash(digest, mode);
      const entries = await readdir(currentPath, { withFileTypes: true });
      entries.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
      for (const entry of entries) {
        await visit(path.join(currentPath, entry.name));
      }
      return;
    }

    if (info.isFile()) {
      updateExactHash(digest, 'file');
      updateExactHash(digest, relativePath);
      updateExactHash(digest, mode);
      updateExactBytes(digest, await readFile(currentPath));
      return;
    }

    if (info.isSymbolicLink()) {
      updateExactHash(digest, 'symbolic-link');
      updateExactHash(digest, relativePath);
      updateExactHash(digest, mode);
      updateExactHash(digest, await readlink(currentPath));
      return;
    }

    throw new BaselineError(`Refusing to snapshot unsupported swap target entry: ${currentPath}.`);
  }

  await visit(targetPath);
  return `sha256:${digest.digest('hex')}`;
}

export async function snapshotSwapTarget(targetPath, kind) {
  const info = await lstat(targetPath);
  if ((kind === 'dir' && !info.isDirectory()) || (kind === 'file' && !info.isFile())) {
    throw new BaselineError(`Refusing to snapshot ${kind} swap target at ${targetPath}.`);
  }

  return { kind, hash: await hashExactTarget(targetPath) };
}

async function snapshotSwapTargets(repoRoot, targets = SWAP_TARGETS) {
  const snapshots = new Map();
  for (const target of targets) {
    snapshots.set(
      target.rel,
      await snapshotSwapTarget(path.join(repoRoot, ...target.rel.split('/')), target.kind),
    );
  }
  return snapshots;
}

async function backupMatchesExpectedSnapshot(target) {
  if (!target.expectedSnapshot) {
    return null;
  }

  const actual = await snapshotSwapTarget(target.backup, target.kind);
  return (
    actual.kind === target.expectedSnapshot.kind &&
    actual.hash === target.expectedSnapshot.hash
  );
}

async function assertBackupMatchesExpectedSnapshot(target) {
  if (!(await backupMatchesExpectedSnapshot(target))) {
    throw new BaselineError(
      `Refusing to complete swap: backup for ${target.rel} changed from its expected snapshot.`,
    );
  }
}

async function assertBackupsMatchExpectedSnapshots(transaction) {
  for (const target of transaction.targets) {
    await assertBackupMatchesExpectedSnapshot(target);
  }
}

async function recoverPendingTransaction(journalPath, { renameOp = durableTargetRename } = {}) {
  let transaction;
  try {
    transaction = JSON.parse(await readFile(journalPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw new BaselineError(
      `Refusing to recover: transaction journal ${journalPath} cannot be read. ` +
        'Inspect it and restore the repository from the recorded backup before retrying.',
    );
  }

  assertValidTransaction(transaction, journalPath);

  let shouldRestore = transaction.status !== 'validated';
  if (!shouldRestore) {
    if (
      transaction.version !== 2 ||
      transaction.targets.some((target) => !target.expectedSnapshot)
    ) {
      throw new BaselineError(
        `Refusing to recover: validated transaction ${journalPath} lacks expected snapshots. ` +
          'Inspect the candidate and remaining backups before retrying.',
      );
    }

    const snapshots = [];
    for (const target of transaction.targets) {
      if (!target.expectedSnapshot) continue;
      const backupInfo = await lstatOrNull(target.backup);
      if (!backupInfo) {
        snapshots.push({ target, state: 'removed' });
        continue;
      }
      snapshots.push({
        target,
        state: (await backupMatchesExpectedSnapshot(target)) ? 'matches' : 'changed',
      });
    }

    if (snapshots.some(({ state }) => state === 'changed')) {
      throw new BaselineError(
        `Refusing to recover: validated transaction ${journalPath} has a changed backup. ` +
          'Inspect the candidate and remaining backups before retrying.',
      );
    }
  }

  if (shouldRestore) {
    for (const target of [...transaction.targets].reverse()) {
      const backupInfo = await lstatOrNull(target.backup);
      const liveInfo = await lstatOrNull(target.live);

      if (!backupInfo) {
        if (!liveInfo) {
          throw new BaselineError(
            `Refusing to recover: neither live nor backup exists for ${target.rel}. ` +
              `Inspect ${journalPath} before retrying.`,
          );
        }
        continue;
      }

      if (liveInfo) {
        await rm(target.live, { recursive: true, force: true });
      }
      await mkdir(path.dirname(target.live), { recursive: true });
      await renameOp(target.backup, target.live);
    }
  }

  await removeTransactionArtifacts(transaction, journalPath);
  return true;
}

async function completeTransaction(transaction) {
  await syncSwapTargets(
    transaction.repoRoot,
    transaction.definitions ?? SWAP_TARGETS,
  );
  await assertBackupsMatchExpectedSnapshots(transaction);
  transaction.status = 'validated';
  await writeTransaction(transaction);
  await assertBackupsMatchExpectedSnapshots(transaction);
  await removeTransactionArtifacts(transaction, transaction.journalPath);
}

async function assertUnchangedGitState(repoRoot, initialStatus, readGitStatus) {
  const currentStatus = await readGitStatus(repoRoot);
  if (currentStatus !== initialStatus) {
    throw new BaselineError(
      'Refusing to apply: the git working tree changed while staging. ' +
        'Commit or stash the new changes before retrying.',
    );
  }
}

/**
 * Clones each upstream once, stages every mapped skill, and records the verified
 * content hash before stamping plus the vendored hash after stamping.
 */
async function stageMappedSkills({ manifest, workRoot, runGit, version = BASELINE_VERSION }) {
  const clonesDir = path.join(workRoot, 'clones');
  const stagingDir = path.join(workRoot, 'staging');
  await mkdir(clonesDir, { recursive: true });
  await mkdir(stagingDir, { recursive: true });

  const mappingsByUpstream = new Map();
  for (const mapping of manifest.mappings) {
    if (!mappingsByUpstream.has(mapping.upstream)) {
      mappingsByUpstream.set(mapping.upstream, []);
    }
    mappingsByUpstream.get(mapping.upstream).push(mapping);
  }

  const staged = new Map();
  const unavailable = [];
  const sources = [];

  for (const upstreamName of [...mappingsByUpstream.keys()].sort()) {
    const mappings = mappingsByUpstream.get(upstreamName);
    const upstream = manifest.upstreams[upstreamName];
    const cloneDir = path.join(clonesDir, upstreamName);

    let clone;
    try {
      clone = await cloneUpstream({
        repository: upstream.repository,
        reference: upstream.reference,
        destination: cloneDir,
        runGit,
      });
    } catch (error) {
      if (!(error instanceof GitCloneError)) {
        throw error;
      }
      sources.push({ upstream: upstreamName, available: false, commit: null });
      for (const mapping of mappings) {
        unavailable.push({ path: mapping.path, upstream: upstreamName, reason: 'upstream-unavailable' });
      }
      continue;
    }

    sources.push({ upstream: upstreamName, available: true, commit: clone.commit });
    const upstreamEvidence = {
      repository: upstream.repository,
      reference: upstream.reference,
      commit: clone.commit,
    };
    const rootLicense = await readRootLicenseEvidence(cloneDir, upstreamEvidence);

    for (const mapping of mappings) {
      const { path: sourceAbs, stat: sourceStat } = await assertClonePathBoundary(
        cloneDir,
        mapping.source,
      );

      if (!sourceStat) {
        unavailable.push({ path: mapping.path, upstream: upstreamName, reason: 'missing-source' });
        continue;
      }

      if (!sourceStat.isDirectory()) {
        // Non-directory upstream sources (e.g. a single command markdown file
        // requiring an unimplemented `command-to-skill` transform) cannot be
        // staged by the directory pipeline. Refuse cleanly so the baseline is
        // all-or-nothing rather than crashing mid-stage.
        unavailable.push({ path: mapping.path, upstream: upstreamName, reason: 'source-not-directory' });
        continue;
      }

      const sourceFrontmatter = parseSkillFrontmatter(
        await readFile(path.join(sourceAbs, 'SKILL.md'), 'utf8'),
        `${mapping.source}/SKILL.md`,
      );
      const {
        license,
        redistributable,
        licenseEvidence,
      } = await resolveLicense(
        cloneDir,
        mapping.source,
        sourceFrontmatter,
        {
          upstream: upstreamEvidence,
          rootLicense,
          policyPath: mapping.path,
        },
      );

      const stageDir = path.join(stagingDir, ...mapping.path.split('/'));
      await mkdir(path.dirname(stageDir), { recursive: true });
      // The same exclusion and fail-closed symlink policy the hash applies:
      // never stage bytes git refuses to track.
      await copyHashableDirectory(sourceAbs, stageDir);

      // Hash BEFORE transform: this is the verified upstream content identity.
      const contentHash = await hashDirectory(stageDir);
      const override = manifest.overrides.find((entry) => entry.path === mapping.path);

      await transformStaged({
        skillDir: stageDir,
        skillPath: mapping.path,
        override,
        upstream,
        source: mapping.source,
        commit: clone.commit,
        version,
      });

      const snapshotHash = await hashDirectory(stageDir);
      const stagedFrontmatter = parseSkillFrontmatter(
        await readFile(path.join(stageDir, 'SKILL.md'), 'utf8'),
        `${mapping.path}/SKILL.md`,
      );
      staged.set(mapping.path, {
        category: 'mapped',
        commit: clone.commit,
        contentHash,
        snapshotHash,
        stageDir,
        name: stagedFrontmatter.name,
        repository: upstream.repository,
        reference: upstream.reference,
        source: mapping.source,
        license,
        redistributable,
        licenseEvidence,
        rootLicense,
      });
    }
  }

  return { staged, unavailable, sources };
}

/**
 * Verifies the lock and the on-disk skill tree agree: counts are internally
 * consistent, names are unique, and every declared skill exists with matching
 * frontmatter. This is the deterministic structural analog of the npx install
 * smoke, run without any network access.
 */
export async function assertStructuralIntegrity(repoRoot, lock) {
  const activeSkills = lock.skills.filter((skill) => skill.category !== 'removed');
  if (lock.counts.total !== activeSkills.length) {
    throw new BaselineError(
      `Structural smoke failed: lock counts.total ${lock.counts.total} != ${activeSkills.length} active skills.`,
    );
  }

  const tallies = { mapped: 0, orphan: 0, local: 0 };
  const names = new Set();

  for (const skill of lock.skills) {
    if (skill.category === 'removed') {
      const removedSkillFile = path.join(repoRoot, ...skill.path.split('/'), 'SKILL.md');
      try {
        await readFile(removedSkillFile, 'utf8');
        throw new BaselineError(
          `Structural smoke failed: tombstoned skill still exists at ${skill.path}.`,
        );
      } catch (error) {
        if (error instanceof BaselineError) throw error;
        if (error?.code !== 'ENOENT') throw error;
      }
      continue;
    }

    tallies[skill.category] += 1;

    if (names.has(skill.name)) {
      throw new BaselineError(`Structural smoke failed: duplicate skill name ${skill.name}.`);
    }
    names.add(skill.name);

    const skillFile = path.join(repoRoot, ...skill.path.split('/'), 'SKILL.md');
    let text;
    try {
      text = await readFile(skillFile, 'utf8');
    } catch {
      throw new BaselineError(`Structural smoke failed: missing SKILL.md for ${skill.path}.`);
    }

    const frontmatter = parseSkillFrontmatter(text, `${skill.path}/SKILL.md`);
    if (frontmatter.name !== skill.name) {
      throw new BaselineError(
        `Structural smoke failed: ${skill.path} frontmatter name ${frontmatter.name} != lock ${skill.name}.`,
      );
    }
  }

  for (const category of ['mapped', 'orphan', 'local']) {
    if ((lock.counts[category] ?? 0) !== tallies[category]) {
      throw new BaselineError(
        `Structural smoke failed: lock counts.${category} ${lock.counts[category]} != ${tallies[category]}.`,
      );
    }
  }
}

async function readLock(repoRoot) {
  const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
  return JSON.parse(await readFile(lockPath, 'utf8'));
}

async function readHistoryDoc(repoRoot, skillPath) {
  const fileName = `${skillPath.replace(/\//g, '__')}.json`;
  const filePath = path.join(repoRoot, 'catalog', 'history', fileName);
  return { fileName, content: JSON.parse(await readFile(filePath, 'utf8')) };
}

export async function copyLicenseBundleTarget(repoRoot, candidateRoot) {
  try {
    await cp(
      path.join(repoRoot, 'catalog', 'licenses'),
      path.join(candidateRoot, 'catalog', 'licenses'),
      { recursive: true },
    );
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new BaselineError(
        'Required catalog/licenses is missing; restore the generated bundle before applying.',
      );
    }
    throw error;
  }
}

/**
 * Builds the complete candidate tree in the staging area: a full copy of the
 * live skills tree and history with the mapped skills replaced, plus the
 * regenerated lock, NOTICE, and README.
 */
async function buildCandidate({ repoRoot, candidateRoot, manifest, lock, staged, generatedAt }) {
  await cp(path.join(repoRoot, 'skills'), path.join(candidateRoot, 'skills'), { recursive: true });
  await cp(
    path.join(repoRoot, 'catalog', 'history'),
    path.join(candidateRoot, 'catalog', 'history'),
    { recursive: true },
  );
  await copyLicenseBundleTarget(repoRoot, candidateRoot);
  await cp(
    path.join(repoRoot, 'catalog', 'sources.yml'),
    path.join(candidateRoot, 'catalog', 'sources.yml'),
  );

  for (const [skillPath, stagedEntry] of staged) {
    const dest = path.join(candidateRoot, ...skillPath.split('/'));
    await rm(dest, { recursive: true, force: true });
    await cp(stagedEntry.stageDir, dest, { recursive: true });
  }

  const nextLock = buildVerifiedLock({ lock, staged, release: BASELINE_RELEASE, generatedAt });

  await writeFile(
    path.join(candidateRoot, 'catalog', 'skills.lock.json'),
    serialize(nextLock),
  );

  for (const [skillPath, stagedEntry] of staged) {
    const { fileName, content } = await readHistoryDoc(repoRoot, skillPath);
    const next = appendBaselineHistoryEntry(content, {
      release: BASELINE_RELEASE,
      version: BASELINE_VERSION,
      upstreamCommit: stagedEntry.commit,
      contentHash: stagedEntry.contentHash,
    });
    await writeFile(path.join(candidateRoot, 'catalog', 'history', fileName), serialize(next));
  }

  const rootLicenses = await collectRequiredRootLicenses({
    repoRoot,
    nextLock,
    staged,
  });
  const licenseBundle = await writeLicenseBundle(
    path.join(candidateRoot, 'catalog', 'licenses'),
    rootLicenses,
    { release: nextLock.release },
  );
  await writeFile(
    path.join(candidateRoot, 'NOTICE'),
    renderNotice(nextLock, { licenseBundle }),
  );

  const readmeText = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
  await writeFile(path.join(candidateRoot, 'README.md'), renderReadme(readmeText, nextLock));

  return nextLock;
}

async function assertUnchanged(repoRoot, candidateRoot, relativePath, label) {
  const original = await hashDirectory(path.join(repoRoot, ...relativePath.split('/')));
  const candidate = await hashDirectory(path.join(candidateRoot, ...relativePath.split('/')));

  if (original !== candidate) {
    throw new BaselineError(`Refusing baseline: ${label} changed unexpectedly (${relativePath}).`);
  }
}

/**
 * Atomically swaps live repo targets with their candidate counterparts, backing
 * up each original before placement. Tracks backed-up targets independently so
 * rollback can restore every original even if placement fails partway through.
 *
 * Accepts injectable `renameOp` / `removeOp` for fault-injection tests.
 * Exported so tests can exercise the swap logic directly.
 */
export async function swapInCandidate(
  repoRoot,
  candidateRoot,
  backupRoot,
  {
    renameOp = rename,
    removeOp = rm,
    transaction,
    beforeFirstDestructiveMove,
    afterCleanCheck,
    afterBackupMove,
  } = {},
) {
  const backedUp = [];
  const activeRenameOp = transaction?.targetRenameOp ?? renameOp;
  const targetDefinitions = transaction?.definitions ?? SWAP_TARGETS;

  try {
    if (transaction) {
      await syncSwapTargets(candidateRoot, targetDefinitions);
    }
    for (const [index, target] of targetDefinitions.entries()) {
      const original = path.join(repoRoot, ...target.rel.split('/'));
      const backup = path.join(backupRoot, ...target.rel.split('/'));
      const candidate = path.join(candidateRoot, ...target.rel.split('/'));

      await mkdir(path.dirname(backup), { recursive: true });
      await syncDirectory(path.dirname(path.dirname(backup)));
      await syncDirectory(path.dirname(backup));
      if (transaction) {
        transaction.targets[index].phase = 'moving-to-backup';
        await writeTransaction(transaction);
      }
      if (index === 0 && beforeFirstDestructiveMove) {
        await beforeFirstDestructiveMove();
      }
      if (index === 0 && afterCleanCheck) {
        await afterCleanCheck();
      }
      await activeRenameOp(original, backup);
      backedUp.push(target);
      if (afterBackupMove) {
        await afterBackupMove(transaction?.targets[index] ?? {
          ...target,
          live: original,
          backup,
          candidate,
        });
      }
      if (transaction) {
        await assertBackupMatchesExpectedSnapshot(transaction.targets[index]);
      }
      if (transaction) {
        transaction.targets[index].phase = 'backed-up';
        await writeTransaction(transaction);
      }

      await mkdir(path.dirname(original), { recursive: true });
      if (transaction) {
        transaction.targets[index].phase = 'placing-candidate';
        await writeTransaction(transaction);
      }
      await activeRenameOp(candidate, original);
      if (transaction) {
        transaction.targets[index].phase = 'placed';
        await writeTransaction(transaction);
      }
    }
  } catch (error) {
    try {
      await rollbackSwap(repoRoot, backupRoot, backedUp, { renameOp: activeRenameOp, removeOp });
    } catch (rollbackError) {
      const wrapped = new BaselineError(
        `Swap failed and rollback also failed. Backup data preserved at ${backupRoot}. ` +
        `Original error: ${error.message}. Rollback error: ${rollbackError.message}`,
      );
      wrapped.backupPath = backupRoot;
      wrapped.rollbackFailed = true;
      throw wrapped;
    }
    throw error;
  }

  return backedUp;
}

async function rollbackSwap(repoRoot, backupRoot, targets, { renameOp = rename, removeOp = rm } = {}) {
  for (const target of [...targets].reverse()) {
    const original = path.join(repoRoot, ...target.rel.split('/'));
    const backup = path.join(backupRoot, ...target.rel.split('/'));
    await removeOp(original, { recursive: true, force: true });
    await renameOp(backup, original);
  }
}

/**
 * Establishes the verified upstream baseline.
 *
 * Refuses unless `baseline` is explicitly true and the working tree is clean.
 * Stages every mapped skill from a fresh upstream clone; refuses if any upstream
 * is unavailable, any mapped source is missing, or the staged count does not
 * match the manifest. Applies the change through an all-or-nothing directory
 * swap and rolls the swap back if post-apply validation or the structural smoke
 * fails. Never creates commits or tags.
 */
export async function applyBaseline({
  repoRoot = defaultRepoRoot,
  baseline = false,
  readGitStatus = defaultReadGitStatus,
  now = () => new Date().toISOString(),
  runGit,
  validate = validateRepository,
  afterCleanCheck,
  afterBackupMove,
} = {}) {
  if (baseline !== true) {
    throw new BaselineError('Refusing to apply: baseline mode must be explicitly enabled.');
  }

  const absoluteRepoRoot = path.resolve(repoRoot);
  const { commonGitDir } = await resolveGitDirectories(absoluteRepoRoot);
  const journalPath = path.join(commonGitDir, TRANSACTION_JOURNAL_FILE);
  let applyLock;
  let workRoot;
  let transaction;
  let journalRenamer;
  let preserveWorkRoot = false;

  try {
    applyLock = await acquireApplyLock(commonGitDir);
    journalRenamer = createJournalRenamer();
    await recoverPendingTransaction(journalPath, {
      renameOp: journalRenamer?.rename.bind(journalRenamer),
    });

    const initialStatus = await readGitStatus(absoluteRepoRoot);
    if (initialStatus.trim() !== '') {
      throw new BaselineError(
        'Refusing to apply baseline: the git working tree is not clean. Commit or stash changes first.',
      );
    }

    const manifest = await loadManifest(
      path.join(absoluteRepoRoot, 'catalog', 'sources.yml'),
    );

    // Protected-root guard: identical to the dry-run plan, applied here BEFORE
    // any clone, stage, or candidate write so plan and apply can never diverge.
    assertMappingsWritable(manifest);

    const lock = await readLock(absoluteRepoRoot);

    // --- One-time baseline guards (Defect 2) ---
    // The baseline is a one-time migration from v1.0.0 bootstrap to v1.1.0
    // verified. Once applied, it must never be re-run.
    if (lock.release !== '1.0.0') {
      throw new BaselineError(
        `Refusing baseline: already established. Lock release is ${lock.release}, ` +
        `expected 1.0.0. The baseline is a one-time migration.`,
      );
    }

    for (const skill of lock.skills) {
      if (skill.category === 'mapped' && skill.baseline !== 'unverified') {
        throw new BaselineError(
          `Refusing baseline: already established. Mapped skill ${skill.path} ` +
          `has baseline "${skill.baseline}"; expected "unverified".`,
        );
      }
    }

    // Check that no history file contains a baseline-verified entry.
    const historyDir = path.join(absoluteRepoRoot, 'catalog', 'history');
    const historyEntries = await readdir(historyDir, { withFileTypes: true });
    for (const entry of historyEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const histDoc = JSON.parse(await readFile(path.join(historyDir, entry.name), 'utf8'));
      if (Array.isArray(histDoc.entries) && histDoc.entries.some((e) => e.kind === BASELINE_HISTORY_KIND)) {
        throw new BaselineError(
          `Refusing baseline: already established. History for ${histDoc.path} ` +
          `already contains a ${BASELINE_HISTORY_KIND} entry.`,
        );
      }
    }

    // Check that the target tag does not already exist.
    const targetTag = `v${BASELINE_RELEASE}`;
    if (await tagExists(targetTag, { runGit: runGit ?? undefined })) {
      throw new BaselineError(
        `Refusing baseline: already established. Tag ${targetTag} already exists.`,
      );
    }

    workRoot = await createApplyWorkRoot(absoluteRepoRoot, 'baseline');
    const backupRoot = path.join(workRoot, 'backup');
    const candidateRoot = path.join(workRoot, 'candidate');
    await mkdir(candidateRoot, { recursive: true });

    const { staged, unavailable, sources } = await stageMappedSkills({
      manifest,
      workRoot,
      runGit,
    });

    if (unavailable.length > 0) {
      const detail = unavailable
        .map((entry) => `${entry.path} (${entry.reason})`)
        .join(', ');
      throw new BaselineError(
        `Refusing baseline: ${unavailable.length} mapped skill(s) are unavailable and block the baseline: ${detail}.`,
      );
    }

    if (staged.size !== manifest.mappings.length) {
      throw new BaselineError(
        `Refusing baseline: staged ${staged.size} of ${manifest.mappings.length} mapped skills.`,
      );
    }

    const guard = evaluateDeletionGuards(
      sources.map((source) => ({
        upstream: source.upstream,
        declared: manifest.mappings.filter((mapping) => mapping.upstream === source.upstream).length,
        removed: 0,
        available: source.available,
      })),
    );

    if (guard.blocked) {
      throw new BaselineError('Refusing baseline: deletion guardrail is blocked.');
    }

    const generatedAt = now();
    const nextLock = await buildCandidate({
      repoRoot: absoluteRepoRoot,
      candidateRoot,
      manifest,
      lock,
      staged,
      generatedAt,
    });

    // Orphan and local skills must never be touched by the baseline.
    for (const skill of lock.skills) {
      if (skill.category === 'orphan' || skill.category === 'local') {
        await assertUnchanged(absoluteRepoRoot, candidateRoot, skill.path, `${skill.category} skill`);
      }
    }

    const expectedSnapshots = await snapshotSwapTargets(absoluteRepoRoot);
    transaction = buildTransaction({
      repoRoot: absoluteRepoRoot,
      candidateRoot,
      backupRoot,
      workRoot,
      journalPath,
      renameOp: journalRenamer?.rename.bind(journalRenamer),
      targetRenameOp: journalRenamer?.rename.bind(journalRenamer) ?? durableTargetRename,
      expectedSnapshots,
    });

    const placed = await swapInCandidate(absoluteRepoRoot, candidateRoot, backupRoot, {
      transaction,
      beforeFirstDestructiveMove: () =>
        assertUnchangedGitState(absoluteRepoRoot, initialStatus, readGitStatus),
      afterCleanCheck,
      afterBackupMove,
    });

    try {
      await validate(absoluteRepoRoot);
      await assertStructuralIntegrity(absoluteRepoRoot, nextLock);
    } catch (error) {
      try {
        await rollbackSwap(absoluteRepoRoot, backupRoot, placed, {
          renameOp: transaction.targetRenameOp,
        });
      } catch (rollbackError) {
        const wrapped = new BaselineError(
          `Baseline post-apply validation failed and rollback also failed. ` +
          `Backup data preserved at ${backupRoot}. ` +
          `Validation error: ${error.message}. Rollback error: ${rollbackError.message}`,
        );
        wrapped.backupPath = backupRoot;
        wrapped.rollbackFailed = true;
        throw wrapped;
      }
      throw new BaselineError(`Baseline post-apply validation failed; rolled back. ${error.message}`);
    }

    await completeTransaction(transaction);
    transaction = null;

    return {
      release: BASELINE_RELEASE,
      applied: [...staged.keys()].sort(),
      counts: nextLock.counts,
      sources,
    };
  } catch (error) {
    if (error.rollbackFailed) {
      preserveWorkRoot = true;
    } else if (transaction) {
      try {
        await recoverPendingTransaction(journalPath, {
          renameOp: journalRenamer?.rename.bind(journalRenamer),
        });
        transaction = null;
      } catch (recoveryError) {
        preserveWorkRoot = true;
        const wrapped = new BaselineError(
          `Baseline apply failed and transaction recovery also failed. ` +
          `Journal preserved at ${journalPath}. Original error: ${error.message}. ` +
          `Recovery error: ${recoveryError.message}`,
        );
        wrapped.recoveryFailed = true;
        throw wrapped;
      }
    }
    throw error;
  } finally {
    journalRenamer?.close();
    if (!preserveWorkRoot && workRoot) {
      await rm(workRoot, { recursive: true, force: true });
    }
    if (applyLock) {
      await applyLock.release();
    }
  }
}

// ---------------------------------------------------------------------------
// Daily upstream update engine
// ---------------------------------------------------------------------------

/**
 * Bumps a semver version string by one patch level.
 */
function bumpPatch(version) {
  const parsed = parseVersion(version);
  return formatVersion({ major: parsed.major, minor: parsed.minor, patch: parsed.patch + 1 });
}

/**
 * Builds a GitHub compare URL between two commits for a skill's upstream repo.
 * Returns `null` when no previous commit is available.
 */
function diffUrl(repository, previousCommit, newCommit) {
  if (!previousCommit) return null;
  return `https://github.com/${repository}/compare/${previousCommit}...${newCommit}`;
}

function sameRootEvidence(left, right) {
  return (
    left?.repository === right?.repository &&
    left?.reference === right?.reference &&
    left?.commit === right?.commit &&
    (left?.path ?? left?.sourcePath) === (right?.path ?? right?.sourcePath) &&
    left?.hash === right?.hash
  );
}

async function collectRequiredRootLicenses({ repoRoot, nextLock, staged }) {
  const requiredEvidence = nextLock.skills
    .map((skill) => skill.licenseEvidence)
    .filter(
      (evidence) =>
        evidence?.source?.startsWith('upstream-root:') ||
        (evidence?.source === 'unresolved' &&
          evidence.scope === 'upstream-root'),
    );
  const stagedRoots = [...staged.values()]
    .map((entry) => entry.rootLicense)
    .filter(Boolean);

  let existing = { licenses: [] };
  try {
    const liveLock = JSON.parse(
      await readFile(
        path.join(repoRoot, 'catalog', 'skills.lock.json'),
        'utf8',
      ),
    );
    existing = await validateLicenseBundle(repoRoot, liveLock);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const collected = [];
  for (const evidence of requiredEvidence) {
    const stagedRoot = stagedRoots.find((root) =>
      sameRootEvidence(root, evidence),
    );
    if (stagedRoot) {
      collected.push(stagedRoot);
      continue;
    }

    const existingEntry = (existing.licenses ?? []).find((entry) =>
      sameRootEvidence(entry, evidence),
    );
    if (!existingEntry) {
      throw new BaselineError(
        `Required root license evidence is missing from staged and bundled state: ` +
          `${evidence.repository}@${evidence.commit}:${evidence.path}.`,
      );
    }
    collected.push({
      license: existingEntry.license,
      filename: path.posix.basename(existingEntry.sourcePath),
      path: existingEntry.sourcePath,
      hash: existingEntry.hash,
      content: await readFile(
        path.join(repoRoot, 'catalog', 'licenses', existingEntry.bundlePath),
      ),
      repository: existingEntry.repository,
      reference: existingEntry.reference,
      commit: existingEntry.commit,
    });
  }
  return collected;
}

async function readOptionalHistoryDoc(repoRoot, skillPath, name) {
  const fileName = historyFileName(skillPath);

  try {
    const content = JSON.parse(
      await readFile(path.join(repoRoot, 'catalog', 'history', fileName), 'utf8'),
    );

    if (
      content.path !== skillPath ||
      !Array.isArray(content.entries)
    ) {
      throw new BaselineError(`Invalid history ledger for added skill: ${skillPath}`);
    }

    return { fileName, content };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return {
      fileName,
      content: {
        path: skillPath,
        name,
        category: 'mapped',
        entries: [],
      },
    };
  }
}

/**
 * Rebuilds the lockfile with added and changed skills updated and removed
 * mappings retained as inactive tombstones.
 *
 * Added entries start at version 1.0.0 with verified staged provenance and
 * conservatively derived license metadata. Changed entries get a bumped patch
 * version, updated hashes, commit, and adopted staged name. Entries listed in
 * `removedPaths` become `removed` entries so their audit identity remains in the
 * lock without being installable. Unchanged mapped entries, orphan entries, and
 * local entries pass through untouched. `counts` includes active entries only.
 */
export function buildUpdateLock({
  lock,
  staged,
  addedPaths = [],
  changedPaths,
  removedPaths = [],
  release,
  generatedAt,
}) {
  const changedSet = new Set(changedPaths);
  const addedSet = new Set(addedPaths);
  const removedSet = new Set(removedPaths);
  const stagedMap = staged instanceof Map ? staged : new Map(Object.entries(staged));

  const skills = lock.skills
    .filter((skill) => !(addedSet.has(skill.path) && skill.category === 'removed'))
    .map((skill) => {
      if (removedSet.has(skill.path)) {
        return {
          ...skill,
          category: 'removed',
          removedIn: release,
          removalReason: 'Mapping removed from the registry manifest.',
        };
      }

      if (skill.category !== 'mapped') return skill;

      if (!changedSet.has(skill.path)) return skill;

      const stagedEntry = stagedMap.get(skill.path);
      if (!stagedEntry) {
        throw new BaselineError(`Changed skill was not staged: ${skill.path}`);
      }
      if (
        !stagedEntry.repository ||
        !stagedEntry.reference ||
        !stagedEntry.source
      ) {
        throw new BaselineError(`Changed skill is missing upstream tuple: ${skill.path}`);
      }

      return {
        path: skill.path,
        name: stagedEntry.name ?? skill.name,
        category: skill.category,
        version: bumpPatch(skill.version),
        baseline: 'verified',
        license: stagedEntry.license ?? skill.license,
        redistributable: stagedEntry.redistributable ?? skill.redistributable,
        licenseEvidence: stagedEntry.licenseEvidence ?? skill.licenseEvidence,
        snapshotHash: stagedEntry.snapshotHash,
        contentHash: stagedEntry.contentHash,
        upstream: {
          repository: stagedEntry.repository,
          reference: stagedEntry.reference,
          source: stagedEntry.source,
          commit: stagedEntry.commit,
        },
      };
    });

  for (const skillPath of addedSet) {
    if (skills.some((skill) => skill.path === skillPath)) {
      throw new BaselineError(`Added skill already exists in lock: ${skillPath}`);
    }

    const stagedEntry = stagedMap.get(skillPath);
    if (!stagedEntry) {
      throw new BaselineError(`Added skill was not staged: ${skillPath}`);
    }
    if (
      !stagedEntry.snapshotHash ||
      !stagedEntry.name ||
      !stagedEntry.license ||
      typeof stagedEntry.redistributable !== 'boolean'
    ) {
      throw new BaselineError(`Added skill is missing verified metadata: ${skillPath}`);
    }

    const category = stagedEntry.category ?? 'mapped';
    const isMapped = category === 'mapped';

    if (
      isMapped &&
      (
        !stagedEntry.repository ||
        !stagedEntry.reference ||
        !stagedEntry.source ||
        !stagedEntry.commit ||
        !stagedEntry.contentHash
      )
    ) {
      throw new BaselineError(`Added mapped skill is missing provenance: ${skillPath}`);
    }

    skills.push({
      path: skillPath,
      name: stagedEntry.name,
      category,
      version: ADDED_SKILL_VERSION,
      baseline: isMapped ? 'verified' : null,
      license: stagedEntry.license,
      redistributable: stagedEntry.redistributable,
      licenseEvidence: stagedEntry.licenseEvidence,
      snapshotHash: stagedEntry.snapshotHash,
      ...(isMapped ? { contentHash: stagedEntry.contentHash } : {}),
      upstream: isMapped
        ? {
            repository: stagedEntry.repository,
            reference: stagedEntry.reference,
            source: stagedEntry.source,
            commit: stagedEntry.commit,
          }
        : null,
    });
  }

  skills.sort((left, right) =>
    left.path === right.path ? 0 : left.path < right.path ? -1 : 1,
  );

  const activeSkills = skills.filter((skill) => skill.category !== 'removed');
  const counts = { total: activeSkills.length, mapped: 0, orphan: 0, local: 0 };
  for (const skill of activeSkills) {
    counts[skill.category] += 1;
  }

  return {
    release,
    generatedAt,
    ...(lock.licenseEvidenceVersion
      ? { licenseEvidenceVersion: lock.licenseEvidenceVersion }
      : {}),
    counts,
    skills,
  };
}

/**
 * Builds the candidate tree for a daily update: copies the live tree, replaces
 * only the changed skills, updates the lock and history, and regenerates NOTICE
 * and README.
 */
async function buildUpdateCandidate({
  repoRoot,
  candidateRoot,
  lock,
  staged,
  addedPaths = [],
  changedPaths,
  removedPaths = [],
  release,
  generatedAt,
}) {
  await cp(path.join(repoRoot, 'skills'), path.join(candidateRoot, 'skills'), { recursive: true });
  await cp(
    path.join(repoRoot, 'catalog', 'history'),
    path.join(candidateRoot, 'catalog', 'history'),
    { recursive: true },
  );
  await copyLicenseBundleTarget(repoRoot, candidateRoot);
  await cp(
    path.join(repoRoot, 'catalog', 'sources.yml'),
    path.join(candidateRoot, 'catalog', 'sources.yml'),
  );

  const changedSet = new Set(changedPaths);
  const addedSet = new Set(addedPaths);

  for (const [skillPath, stagedEntry] of staged) {
    if (!changedSet.has(skillPath) && !addedSet.has(skillPath)) continue;
    const dest = path.join(candidateRoot, ...skillPath.split('/'));
    await rm(dest, { recursive: true, force: true });
    await cp(stagedEntry.stageDir, dest, { recursive: true });
  }

  // Undeclared mappings leave the vendored tree; the history ledger keeps the
  // provenance record so the removal stays auditable.
  for (const skillPath of removedPaths) {
    await rm(path.join(candidateRoot, ...skillPath.split('/')), {
      recursive: true,
      force: true,
    });
  }

  const nextLock = buildUpdateLock({
    lock,
    staged,
    addedPaths,
    changedPaths,
    removedPaths,
    release,
    generatedAt,
  });

  await writeFile(
    path.join(candidateRoot, 'catalog', 'skills.lock.json'),
    serialize(nextLock),
  );

  for (const skillPath of changedPaths) {
    const stagedEntry = staged.get(skillPath);
    const lockSkill = lock.skills.find((skill) => skill.path === skillPath);
    const { fileName, content } = await readHistoryDoc(repoRoot, skillPath);
    const previousCommit = lockSkill?.upstream?.commit ?? null;
    const repository = stagedEntry.repository;
    const sameRepository = lockSkill?.upstream?.repository === repository;

    const entry = {
      release,
      kind: 'upstream-update',
      version: bumpPatch(lockSkill.version),
      upstreamCommit: stagedEntry.commit,
      diffUrl: sameRepository ? diffUrl(repository, previousCommit, stagedEntry.commit) : null,
      contentHash: stagedEntry.contentHash,
    };

    const next = { ...content, entries: [...content.entries, entry] };
    await writeFile(path.join(candidateRoot, 'catalog', 'history', fileName), serialize(next));
  }

  for (const skillPath of addedPaths) {
    const stagedEntry = staged.get(skillPath);
    const { fileName, content } = await readOptionalHistoryDoc(
      repoRoot,
      skillPath,
      stagedEntry.name,
    );
    const isMapped = stagedEntry.category === 'mapped';
    const entry = {
      release,
      kind: isMapped ? 'mapping-added' : `${stagedEntry.category}-added`,
      version: ADDED_SKILL_VERSION,
      ...(content.entries.length === 0 ? { firstSeen: generatedAt } : {}),
      upstreamCommit: isMapped ? stagedEntry.commit : null,
      diffUrl: null,
      ...(isMapped
        ? { contentHash: stagedEntry.contentHash }
        : { snapshotHash: stagedEntry.snapshotHash }),
    };
    const next = {
      ...content,
      name: stagedEntry.name,
      category: stagedEntry.category,
      entries: [...content.entries, entry],
    };
    await writeFile(
      path.join(candidateRoot, 'catalog', 'history', fileName),
      serialize(next),
    );
  }

  for (const skillPath of removedPaths) {
    const lockSkill = lock.skills.find(
      (skill) => skill.path === skillPath && skill.category !== 'removed',
    );
    const { fileName, content } = await readHistoryDoc(repoRoot, skillPath);

    const entry = {
      release,
      kind: 'mapping-removed',
      version: lockSkill?.version ?? null,
      upstreamCommit: lockSkill?.upstream?.commit ?? null,
      diffUrl: null,
      contentHash: lockSkill?.contentHash ?? null,
    };

    const next = { ...content, entries: [...content.entries, entry] };
    await writeFile(path.join(candidateRoot, 'catalog', 'history', fileName), serialize(next));
  }

  const rootLicenses = await collectRequiredRootLicenses({
    repoRoot,
    nextLock,
    staged,
  });
  const licenseBundle = await writeLicenseBundle(
    path.join(candidateRoot, 'catalog', 'licenses'),
    rootLicenses,
    { release: nextLock.release },
  );
  await writeFile(
    path.join(candidateRoot, 'NOTICE'),
    renderNotice(nextLock, { licenseBundle }),
  );

  const readmeText = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
  await writeFile(path.join(candidateRoot, 'README.md'), renderReadme(readmeText, nextLock));

  return nextLock;
}

async function buildDeproprietizeCandidate({
  repoRoot,
  candidateRoot,
  lock,
  generatedAt,
}) {
  await cp(path.join(repoRoot, 'skills'), path.join(candidateRoot, 'skills'), {
    recursive: true,
  });
  await cp(
    path.join(repoRoot, 'catalog', 'history'),
    path.join(candidateRoot, 'catalog', 'history'),
    { recursive: true },
  );
  await copyLicenseBundleTarget(repoRoot, candidateRoot);

  const manifestText = await readFile(
    path.join(repoRoot, 'catalog', 'sources.yml'),
    'utf8',
  );
  await writeFile(
    path.join(candidateRoot, 'catalog', 'sources.yml'),
    removeDeproprietizedMappings(manifestText),
  );

  for (const skillPath of DEPROPRIETIZE_PATHS) {
    await rm(path.join(candidateRoot, ...skillPath.split('/')), {
      recursive: true,
      force: true,
    });
  }

  const nextLock = buildDeproprietizedLock({ lock, generatedAt });
  await writeFile(
    path.join(candidateRoot, 'catalog', 'skills.lock.json'),
    serialize(nextLock),
  );

  for (const skillPath of DEPROPRIETIZE_PATHS) {
    const lockSkill = lock.skills.find((skill) => skill.path === skillPath);
    const { fileName, content } = await readHistoryDoc(repoRoot, skillPath);
    const entry = {
      release: DEPROPRIETIZE_RELEASE,
      kind: 'mapping-removed',
      version: lockSkill.version,
      upstreamCommit: lockSkill.upstream?.commit ?? null,
      diffUrl: null,
      contentHash: lockSkill.contentHash ?? null,
      reason: 'Removed proprietary material to prevent proprietary redistribution.',
    };
    await writeFile(
      path.join(candidateRoot, 'catalog', 'history', fileName),
      serialize({ ...content, entries: [...content.entries, entry] }),
    );
  }

  await writeFile(path.join(candidateRoot, 'NOTICE'), renderNotice(nextLock));
  const readmeText = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
  await writeFile(
    path.join(candidateRoot, 'README.md'),
    renderReadme(readmeText, nextLock),
  );

  return nextLock;
}

async function resolveAllLicenseMetadata({
  repoRoot,
  manifest,
  lock,
  workRoot,
  runGit,
}) {
  let pinned;
  try {
    pinned = await resolvePinnedMappedLicenses({
      manifest,
      lock,
      workspace: path.join(workRoot, 'license-evidence'),
      runGit,
    });
  } catch (error) {
    if (error instanceof LicenseEvidenceError) {
      throw new BaselineError(error.message);
    }
    throw error;
  }

  const resolvedByPath = new Map(pinned.resolvedByPath);
  for (const skill of lock.skills) {
    if (resolvedByPath.has(skill.path)) {
      continue;
    }

    if (skill.category === 'removed') {
      if (skill.licenseEvidence) {
        resolvedByPath.set(skill.path, {
          license: skill.license,
          redistributable: skill.redistributable,
          licenseEvidence: skill.licenseEvidence,
        });
        continue;
      }
      if (skill.license !== 'Unknown') {
        throw new BaselineError(
          `Removed skill ${skill.path} has a known license without auditable evidence.`,
        );
      }
      resolvedByPath.set(skill.path, {
        license: 'Unknown',
        redistributable: true,
        licenseEvidence: { source: 'unresolved' },
      });
      continue;
    }

    const skillFile = path.join(repoRoot, ...skill.path.split('/'), 'SKILL.md');
    const frontmatter = parseSkillFrontmatter(
      await readFile(skillFile, 'utf8'),
      `${skill.path}/SKILL.md`,
    );
    resolvedByPath.set(
      skill.path,
      await resolveLicense(repoRoot, skill.path, frontmatter),
    );
  }

  return { ...pinned, resolvedByPath };
}

function countLicenses(lock) {
  const counts = {};
  for (const skill of lock.skills) {
    if (skill.category === 'removed') {
      continue;
    }
    counts[skill.license] = (counts[skill.license] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

async function buildLicenseRefreshCandidate({
  repoRoot,
  candidateRoot,
  lock,
  nextLock,
  changedPaths,
  rootLicenses,
}) {
  await cp(
    path.join(repoRoot, 'catalog', 'history'),
    path.join(candidateRoot, 'catalog', 'history'),
    { recursive: true },
  );
  const bundle = await writeLicenseBundle(
    path.join(candidateRoot, 'catalog', 'licenses'),
    rootLicenses,
    { release: nextLock.release },
  );
  await writeFile(
    path.join(candidateRoot, 'catalog', 'skills.lock.json'),
    serialize(nextLock),
  );

  const beforeByPath = new Map(lock.skills.map((skill) => [skill.path, skill]));
  const afterByPath = new Map(nextLock.skills.map((skill) => [skill.path, skill]));
  for (const skillPath of changedPaths) {
    const { fileName, content } = await readHistoryDoc(repoRoot, skillPath);
    const next = appendLicenseRefreshHistory(content, {
      release: nextLock.release,
      before: beforeByPath.get(skillPath),
      after: afterByPath.get(skillPath),
    });
    await writeFile(
      path.join(candidateRoot, 'catalog', 'history', fileName),
      serialize(next),
    );
  }

  await writeFile(
    path.join(candidateRoot, 'NOTICE'),
    renderNotice(nextLock, { licenseBundle: bundle }),
  );
  const readmeText = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
  await writeFile(
    path.join(candidateRoot, 'README.md'),
    renderReadme(readmeText, nextLock),
  );
  return bundle;
}

async function assertLicenseRefreshCandidate({
  repoRoot,
  candidateRoot,
  nextLock,
}) {
  const evidenceErrors = nextLock.skills.flatMap((skill) =>
    collectLicenseEvidenceErrors(skill),
  );
  if (evidenceErrors.length > 0) {
    throw new BaselineError(
      `License refresh candidate failed evidence validation: ${evidenceErrors.join(' ')}`,
    );
  }

  await assertStructuralIntegrity(repoRoot, nextLock);
  const candidateLock = JSON.parse(
    await readFile(
      path.join(candidateRoot, 'catalog', 'skills.lock.json'),
      'utf8',
    ),
  );
  if (!sameJson(candidateLock, nextLock)) {
    throw new BaselineError('License refresh candidate lock does not match planned state.');
  }
  await validateLicenseBundle(candidateRoot, nextLock);
}

/**
 * Re-resolves every license from pinned evidence without changing skill bytes
 * or per-skill provenance/version fields.
 */
export async function applyLicenseRefresh({
  repoRoot = defaultRepoRoot,
  readGitStatus = defaultReadGitStatus,
  now = () => new Date().toISOString(),
  runGit,
  validate = validateRepository,
  afterCleanCheck,
  afterBackupMove,
} = {}) {
  const absoluteRepoRoot = path.resolve(repoRoot);
  const { commonGitDir } = await resolveGitDirectories(absoluteRepoRoot);
  const journalPath = path.join(commonGitDir, TRANSACTION_JOURNAL_FILE);
  let applyLock;
  let workRoot;
  let transaction;
  let journalRenamer;
  let preserveWorkRoot = false;

  try {
    applyLock = await acquireApplyLock(commonGitDir);
    journalRenamer = createJournalRenamer();
    await recoverPendingTransaction(journalPath, {
      renameOp: journalRenamer?.rename.bind(journalRenamer),
    });

    const initialStatus = await readGitStatus(absoluteRepoRoot);
    if (initialStatus.trim() !== '') {
      throw new BaselineError(
        'Refusing to refresh licenses: the git working tree is not clean. Commit or stash changes first.',
      );
    }

    const manifest = await loadManifest(
      path.join(absoluteRepoRoot, 'catalog', 'sources.yml'),
    );
    const lock = await readLock(absoluteRepoRoot);

    try {
      await assertTagReconciled(lock.release, { runGit: runGit ?? undefined });
    } catch (error) {
      throw new BaselineError(
        `Refusing license refresh: tag/lock reconciliation failed. ${error.message}`,
      );
    }

    for (const skill of lock.skills) {
      if (skill.category === 'mapped' && skill.baseline !== 'verified') {
        throw new BaselineError(
          `Refusing license refresh: mapped skill ${skill.path} is not verified.`,
        );
      }
    }

    workRoot = await createApplyWorkRoot(absoluteRepoRoot, 'license-refresh');
    const backupRoot = path.join(workRoot, 'backup');
    const candidateRoot = path.join(workRoot, 'candidate');
    await mkdir(candidateRoot, { recursive: true });

    const evidence = await resolveAllLicenseMetadata({
      repoRoot: absoluteRepoRoot,
      manifest,
      lock,
      workRoot,
      runGit,
    });
    const preview = buildLicenseRefreshLock({
      lock,
      resolvedByPath: evidence.resolvedByPath,
      release: lock.release,
      generatedAt: lock.generatedAt,
    });

    if (preview.changedPaths.length === 0) {
      await validate(absoluteRepoRoot);
      await assertStructuralIntegrity(absoluteRepoRoot, lock);
      return {
        added: [],
        changed: [],
        removed: [],
        metadataChanged: [],
        metadataChangedCount: 0,
        release: lock.release,
        nextTag: null,
        commitMessage: null,
        evidence: {
          ...evidence.summary,
          licenseCounts: countLicenses(lock),
        },
        applied: false,
      };
    }

    const diffClass = classifyDiff({ metadata: preview.changedPaths });
    const releasePlan = await planRelease({
      diffClass,
      currentVersion: lock.release,
      runGit,
    });
    if (
      lock.release === DEPROPRIETIZE_RELEASE &&
      releasePlan.nextVersion !== LICENSE_REFRESH_RELEASE
    ) {
      throw new BaselineError(
        `Refusing license refresh: metadata patch must produce ${LICENSE_REFRESH_RELEASE}, got ${releasePlan.nextVersion}.`,
      );
    }

    const refreshed = buildLicenseRefreshLock({
      lock,
      resolvedByPath: evidence.resolvedByPath,
      release: releasePlan.nextVersion,
      generatedAt: now(),
    });
    const nextLock = refreshed.lock;
    await buildLicenseRefreshCandidate({
      repoRoot: absoluteRepoRoot,
      candidateRoot,
      lock,
      nextLock,
      changedPaths: refreshed.changedPaths,
      rootLicenses: evidence.rootLicenses,
    });

    await validate(absoluteRepoRoot);
    await assertLicenseRefreshCandidate({
      repoRoot: absoluteRepoRoot,
      candidateRoot,
      nextLock,
    });

    const expectedSnapshots = await snapshotSwapTargets(
      absoluteRepoRoot,
      LICENSE_REFRESH_SWAP_TARGETS,
    );
    transaction = buildTransaction({
      repoRoot: absoluteRepoRoot,
      candidateRoot,
      backupRoot,
      workRoot,
      journalPath,
      renameOp: journalRenamer?.rename.bind(journalRenamer),
      targetRenameOp: journalRenamer?.rename.bind(journalRenamer) ?? durableTargetRename,
      expectedSnapshots,
      targets: LICENSE_REFRESH_SWAP_TARGETS,
    });

    const placed = await swapInCandidate(
      absoluteRepoRoot,
      candidateRoot,
      backupRoot,
      {
        transaction,
        beforeFirstDestructiveMove: () =>
          assertUnchangedGitState(absoluteRepoRoot, initialStatus, readGitStatus),
        afterCleanCheck,
        afterBackupMove,
      },
    );

    try {
      await validate(absoluteRepoRoot);
      await assertStructuralIntegrity(absoluteRepoRoot, nextLock);
    } catch (error) {
      try {
        await rollbackSwap(absoluteRepoRoot, backupRoot, placed, {
          renameOp: transaction.targetRenameOp,
        });
      } catch (rollbackError) {
        const wrapped = new BaselineError(
          `License refresh validation failed and rollback also failed. ` +
            `Backup data preserved at ${backupRoot}. Validation error: ${error.message}. ` +
            `Rollback error: ${rollbackError.message}`,
        );
        wrapped.backupPath = backupRoot;
        wrapped.rollbackFailed = true;
        throw wrapped;
      }
      throw new BaselineError(
        `License refresh post-apply validation failed; rolled back. ${error.message}`,
      );
    }

    await completeTransaction(transaction);
    transaction = null;

    return {
      added: [],
      changed: [],
      removed: [],
      metadataChanged: refreshed.changedPaths,
      metadataChangedCount: refreshed.changedPaths.length,
      release: releasePlan.nextVersion,
      nextTag: releasePlan.nextTag,
      commitMessage: LICENSE_REFRESH_COMMIT_MESSAGE,
      evidence: {
        ...evidence.summary,
        licenseCounts: countLicenses(nextLock),
      },
      applied: true,
    };
  } catch (error) {
    if (error.rollbackFailed) {
      preserveWorkRoot = true;
    } else if (transaction) {
      try {
        await recoverPendingTransaction(journalPath, {
          renameOp: journalRenamer?.rename.bind(journalRenamer),
        });
        transaction = null;
      } catch (recoveryError) {
        preserveWorkRoot = true;
        const wrapped = new BaselineError(
          `License refresh failed and transaction recovery also failed. ` +
            `Journal preserved at ${journalPath}. Original error: ${error.message}. ` +
            `Recovery error: ${recoveryError.message}`,
        );
        wrapped.recoveryFailed = true;
        throw wrapped;
      }
    }
    throw error;
  } finally {
    journalRenamer?.close();
    if (!preserveWorkRoot && workRoot) {
      await rm(workRoot, { recursive: true, force: true });
    }
    if (applyLock) {
      await applyLock.release();
    }
  }
}

/**
 * Removes the four unpublished proprietary mirrors through the shared atomic
 * transaction. This one-time migration intentionally does not reconcile tags:
 * v1.1.0 was never published, and v2.0.0 is the first publishable release.
 */
export async function applyDeproprietize({
  repoRoot = defaultRepoRoot,
  deproprietize = false,
  readGitStatus = defaultReadGitStatus,
  now = () => new Date().toISOString(),
  validate = validateRepository,
  afterCleanCheck,
  afterBackupMove,
} = {}) {
  if (deproprietize !== true) {
    throw new BaselineError(
      'Refusing to apply: deproprietize mode must be explicitly enabled.',
    );
  }

  const absoluteRepoRoot = path.resolve(repoRoot);
  const { commonGitDir } = await resolveGitDirectories(absoluteRepoRoot);
  const journalPath = path.join(commonGitDir, TRANSACTION_JOURNAL_FILE);
  let applyLock;
  let workRoot;
  let transaction;
  let journalRenamer;
  let preserveWorkRoot = false;

  try {
    applyLock = await acquireApplyLock(commonGitDir);
    journalRenamer = createJournalRenamer();
    await recoverPendingTransaction(journalPath, {
      renameOp: journalRenamer?.rename.bind(journalRenamer),
    });

    const initialStatus = await readGitStatus(absoluteRepoRoot);
    if (initialStatus.trim() !== '') {
      throw new BaselineError(
        'Refusing to apply deproprietize migration: the git working tree is not clean. Commit or stash changes first.',
      );
    }

    const manifest = await loadManifest(
      path.join(absoluteRepoRoot, 'catalog', 'sources.yml'),
    );
    const protectedRoots = assertMappingsWritable(manifest);
    const lock = await readLock(absoluteRepoRoot);
    assertDeproprietizePreconditions({ lock, manifest });
    await assertDeproprietizeHistory(absoluteRepoRoot, lock);

    for (const skillPath of DEPROPRIETIZE_PATHS) {
      assertWritableSkillPath(skillPath, protectedRoots);
      try {
        await readFile(
          path.join(absoluteRepoRoot, ...skillPath.split('/'), 'SKILL.md'),
          'utf8',
        );
      } catch {
        throw new BaselineError(
          `Refusing deproprietize migration: live skill directory is missing for ${skillPath}.`,
        );
      }
    }

    const removedSet = new Set(DEPROPRIETIZE_PATHS);
    const nextManifest = {
      ...manifest,
      mappings: manifest.mappings.filter(
        (mapping) => !removedSet.has(mapping.path),
      ),
    };
    const guardrail = evaluateDeletionGuards(
      buildDeletionGroups({ manifest: nextManifest, lock }),
    );
    if (guardrail.blocked) {
      throw new BaselineError(
        'Refusing deproprietize migration: deletion guardrail blocked the four declared removals.',
      );
    }

    const anthropicsGuard = guardrail.groups.find(
      (group) => group.upstream === 'anthropics',
    );
    if (
      !anthropicsGuard ||
      anthropicsGuard.declared !== 17 ||
      anthropicsGuard.removed !== 4
    ) {
      throw new BaselineError(
        `Refusing deproprietize migration: expected anthropics deletion guard inventory 4/17, got ` +
          `${anthropicsGuard?.removed ?? 'missing'}/${anthropicsGuard?.declared ?? 'missing'}.`,
      );
    }

    workRoot = await createApplyWorkRoot(absoluteRepoRoot, 'deproprietize');
    const backupRoot = path.join(workRoot, 'backup');
    const candidateRoot = path.join(workRoot, 'candidate');
    await mkdir(candidateRoot, { recursive: true });

    const nextLock = await buildDeproprietizeCandidate({
      repoRoot: absoluteRepoRoot,
      candidateRoot,
      lock,
      generatedAt: now(),
    });

    await validate(candidateRoot);
    await assertStructuralIntegrity(candidateRoot, nextLock);

    const expectedSnapshots = await snapshotSwapTargets(absoluteRepoRoot);
    transaction = buildTransaction({
      repoRoot: absoluteRepoRoot,
      candidateRoot,
      backupRoot,
      workRoot,
      journalPath,
      renameOp: journalRenamer?.rename.bind(journalRenamer),
      targetRenameOp:
        journalRenamer?.rename.bind(journalRenamer) ?? durableTargetRename,
      expectedSnapshots,
    });

    const placed = await swapInCandidate(
      absoluteRepoRoot,
      candidateRoot,
      backupRoot,
      {
        transaction,
        beforeFirstDestructiveMove: () =>
          assertUnchangedGitState(
            absoluteRepoRoot,
            initialStatus,
            readGitStatus,
          ),
        afterCleanCheck,
        afterBackupMove,
      },
    );

    try {
      await validate(absoluteRepoRoot);
      await assertStructuralIntegrity(absoluteRepoRoot, nextLock);
    } catch (error) {
      try {
        await rollbackSwap(absoluteRepoRoot, backupRoot, placed, {
          renameOp: transaction.targetRenameOp,
        });
      } catch (rollbackError) {
        const wrapped = new BaselineError(
          `Deproprietize post-apply validation failed and rollback also failed. ` +
            `Backup data preserved at ${backupRoot}. Validation error: ${error.message}. ` +
            `Rollback error: ${rollbackError.message}`,
        );
        wrapped.backupPath = backupRoot;
        wrapped.rollbackFailed = true;
        throw wrapped;
      }
      throw new BaselineError(
        `Deproprietize post-apply validation failed; rolled back. ${error.message}`,
      );
    }

    await completeTransaction(transaction);
    transaction = null;

    return {
      removed: [...DEPROPRIETIZE_PATHS],
      release: DEPROPRIETIZE_RELEASE,
      nextTag: `v${DEPROPRIETIZE_RELEASE}`,
      commitMessage: DEPROPRIETIZE_COMMIT_MESSAGE,
      counts: nextLock.counts,
      guardrail: anthropicsGuard,
      applied: true,
    };
  } catch (error) {
    if (error.rollbackFailed) {
      preserveWorkRoot = true;
    } else if (transaction) {
      try {
        await recoverPendingTransaction(journalPath, {
          renameOp: journalRenamer?.rename.bind(journalRenamer),
        });
        transaction = null;
      } catch (recoveryError) {
        preserveWorkRoot = true;
        const wrapped = new BaselineError(
          `Deproprietize migration failed and transaction recovery also failed. ` +
            `Journal preserved at ${journalPath}. Original error: ${error.message}. ` +
            `Recovery error: ${recoveryError.message}`,
        );
        wrapped.recoveryFailed = true;
        throw wrapped;
      }
    }
    throw error;
  } finally {
    journalRenamer?.close();
    if (!preserveWorkRoot && workRoot) {
      await rm(workRoot, { recursive: true, force: true });
    }
    if (applyLock) {
      await applyLock.release();
    }
  }
}

/**
 * Applies upstream updates to an already-verified baseline.
 *
 * This is the daily cron engine. It refuses unless the working tree is clean
 * and every mapped skill has `baseline === "verified"`. It detects changes by
 * comparing pre-stamp content hashes AND by diffing the manifest mapping set
 * against the mapped paths recorded in the lockfile:
 *
 *  - A mapping present in the manifest but absent from the lock is adopted from
 *    the verified staged copy at version 1.0.0 and receives a mapping-added
 *    history entry.
 *  - A mapped lock path no longer declared by the manifest is a removal. It runs
 *    through the shared deletion guardrails and, when allowed, is dropped from
 *    the lock, deleted from the candidate tree, and recorded in the history
 *    ledger. Removals classify as `major` via {@link classifyDiff}.
 *
 * If nothing was added, changed, or removed, it returns a no-op result with zero
 * filesystem mutations. The apply is atomic: all-or-nothing swap with full
 * rollback on post-apply validation failure. Never creates commits or tags.
 */
export async function applyUpdate({
  repoRoot = defaultRepoRoot,
  readGitStatus = defaultReadGitStatus,
  now = () => new Date().toISOString(),
  runGit,
  validate = validateRepository,
  afterCleanCheck,
  afterBackupMove,
} = {}) {
  const absoluteRepoRoot = path.resolve(repoRoot);
  const { commonGitDir } = await resolveGitDirectories(absoluteRepoRoot);
  const journalPath = path.join(commonGitDir, TRANSACTION_JOURNAL_FILE);
  let applyLock;
  let workRoot;
  let transaction;
  let journalRenamer;
  let preserveWorkRoot = false;

  try {
    applyLock = await acquireApplyLock(commonGitDir);
    journalRenamer = createJournalRenamer();
    await recoverPendingTransaction(journalPath, {
      renameOp: journalRenamer?.rename.bind(journalRenamer),
    });

    const initialStatus = await readGitStatus(absoluteRepoRoot);
    if (initialStatus.trim() !== '') {
      throw new BaselineError(
        'Refusing to apply update: the git working tree is not clean. Commit or stash changes first.',
      );
    }

    const manifest = await loadManifest(
      path.join(absoluteRepoRoot, 'catalog', 'sources.yml'),
    );

    // Protected-root guard: identical to the dry-run plan, applied here BEFORE
    // any clone, stage, or candidate write so plan and apply can never diverge.
    const protectedRoots = assertMappingsWritable(manifest);

    const lock = await readLock(absoluteRepoRoot);
    assertLicenseEvidenceMigrationComplete(lock);

    // The daily update must never run before the verified baseline exists.
    for (const skill of lock.skills) {
      if (skill.category === 'mapped' && skill.baseline !== 'verified') {
        throw new BaselineError(
          `Refusing update: mapped skill ${skill.path} has baseline "${skill.baseline}"; all mapped skills must be verified before running daily updates.`,
        );
      }
    }

    // Tag/lock reconciliation guard: the highest tag must match the lock
    // release and be an ancestor of HEAD.
    try {
      await assertTagReconciled(lock.release, { runGit: runGit ?? undefined });
    } catch (error) {
      throw new BaselineError(
        `Refusing update: tag/lock reconciliation failed. ${error.message}`,
      );
    }

    workRoot = await createApplyWorkRoot(absoluteRepoRoot, 'update');
    const backupRoot = path.join(workRoot, 'backup');
    const candidateRoot = path.join(workRoot, 'candidate');
    await mkdir(candidateRoot, { recursive: true });

    const { staged, unavailable, sources } = await stageMappedSkills({
      manifest,
      workRoot,
      runGit,
    });

    // Unavailable upstreams or missing sources are hard blockers — never treat
    // them as deletions.
    if (unavailable.length > 0) {
      const detail = unavailable
        .map((entry) => `${entry.path} (${entry.reason})`)
        .join(', ');
      throw new BaselineError(
        `Refusing update: ${unavailable.length} mapped skill(s) are unavailable: ${detail}.`,
      );
    }

    if (staged.size !== manifest.mappings.length) {
      const stagedPaths = new Set(staged.keys());
      const missing = manifest.mappings
        .map((mapping) => mapping.path)
        .filter((mappingPath) => !stagedPaths.has(mappingPath))
        .sort();

      throw new BaselineError(
        `Refusing update: staged ${staged.size} of ${manifest.mappings.length} mapped skills` +
          `${missing.length > 0 ? ` (missing: ${missing.join(', ')})` : ''}.`,
      );
    }

    // Mapping-set diff: the manifest is the declaration, the lock is the record.
    // Any divergence between them must be surfaced, never silently skipped.
    const lockMappedPaths = lock.skills
      .filter((skill) => skill.category === 'mapped')
      .map((skill) => skill.path);
    const lockMappedSet = new Set(lockMappedPaths);
    const manifestPathSet = new Set(manifest.mappings.map((mapping) => mapping.path));

    const addedMappedPaths = [...manifestPathSet]
      .filter((p) => !lockMappedSet.has(p))
      .sort();
    const lockPathSet = new Set(
      lock.skills
        .filter((skill) => skill.category !== 'removed')
        .map((skill) => skill.path),
    );
    const addedOrphanPaths = manifest.orphans
      .map((orphan) => orphan.path)
      .filter((skillPath) => !lockPathSet.has(skillPath))
      .sort();
    const addedLocalPaths = manifest.localSkillPaths
      .filter((skillPath) => !lockPathSet.has(skillPath))
      .sort();
    const addedPaths = [
      ...addedMappedPaths,
      ...addedOrphanPaths,
      ...addedLocalPaths,
    ].sort();
    const removedPaths = lockMappedPaths.filter((p) => !manifestPathSet.has(p)).sort();
    const removedSet = new Set(removedPaths);

    for (const [category, paths] of [
      ['orphan', addedOrphanPaths],
      ['local', addedLocalPaths],
    ]) {
      for (const skillPath of paths) {
        const skillDir = path.join(absoluteRepoRoot, ...skillPath.split('/'));
        const frontmatter = parseSkillFrontmatter(
          await readFile(path.join(skillDir, 'SKILL.md'), 'utf8'),
          `${skillPath}/SKILL.md`,
        );
        const { license, redistributable, licenseEvidence } = await resolveLicense(
          absoluteRepoRoot,
          skillPath,
          frontmatter,
        );

        staged.set(skillPath, {
          category,
          stageDir: skillDir,
          name: frontmatter.name,
          snapshotHash: await hashDirectory(skillDir),
          license,
          redistributable,
          licenseEvidence,
        });
      }
    }

    // Removals run through the shared deletion guardrails, grouped by the
    // SAME (repository, reference) key the dry-run planner uses, so plan and
    // apply cannot diverge.
    if (removedPaths.length > 0) {
      for (const removedPath of removedPaths) {
        assertWritableSkillPath(removedPath, protectedRoots);
      }

      const verdict = evaluateDeletionGuards(buildDeletionGroups({ manifest, lock }));

      if (verdict.blocked) {
        const detail = verdict.groups
          .filter((group) => group.blocked)
          .map((group) => `${group.upstream}: ${group.status} (${group.removed}/${group.declared})`)
          .join('; ');

        throw new BaselineError(
          `Refusing update: deletion guard blocked ${removedPaths.length} undeclared mapping(s) ` +
            `[${removedPaths.join(', ')}]. ${detail}.`,
        );
      }
    }

    // Change detection: compare pre-stamp contentHash against the lock.
    const changedPaths = [];
    for (const skill of lock.skills) {
      if (skill.category !== 'mapped') continue;
      if (removedSet.has(skill.path)) continue;
      const stagedEntry = staged.get(skill.path);
      if (!stagedEntry) continue;
      const tupleChanged =
        stagedEntry.repository !== skill.upstream?.repository ||
        stagedEntry.reference !== skill.upstream?.reference ||
        stagedEntry.source !== skill.upstream?.source;
      if (stagedEntry.contentHash !== skill.contentHash || tupleChanged) {
        changedPaths.push(skill.path);
      }
    }

    // No-op: nothing changed, return immediately with no filesystem mutation.
    if (addedPaths.length === 0 && changedPaths.length === 0 && removedPaths.length === 0) {
      return {
        added: [],
        changed: [],
        removed: [],
        release: null,
        nextTag: null,
        commitMessage: null,
        applied: false,
      };
    }

    // Plan release from the real diff shape: a removal is always breaking.
    const diffClass = classifyDiff({
      removed: removedPaths,
      added: addedPaths,
      changed: changedPaths,
    });
    const releasePlan = await planRelease({ diffClass, runGit });
    const commitMessage = commitMessageForDiffClass(diffClass);
    const generatedAt = now();

    // Re-stamp adopted and changed skills with their final per-skill version so
    // `x-version` and `snapshotHash` reflect the actual vendored bytes.
    for (const skillPath of [...addedMappedPaths, ...changedPaths]) {
      const stagedEntry = staged.get(skillPath);
      const lockSkill = lock.skills.find(
        (skill) => skill.path === skillPath && skill.category !== 'removed',
      );
      const nextSkillVersion = lockSkill
        ? bumpPatch(lockSkill.version)
        : ADDED_SKILL_VERSION;
      const mapping = manifest.mappings.find((m) => m.path === skillPath);
      const upstreamDef = manifest.upstreams[mapping.upstream];
      const override = manifest.overrides.find((entry) => entry.path === skillPath);

      await transformStaged({
        skillDir: stagedEntry.stageDir,
        skillPath,
        override,
        upstream: upstreamDef,
        source: mapping.source,
        commit: stagedEntry.commit,
        version: nextSkillVersion,
      });

      stagedEntry.snapshotHash = await hashDirectory(stagedEntry.stageDir);
      stagedEntry.name = parseSkillFrontmatter(
        await readFile(path.join(stagedEntry.stageDir, 'SKILL.md'), 'utf8'),
        `${skillPath}/SKILL.md`,
      ).name;
    }

    const nextLock = await buildUpdateCandidate({
      repoRoot: absoluteRepoRoot,
      candidateRoot,
      lock,
      staged,
      addedPaths,
      changedPaths,
      removedPaths,
      release: releasePlan.nextVersion,
      generatedAt,
    });

    // Protected paths must never be written.
    for (const skill of lock.skills) {
      if (skill.category === 'orphan' || skill.category === 'local') {
        await assertUnchanged(absoluteRepoRoot, candidateRoot, skill.path, `${skill.category} skill`);
      }
    }

    const expectedSnapshots = await snapshotSwapTargets(absoluteRepoRoot);
    transaction = buildTransaction({
      repoRoot: absoluteRepoRoot,
      candidateRoot,
      backupRoot,
      workRoot,
      journalPath,
      renameOp: journalRenamer?.rename.bind(journalRenamer),
      targetRenameOp: journalRenamer?.rename.bind(journalRenamer) ?? durableTargetRename,
      expectedSnapshots,
    });

    const placed = await swapInCandidate(absoluteRepoRoot, candidateRoot, backupRoot, {
      transaction,
      beforeFirstDestructiveMove: () =>
        assertUnchangedGitState(absoluteRepoRoot, initialStatus, readGitStatus),
      afterCleanCheck,
      afterBackupMove,
    });

    try {
      await validate(absoluteRepoRoot);
      await assertStructuralIntegrity(absoluteRepoRoot, nextLock);
    } catch (error) {
      try {
        await rollbackSwap(absoluteRepoRoot, backupRoot, placed, {
          renameOp: transaction.targetRenameOp,
        });
      } catch (rollbackError) {
        const wrapped = new BaselineError(
          `Update post-apply validation failed and rollback also failed. ` +
          `Backup data preserved at ${backupRoot}. ` +
          `Validation error: ${error.message}. Rollback error: ${rollbackError.message}`,
        );
        wrapped.backupPath = backupRoot;
        wrapped.rollbackFailed = true;
        throw wrapped;
      }
      throw new BaselineError(`Update post-apply validation failed; rolled back. ${error.message}`);
    }

    await completeTransaction(transaction);
    transaction = null;

    return {
      added: addedPaths,
      changed: changedPaths.sort(),
      removed: removedPaths,
      release: releasePlan.nextVersion,
      nextTag: releasePlan.nextTag,
      commitMessage,
      applied: true,
    };
  } catch (error) {
    if (error.rollbackFailed) {
      preserveWorkRoot = true;
    } else if (transaction) {
      try {
        await recoverPendingTransaction(journalPath, {
          renameOp: journalRenamer?.rename.bind(journalRenamer),
        });
        transaction = null;
      } catch (recoveryError) {
        preserveWorkRoot = true;
        const wrapped = new BaselineError(
          `Update apply failed and transaction recovery also failed. ` +
          `Journal preserved at ${journalPath}. Original error: ${error.message}. ` +
          `Recovery error: ${recoveryError.message}`,
        );
        wrapped.recoveryFailed = true;
        throw wrapped;
      }
    }
    throw error;
  } finally {
    journalRenamer?.close();
    if (!preserveWorkRoot && workRoot) {
      await rm(workRoot, { recursive: true, force: true });
    }
    if (applyLock) {
      await applyLock.release();
    }
  }
}
