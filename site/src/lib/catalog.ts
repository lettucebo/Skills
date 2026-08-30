import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import { parse as parseYaml } from 'yaml';
import { escapeHtmlAttribute, isSafeUrl } from './url-policy.ts';

// ─── Site Configuration ─────────────────────────────────────────────

export const REPO_OWNER = 'lettucebo';
export const REPO_NAME = 'Skills';

/**
 * Walks up from the current working directory until `catalog/skills.lock.json`
 * is found. `astro build`, `astro preview` and `node --test` all run with the
 * site directory as cwd, while ad-hoc tooling may run from the repository root;
 * both resolve to the same root here.
 *
 * Deliberately NOT based on `import.meta.url`: Astro bundles this module into
 * `dist/chunks/*` for the SSG pass, where the module URL no longer describes
 * the source tree layout.
 */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);

  for (;;) {
    if (existsSync(path.join(dir, 'catalog', 'skills.lock.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `Could not locate catalog/skills.lock.json above ${path.resolve(start)}`,
  );
}

/**
 * The release the site describes is the release recorded in the lock file.
 * Reading it here means a sync that bumps `catalog/skills.lock.json` also moves
 * every rendered version badge and install command, with no second edit.
 */
function readLockRelease(): string {
  const lockPath = path.join(findRepoRoot(), 'catalog', 'skills.lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as LockFile;

  if (typeof lock.release !== 'string' || lock.release === '') {
    throw new Error(`${lockPath} does not declare a release`);
  }

  return lock.release;
}

export const RELEASE_VERSION = readLockRelease();

/**
 * Publication is a build-time input, not a property of the repository content:
 * the lock file records which release the tree *is*, and the `RELEASE_PUBLISHED`
 * input records whether `v<release>` has actually been tagged and pushed.
 *
 * Only the exact string `'true'` enables published mode, so an unset, empty or
 * malformed value always degrades to the safe "pending" rendering. The site
 * never queries the network at runtime; the deploy workflow resolves the tag
 * and passes the answer in.
 */
export function parseReleasePublished(value: string | undefined): boolean {
  return value === 'true';
}

export const RELEASE_PUBLISHED = parseReleasePublished(process.env.RELEASE_PUBLISHED);

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
  generatedAt: string;
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

export interface BaselineVerification {
  mapped: number;
  verified: number;
  unverified: number;
  allVerified: boolean;
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
    restricted: getRestrictedSkills(skills).length,
  };
}

export interface StatusPartition {
  total: number;
  synced: number;
  frozen: number;
  local: number;
  restricted: number;
}

/**
 * Partitions the catalog exactly the way the badges and the origin filter do:
 * restricted wins over frozen, frozen over local, everything else is synced.
 *
 * `counts.mapped` deliberately still counts every mapped lock entry (including
 * restricted ones) for the status page; this partition is what the homepage
 * summary line must use, because its buckets have to be disjoint and sum to the
 * catalog total.
 */
export function computeStatusPartition(skills: SkillViewModel[]): StatusPartition {
  const partition: StatusPartition = {
    total: 0,
    synced: 0,
    frozen: 0,
    local: 0,
    restricted: 0,
  };

  for (const skill of skills) {
    if (skill.isTombstone) continue;

    partition.total += 1;

    if (skill.isRestricted) partition.restricted += 1;
    else if (skill.isOrphan) partition.frozen += 1;
    else if (skill.isLocal) partition.local += 1;
    else partition.synced += 1;
  }

  return partition;
}

/**
 * Baseline verification is reported from the lock file itself rather than
 * assumed: a mapped skill only counts as verified when its recorded baseline
 * says so, so a partially verified release reports the real ratio.
 */
export function computeBaselineVerification(
  skills: SkillViewModel[],
): BaselineVerification {
  const mapped = skills.filter((s) => s.category === 'mapped');
  const verified = mapped.filter((s) => s.baseline === 'verified');

  return {
    mapped: mapped.length,
    verified: verified.length,
    unverified: mapped.length - verified.length,
    allVerified: mapped.length > 0 && verified.length === mapped.length,
  };
}

/**
 * Renders the verification ratio and a matching summary sentence. The sentence
 * has to stay true when the lock is only partially verified, so it is derived
 * rather than asserted.
 */
export function formatBaselineVerification(
  verification: BaselineVerification,
): { headline: string; detail: string } {
  const headline = `${verification.verified}/${verification.mapped}`;

  if (verification.mapped === 0) {
    return { headline, detail: 'This release contains no mapped skills.' };
  }

  if (verification.allVerified) {
    return {
      headline,
      detail:
        'All mapped skills are synced against their upstream repositories with verified content hashes.',
    };
  }

  const noun = verification.unverified === 1 ? 'mapped skill does' : 'mapped skills do';
  return {
    headline,
    detail: `${verification.unverified} ${noun} not have a verified baseline in the current lock file.`,
  };
}

// ─── Restricted inventory (single source of truth: the lock file) ────

/**
 * The restricted inventory is derived from `redistributable === false` in the
 * lock file. Nothing else may enumerate restricted skills, so a skill that
 * becomes non-redistributable upstream is suppressed everywhere automatically.
 * Tombstones are excluded: a removed skill is no longer shipped, so it neither
 * ships restricted content nor justifies suppressing a bulk install.
 */
export function getRestrictedSkills(skills: SkillViewModel[]): SkillViewModel[] {
  return skills.filter((s) => s.isRestricted && !s.isTombstone);
}

export function getRestrictedPaths(skills: SkillViewModel[]): string[] {
  return getRestrictedSkills(skills)
    .map((s) => s.path)
    .sort();
}

export function getRestrictedSources(skills: SkillViewModel[]): string[] {
  return [...new Set(getRestrictedSkills(skills).map((s) => s.source))].sort();
}

export function sourceContainsRestricted(
  skills: SkillViewModel[],
  source: string,
): boolean {
  return getRestrictedSkills(skills).some((s) => s.source === source);
}

// ─── Route helpers ──────────────────────────────────────────────────

export function deriveRouteParams(skill: SkillViewModel): { source: string; skill: string } {
  return { source: skill.source, skill: skill.slug };
}

// ─── Install commands ───────────────────────────────────────────────

export function generateRepoInstallCommand(): string {
  return `npx skills add ${REPO_OWNER}/${REPO_NAME}#v${RELEASE_VERSION} --full-depth`;
}

export function generateSourceInstallCommand(
  skills: SkillViewModel[],
  source: string,
): string | null {
  if (sourceContainsRestricted(skills, source)) {
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
  return `npx skills add "${REPO_OWNER}/${REPO_NAME}#v${RELEASE_VERSION}@${name}" --full-depth`;
}

// ─── Markdown rendering ─────────────────────────────────────────────

const marked = new Marked({
  renderer: {
    html(_token) {
      // Strip all raw HTML to prevent XSS
      return '';
    },

    /**
     * Markdown link syntax can still express a dangerous URL even with raw HTML
     * stripped. Rejected links degrade to their visible text with no anchor.
     */
    link(token) {
      const text = this.parser.parseInline(token.tokens);

      if (!isSafeUrl(token.href)) {
        return text;
      }

      let out = `<a href="${escapeHtmlAttribute(token.href)}"`;
      if (token.title) {
        out += ` title="${escapeHtmlAttribute(token.title)}"`;
      }
      return `${out}>${text}</a>`;
    },

    /**
     * Rejected images degrade to their alt text with no image element. The alt
     * text is always escaped: Marked resolves it through the text renderer,
     * which returns raw (unescaped) inline HTML and would otherwise break out
     * of the `alt` attribute.
     */
    image(token) {
      const rawAlt = token.tokens
        ? this.parser.parseInline(token.tokens, this.parser.textRenderer)
        : token.text;
      const alt = escapeHtmlAttribute(rawAlt ?? '');

      if (!isSafeUrl(token.href)) {
        return alt;
      }

      let out = `<img src="${escapeHtmlAttribute(token.href)}" alt="${alt}"`;
      if (token.title) {
        out += ` title="${escapeHtmlAttribute(token.title)}"`;
      }
      return `${out}>`;
    },
  },
});

/**
 * Markdown tables are laid out at their min-content width, which overflows a
 * 375px viewport on table-heavy skill pages. Each table is wrapped in a
 * focusable scroll container so the horizontal scrolling stays local to the
 * table instead of the document. The `<table>` element is left untouched, so
 * its implicit ARIA role, rows, and cells all survive.
 *
 * Marked emits bare `<table>` tags and markdown cannot nest tables, so a
 * non-greedy match over the rendered output is unambiguous.
 */
const RENDERED_TABLE_RE = /<table>[\s\S]*?<\/table>/g;

function wrapTablesForMobileScrolling(html: string): string {
  return html.replace(
    RENDERED_TABLE_RE,
    (table) =>
      `<div class="table-scroll" role="region" aria-label="Table" tabindex="0">${table}</div>`,
  );
}

export function renderMarkdownBody(markdown: string): string {
  const result = marked.parse(markdown);
  if (typeof result === 'string') {
    return wrapTablesForMobileScrolling(result);
  }
  // Should not happen with sync parse, but handle gracefully
  return '';
}

// ─── SKILL.md parsing ───────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)/;

/**
 * Splits a SKILL.md into its frontmatter description and its body.
 *
 * The frontmatter is parsed with the `yaml` package rather than pattern-matched:
 * a line-scoped regex cannot see past `description: >` / `>-` / `|`, so block
 * scalars used to render as the literal indicator character. Invalid YAML
 * degrades to an empty description instead of throwing, because a single
 * malformed vendored file must never break the whole catalog build.
 */
export function parseSkillMd(
  content: string,
): { description: string; body: string } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { description: '', body: content };
  }

  const frontmatterBlock = match[1];
  const body = (match[2] ?? '').trim();

  let description = '';

  try {
    const parsed = parseYaml(frontmatterBlock);

    if (parsed && typeof parsed === 'object') {
      const raw = (parsed as Record<string, unknown>).description;

      if (typeof raw === 'string') {
        description = raw.trim();
      } else if (raw != null && typeof raw !== 'object') {
        description = String(raw).trim();
      }
    }
  } catch {
    description = '';
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
    generatedAt: lock.generatedAt,
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
