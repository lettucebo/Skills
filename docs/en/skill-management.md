# Skill management

[繁體中文](../zh-TW/skill-management.md) | [**English**](../en/skill-management.md) | [Documentation home](README.md)

This page covers how a skill moves through its lifecycle in this registry.
For the manifest fields referenced here, see [Configuration](configuration.md).
For how a sync run is actually executed, see
[Sync and releases](sync-and-releases.md).

## Skill lifecycles

Every skill belongs to exactly one category, declared in
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
3. Update the fixed mapping count in `scripts/test/provenance.test.mjs`. For a
   `microsoft` or `cloudflare` mapping, also update that test's exact approved
   source list. These assertions run before workflow apply, so the manifest
   and provenance contract must change together.
4. If its terms are proprietary, add the destination path to
   `RESTRICTED_SKILL_PATHS` in `scripts/catalog.mjs`. This policy is not
   inferred from `LICENSE.txt` or configured in `catalog/sources.yml`.
5. Commit, and confirm the current lock `release` tag is published and an
   ancestor of `HEAD`.
6. Run `node scripts/sync.mjs --apply`. The engine re-stages the skill from
   the real upstream, verifies its provenance, stamps `x-source*` frontmatter
   fields, and records a `mapping-added` history entry starting at version
   `1.0.0`.
7. Complete the validation, commit, merge, and tag handoff in
   [Finishing an adoption](#finishing-an-adoption).

## Adding an orphan skill

1. Add the skill folder under `skills/<source>/<skill>/`.
2. Add its `orphans` entry (with a `note` explaining why no upstream is
   tracked) in the same commit.
3. Update the fixed orphan count in `scripts/test/provenance.test.mjs`.
4. If its terms are proprietary, add its path to
   `RESTRICTED_SKILL_PATHS` in `scripts/catalog.mjs`.
5. Run `node scripts/sync.mjs --apply` under the same clean-tree and
   current-tag preconditions. The engine hashes the committed content as-is
   and records an `orphan-added` history entry at version `1.0.0` — it never
   fetches or rewrites the content itself.
6. Complete [Finishing an adoption](#finishing-an-adoption).

## Adding a local skill

1. Add the skill folder under the declared `local` root
   (`skills/lettucebo/<skill>/`).
2. No new manifest entry is needed beyond the existing `local` root
   declaration, since every path under that root is automatically covered.
3. If its terms are proprietary, add its path to
   `RESTRICTED_SKILL_PATHS` in `scripts/catalog.mjs`.
4. Run `node scripts/sync.mjs --apply` under the same preconditions. The
   engine records a `local-added` history entry at version `1.0.0` from the
   committed content's hash. The candidate transaction preserves those bytes
   rather than replacing them with staged upstream content.
5. Complete [Finishing an adoption](#finishing-an-adoption).

## Finishing an adoption

After `--apply` regenerates the lock and derived files:

1. Run `npm run smoke:npx -- --ref HEAD`, then `npm test` and
   `node scripts/validate.mjs`. The smoke check must run **after** the lockfile
   includes the new skill.
2. Commit the sync-generated lockfile, history, `NOTICE`, and README blocks,
   and merge the reviewed change into `main`.
3. Keep scheduled sync disabled until the release is published. On an updated
   `main`, create the annotated `v<release>` tag named by the lockfile at the
   merged release commit and push it. Do not tag the feature branch. Because
   the commit is already on the remote after a PR merge, this manual route
   cannot retroactively make commit and tag publication atomic. The merge
   push also deploys before the tag exists, and a tag push does not trigger
   `deploy-site.yml`; after tagging, re-run the prior deploy workflow so it
   fetches tags and recomputes publication. A follow-up commit on `main` also
   triggers a new deploy.

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
derived deterministically from the manifest plus the current staged content.
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
