---
name: release
description: Use when publishing a new Skills registry version, adopting upstream skills for a release, tagging a registry snapshot, creating a GitHub Release, or diagnosing a release that is tagged but not published on the catalog site.
metadata:
  internal: true
---

# Releasing the Skills registry

The sync transaction creates a version; a tag, GitHub Release, and site deployment publish it. Never invent a version by editing the lockfile or tagging an unchanged snapshot. Read [sync and releases](../../../docs/en/sync-and-releases.md) and [skill management](../../../docs/en/skill-management.md) before acting.

## Choose the route

| Situation | Route |
|---|---|
| Ordinary upstream update, license refresh, or adoption with no affected site routes, counts, search, or installation behavior | Merge the declaration/content PR, then dispatch `sync.yml` on `main` with `dry_run=false`, `baseline=false` (and `refresh_licenses=true` only for license refresh). The workflow applies, validates, commits, tags, atomically pushes, and deploys. |
| Changed routes, exact-count tests, search/install behavior, or other changes needing the lock-derived site checked **before** publication; choose this route when uncertain | Commit declarations/content first; apply locally on a clean, isolated branch; include generated state and site/test changes in one PR. Validate the resulting snapshot before merging, then tag the reviewed merge commit on `main` and rerun deployment. Do not also dispatch apply for this snapshot. |
| Site-only or documentation-only change with no registry diff | Use the normal PR/deploy path; do not create a registry release. |

## Before apply

1. Fetch refs/tags and check `git status --short`, the lockfile `release`, and the highest semantic `v*` tag. The tag must equal the current lock release and be an ancestor of the apply branch. Require verified baselines and reachable upstreams; never interpret an unavailable source as a deletion.
2. For a new mapping, commit `catalog/sources.yml`, upstream-mirrored content, source metadata/policy, and affected tests before apply. Preserve the main checkout's unrelated files; use an isolated worktree if it is dirty.
3. Run `node scripts/sync.mjs --dry-run --output <report-path>` and inspect unavailable, removed, and deletion-guard results. Stop on blockers. `--baseline` and `--deproprietize` are completed one-time migrations, not release shortcuts.

## Apply and publish

- **Workflow route:** Dispatch `.github/workflows/sync.yml` **on `main`** with the non-dry inputs above. A dispatch on another branch may succeed while skipping apply; a no-op produces no tag. Inspect the result artifact, workflow checks, new commit and tag.
- **Pre-publication PR route:** Run `node scripts/sync.mjs --apply --output <report-path>` on the clean, committed adoption branch; put reports outside the repository or under ignored `sync-report/`. Confirm `applied`, `release`, `nextTag`, and affected skills. Run `npm run enrich:prune` if needed. Commit **all** transaction outputs, including `skills/**`, lock/history/license/README/NOTICE state, any pruned `catalog/enrichment/` artifacts, and related site/test changes; never edit generated views by hand. Require empty `git status --porcelain` before validation and push. Run `npm test`, `npm run validate`, `npm run validate:enrichment`, `npm run smoke:npx -- --ref HEAD`, then build and test the site (`npm --prefix site run build`, `npm --prefix site test`, `npm --prefix site run test:e2e`). Review the rendered new routes and install commands; merge only after PR checks pass.
- **Manual tag handoff:** On the merged `main`, verify that the reviewed snapshot and lock release are present, create the annotated `v<release>` tag at the merge commit, and push it. A tag push alone does not deploy. Rerun the successful `main` push's `deploy-site.yml` run (or make a reviewed follow-up commit), and verify `RELEASE_PUBLISHED=true` in the build log.
- **Either route:** After the tag exists remotely, verify release notes against the applied report and changes since the prior tag, then create the GitHub Release with `gh release create v<release> --verify-tag --notes-file <verified-notes-file>`. Verify the published site, release label, `#v<release>` installation command, new source/skill routes, and search. Enable scheduled sync with `gh variable set SKILLS_SYNC_ENABLED --body true` only after the release tag is published; read the variable back.

Enrichment is a separate sidecar, not part of the sync transaction. Regenerate summaries/changelogs in a follow-up PR, run both `--check` commands and `npm run validate:enrichment -- --strict`, then rebuild/test the site. Check the pinned Copilot model against current policy **before** invoking generators: changing its contract invalidates existing signatures and needs a separately reviewed full-regeneration plan. A non-strict safety pass does not prove freshness. If enrichment is blocked, report that explicitly; do not claim strict validation passed.

If a rollback, guard, test, review, deploy, or publication check fails, stop before irreversible steps; investigate and resolve the cause rather than forcing a tag. Preserve transaction journals/backups for recovery. Do not enable scheduled sync against an unpublished lock release.
