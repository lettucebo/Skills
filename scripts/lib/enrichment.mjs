import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import Ajv from 'ajv';

import { hashJson } from './hash.mjs';
import { historyFileName } from './history.mjs';

export const ENRICHMENT_SCHEMA_VERSION = 1;
export const ENRICHMENT_ARTIFACT_KINDS = Object.freeze(['summaries', 'changelog']);
export const ENRICHMENT_LOCALES = Object.freeze(['en', 'zh-tw', 'zh-cn']);

const HASH_PATTERN = '^sha256:[0-9a-f]{64}$';
const ajv = new Ajv({ allErrors: true, strict: true });

const hashSchema = { type: 'string', pattern: HASH_PATTERN };
const contentSchema = { type: 'object', additionalProperties: true };
const llmLocaleSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'signature',
    'producer',
    'model',
    'promptHash',
    'generatorVersion',
    'content',
  ],
  properties: {
    signature: hashSchema,
    producer: { const: 'llm' },
    model: { type: 'string', minLength: 1 },
    promptHash: hashSchema,
    generatorVersion: { type: 'integer', minimum: 1 },
    content: contentSchema,
  },
};
const openccLocaleSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'signature',
    'producer',
    'converterVersion',
    'generatorVersion',
    'content',
  ],
  properties: {
    signature: hashSchema,
    producer: { const: 'opencc' },
    converterVersion: { type: 'string', minLength: 1 },
    generatorVersion: { type: 'integer', minimum: 1 },
    content: contentSchema,
  },
};

function freshnessSchema(kind) {
  if (kind === 'summaries') {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['contentHash'],
      properties: {
        contentHash: hashSchema,
      },
    };
  }

  return {
    type: 'object',
    additionalProperties: false,
    required: ['contentHash', 'repository', 'reference', 'source', 'pinnedCommit'],
    properties: {
      contentHash: hashSchema,
      repository: { type: 'string', minLength: 1 },
      reference: { type: 'string', minLength: 1 },
      source: { type: 'string', minLength: 1 },
      pinnedCommit: { type: 'string', minLength: 1 },
    },
  };
}

function artifactSchema(kind) {
  return {
    $id: `https://lettucebo.github.io/Skills/schemas/enrichment-${kind}-v1.json`,
    type: 'object',
    additionalProperties: false,
    required: ['path', 'schemaVersion', 'freshnessKey', 'locales'],
    properties: {
      path: { type: 'string', minLength: 1 },
      schemaVersion: { const: ENRICHMENT_SCHEMA_VERSION },
      freshnessKey: freshnessSchema(kind),
      locales: {
        type: 'object',
        additionalProperties: false,
        required: ENRICHMENT_LOCALES,
        properties: {
          en: llmLocaleSchema,
          'zh-tw': llmLocaleSchema,
          'zh-cn': openccLocaleSchema,
        },
      },
    },
  };
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) {
      deepFreeze(nested);
    }
  }
  return value;
}

export const ENRICHMENT_ARTIFACT_SCHEMAS = Object.freeze({
  summaries: deepFreeze(artifactSchema('summaries')),
  changelog: deepFreeze(artifactSchema('changelog')),
});

const artifactValidators = new Map(
  ENRICHMENT_ARTIFACT_KINDS.map((kind) => [
    kind,
    ajv.compile(ENRICHMENT_ARTIFACT_SCHEMAS[kind]),
  ]),
);

const manifestValidator = ajv.compile({
  $id: 'https://lettucebo.github.io/Skills/schemas/enrichment-manifest-v1.json',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'enabled'],
  properties: {
    schemaVersion: { const: ENRICHMENT_SCHEMA_VERSION },
    enabled: {
      type: 'object',
      additionalProperties: false,
      required: ENRICHMENT_ARTIFACT_KINDS,
      properties: {
        summaries: { type: 'boolean' },
        changelog: { type: 'boolean' },
      },
    },
  },
});

function assertArtifactKind(kind) {
  if (!ENRICHMENT_ARTIFACT_KINDS.includes(kind)) {
    throw new TypeError(`Unknown enrichment artifact kind: ${JSON.stringify(kind)}.`);
  }
}

function formatSchemaErrors(errors) {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
}

export function assertSafeEnrichmentSkillPath(skillPath) {
  if (typeof skillPath !== 'string' || skillPath === '') {
    throw new Error('Unsafe enrichment skill path: expected a non-empty string.');
  }
  if (skillPath.includes('\\') || path.posix.isAbsolute(skillPath)) {
    throw new Error(`Unsafe enrichment skill path: ${JSON.stringify(skillPath)}.`);
  }

  const segments = skillPath.split('/');
  if (segments.length < 3 || segments[0] !== 'skills' || segments.some((segment) => segment === '')) {
    throw new Error(`Unsafe enrichment skill path: ${JSON.stringify(skillPath)}.`);
  }

  for (const segment of segments) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(`Unsafe enrichment skill path: ${JSON.stringify(skillPath)}.`);
    }
    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\')
    ) {
      throw new Error(`Unsafe enrichment skill path: ${JSON.stringify(skillPath)}.`);
    }
  }

  if (path.posix.normalize(skillPath) !== skillPath) {
    throw new Error(`Unsafe enrichment skill path: ${JSON.stringify(skillPath)}.`);
  }

  return skillPath;
}

export function enrichmentArtifactPath(repoRoot, kind, skillPath) {
  assertArtifactKind(kind);
  assertSafeEnrichmentSkillPath(skillPath);

  const directory = path.resolve(repoRoot, 'catalog', 'enrichment', kind);
  const artifactPath = path.resolve(directory, historyFileName(skillPath));
  const relative = path.relative(directory, artifactPath);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`Enrichment artifact path escapes ${directory}: ${artifactPath}.`);
  }
  return artifactPath;
}

export function isEligibleForEnrichment(kind, skill) {
  assertArtifactKind(kind);
  if (!skill || skill.category === 'removed' || skill.redistributable === false) {
    return false;
  }
  return kind === 'summaries' || skill.upstream != null;
}

function contentIdentity(skill) {
  const hash = skill.category === 'mapped' ? skill.contentHash : skill.snapshotHash;
  if (typeof hash !== 'string' || !new RegExp(HASH_PATTERN).test(hash)) {
    throw new Error(
      `Skill ${JSON.stringify(skill.path)} lacks the required enrichment content identity.`,
    );
  }
  return hash;
}

export function createArtifactFreshnessKey(kind, skill) {
  assertArtifactKind(kind);
  const contentHash = contentIdentity(skill);

  if (kind === 'summaries') {
    return { contentHash };
  }

  if (!skill.upstream) {
    throw new Error(`Changelog enrichment requires upstream provenance for ${skill.path}.`);
  }

  return {
    contentHash,
    repository: skill.upstream.repository,
    reference: skill.upstream.reference,
    source: skill.upstream.source,
    pinnedCommit: skill.upstream.commit,
  };
}

export function isArtifactFresh(kind, artifact, skill) {
  try {
    return isDeepStrictEqual(
      artifact?.freshnessKey,
      createArtifactFreshnessKey(kind, skill),
    );
  } catch {
    return false;
  }
}

export function createLocaleSignature({
  locale,
  schemaVersion,
  producer,
  promptId,
  promptHash,
  model,
  converterVersion,
  generatorVersion,
  cliContract,
}) {
  if (!ENRICHMENT_LOCALES.includes(locale)) {
    throw new TypeError(`Unknown enrichment locale: ${JSON.stringify(locale)}.`);
  }
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new TypeError('schemaVersion must be a positive integer.');
  }
  if (!Number.isInteger(generatorVersion) || generatorVersion < 1) {
    throw new TypeError('generatorVersion must be a positive integer.');
  }
  if (typeof promptId !== 'string' || promptId === '') {
    throw new TypeError('promptId must be a non-empty string.');
  }
  if (typeof promptHash !== 'string' || !new RegExp(HASH_PATTERN).test(promptHash)) {
    throw new TypeError('promptHash must be a sha256-prefixed hash.');
  }
  if (producer !== 'llm' && producer !== 'opencc') {
    throw new TypeError(`Unknown enrichment producer: ${JSON.stringify(producer)}.`);
  }
  if (producer === 'llm' && (typeof model !== 'string' || model === '')) {
    throw new TypeError('LLM locale signatures require a non-empty model.');
  }
  if (
    producer === 'opencc' &&
    (typeof converterVersion !== 'string' || converterVersion === '')
  ) {
    throw new TypeError('OpenCC locale signatures require a non-empty converterVersion.');
  }
  if (cliContract === null || typeof cliContract !== 'object') {
    throw new TypeError('cliContract must be an object.');
  }

  return hashJson([
    locale,
    schemaVersion,
    producer,
    promptId,
    promptHash,
    producer === 'llm' ? model : null,
    producer === 'opencc' ? converterVersion : null,
    generatorVersion,
    cliContract,
  ]);
}

export function validateEnrichmentArtifact(kind, value) {
  assertArtifactKind(kind);
  const validate = artifactValidators.get(kind);
  const valid = validate(value);
  return {
    valid,
    errors: valid ? [] : [...(validate.errors ?? [])],
  };
}

export function assertValidEnrichmentArtifact(kind, value, label = `${kind} artifact`) {
  const result = validateEnrichmentArtifact(kind, value);
  if (!result.valid) {
    throw new Error(`${label} failed schema validation: ${formatSchemaErrors(result.errors)}.`);
  }
  assertSafeEnrichmentSkillPath(value.path);
  return value;
}

export function assertValidEnrichmentManifest(value) {
  if (!manifestValidator(value)) {
    throw new Error(
      `catalog/enrichment/manifest.json failed schema validation: ` +
        `${formatSchemaErrors(manifestValidator.errors)}.`,
    );
  }
  return value;
}
