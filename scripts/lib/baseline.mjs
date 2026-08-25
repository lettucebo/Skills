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
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
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
import { historyFileName } from './history.mjs';
import { loadManifest } from './manifest.mjs';
import { parseSkillFrontmatter } from './frontmatter.mjs';
import { parseVersion, formatVersion, planRelease, readCurrentVersion, tagExists, assertTagReconciled } from './release.mjs';
import { transformStaged } from '../transform.mjs';
import { renderNotice, renderReadme, serialize } from '../catalog.mjs';
import { validateRepository } from '../validate.mjs';

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
export const APPLY_LOCK_FILE = '.skills-sync-apply.lock';
export const TRANSACTION_JOURNAL_FILE = '.skills-sync-transaction.json';

/**
 * Files and directories the swap replaces atomically. Order is irrelevant to
 * correctness because backups are taken before any placement.
 */
export const SWAP_TARGETS = [
  { rel: 'skills', kind: 'dir' },
  { rel: 'catalog/history', kind: 'dir' },
  { rel: 'catalog/skills.lock.json', kind: 'file' },
  { rel: 'NOTICE', kind: 'file' },
  { rel: 'README.md', kind: 'file' },
];

export class BaselineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BaselineError';
  }
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
      license: skill.license,
      redistributable: skill.redistributable,
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

  return { release, generatedAt, counts: lock.counts, skills };
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

async function syncSwapTargets(rootPath) {
  for (const target of SWAP_TARGETS) {
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
}) {
  return {
    version: 1,
    status: 'swapping',
    repoRoot,
    candidateRoot,
    backupRoot,
    workRoot,
    journalPath,
    renameOp,
    targetRenameOp,
    targets: SWAP_TARGETS.map((target) => ({
      ...target,
      live: path.join(repoRoot, ...target.rel.split('/')),
      backup: path.join(backupRoot, ...target.rel.split('/')),
      candidate: path.join(candidateRoot, ...target.rel.split('/')),
      phase: 'live',
    })),
  };
}

async function writeTransaction(transaction) {
  const { journalPath, renameOp, targetRenameOp, ...content } = transaction;
  await writeAtomicJson(journalPath, content, { renameOp });
}

function assertValidTransaction(transaction, journalPath) {
  if (
    transaction?.version !== 1 ||
    !['swapping', 'validated'].includes(transaction.status) ||
    !Array.isArray(transaction.targets) ||
    transaction.targets.length !== SWAP_TARGETS.length ||
    typeof transaction.repoRoot !== 'string' ||
    typeof transaction.candidateRoot !== 'string' ||
    typeof transaction.backupRoot !== 'string'
  ) {
    throw new BaselineError(
      `Refusing to recover: transaction journal ${journalPath} is malformed. ` +
        'Inspect it and restore the repository from the recorded backup before retrying.',
    );
  }

  for (const [index, target] of SWAP_TARGETS.entries()) {
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

  if (transaction.status !== 'validated') {
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
  await syncSwapTargets(transaction.repoRoot);
  transaction.status = 'validated';
  await writeTransaction(transaction);
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

    for (const mapping of mappings) {
      const sourceAbs = path.join(cloneDir, ...mapping.source.split('/'));
      const sourceStat = await lstatOrNull(sourceAbs);

      if (!sourceStat) {
        unavailable.push({ path: mapping.path, upstream: upstreamName, reason: 'missing-source' });
        continue;
      }

      if (sourceStat.isSymbolicLink()) {
        throw new BaselineError(`Refusing to stage symbolic link: ${sourceAbs}`);
      }

      if (!sourceStat.isDirectory()) {
        // Non-directory upstream sources (e.g. a single command markdown file
        // requiring an unimplemented `command-to-skill` transform) cannot be
        // staged by the directory pipeline. Refuse cleanly so the baseline is
        // all-or-nothing rather than crashing mid-stage.
        unavailable.push({ path: mapping.path, upstream: upstreamName, reason: 'source-not-directory' });
        continue;
      }

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
        commit: clone.commit,
        contentHash,
        snapshotHash,
        stageDir,
        name: stagedFrontmatter.name,
        repository: upstream.repository,
        reference: upstream.reference,
        source: mapping.source,
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
  if (lock.counts.total !== lock.skills.length) {
    throw new BaselineError(
      `Structural smoke failed: lock counts.total ${lock.counts.total} != ${lock.skills.length} skills.`,
    );
  }

  const tallies = { mapped: 0, orphan: 0, local: 0 };
  const names = new Set();

  for (const skill of lock.skills) {
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

  await writeFile(path.join(candidateRoot, 'NOTICE'), renderNotice(nextLock));

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
  } = {},
) {
  const backedUp = [];
  const activeRenameOp = transaction?.targetRenameOp ?? renameOp;

  try {
    if (transaction) {
      await syncSwapTargets(candidateRoot);
    }
    for (const [index, target] of SWAP_TARGETS.entries()) {
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
      await activeRenameOp(original, backup);
      backedUp.push(target);
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

    transaction = buildTransaction({
      repoRoot: absoluteRepoRoot,
      candidateRoot,
      backupRoot,
      workRoot,
      journalPath,
      renameOp: journalRenamer?.rename.bind(journalRenamer),
      targetRenameOp: journalRenamer?.rename.bind(journalRenamer) ?? durableTargetRename,
    });

    const placed = await swapInCandidate(absoluteRepoRoot, candidateRoot, backupRoot, {
      transaction,
      beforeFirstDestructiveMove: () =>
        assertUnchangedGitState(absoluteRepoRoot, initialStatus, readGitStatus),
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

/**
 * Rebuilds the lockfile with only the changed skills updated and the removed
 * mappings dropped.
 *
 * Changed entries get a bumped patch version, updated hashes, commit, and
 * adopted staged name. Entries listed in `removedPaths` are dropped entirely so
 * an undeclared mapping can never survive as a phantom lock entry. Unchanged
 * mapped entries, orphan entries, and local entries pass through untouched.
 * `counts` is always recomputed from the resulting skill list.
 */
export function buildUpdateLock({
  lock,
  staged,
  changedPaths,
  removedPaths = [],
  release,
  generatedAt,
}) {
  const changedSet = new Set(changedPaths);
  const removedSet = new Set(removedPaths);
  const stagedMap = staged instanceof Map ? staged : new Map(Object.entries(staged));

  const skills = lock.skills
    .filter((skill) => !removedSet.has(skill.path))
    .map((skill) => {
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
        license: skill.license,
        redistributable: skill.redistributable,
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

  const counts = { total: skills.length, mapped: 0, orphan: 0, local: 0 };
  for (const skill of skills) {
    counts[skill.category] += 1;
  }

  return { release, generatedAt, counts, skills };
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

  const changedSet = new Set(changedPaths);

  for (const [skillPath, stagedEntry] of staged) {
    if (!changedSet.has(skillPath)) continue;
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
    const lockSkill = lock.skills.find((s) => s.path === skillPath);
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

  for (const skillPath of removedPaths) {
    const lockSkill = lock.skills.find((s) => s.path === skillPath);
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

  await writeFile(path.join(candidateRoot, 'NOTICE'), renderNotice(nextLock));

  const readmeText = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
  await writeFile(path.join(candidateRoot, 'README.md'), renderReadme(readmeText, nextLock));

  return nextLock;
}

/**
 * Applies upstream updates to an already-verified baseline.
 *
 * This is the daily cron engine. It refuses unless the working tree is clean
 * and every mapped skill has `baseline === "verified"`. It detects changes by
 * comparing pre-stamp content hashes AND by diffing the manifest mapping set
 * against the mapped paths recorded in the lockfile:
 *
 *  - A mapping present in the manifest but absent from the lock fails closed:
 *    adopting it requires lock metadata (license, redistributability, history
 *    bootstrap) that only the bootstrap/baseline flow can derive.
 *  - A mapped lock path no longer declared by the manifest is a removal. It runs
 *    through the shared deletion guardrails and, when allowed, is dropped from
 *    the lock, deleted from the candidate tree, and recorded in the history
 *    ledger. Removals classify as `major` via {@link classifyDiff}.
 *
 * If nothing changed and nothing was removed, it returns a no-op result with
 * zero filesystem mutations. The apply is atomic: all-or-nothing swap with full
 * rollback on post-apply validation failure. Never creates commits or tags.
 */
export async function applyUpdate({
  repoRoot = defaultRepoRoot,
  readGitStatus = defaultReadGitStatus,
  now = () => new Date().toISOString(),
  runGit,
  validate = validateRepository,
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

    const addedPaths = [...manifestPathSet].filter((p) => !lockMappedSet.has(p)).sort();
    const removedPaths = lockMappedPaths.filter((p) => !manifestPathSet.has(p)).sort();
    const removedSet = new Set(removedPaths);

    // Fail closed on adoption: a lock entry needs license, redistributability
    // and a bootstrapped history ledger, none of which the daily engine can
    // derive from a staged directory alone.
    if (addedPaths.length > 0) {
      throw new BaselineError(
        `Refusing update: ${addedPaths.length} manifest mapping(s) are absent from the lockfile: ` +
          `${addedPaths.join(', ')}. The daily update engine cannot adopt new mappings because lock ` +
          `metadata (license, redistributable, history bootstrap) is only derived by the baseline ` +
          `flow. Adopt them with \`node scripts/catalog.mjs --bootstrap\` followed by ` +
          `\`node scripts/sync.mjs --baseline\`, then re-run the update.`,
      );
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
    if (changedPaths.length === 0 && removedPaths.length === 0) {
      return {
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

    // Re-stamp changed skills with the correct bumped version so the on-disk
    // `x-version` matches the lock's `version` and `snapshotHash` reflects
    // the actual vendored bytes.
    for (const skillPath of changedPaths) {
      const stagedEntry = staged.get(skillPath);
      const lockSkill = lock.skills.find((s) => s.path === skillPath);
      const nextSkillVersion = bumpPatch(lockSkill.version);
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

    transaction = buildTransaction({
      repoRoot: absoluteRepoRoot,
      candidateRoot,
      backupRoot,
      workRoot,
      journalPath,
      renameOp: journalRenamer?.rename.bind(journalRenamer),
      targetRenameOp: journalRenamer?.rename.bind(journalRenamer) ?? durableTargetRename,
    });

    const placed = await swapInCandidate(absoluteRepoRoot, candidateRoot, backupRoot, {
      transaction,
      beforeFirstDestructiveMove: () =>
        assertUnchangedGitState(absoluteRepoRoot, initialStatus, readGitStatus),
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
