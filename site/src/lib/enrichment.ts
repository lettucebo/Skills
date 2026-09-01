import { readFile } from 'node:fs/promises';
import path from 'node:path';

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

export interface EnrichmentLoadRequest<TContent extends JsonObject> {
  repoRoot: string;
  kind: EnrichmentArtifactKind;
  skill: LockSkillEntry;
  locale: EnrichmentLocale;
  fallback: TContent;
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
  if (!validation.valid) {
    if (isOnlyMissingLocaleError(validation.errors, locale)) {
      return fallback;
    }
    assertValidEnrichmentArtifact(kind, value);
  }

  const artifact = value as EnrichmentArtifact<TContent>;
  if (!isArtifactFresh(kind, artifact, skill)) {
    return fallback;
  }

  return artifact.locales[locale]?.content ?? fallback;
}
