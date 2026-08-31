export type GitNameStatusChange = {
  status: string;
  paths: string[];
};

export type ParsedGitCommit = {
  sha: string;
  date: string;
  subject: string;
  changes: GitNameStatusChange[];
};

export type ResolvedGitCommit = ParsedGitCommit & {
  pathAtCommit: string;
  resolvedVia: 'direct' | 'rename' | 'copy-then-delete-migration';
  transition?: {
    status: string;
    sourcePath: string;
    destinationPath: string;
  };
};

export type SkillHistoryResult = {
  commits: ResolvedGitCommit[];
  truncatedAt?: {
    sha: string;
    sourcePath: string;
    reason: 'copy-source-still-live' | 'restricted-transition-source';
  };
};

export const GIT_LOG_SENTINEL: string;
export const CHANGELOG_PROMPT_ID: string;
export const CHANGELOG_PROMPT: string;
export function buildGitLogArgs(input: {
  pinnedCommit: string;
  sourcePath: string;
}): string[];
export function parseGitLogZ(output: string | Buffer): ParsedGitCommit[];
export function resolveHistoryProvenance(input: {
  commits: ParsedGitCommit[];
  sourcePath: string;
  pinnedCommit: string;
  isCopySourceDeleted(input: {
    transitionSha: string;
    pinnedCommit: string;
    sourcePath: string;
  }): Promise<boolean>;
  blockedSourcePaths?: ReadonlySet<string>;
}): Promise<SkillHistoryResult>;
export function collectSkillHistory(input: {
  repoDir: string;
  pinnedCommit: string;
  sourcePath: string;
  blockedSourcePaths?: ReadonlySet<string>;
  runGit?: (
    args: string[],
    options: { cwd: string },
  ) => Promise<string | Buffer>;
}): Promise<SkillHistoryResult>;
export function parsePatchPaths(patch: string | Buffer): string[];
export function extractScopedPatch(input: {
  repoDir: string;
  sha: string;
  pathAtCommit: string;
  transition?: {
    status: string;
    sourcePath: string;
    destinationPath: string;
  };
  runGit?: (
    args: string[],
    options: { cwd: string },
  ) => Promise<string | Buffer>;
}): Promise<string>;
export function summarizeSkillHistory(input: {
  skill: {
    path: string;
    upstream: {
      repository: string;
      commit: string;
    };
  };
  history: SkillHistoryResult;
  repoDir: string;
  runner: {
    run<T = unknown>(request: {
      instruction: string;
      payload: unknown;
      schema: Record<string, unknown>;
    }): Promise<T>;
  };
  restrictedSourcePaths?: ReadonlySet<string>;
  extractPatch?: typeof extractScopedPatch;
}): Promise<Map<string, { en: string; 'zh-tw': string }>>;
