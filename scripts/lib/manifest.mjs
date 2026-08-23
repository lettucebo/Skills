import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

export class ManifestValidationError extends Error {
  constructor(message, partialManifest) {
    super(message);
    this.name = 'ManifestValidationError';
    this.partialManifest = partialManifest;
  }
}

export async function loadManifest(manifestPath) {
  const absoluteManifestPath = path.resolve(manifestPath);
  const manifestText = await readFile(absoluteManifestPath, 'utf8');
  const parsed = parse(manifestText);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Manifest must be a YAML object.');
  }

  const repoRoot = path.resolve(path.dirname(absoluteManifestPath), '..');
  const existingSkillPaths = await collectSkillPaths(path.join(repoRoot, 'skills'));
  const partialManifest = {
    upstreams: {},
    mappings: [],
    orphans: [],
    local: [],
    overrides: [],
    linkExceptions: [],
  };

  try {
    await normalizeLinkExceptions(
      parsed.linkExceptions ?? [],
      repoRoot,
      partialManifest.linkExceptions,
    );
    partialManifest.upstreams = normalizeUpstreams(parsed.upstreams);
    partialManifest.mappings = normalizeMappings(
      parsed.mappings,
      partialManifest.upstreams,
    );
    partialManifest.orphans = normalizeOrphans(parsed.orphans);
    partialManifest.local = normalizeLocal(parsed.local);
    partialManifest.overrides = normalizeOverrides(parsed.overrides);

    const coverageSources = new Map();
    const existingSkillSet = new Set(existingSkillPaths);

    for (const mapping of partialManifest.mappings) {
      assertExistingSkillPath(mapping.path, existingSkillSet, 'Mapped');
      addCoveragePath(coverageSources, mapping.path, 'mapping');
    }

    for (const orphan of partialManifest.orphans) {
      assertExistingSkillPath(orphan.path, existingSkillSet, 'Orphan');
      addCoveragePath(coverageSources, orphan.path, 'orphan');
    }

    for (const entry of partialManifest.local) {
      const coveredByLocalRoot = existingSkillPaths.filter(
        (skillPath) =>
          skillPath === entry.root || skillPath.startsWith(`${entry.root}/`),
      );

      for (const coveredPath of coveredByLocalRoot) {
        addCoveragePath(coverageSources, coveredPath, `local:${entry.root}`);
      }
    }

    const uncoveredSkillPaths = existingSkillPaths.filter(
      (skillPath) => !coverageSources.has(skillPath),
    );

    if (uncoveredSkillPaths.length > 0) {
      throw new Error(
        `Uncovered skill paths: ${uncoveredSkillPaths.sort().join(', ')}`,
      );
    }

    const coveredPathSet = new Set([
      ...partialManifest.mappings.map((entry) => entry.path),
      ...partialManifest.orphans.map((entry) => entry.path),
      ...Array.from(coverageSources.keys()),
    ]);

    validateOverrides(
      partialManifest.overrides,
      coveredPathSet,
      partialManifest.mappings,
    );
  } catch (error) {
    throw new ManifestValidationError(error.message, partialManifest);
  }

  return partialManifest;
}

function normalizeUpstreams(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Manifest upstreams must be an object.');
  }

  return Object.fromEntries(
    Object.entries(value).map(([name, definition]) => {
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
        throw new Error(`Upstream "${name}" must be an object.`);
      }

      return [
        name,
        {
          repository: requireString(definition.repository, `upstreams.${name}.repository`),
          reference: requireString(definition.reference, `upstreams.${name}.reference`),
        },
      ];
    }),
  );
}

function normalizeMappings(value, upstreams) {
  const mappings = requireArray(value, 'mappings');

  return mappings.map((entry, index) => {
    const normalizedEntry = requireObject(entry, `mappings[${index}]`);
    const upstream = requireString(normalizedEntry.upstream, `mappings[${index}].upstream`);

    if (!(upstream in upstreams)) {
      throw new Error(`Unknown upstream "${upstream}" in mappings[${index}].upstream.`);
    }

    return {
      path: normalizeRelativePath(
        requireString(normalizedEntry.path, `mappings[${index}].path`),
        `mappings[${index}].path`,
      ),
      upstream,
      source: normalizeRelativePath(
        requireString(normalizedEntry.source, `mappings[${index}].source`),
        `mappings[${index}].source`,
      ),
    };
  });
}

function normalizeOrphans(value) {
  const orphans = requireArray(value, 'orphans');

  return orphans.map((entry, index) => {
    const normalizedEntry = requireObject(entry, `orphans[${index}]`);
    const result = {
      path: normalizeRelativePath(
        requireString(normalizedEntry.path, `orphans[${index}].path`),
        `orphans[${index}].path`,
      ),
    };

    if ('note' in normalizedEntry) {
      result.note = requireString(normalizedEntry.note, `orphans[${index}].note`);
    }

    return result;
  });
}

function normalizeLocal(value) {
  const local = requireArray(value, 'local');

  return local.map((entry, index) => {
    const normalizedEntry = requireObject(entry, `local[${index}]`);
    const result = {
      root: normalizeRelativePath(
        requireString(normalizedEntry.root, `local[${index}].root`),
        `local[${index}].root`,
      ),
    };

    if ('note' in normalizedEntry) {
      result.note = requireString(normalizedEntry.note, `local[${index}].note`);
    }

    return result;
  });
}

function normalizeOverrides(value) {
  const overrides = requireArray(value, 'overrides');

  return overrides.map((entry, index) => {
    const normalizedEntry = requireObject(entry, `overrides[${index}]`);
    const override = {
      path: normalizeRelativePath(
        requireString(normalizedEntry.path, `overrides[${index}].path`),
        `overrides[${index}].path`,
      ),
      transform: requireString(
        normalizedEntry.transform,
        `overrides[${index}].transform`,
      ),
    };

    if ('note' in normalizedEntry) {
      override.note = requireString(
        normalizedEntry.note,
        `overrides[${index}].note`,
      );
    }

    if ('source' in normalizedEntry) {
      override.source = normalizeRelativePath(
        requireString(normalizedEntry.source, `overrides[${index}].source`),
        `overrides[${index}].source`,
      );
    }

    return override;
  });
}

async function normalizeLinkExceptions(value, repoRoot, normalizedExceptions = []) {
  const linkExceptions = requireArray(value, 'linkExceptions');
  const seenKeys = new Set();
  const errors = [];

  for (const [index, entry] of linkExceptions.entries()) {
    try {
      const normalizedEntry = requireObject(entry, `linkExceptions[${index}]`);
      const linkException = {
        sourcePath: normalizeRelativePath(
          requireString(
            normalizedEntry.sourcePath,
            `linkExceptions[${index}].sourcePath`,
          ),
          `linkExceptions[${index}].sourcePath`,
        ),
        target: normalizeRelativeLinkTarget(
          requireString(normalizedEntry.target, `linkExceptions[${index}].target`),
          `linkExceptions[${index}].target`,
        ),
        reason: requireString(normalizedEntry.reason, `linkExceptions[${index}].reason`),
        upstreamUrl: requireString(
          normalizedEntry.upstreamUrl,
          `linkExceptions[${index}].upstreamUrl`,
        ),
      };
      const exceptionKey = createLinkExceptionKey(
        linkException.sourcePath,
        linkException.target,
      );

      if (seenKeys.has(exceptionKey)) {
        throw new Error(`Link exception declared more than once: ${exceptionKey}`);
      }

      if (!(await fileExists(path.join(repoRoot, ...linkException.sourcePath.split('/'))))) {
        throw new Error(`Link exception source file does not exist: ${linkException.sourcePath}`);
      }

      seenKeys.add(exceptionKey);
      normalizedExceptions.push(linkException);
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  return normalizedExceptions;
}

function validateOverrides(overrides, coveredPaths, mappings) {
  const seenPaths = new Set();
  const mappingByPath = new Map(mappings.map((mapping) => [mapping.path, mapping]));

  for (const override of overrides) {
    if (!coveredPaths.has(override.path)) {
      throw new Error(`Override targets unknown skill path: ${override.path}`);
    }

    if (seenPaths.has(override.path)) {
      throw new Error(`Override declared more than once for path: ${override.path}`);
    }

    const coveredMapping = mappingByPath.get(override.path);

    if (
      coveredMapping &&
      'source' in override &&
      override.source !== coveredMapping.source
    ) {
      throw new Error(
        `Override source mismatch for ${override.path}: expected ${coveredMapping.source}, received ${override.source}`,
      );
    }

    seenPaths.add(override.path);
  }
}

function addCoveragePath(coverageSources, skillPath, source) {
  const previousSource = coverageSources.get(skillPath);

  if (previousSource) {
    throw new Error(
      `Skill path is covered more than once: ${skillPath} (${previousSource}, ${source})`,
    );
  }

  coverageSources.set(skillPath, source);
}

function assertExistingSkillPath(skillPath, existingSkillSet, label) {
  if (!existingSkillSet.has(skillPath)) {
    throw new Error(`${label} skill path does not exist: ${skillPath}`);
  }
}

async function collectSkillPaths(skillsRoot) {
  const collectedPaths = [];
  await walkSkillTree(skillsRoot, collectedPaths, skillsRoot);
  return collectedPaths.sort();
}

async function walkSkillTree(currentPath, collectedPaths, skillsRoot) {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const containsSkillFile = entries.some(
    (entry) => entry.isFile() && entry.name === 'SKILL.md',
  );

  if (containsSkillFile) {
    collectedPaths.push(
      toPosixPath(path.relative(path.dirname(skillsRoot), currentPath)),
    );
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    await walkSkillTree(path.join(currentPath, entry.name), collectedPaths, skillsRoot);
  }
}

function normalizeRelativePath(value, fieldName) {
  const normalized = toPosixPath(value.trim())
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');

  if (!normalized) {
    throw new Error(`${fieldName} must not be empty.`);
  }

  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`${fieldName} must be a repository-relative path.`);
  }

  return normalized;
}

function normalizeRelativeLinkTarget(value, fieldName) {
  const normalized = toPosixPath(value.trim());

  if (!normalized) {
    throw new Error(`${fieldName} must not be empty.`);
  }

  if (
    normalized.startsWith('/')
    || normalized.startsWith('#')
    || /^[A-Za-z]:\//.test(normalized)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalized)
  ) {
    throw new Error(`${fieldName} must be a relative link target.`);
  }

  return normalized;
}

async function fileExists(targetPath) {
  try {
    const targetStat = await stat(targetPath);
    return targetStat.isFile();
  } catch {
    return false;
  }
}

function createLinkExceptionKey(sourcePath, target) {
  return `${sourcePath} -> ${target}`;
}

function toPosixPath(value) {
  return value.replace(/\\/g, '/');
}

function requireArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array.`);
  }

  return value;
}

function requireObject(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }

  return value;
}

function requireString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }

  return value.trim();
}
