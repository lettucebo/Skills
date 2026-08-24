import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Marked } from 'marked';

// ─── Site Configuration ─────────────────────────────────────────────

export const RELEASE_VERSION = '1.1.0';
export const RELEASE_PUBLISHED = false;
export const REPO_OWNER = 'lettucebo';
export const REPO_NAME = 'Skills';

export const RESTRICTED_PATHS = new Set([
  'skills/claude/docx',
  'skills/claude/pdf',
  'skills/claude/pptx',
  'skills/claude/xlsx',
]);

// ─── Types ──────────────────────────────────────────────────────────

export interface LockUpstream {
  repository: string;
  reference: string;
  source: string;
  commit: string;
}

export interface LockSkillEntry {
  path: string;
  name: string;
  category: string;
  version: string;
  baseline: string | null;
  license: string;
  redistributable: boolean;
  snapshotHash: string;
  contentHash?: string;
  upstream: LockUpstream | null;
}

export interface LockFile {
  release: string;
  generatedAt: string;
  counts: {
    total: number;
    mapped: number;
    orphan: number;
    local: number;
  };
  skills: LockSkillEntry[];
}

export interface HistoryEntry {
  release: string;
  kind: string;
  version: string;
  firstSeen?: string;
  upstreamCommit?: string | null;
  diffUrl?: string | null;
  snapshotHash?: string;
  contentHash?: string;
}

export interface SkillHistory {
  path: string;
  name: string;
  category: string;
  entries: HistoryEntry[];
}

export interface SkillViewModel {
  name: string;
  path: string;
  source: string;
  slug: string;
  category: string;
  isMapped: boolean;
  isOrphan: boolean;
  isLocal: boolean;
  isRestricted: boolean;
  isTombstone: boolean;
  statusLabel: string;
  version: string;
  baseline: string | null;
  license: string;
  upstreamRepo: string | null;
  upstreamCommit: string | null;
  upstreamSource: string | null;
  upstreamReference: string | null;
  description?: string;
  body?: string;
  history?: HistoryEntry[];
}

export interface CatalogData {
  release: string;
  skills: SkillViewModel[];
  sources: string[];
  counts: CatalogCounts;
}

export interface CatalogCounts {
  total: number;
  mapped: number;
  orphan: number;
  local: number;
  restricted: number;
}

// ─── Normalization ──────────────────────────────────────────────────

export function deriveSourceFromPath(skillPath: string): string {
  const parts = skillPath.replace(/\\/g, '/').split('/');
  // path format: skills/<source>/<skill-name>
  return parts[1];
}

export function normalizeSkill(entry: LockSkillEntry): SkillViewModel {
  const source = deriveSourceFromPath(entry.path);
  const slug = entry.path.replace(/\\/g, '/').split('/').slice(2).join('/');

  const isMapped = entry.category === 'mapped' && entry.redistributable !== false;
  const isOrphan = entry.category === 'orphan';
  const isLocal = entry.category === 'local';
  const isRestricted = entry.redistributable === false;
  const isTombstone = entry.category === 'removed';

  let statusLabel: string;
  if (isRestricted) statusLabel = 'Restricted';
  else if (isTombstone) statusLabel = 'Removed';
  else if (isOrphan) statusLabel = 'Frozen';
  else if (isLocal) statusLabel = 'Local';
  else statusLabel = 'Synced';

  return {
    name: entry.name,
    path: entry.path,
    source,
    slug,
    category: entry.category,
    isMapped: entry.category === 'mapped' && !isRestricted,
    isOrphan,
    isLocal,
    isRestricted,
    isTombstone,
    statusLabel,
    version: entry.version,
    baseline: entry.baseline,
    license: entry.license,
    upstreamRepo: entry.upstream?.repository ?? null,
    upstreamCommit: entry.upstream?.commit ?? null,
    upstreamSource: entry.upstream?.source ?? null,
    upstreamReference: entry.upstream?.reference ?? null,
  };
}

export function computeCounts(skills: SkillViewModel[]): CatalogCounts {
  return {
    total: skills.filter((s) => !s.isTombstone).length,
    mapped: skills.filter((s) => s.category === 'mapped').length,
    orphan: skills.filter((s) => s.isOrphan).length,
    local: skills.filter((s) => s.isLocal).length,
    restricted: skills.filter((s) => s.isRestricted).length,
  };
}

// ─── Route helpers ──────────────────────────────────────────────────

export function deriveRouteParams(skill: SkillViewModel): { source: string; skill: string } {
  return { source: skill.source, skill: skill.slug };
}

// ─── Install commands ───────────────────────────────────────────────

export function generateRepoInstallCommand(): string {
  return `npx skills add ${REPO_OWNER}/${REPO_NAME}#v${RELEASE_VERSION}`;
}

export function generateSourceInstallCommand(source: string): string | null {
  if (sourceContainsRestricted(source)) {
    return null;
  }
  return `npx skills add ${REPO_OWNER}/${REPO_NAME}/skills/${source}#v${RELEASE_VERSION}`;
}

export function generateSingleSkillInstallCommand(
  name: string,
  restricted: boolean = false,
): string | null {
  if (restricted) {
    return null;
  }
  return `npx skills add "${REPO_OWNER}/${REPO_NAME}#v${RELEASE_VERSION}@${name}"`;
}

export function sourceContainsRestricted(source: string): boolean {
  for (const restrictedPath of RESTRICTED_PATHS) {
    if (restrictedPath.startsWith(`skills/${source}/`)) {
      return true;
    }
  }
  return false;
}

// ─── Markdown rendering ─────────────────────────────────────────────

const marked = new Marked({
  renderer: {
    html(_token) {
      // Strip all raw HTML to prevent XSS
      return '';
    },
  },
});

export function renderMarkdownBody(markdown: string): string {
  const result = marked.parse(markdown);
  if (typeof result === 'string') {
    return result;
  }
  // Should not happen with sync parse, but handle gracefully
  return '';
}

// ─── SKILL.md parsing ───────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)/;

export function parseSkillMd(
  content: string,
): { description: string; body: string } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { description: '', body: content };
  }

  const frontmatterBlock = match[1];
  const body = (match[2] ?? '').trim();

  // Simple YAML parsing for description field
  const descMatch = frontmatterBlock.match(
    /^description:\s*["']?([\s\S]*?)["']?\s*$/m,
  );
  let description = '';
  if (descMatch) {
    description = descMatch[1].trim();
    // Handle multi-line YAML string
    if (description.startsWith('"') || description.startsWith("'")) {
      description = description.slice(1);
    }
  }

  return { description, body };
}

// ─── Catalog loader ─────────────────────────────────────────────────

export async function loadCatalog(repoRoot: string): Promise<CatalogData> {
  const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
  const lockText = await readFile(lockPath, 'utf8');
  const lock: LockFile = JSON.parse(lockText);

  const skills = lock.skills.map(normalizeSkill);
  const sources = [...new Set(skills.map((s) => s.source))].sort();
  const counts = computeCounts(skills);

  return {
    release: lock.release,
    skills,
    sources,
    counts,
  };
}

export async function loadSkillBody(
  repoRoot: string,
  skill: SkillViewModel,
): Promise<{ description: string; renderedBody: string } | null> {
  // Security: NEVER read SKILL.md for restricted skills
  if (skill.isRestricted) {
    return null;
  }

  if (skill.isTombstone) {
    return null;
  }

  const skillMdPath = path.join(repoRoot, skill.path, 'SKILL.md');
  try {
    const content = await readFile(skillMdPath, 'utf8');
    const parsed = parseSkillMd(content);
    const renderedBody = renderMarkdownBody(parsed.body);
    return { description: parsed.description, renderedBody };
  } catch {
    return null;
  }
}

export async function loadSkillHistory(
  repoRoot: string,
  skill: SkillViewModel,
): Promise<HistoryEntry[]> {
  const historyKey = skill.path.replace(/\//g, '__');
  const historyPath = path.join(
    repoRoot,
    'catalog',
    'history',
    `${historyKey}.json`,
  );

  try {
    const content = await readFile(historyPath, 'utf8');
    const history: SkillHistory = JSON.parse(content);
    return history.entries ?? [];
  } catch {
    return [];
  }
}

// ─── Source-level helpers ────────────────────────────────────────────

export function getSkillsBySource(
  skills: SkillViewModel[],
  source: string,
): SkillViewModel[] {
  return skills.filter((s) => s.source === source && !s.isTombstone);
}

export function getUpstreamRepoForSource(
  skills: SkillViewModel[],
  source: string,
): string | null {
  const mapped = skills.find((s) => s.source === source && s.upstreamRepo);
  return mapped?.upstreamRepo ?? null;
}
