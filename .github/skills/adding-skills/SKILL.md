---
name: adding-skills
description: Use when adding, importing, or adopting a skill in this repository, including requests to fetch or update its metadata from an upstream URL.
metadata:
  internal: true
---

# Adding skills to this repository

Use one adoption runbook, not the publication workflow by default.
**Required reading:** [English runbook](../../../docs/en/skill-management.md)
or its synchronized [Traditional Chinese version](../../../docs/zh-TW/skill-management.md).
Follow its category-specific steps, metadata completion, and finishing gates.

## Quick reference

| Request | Route |
|---|---|
| Upstream URL, frozen snapshot, or original public skill | Mapped, orphan, or local adoption in the runbook |
| Repository-only operating procedure | Internal skill under `.github/skills/`, with `metadata.internal: true`; no registry transaction |
| Explicit publication of a prepared snapshot | **Required sub-skill:** `release`; do not mix its two publication routes |

Before mutation, establish the requested paths, category, redistribution
rights, metadata deliverables, and current plan/review requirements. Discover
affected inventory assertions across root and site tests, including tests
under `site/src/`. Preserve mirrored bytes and transaction-owned outputs.
An adoption request alone authorizes no push, merge, tag, Release, workflow
publication, deployment, or scheduling change.

## Metadata and completion

Registry provenance/license/history and generated summaries/upstream
changelogs are different deliverables. When metadata is requested, include
eligible three-locale sidecars now and verify them with targeted `--check`
commands plus global safety validation. Read the generator's current model
contract before calling it; do not change signatures to bypass policy.

For local adoption completion, require fresh requested metadata and all
applicable checks. Global strict freshness is a **publication** gate.
Disclose independently established unrelated stale artifacts as publication
blockers, not proof that the new skill is incomplete. Missing target
artifacts or a failed required check still blocks completion.

Example: "Add this upstream skill and its metadata; do not publish" uses
local adoption and targeted enrichment, then stops after committed,
reviewed verification. A reported `nextTag` is not permission to create it.

## Common mistakes and stop conditions

| Mistake | Correction |
|---|---|
| Requiring publication readiness for every adoption | Apply the runbook's separate adoption and publication gates |
| Treating a safety pass as complete metadata | Verify the requested eligible artifacts and their freshness |
| Deferring explicitly requested metadata to a follow-up | Finish it now or report the task incomplete |

Stop before apply on unavailable sources, invalid licensing, tag/baseline
mismatch, or unrelated changes outside the authorized scope. Keep recovery
journals; do not hand-edit generated state, rewrite mirrors, edit reports to
filter apply, or reuse completed migrations as shortcuts.

Report changed paths, metadata coverage, exact check results, review outcome,
unresolved blockers, and publication status with evidence.
