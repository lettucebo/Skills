import { rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ENRICHMENT_ARTIFACT_KINDS,
  isEligibleForEnrichment,
} from './lib/enrichment.mjs';
import { collectEnrichmentArtifacts } from './validate-enrichment.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, '..');

export async function pruneEnrichment({ repoRoot = defaultRepoRoot } = {}) {
  const lockPath = path.join(repoRoot, 'catalog', 'skills.lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (!Array.isArray(lock.skills)) {
    throw new Error(`${lockPath} must contain a skills array.`);
  }

  const skills = new Map(lock.skills.map((skill) => [skill.path, skill]));
  const removals = [];

  for (const kind of ENRICHMENT_ARTIFACT_KINDS) {
    const collection = await collectEnrichmentArtifacts({ repoRoot, kind });
    for (const entry of collection.artifacts) {
      const skill = skills.get(entry.artifact.path);
      if (!skill || !isEligibleForEnrichment(kind, skill)) {
        removals.push(entry);
      }
    }
  }

  removals.sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0,
  );
  for (const entry of removals) {
    await rm(entry.absolutePath);
  }

  return { removed: removals.map((entry) => entry.relativePath) };
}

async function main() {
  if (process.argv.length > 2) {
    throw new Error(`enrich:prune accepts no arguments: ${process.argv.slice(2).join(', ')}`);
  }
  const result = await pruneEnrichment();
  console.log(`Pruned ${result.removed.length} forbidden enrichment artifact(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
