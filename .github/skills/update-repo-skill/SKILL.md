---
name: update-repo-skill
description: Use when checking or updating already registered skills in lettucebo/Skills, including upstream changes, provenance drift, or requested summary and changelog metadata.
metadata:
  internal: true
---

# Update registered skills

An internal operating reference for this registry, not an installable registry
skill. Updating existing content, discovering candidates, adopting skills, and
publishing a release are separate scopes.

**Required reading:** [Update workflow](references/update-workflow.md) and the
canonical [English runbook](../../../docs/en/skill-management.md) or
[Traditional Chinese runbook](../../../docs/zh-TW/skill-management.md).
Use current repository instructions for review and executable command contracts.

## Start with a scope record

Record base branch/HEAD, manifest/lock identity, observation time, exact target
paths/categories, excluded work, tool footprint, authorizations, and requested
metadata. Default to active registered skills, not upstream candidates.

Verify the actual script, arguments, clone/download/checkout/read boundaries
**before network access**. A full scan followed by filtered output is not a
scoped scan. Standard sync clones whole upstreams; it has no single-skill
apply. If its footprint exceeds scope or touches blocked content, deliver the
local inventory and limitation, then propose separate supported tooling work.

## Quick reference

| Situation | Route |
|---|---|
| Existing mapped content/provenance | Full-directory hashes and provenance comparison, reviewed transaction |
| Existing local/orphan content | Unsupported by current apply; separate engine/migration plan |
| New upstream candidate or adoption | **Required sub-skill:** `adding-skills`, only when requested |
| Requested summaries/changelog | Eligible target freshness in three locales; global safety separately |
| Explicit snapshot publication | **Required sub-skill:** `release`; `nextTag` alone grants nothing |

Follow the reference's preflight, plan/review, transaction, metadata, and
finishing gates. An upstream HEAD change alone does not prove a skill changed;
compare all supported bytes and provenance through shared helpers.

## Common mistakes and stop signals

| Mistake | Required distinction |
|---|---|
| Treating every read error as Defender | Confirm an exact protection event; ordinary I/O remains unresolved |
| Ignoring a detection without tracking | Issue first, then authorized, supported exact exclusion |
| Reporting a skipped mapped skill unchanged | Unknown/not assessed; blocks complete apply |
| Patching mirrors, hashes, or tags to unblock | Preserve evidence and plan a supported resolution |
| Treating safety validation as complete metadata | Target freshness and publication strict checks differ |

Never restore quarantine, disable protection, add antivirus exclusions, or
retrieve blocked bytes through aliases/Git blobs. Stop on unavailable sources,
invalid YAML, unexplained hash drift, tag/baseline mismatch, failed required
checks, or an unqualified reviewer. Keep recovery journals and others' files.

Report completion level/scope, decisions/changes, metadata coverage, actual
commands/results, review model/effort/limitations, blockers/deferred work, and
commit/publication state with evidence. Local inventory is not upstream
verification; unknown is not success.
