import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assertValidEnrichmentArtifact,
  assertValidEnrichmentManifest,
  enrichmentArtifactPath,
  isArtifactFresh,
} from '../../../scripts/lib/enrichment.mjs';
import type {
  EnrichmentArtifact,
  EnrichmentArtifactKind,
  EnrichmentLocale,
  EnrichmentManifest,
  JsonObject,
  LlmLocaleArtifact,
  OpenccLocaleArtifact,
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
};

export interface EnrichmentLoadRequest<TContent extends JsonObject> {
  repoRoot: string;
  kind: EnrichmentArtifactKind;
  skill: LockSkillEntry;
  locale: EnrichmentLocale;
  fallback: TContent;
}

export async function loadEnrichmentLocale<TContent extends JsonObject>({
  repoRoot,
  kind,
  skill,
  locale,
  fallback,
}: EnrichmentLoadRequest<TContent>): Promise<TContent> {
  if (skill.redistributable === false || skill.category === 'removed') {
    return fallback;
  }

  try {
    const manifestPath = path.join(repoRoot, 'catalog', 'enrichment', 'manifest.json');
    const manifest = assertValidEnrichmentManifest(
      JSON.parse(await readFile(manifestPath, 'utf8')),
    );
    if (!manifest.enabled[kind]) {
      return fallback;
    }

    const artifact = assertValidEnrichmentArtifact(
      kind,
      JSON.parse(await readFile(enrichmentArtifactPath(repoRoot, kind, skill.path), 'utf8')),
    ) as EnrichmentArtifact<TContent>;
    if (artifact.path !== skill.path || !isArtifactFresh(kind, artifact, skill)) {
      return fallback;
    }

    return artifact.locales[locale]?.content ?? fallback;
  } catch {
    return fallback;
  }
}
