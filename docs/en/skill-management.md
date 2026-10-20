# Skill management

[繁體中文](../zh-TW/skill-management.md) | [**English**](../en/skill-management.md) | [Documentation home](README.md)

This page covers how a skill moves through its lifecycle in this registry.
For the manifest fields referenced here, see [Configuration](configuration.md).
For how a sync run is actually executed, see
[Sync and releases](sync-and-releases.md).

## Skill lifecycles

Every registry skill belongs to exactly one category, declared in
`catalog/sources.yml` and recorded in `catalog/skills.lock.json`:

### Mapped skills

Vendored from a declared upstream (`mappings`). Sync re-stages a mapped
skill's content from its upstream on every run, detects whether it changed,
and (once a verified baseline exists) can adopt in-place upstream changes
automatically.

### Orphan skills

A frozen snapshot (`orphans`) with no tracked upstream. Sync never re-stages
or modifies an orphan's content; it is only touched once, at adoption.

### Local skills

Original content under a declared `local` root (`skills/lettucebo`). Sync
never replaces it with upstream content. At adoption, the transaction copies
the committed tree through the candidate swap and records its hash without
modifying the skill's content.

### Removed mappings and the proprietary denylist

A removed mapping remains in the lock as a `removed` tombstone and receives a
`mapping-removed` history entry. It no longer contributes to active counts,
install plans, source inventories, or site routes, and its vendored directory
must be absent.

Release `2.0.0` used the completed one-time `--deproprietize` migration to
remove `skills/claude/{docx,pdf,pptx,xlsx}` before any tag was published.
Those paths remain permanently listed in `RESTRICTED_SKILL_PATHS`. For 2.0.0
and later, validation rejects them on disk, in active mappings, or in active
lock entries. This migration was the deliberate exception to the normal rule
that declaration/content changes are committed before `--apply`: it changed
the manifest and materialized state inside the same journaled transaction.

## Adoption runbook

The repository-local [adding-skills entrypoint](../../.github/skills/adding-skills/SKILL.md)
routes addition/import requests here. This page is the canonical procedure;
the Traditional Chinese counterpart describes the same workflow.

1. **Confirm scope and rights.** Identify the upstream repository, reference,
   source folder, destination, existing mapping/name collisions, and requested
   metadata. Inspect the actual upstream skill and supporting files, nearest
   source guidance, and redistribution terms before copying. Reject
   proprietary or denylisted content; adding a denylist entry is not
   permission to redistribute. Resolve supported name collisions through
   manifest overrides, not mirror edits.
2. **Choose the category.** Use mapped for a tracked upstream, orphan for an
   explicitly frozen snapshot, or local for original public content under
   `skills/lettucebo/`. Repository-only procedures belong under
   `.github/skills/<name>/SKILL.md` with `metadata.internal: true`: test their
   links, discovery and behavior, but do not add registry mappings, lock
   entries, enrichment, or release bumps. For existing local/orphan content,
   stop and plan supported engine/migration work: apply passes those entries
   through unchanged and cannot refresh their version/hash/history.
3. **Plan and review.** Follow current repository review and skill-authoring
   requirements. For public additions, prepare the category-specific
   declaration/content changes below. Add `SOURCE_META` for a new source.
   Search affected inventory/count assertions across `scripts/test/`,
   `site/test/`, `site/src/` (including `i18n/routes.test.ts`), and `site/e2e/`;
   account for active/mapped/orphan/source counts, localized routes,
   compatibility redirects and Pagefind output. Do not update only the
   provenance test or hard-code today's totals in this procedure.
4. **Prepare a committed candidate.** Commit the declaration, mirrored or
   original content, and affected pre-apply assertions together. Check the
   [preconditions](#preconditions-for-onboarding-any-new-skill), refreshing
   remote refs/tags first. Preserve unrelated working files; use isolation
   rather than stashing or overwriting someone else's changes.
5. **Inspect before applying.** Run the following from the repository root:

   ```powershell
   node scripts\sync.mjs --dry-run --output sync-report\changeset.json
   ```

   Inspect additions, updates, removals, unavailable sources, guards and
   affected paths. Apply re-stages all mapped skills; it does not consume a
   hand-filtered report and has no single-skill apply flag. If unrelated
   changes exceed the authorized scope, stop for a scope decision or a
   separately reviewed, supported source-selection plan. Do not silently
   broaden adoption, patch generated state, fabricate upstream commits, or
   reuse `--bootstrap`, `--baseline` or `--deproprietize`.
6. **Apply and verify the result.** Only with a clean committed tree and
   approved changeset, run:

   ```powershell
   node scripts\sync.mjs --apply --output sync-report\result.json
   ```

   Inspect `applied`, `release`, `nextTag` and affected skills; compare them
   with the approved plan. Retain journals/backups on failure. Complete
   [metadata](#metadata-completion) and [local verification](#finishing-an-adoption)
   next. Reading `nextTag` does not authorize creating that tag.

## Preconditions for onboarding any new skill

Regardless of category, adding a new skill through the sync engine
(`node scripts/sync.mjs --apply`) requires:

- a **clean working tree** (`git status` must report nothing) — the engine
  refuses to run otherwise, so a sync transaction is never mixed with
  uncommitted local edits, and
- the **current release tag is an ancestor of `HEAD`** — the highest
  `v<release>` tag must match `catalog/skills.lock.json`'s `release` field and
  be reachable from the branch being updated. This is checked before any
  staging happens, for mapped, orphan, and local additions alike;
- every mapped entry already in the lockfile has a **verified baseline**; and
- every mapped upstream and source is reachable. Orphan and local adoption
  still stage the complete mapped inventory first, so an unrelated upstream
  outage blocks them too.

## Adding a mapped skill

1. Add the upstream to `upstreams` in `catalog/sources.yml` if it is not
   already declared.
2. Add the skill folder under `skills/<source>/<skill>/` (a copy of the
   upstream content is fine as a starting point) and add its `mappings` entry
   in the same commit.
3. Update all affected assertions identified by the runbook, including the
   fixed mapping count in `scripts/test/provenance.test.mjs`. For a
   `microsoft` or `cloudflare` mapping, also update that test's exact approved
   source list. These assertions run before workflow apply, so the manifest
   and provenance contract must change together.
4. Confirm redistribution rights. Reject proprietary and permanently
   denylisted content; `RESTRICTED_SKILL_PATHS` is a rejection policy, not
   an adoption mechanism.
5. Commit, and confirm the current lock `release` tag is published and an
   ancestor of `HEAD`.
6. Run `node scripts/sync.mjs --apply`. The engine re-stages the skill from
   the real upstream, verifies its provenance, stamps `x-source*` frontmatter
   fields, resolves license evidence at that staged commit, updates the
   third-party root-license bundle when needed, and records a `mapping-added`
   history entry starting at version `1.0.0`.
7. Complete the metadata, validation and commit steps in
   [Finishing an adoption](#finishing-an-adoption).

## Adding an orphan skill

1. Add the skill folder under `skills/<source>/<skill>/`.
2. Add its `orphans` entry (with a `note` explaining why no upstream is
   tracked) in the same commit.
3. Update all affected assertions, including the fixed orphan count in
   `scripts/test/provenance.test.mjs`.
4. Confirm redistribution rights; reject proprietary/denylisted content.
   Commit the declaration, content and affected pre-apply assertions.
5. Inspect the dry-run, then run `node scripts/sync.mjs --apply` under the same clean-tree and
   current-tag preconditions. The engine hashes the committed content as-is
   and records an `orphan-added` history entry at version `1.0.0` — it never
   fetches or rewrites the content itself.
6. Complete [Finishing an adoption](#finishing-an-adoption).

## Adding a local skill

1. Add the skill folder under the declared `local` root
   (`skills/lettucebo/<skill>/`).
2. No new manifest entry is needed beyond the existing `local` root
   declaration, since every path under that root is automatically covered.
3. Confirm redistribution rights; reject proprietary/denylisted content.
   Update affected inventory assertions and commit the content and tests.
4. Inspect the dry-run, then run `node scripts/sync.mjs --apply` under the same preconditions. The
   engine records a `local-added` history entry at version `1.0.0` from the
   committed content's hash. The candidate transaction preserves those bytes
   rather than replacing them with staged upstream content.
5. Complete [Finishing an adoption](#finishing-an-adoption).

## Metadata completion

Inspect two distinct sets of metadata; one does not substitute for the other:

| Set | Acceptance evidence |
|---|---|
| Registry transaction | Correct category/name/path, skill version starting at `1.0.0`, hashes, provenance fields and pinned upstream commit where applicable, truthful structured license evidence/bundle, adoption history, and consistent generated README/NOTICE views |
| Enrichment sidecars | Eligible requested summaries and upstream changelog under `catalog/enrichment/`, fresh against the lock with schema-valid `en`, `zh-tw`, `zh-cn` content and valid locale signatures |

When the request includes metadata, finish eligible sidecars in the same
adoption; missing target artifacts mean **incomplete**, not a silent follow-up.
Summaries support active redistributable registry entries; changelogs require
upstream provenance. Record an ineligible kind as N/A rather than fabricating
history or disabling enrichment. Internal skills have neither kind.

Check the current generator model/effort contract in `scripts/lib/llm.mjs`
against applicable policy before generation. A conflict blocks generation;
changing the contract/signatures requires its own reviewed regeneration plan.
For each eligible kind, set `$SkillPath` to the exact lock entry path and use
the corresponding commands below (a mapped adoption normally uses both):

```powershell
$SkillPath = 'skills/github/plantuml-ascii'
npm run enrich:summaries -- --skill $SkillPath
npm run enrich:changelog -- --skill $SkillPath
npm run enrich:summaries -- --skill $SkillPath --check
npm run enrich:changelog -- --skill $SkillPath --check
npm run validate:enrichment
```

Confirm all three locales, source-supported summaries, preserved original
commit subjects and history at the lock-pinned revision, not live upstream
HEAD. Inspect any pruning side effects before committing; only remove
ineligible artifacts, not eligible stale ones to make checks pass.

Default safety intentionally permits missing/stale eligible artifacts:
**its success alone does not prove requested metadata is complete**. Targeted
`--check` verifies the adopted skill's freshness without regenerating unrelated
artifacts. Global strict freshness is the separate
[publication gate](#publishing-an-adopted-release).

## Finishing an adoption

After `--apply` regenerates the lock and derived files, complete the requested
metadata above. Adoption-only work stops here; it does not authorize push,
merge, tag, GitHub Release, workflow publication, deployment, or changing
scheduled sync.

1. Commit **all** transaction outputs, including `skills/**`, the lockfile,
   history, `catalog/licenses/`, `NOTICE`, and README blocks. Include any
   `catalog/enrichment/` generation/pruning changes and related
   site/test changes. Require empty `git status --porcelain`; keep reports
   outside the repository or under ignored `sync-report/`.
2. Run `npm test`, `npm run validate`, default enrichment safety and the
   targeted freshness checks above, then `npm run smoke:npx -- --ref HEAD`.
   The smoke check must run **after** the lockfile
   and all skill content are committed. Complete the relevant site build,
   unit and E2E checks; personally inspect rendered affected pages, search and
   install controls. Finish the independent review required by current policy
   against the final diff and check evidence.
3. Report adopted paths/category, metadata completeness, commands/results,
   review, remaining problems and unpublished status. A failed required check
   or missing requested metadata blocks completion. Evidence-backed,
   unrelated pre-existing freshness failures do not by themselves block
   otherwise verified local adoption, but remain publication blockers; do not
   report global freshness as passing or silently waive other failed checks.

## Publishing an adopted release

Only after explicit publication authorization, use the internal `release`
skill and [sync/release guidance](sync-and-releases.md). Before publication,
both global cache checks and strict completeness must pass:

```powershell
npm run enrich:summaries -- --check
npm run enrich:changelog -- --check
npm run validate:enrichment -- --strict
```

For the reviewed, locally generated snapshot route, merge the reviewed change
into `main` only when authorized. Keep scheduled sync disabled until the
release is published. On an updated `main`, create the annotated `v<release>`
tag named by the lockfile at the merged release commit and push it. Do not
tag the feature branch. Because the commit is already on the remote after a
PR merge, this manual route cannot retroactively make commit and tag
publication atomic. The merge push also deploys before the tag exists, and
a tag push does not trigger `deploy-site.yml`; after tagging, re-run the
prior deploy workflow so it fetches tags and recomputes publication. A
follow-up commit on `main` also triggers a new deploy.

For atomic publication, use the preferred operator route instead: merge only
the reviewed source/manifest/policy change, then manually dispatch
`.github/workflows/sync.yml` on `main` with `dry_run=false` and
`baseline=false`. The `update` job applies the adoption, validates it, commits
the generated outputs, creates the exact `nextTag`, and pushes commit and tag
atomically. Do not combine this workflow route with a locally generated
release commit.

## Updating an upstream mapping

To change a mapping's upstream, `reference`, or `source` while keeping the
same destination `path`, edit the declarations together, commit them, and run
the same apply and finishing flow. The engine treats this as an in-place
upstream-tuple change and classifies it as `patch`. Changing the
`(repository, reference)` pair also changes the deletion-guard group, so
inspect the dry-run report before applying.

Changing the destination `path` is a rename/restructure represented as removal
plus addition and therefore classifies as `major`. The removal still passes
through the [deletion guard](#deletion-guard): a small group blocks the rename
outright, while a larger group permits it only when removal stays at or below
30%.

## Why generated outputs cannot be edited independently

`catalog/skills.lock.json`, `catalog/history/*.json`, the root `README.md`'s
`<!-- CATALOG:START -->`/`<!-- INSTALL:START -->` blocks, and `NOTICE` are all
derived deterministically from the manifest plus the current staged content
and pinned license evidence. `catalog/licenses/` is generated with them and
contains exact upstream root-license bytes plus its evidence index.
Hand-editing any of them creates a value that the next sync run will simply
overwrite, and in the meantime it can misrepresent what is actually
installable. Treat them as build output, not source.

## Declarative name overrides

When two upstreams each ship a skill with the same frontmatter `name` (for
example `mcp-builder` from both `anthropics/skills` and `microsoft/skills`),
add a `rename-frontmatter-name` entry to `overrides` in
`catalog/sources.yml` instead of hand-editing the vendored `SKILL.md`. See
[Configuration](configuration.md#overrides) for the exact format.

## Upstream broken-link exceptions

When a vendored skill contains a relative link that is already broken in the
upstream repository itself, do not "fix" it locally — the mirror must stay
faithful to upstream. Instead, add a `linkExceptions` entry in
`catalog/sources.yml` documenting the source, target, reason, and upstream
URL. See [Configuration](configuration.md#linkexceptions).

## Deletion guard

Sync groups mapped skills by their `(repository, reference)` pair and blocks
a run that would remove too many of them at once:

- for a group with fewer than 10 declared skills, **any** removal at all is
  blocked;
- for a group with 10 or more declared skills, a removal is blocked once it
  exceeds 30% of that group.

This protects against an accidental mass deletion (for example a manifest
typo or an upstream rename) being silently applied. Splitting a removal is
not a reliable bypass: small groups block every removal, and a large group can
shrink into that rule. There is currently no CLI override; a reviewed manifest
PR alone still fails. An intentional blocked removal first requires a separate
reviewed engine/guardrail change with tests that defines the authorized
exception, followed by the normal generated-output and release process.

## See also

- [Configuration](configuration.md) — the exact manifest field formats.
- [Sync and releases](sync-and-releases.md) — how a sync run is executed and
  released end to end.
