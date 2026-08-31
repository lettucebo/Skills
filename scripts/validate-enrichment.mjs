import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ENRICHMENT_ARTIFACT_KINDS,
  assertSafeEnrichmentSkillPath,
  assertValidEnrichmentArtifact,
  assertValidEnrichmentManifest,
  isArtifactFresh,
  isEligibleForEnrichment,
} from './lib/enrichment.mjs';
import { historyFileName } from './lib/history.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, '..');

async function readJson(filePath, label) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${filePath}: ${error.message}.`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Unable to parse ${label} at ${filePath}: ${error.message}.`);
  }
}

async function directoryExists(directory) {
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Enrichment artifact directory must be a real directory: ${directory}.`);
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function collectEnrichmentArtifacts({ repoRoot, kind }) {
  const directory = path.join(repoRoot, 'catalog', 'enrichment', kind);
  if (!(await directoryExists(directory))) {
    return { directory, exists: false, artifacts: [] };
  }

  const artifacts = [];
  const seenPaths = new Set();
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error(`Unexpected enrichment artifact entry: ${absolutePath}.`);
    }

    const value = await readJson(absolutePath, `${kind} artifact`);
    assertValidEnrichmentArtifact(kind, value, absolutePath);
    assertSafeEnrichmentSkillPath(value.path);

    const expectedName = historyFileName(value.path);
    if (entry.name !== expectedName) {
      throw new Error(
        `${absolutePath} declares path ${JSON.stringify(value.path)} but must be named ` +
          `${JSON.stringify(expectedName)}.`,
      );
    }
    if (seenPaths.has(value.path)) {
      throw new Error(`Duplicate ${kind} artifact path: ${value.path}.`);
    }
    seenPaths.add(value.path);

    artifacts.push({
      absolutePath,
      relativePath: path.relative(repoRoot, absolutePath).replace(/\\/g, '/'),
      artifact: value,
    });
  }

  return { directory, exists: true, artifacts };
}

export async function validateEnrichment({
  repoRoot = defaultRepoRoot,
  strict = false,
  strictKinds = [],
} = {}) {
  const unknownStrictKinds = strictKinds.filter(
    (kind) => !ENRICHMENT_ARTIFACT_KINDS.includes(kind),
  );
  if (unknownStrictKinds.length > 0) {
    throw new Error(`Unknown strict enrichment kinds: ${unknownStrictKinds.join(', ')}.`);
  }
  const manifestPath = path.join(repoRoot, 'catalog', 'enrichment', 'manifest.json');
  const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
  const manifest = assertValidEnrichmentManifest(
    await readJson(manifestPath, 'enrichment manifest'),
  );
  const lock = await readJson(lockPath, 'skills lock');
  if (!Array.isArray(lock.skills)) {
    throw new Error(`${lockPath} must contain a skills array.`);
  }

  const skills = new Map(lock.skills.map((skill) => [skill.path, skill]));
  const errors = [];
  let artifactCount = 0;

  for (const kind of ENRICHMENT_ARTIFACT_KINDS) {
    const collection = await collectEnrichmentArtifacts({ repoRoot, kind });
    artifactCount += collection.artifacts.length;

    const requiresCompleteness =
      strict && (manifest.enabled[kind] || strictKinds.includes(kind));

    if ((manifest.enabled[kind] || requiresCompleteness) && !collection.exists) {
      errors.push(`The enabled ${kind} directory does not exist: ${collection.directory}.`);
      continue;
    }

    const artifactsByPath = new Map(
      collection.artifacts.map((entry) => [entry.artifact.path, entry]),
    );

    for (const entry of collection.artifacts) {
      const skill = skills.get(entry.artifact.path);
      if (!skill) {
        errors.push(
          `${entry.relativePath} refers to ${entry.artifact.path}, which is not present in the skills lock.`,
        );
      } else if (skill.redistributable === false) {
        errors.push(
          `${entry.relativePath} exists for restricted skill ${entry.artifact.path}.`,
        );
      } else if (skill.category === 'removed') {
        errors.push(
          `${entry.relativePath} exists for tombstoned skill ${entry.artifact.path}.`,
        );
      }
    }

    if (!requiresCompleteness) {
      continue;
    }

    for (const skill of lock.skills) {
      if (!isEligibleForEnrichment(kind, skill)) continue;
      const entry = artifactsByPath.get(skill.path);
      if (!entry) {
        errors.push(`Missing ${kind} artifact for ${skill.path}.`);
      } else if (!isArtifactFresh(kind, entry.artifact, skill)) {
        errors.push(`Stale ${kind} artifact for ${skill.path}.`);
      }
    }

    for (const entry of collection.artifacts) {
      const skill = skills.get(entry.artifact.path);
      if (!skill || !isEligibleForEnrichment(kind, skill)) {
        errors.push(`Unexpected ${kind} artifact for ${entry.artifact.path}.`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Enrichment validation failed:\n- ${errors.join('\n- ')}`);
  }

  return {
    strict,
    artifacts: artifactCount,
    enabled: { ...manifest.enabled },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--strict');
  if (unknown.length > 0) {
    throw new Error(`Unknown validate:enrichment arguments: ${unknown.join(', ')}`);
  }
  const result = await validateEnrichment({ strict: args.includes('--strict') });
  console.log(
    `Enrichment validation passed (${result.strict ? 'strict completeness' : 'default safety'}, ` +
      `${result.artifacts} artifacts).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
