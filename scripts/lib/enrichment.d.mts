export type EnrichmentArtifactKind = 'summaries' | 'changelog';
export type EnrichmentLocale = 'en' | 'zh-tw' | 'zh-cn';
export type EnrichmentProducer = 'llm' | 'opencc';
export type JsonObject = Record<string, unknown>;

export interface EnrichmentManifest {
  schemaVersion: 1;
  enabled: Record<EnrichmentArtifactKind, boolean>;
}

export interface SummaryFreshnessKey {
  contentHash: string;
}

export interface ChangelogFreshnessKey extends SummaryFreshnessKey {
  repository: string;
  reference: string;
  source: string;
  pinnedCommit: string;
}

export type ChangelogResolution =
  | 'direct'
  | 'rename'
  | 'copy-then-delete-migration';

export interface ChangelogTransition {
  status: string;
  sourcePath: string;
  destinationPath: string;
}

export interface SkillChangelogCommit {
  sha: string;
  date: string;
  subject: string;
  url: string;
  pathAtCommit: string;
  resolvedVia: ChangelogResolution;
  transition?: ChangelogTransition;
  summary: string;
}

export interface SkillChangelogContent extends JsonObject {
  commits: SkillChangelogCommit[];
  truncatedAt?: {
    sha: string;
    sourcePath: string;
    reason: 'copy-source-still-live' | 'restricted-transition-source';
  };
}

export interface LlmLocaleArtifact<TContent extends JsonObject = JsonObject> {
  signature: string;
  producer: 'llm';
  model: string;
  promptHash: string;
  generatorVersion: number;
  content: TContent;
}

export interface OpenccLocaleArtifact<TContent extends JsonObject = JsonObject> {
  signature: string;
  producer: 'opencc';
  converterVersion: string;
  generatorVersion: number;
  content: TContent;
}

export interface EnrichmentArtifact<TContent extends JsonObject = JsonObject> {
  path: string;
  schemaVersion: 1;
  freshnessKey: SummaryFreshnessKey | ChangelogFreshnessKey;
  locales: {
    en: LlmLocaleArtifact<TContent>;
    'zh-tw': LlmLocaleArtifact<TContent>;
    'zh-cn': OpenccLocaleArtifact<TContent>;
  };
}

export interface EnrichmentLockUpstream {
  repository: string;
  reference: string;
  source: string;
  commit: string;
}

export interface EnrichmentLockSkill {
  path: string;
  category: string;
  redistributable: boolean;
  snapshotHash: string;
  contentHash?: string;
  upstream: EnrichmentLockUpstream | null;
}

export interface LocaleSignatureInput {
  locale: EnrichmentLocale;
  schemaVersion: number;
  producer: EnrichmentProducer;
  promptId: string;
  promptHash: string;
  model?: string;
  converterVersion?: string;
  generatorVersion: number;
  cliContract: Record<string, unknown>;
}

export const ENRICHMENT_SCHEMA_VERSION: 1;
export const ENRICHMENT_ARTIFACT_KINDS: readonly EnrichmentArtifactKind[];
export const ENRICHMENT_LOCALES: readonly EnrichmentLocale[];
export const ENRICHMENT_ARTIFACT_SCHEMAS: Readonly<
  Record<EnrichmentArtifactKind, Readonly<Record<string, unknown>>>
>;

export function assertSafeEnrichmentSkillPath(skillPath: string): string;
export function enrichmentArtifactPath(
  repoRoot: string,
  kind: EnrichmentArtifactKind,
  skillPath: string,
): string;
export function isEligibleForEnrichment(
  kind: EnrichmentArtifactKind,
  skill: EnrichmentLockSkill,
): boolean;
export function createArtifactFreshnessKey(
  kind: 'summaries',
  skill: EnrichmentLockSkill,
): SummaryFreshnessKey;
export function createArtifactFreshnessKey(
  kind: 'changelog',
  skill: EnrichmentLockSkill,
): ChangelogFreshnessKey;
export function createArtifactFreshnessKey(
  kind: EnrichmentArtifactKind,
  skill: EnrichmentLockSkill,
): SummaryFreshnessKey | ChangelogFreshnessKey;
export function isArtifactFresh(
  kind: EnrichmentArtifactKind,
  artifact: EnrichmentArtifact,
  skill: EnrichmentLockSkill,
): boolean;
export function createLocaleSignature(input: LocaleSignatureInput): string;
export function validateEnrichmentArtifact(
  kind: EnrichmentArtifactKind,
  value: unknown,
): { valid: boolean; errors: readonly unknown[] };
export function assertValidEnrichmentArtifact(
  kind: EnrichmentArtifactKind,
  value: unknown,
  label?: string,
): EnrichmentArtifact;
export function assertValidEnrichmentManifest(value: unknown): EnrichmentManifest;
