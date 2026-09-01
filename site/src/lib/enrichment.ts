import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  assertValidEnrichmentArtifact,
  assertValidEnrichmentManifest,
  enrichmentArtifactPath,
  isArtifactFresh,
  validateEnrichmentArtifact,
} from '../../../scripts/lib/enrichment.mjs';
import type {
  EnrichmentArtifact,
  EnrichmentArtifactKind,
  EnrichmentLocale,
  EnrichmentManifest,
  JsonObject,
  LlmLocaleArtifact,
  OpenccLocaleArtifact,
  SkillSummaryContent,
  SkillChangelogContent,
} from '../../../scripts/lib/enrichment.mjs';
import { repositoryWebUrl } from '../../../scripts/lib/git-source.mjs';
import type { LockSkillEntry } from './catalog.ts';

export type {
  EnrichmentArtifact,
  EnrichmentArtifactKind,
  EnrichmentLocale,
  EnrichmentManifest,
  JsonObject,
  LlmLocaleArtifact,
  OpenccLocaleArtifact,
  SkillSummaryContent,
  SkillChangelogContent,
};

export function formatChangelogDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

export type LatestIncludedChangeReason =
  | 'available'
  | 'no-upstream'
  | 'missing-or-stale';

export interface LatestIncludedChange {
  date: string | null;
  reason: LatestIncludedChangeReason;
}

export interface SkillChangelogView {
  content: SkillChangelogContent;
  latestIncludedChange: LatestIncludedChange;
}

export interface EnrichmentLoadRequest<TContent extends JsonObject> {
  repoRoot: string;
  kind: EnrichmentArtifactKind;
  skill: LockSkillEntry;
  locale: EnrichmentLocale;
  fallback: TContent;
  fallbackFromArtifact?: (
    artifact: EnrichmentArtifact<TContent>,
  ) => TContent;
}

function parseJson(text: string, filePath: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SyntaxError(`${filePath} contains invalid JSON: ${detail}`);
  }
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === code
  );
}

function isOnlyMissingLocaleError(
  errors: readonly unknown[],
  locale: EnrichmentLocale,
): boolean {
  if (errors.length !== 1) {
    return false;
  }

  const [error] = errors;
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if (
    !('keyword' in error) ||
    error.keyword !== 'required' ||
    !('instancePath' in error) ||
    error.instancePath !== '/locales' ||
    !('params' in error) ||
    typeof error.params !== 'object' ||
    error.params === null ||
    !('missingProperty' in error.params)
  ) {
    return false;
  }

  return error.params.missingProperty === locale;
}

function isRecoverableGeneratedContentError(
  error: unknown,
  kind: EnrichmentArtifactKind,
  locale: EnrichmentLocale,
): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const instancePath =
    'instancePath' in error && typeof error.instancePath === 'string'
      ? error.instancePath
      : '';
  const keyword =
    'keyword' in error && typeof error.keyword === 'string'
      ? error.keyword
      : '';
  const params =
    'params' in error && typeof error.params === 'object' && error.params !== null
      ? error.params
      : {};
  const contentPath = `/locales/${locale}/content`;
  const isValueError = keyword === 'type' || keyword === 'minLength';

  if (kind === 'summaries') {
    const fields = ['purpose', 'whenToUse', 'outputs'];
    if (
      isValueError &&
      fields.some((field) => instancePath === `${contentPath}/${field}`)
    ) {
      return true;
    }
    return (
      keyword === 'required' &&
      instancePath === contentPath &&
      'missingProperty' in params &&
      fields.includes(String(params.missingProperty))
    );
  }

  if (
    isValueError &&
    new RegExp(`^${contentPath}/commits/\\d+/summary$`).test(instancePath)
  ) {
    return true;
  }
  return (
    keyword === 'required' &&
    new RegExp(`^${contentPath}/commits/\\d+$`).test(instancePath) &&
    'missingProperty' in params &&
    params.missingProperty === 'summary'
  );
}

function hasOnlyRecoverableGeneratedContentErrors(
  errors: readonly unknown[],
  kind: EnrichmentArtifactKind,
  locale: EnrichmentLocale,
): boolean {
  return (
    errors.length > 0 &&
    errors.every((error) =>
      isRecoverableGeneratedContentError(error, kind, locale)
    )
  );
}

function otherwiseValidWithoutRequestedLocale(
  value: object,
  kind: EnrichmentArtifactKind,
  locale: EnrichmentLocale,
): boolean {
  const locales =
    'locales' in value && typeof value.locales === 'object' && value.locales !== null
      ? { ...value.locales }
      : {};
  delete (locales as Record<string, unknown>)[locale];
  const validation = validateEnrichmentArtifact(kind, { ...value, locales });
  return isOnlyMissingLocaleError(validation.errors, locale);
}

function withoutChangelogSummaries(content: SkillChangelogContent): unknown {
  return {
    commits: content.commits.map(({ summary: _summary, ...metadata }) => metadata),
    ...(content.truncatedAt ? { truncatedAt: content.truncatedAt } : {}),
  };
}

function hasSafeChangelogFallbackMetadata(
  artifact: EnrichmentArtifact<SkillChangelogContent>,
  skill: LockSkillEntry,
): boolean {
  if (!skill.upstream || !artifact.locales.en?.content) {
    return false;
  }

  let expectedPrefix: string;
  try {
    expectedPrefix = `${repositoryWebUrl(skill.upstream.repository)}/commit/`;
  } catch {
    return false;
  }
  const localeArtifacts = Object.values(artifact.locales).filter(Boolean);
  const englishMetadata = withoutChangelogSummaries(
    artifact.locales.en.content,
  );

  for (const localeArtifact of localeArtifacts) {
    const content = localeArtifact.content;
    if (!isDeepStrictEqual(withoutChangelogSummaries(content), englishMetadata)) {
      return false;
    }

    let previousTimestamp = Number.POSITIVE_INFINITY;
    for (const commit of content.commits) {
      if (commit.url !== `${expectedPrefix}${commit.sha}`) {
        return false;
      }
      const timestamp = Date.parse(commit.date);
      if (!Number.isFinite(timestamp) || timestamp > previousTimestamp) {
        return false;
      }
      previousTimestamp = timestamp;
    }
  }

  return true;
}

function artifactFallback<TContent extends JsonObject>(
  kind: EnrichmentArtifactKind,
  artifact: EnrichmentArtifact<TContent>,
  skill: LockSkillEntry,
  fallback: TContent,
  fallbackFromArtifact:
    | ((value: EnrichmentArtifact<TContent>) => TContent)
    | undefined,
): TContent {
  if (!fallbackFromArtifact) {
    return fallback;
  }
  if (
    kind === 'changelog' &&
    !hasSafeChangelogFallbackMetadata(
      artifact as EnrichmentArtifact<SkillChangelogContent>,
      skill,
    )
  ) {
    throw new Error(`Unsafe changelog fallback metadata for ${skill.path}.`);
  }
  return fallbackFromArtifact(artifact);
}

async function readOptionalArtifact(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

function assertArtifactPath(
  value: unknown,
  expectedPath: string,
  artifactPath: string,
): void {
  if (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    typeof value.path === 'string' &&
    value.path !== expectedPath
  ) {
    throw new Error(
      `${artifactPath} declares path ${JSON.stringify(value.path)}, expected ` +
        `${JSON.stringify(expectedPath)}.`,
    );
  }
}

export async function loadEnrichmentLocale<TContent extends JsonObject>({
  repoRoot,
  kind,
  skill,
  locale,
  fallback,
  fallbackFromArtifact,
}: EnrichmentLoadRequest<TContent>): Promise<TContent> {
  if (
    skill.redistributable === false ||
    skill.category === 'removed' ||
    (kind === 'changelog' && skill.upstream === null)
  ) {
    return fallback;
  }

  const manifestPath = path.join(repoRoot, 'catalog', 'enrichment', 'manifest.json');
  const manifest = assertValidEnrichmentManifest(
    parseJson(await readFile(manifestPath, 'utf8'), manifestPath),
  );
  if (!manifest.enabled[kind]) {
    return fallback;
  }

  const artifactPath = enrichmentArtifactPath(repoRoot, kind, skill.path);
  const artifactText = await readOptionalArtifact(artifactPath);
  if (artifactText === null) {
    return fallback;
  }

  const value = parseJson(artifactText, artifactPath);
  assertArtifactPath(value, skill.path, artifactPath);
  const validation = validateEnrichmentArtifact(kind, value);
  const artifact = value as EnrichmentArtifact<TContent>;
  if (!validation.valid) {
    if (isOnlyMissingLocaleError(validation.errors, locale)) {
      if (!isArtifactFresh(kind, artifact, skill)) {
        return fallback;
      }
      return artifactFallback(
        kind,
        artifact,
        skill,
        fallback,
        fallbackFromArtifact,
      );
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      hasOnlyRecoverableGeneratedContentErrors(validation.errors, kind, locale) &&
      otherwiseValidWithoutRequestedLocale(value, kind, locale)
    ) {
      if (!isArtifactFresh(kind, artifact, skill)) {
        return fallback;
      }
      return artifactFallback(
        kind,
        artifact,
        skill,
        fallback,
        fallbackFromArtifact,
      );
    }
    assertValidEnrichmentArtifact(kind, value);
  }

  if (!isArtifactFresh(kind, artifact, skill)) {
    return fallback;
  }

  return artifact.locales[locale]?.content ??
    artifactFallback(kind, artifact, skill, fallback, fallbackFromArtifact);
}

export async function loadSkillChangelog({
  repoRoot,
  skill,
  locale,
}: {
  repoRoot: string;
  skill: LockSkillEntry;
  locale: EnrichmentLocale;
}): Promise<SkillChangelogView | null> {
  if (skill.redistributable === false || skill.category === 'removed') {
    return null;
  }
  if (skill.upstream === null) {
    return {
      content: { commits: [] },
      latestIncludedChange: {
        date: null,
        reason: 'no-upstream',
      },
    };
  }

  const unavailable: SkillChangelogContent = { commits: [] };
  const content = await loadEnrichmentLocale<SkillChangelogContent>({
    repoRoot,
    kind: 'changelog',
    skill,
    locale,
    fallback: unavailable,
    fallbackFromArtifact: locale === 'en'
      ? undefined
      : (artifact) => ({
          commits: artifact.locales.en.content.commits.map((entry) => ({
            ...entry,
            summary: '',
          })),
          ...(artifact.locales.en.content.truncatedAt
            ? { truncatedAt: artifact.locales.en.content.truncatedAt }
            : {}),
        }),
  });

  if (content === unavailable) {
    return {
      content,
      latestIncludedChange: {
        date: null,
        reason: 'missing-or-stale',
      },
    };
  }

  return {
    content,
    latestIncludedChange: {
      date: content.commits[0]?.date ?? null,
      reason: 'available',
    },
  };
}
