import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import Ajv from 'ajv';

import { hashJson } from './hash.mjs';
import { historyFileName } from './history.mjs';

export const ENRICHMENT_SCHEMA_VERSION = 1;
export const ENRICHMENT_ARTIFACT_KINDS = Object.freeze(['summaries', 'changelog']);
export const ENRICHMENT_LOCALES = Object.freeze(['en', 'zh-tw', 'zh-cn']);

const HASH_PATTERN = '^sha256:[0-9a-f]{64}$';
const COMMIT_SHA_PATTERN = '^[0-9a-f]{40}$';
const ajv = new Ajv({ allErrors: true, strict: true });

const hashSchema = { type: 'string', pattern: HASH_PATTERN };
const summaryContentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['purpose', 'whenToUse', 'outputs'],
  properties: {
    purpose: { type: 'string', minLength: 1 },
    whenToUse: { type: 'string', minLength: 1 },
    outputs: { type: 'string', minLength: 1 },
  },
};
const changelogCommitSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sha',
    'date',
    'subject',
    'url',
    'pathAtCommit',
    'resolvedVia',
    'summary',
  ],
  properties: {
    sha: { type: 'string', pattern: COMMIT_SHA_PATTERN },
    date: { type: 'string', minLength: 1 },
    subject: { type: 'string' },
    url: { type: 'string', pattern: '^https://github\\.com/[^/]+/[^/]+/commit/[0-9a-f]{40}$' },
    pathAtCommit: { type: 'string', minLength: 1 },
    resolvedVia: {
      enum: ['direct', 'rename', 'copy-then-delete-migration'],
    },
    transition: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'sourcePath', 'destinationPath'],
      properties: {
        status: { type: 'string', pattern: '^[RC][0-9]{1,3}$' },
        sourcePath: { type: 'string', minLength: 1 },
        destinationPath: { type: 'string', minLength: 1 },
      },
    },
    summary: { type: 'string', minLength: 1 },
  },
};
const changelogContentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['commits'],
  properties: {
    commits: {
      type: 'array',
      minItems: 1,
      items: changelogCommitSchema,
    },
    truncatedAt: {
      type: 'object',
      additionalProperties: false,
      required: ['sha', 'sourcePath', 'reason'],
      properties: {
        sha: { type: 'string', pattern: COMMIT_SHA_PATTERN },
        sourcePath: { type: 'string', minLength: 1 },
        reason: {
          enum: ['copy-source-still-live', 'restricted-transition-source'],
        },
      },
    },
  },
};

function contentSchema(kind) {
  return kind === 'summaries' ? summaryContentSchema : changelogContentSchema;
}

function llmLocaleSchema(contentSchema) {
  return {
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
}

function openccLocaleSchema(contentSchema) {
  return {
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
}

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
  const localeContentSchema = contentSchema(kind);
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
          en: llmLocaleSchema(localeContentSchema),
          'zh-tw': llmLocaleSchema(localeContentSchema),
          'zh-cn': openccLocaleSchema(localeContentSchema),
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

function isValidGitAuthorDate(value) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
      .exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
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
  const schemaValid = validate(value);
  const errors = schemaValid ? [] : [...(validate.errors ?? [])];
  if (
    kind === 'changelog' &&
    value &&
    typeof value === 'object' &&
    value.locales &&
    typeof value.locales === 'object'
  ) {
    for (const [locale, localeArtifact] of Object.entries(value.locales)) {
      const commits = localeArtifact?.content?.commits;
      if (!Array.isArray(commits)) {
        continue;
      }
      for (const [index, commit] of commits.entries()) {
        if (
          commit &&
          typeof commit === 'object' &&
          typeof commit.date === 'string' &&
          !isValidGitAuthorDate(commit.date)
        ) {
          errors.push({
              instancePath: `/locales/${locale}/content/commits/${index}/date`,
              keyword: 'format',
              params: { format: 'git-author-date' },
              message: 'must be a valid ISO 8601 Git author date',
          });
        }
      }
    }
  }
  return {
    valid: schemaValid && errors.length === 0,
    errors,
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
