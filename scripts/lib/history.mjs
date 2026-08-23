/**
 * Deterministic per-skill history helpers.
 *
 * Each skill owns one history file under `catalog/history/`. The file name is
 * derived from the skill's stable key (its repository-relative folder path) by
 * replacing path separators, so the mapping is one-to-one and reversible.
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
 * and documented as such in NOTICE.
 */
export function buildBootstrapHistory({ skill, commitTimestamp, previousHistory }) {
  const firstSeen = resolveFirstSeen(previousHistory, commitTimestamp);

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

function resolveFirstSeen(previousHistory, commitTimestamp) {
  const previousFirstSeen = previousHistory?.entries?.[0]?.firstSeen;
  return typeof previousFirstSeen === 'string' ? previousFirstSeen : commitTimestamp;
}
