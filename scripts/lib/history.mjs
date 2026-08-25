/**
 * Deterministic per-skill history helpers.
 *
 * Each skill owns one history file under `catalog/history/`. The file name is
 * derived from the skill's stable key (its repository-relative folder path) by
 * replacing path separators, so the mapping is one-to-one and reversible.
 *
 * Skills present during the original v1.0.0 bootstrap begin with a `bootstrap`
 * entry. Skills first adopted later begin with their adoption entry
 * (`baseline-verified`, `mapping-added`, `orphan-added`, or `local-added`) and
 * carry `firstSeen` there. Bootstrap-only validators below intentionally reject
 * those ledgers because the one-time bootstrap command must never rewrite them.
 */
export function historyFileName(skillPath) {
  return `${skillPath.replace(/\//g, '__')}.json`;
}

/**
 * Builds the bootstrap history document for a single skill.
 *
 * `firstSeen` is preserved from a previous history document when one exists, so
 * re-running bootstrap never rewrites the original first-seen timestamp. On the
 * very first bootstrap there is no prior git-derived history that can be
 * resolved deterministically, so the current commit author timestamp is used
 * and documented as such in NOTICE. Bootstrap intentionally refuses to
 * overwrite any history that has evolved beyond its single bootstrap entry.
 */
export function buildBootstrapHistory({ skill, commitTimestamp, previousHistory }) {
  const firstSeen = resolveFirstSeen(skill.path, previousHistory, commitTimestamp);

  return {
    path: skill.path,
    name: skill.name,
    category: skill.category,
    entries: [
      {
        release: '1.0.0',
        kind: 'bootstrap',
        version: '1.0.0',
        firstSeen,
        upstreamCommit: null,
        diffUrl: null,
        snapshotHash: skill.snapshotHash,
      },
    ],
  };
}

export function validateBootstrapHistory(skillPath, previousHistory) {
  if (previousHistory === undefined) {
    return undefined;
  }

  if (!Array.isArray(previousHistory?.entries)) {
    throw new Error(
      `Refusing to overwrite release history for ${skillPath}: existing history entries ` +
        'must be an array with exactly one bootstrap entry.',
    );
  }

  if (previousHistory.entries.length === 0) {
    throw new Error(
      `Refusing to overwrite release history for ${skillPath}: existing history must ` +
        'contain exactly one bootstrap entry.',
    );
  }

  if (previousHistory.entries.length > 1) {
    throw new Error(
      `Refusing to overwrite release history for ${skillPath}: existing history already ` +
        `contains ${previousHistory.entries.length} entries; rerun bootstrap only on a ` +
        'single bootstrap entry.',
    );
  }

  const [previousEntry] = previousHistory.entries;

  if (previousEntry?.kind !== 'bootstrap') {
    throw new Error(
      `Refusing to overwrite release history for ${skillPath}: existing history entry ` +
        `kind must remain bootstrap, found ${JSON.stringify(previousEntry?.kind ?? null)}.`,
    );
  }

  if (typeof previousEntry.firstSeen !== 'string') {
    throw new Error(
      `Refusing to overwrite release history for ${skillPath}: existing bootstrap entry ` +
        'must preserve a string firstSeen timestamp.',
    );
  }

  return previousEntry;
}

function resolveFirstSeen(skillPath, previousHistory, commitTimestamp) {
  return validateBootstrapHistory(skillPath, previousHistory)?.firstSeen ?? commitTimestamp;
}
