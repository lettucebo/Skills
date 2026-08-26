# Sync and releases

[繁體中文](../zh-TW/sync-and-releases.md) | [**English**](../en/sync-and-releases.md) | [Documentation home](README.md)

This page documents `scripts/sync.mjs` and the workflow that drives it end to
end. For the manifest fields it reads, see [Configuration](configuration.md);
for how a specific skill is added, see [Skill management](skill-management.md).

## Three modes

### Dry-run (the default)

```bash
node scripts/sync.mjs
```

```bash
node scripts/sync.mjs --dry-run
```

Both forms compute the identical, read-only change set: every upstream
referenced by at least one mapping is cloned into a temporary workspace,
mapped skills are staged and hashed, and the resulting
added/changed/removed/unavailable/unadopted/baseline-required lists, SemVer
classification, deletion-guard verdict, and
`baseline: { ready, blockers }` go/no-go summary are returned as JSON.
Declared upstreams with no mapping are not cloned. **Neither form ever writes
to the repository** — `--dry-run` only changes the `dryRun` field recorded in
the output JSON, not the behavior.

### Apply

```bash
node scripts/sync.mjs --apply
```

Performs a real update: re-stages every mapped skill, computes what changed
since the lockfile, and — if there is anything to apply — writes the updated
`catalog/skills.lock.json`, `catalog/history/*.json`, skill directories,
`NOTICE`, and the generated README blocks through an atomic transaction (see
[Transaction safety](#transaction-safety-journal-rollback-crash-recovery)
below). It requires every mapped skill's lockfile entry to already have a
verified baseline and a clean working tree. At least one semantic release tag
must exist; the highest `v*` semantic tag must exactly equal the lockfile's
`release` and be an ancestor of `HEAD` (see
[Skill management](skill-management.md#preconditions-for-onboarding-any-new-skill)).
If nothing changed, it returns `applied: false` and writes nothing.

**`--apply` never commits or tags.** Committing and pushing the tag is always
a separate step performed by the calling workflow (or you, locally) — see
[The daily and manual workflow sequence](#the-daily-and-manual-workflow-sequence).

### Baseline (one-time)

```bash
node scripts/sync.mjs --baseline
```

Migrates the registry from its initial `1.0.0` bootstrap (where every mapped
skill's baseline is `unverified`) to a fully verified `1.1.0` baseline. It
requires explicit baseline mode and a clean tree, and refuses to run more than
once: the lock `release` must still be exactly `1.0.0`, every mapped skill must
still be `unverified`, no history may contain `baseline-verified`, and the
target tag must not exist. Every mapped source must also be reachable and
staged, and the baseline availability guard must pass. A failure exits rather
than silently repeating or partially establishing the baseline.

`--apply`, `--baseline`, and `--dry-run` are mutually exclusive; combining any
two is rejected before any work starts.

On Windows, apply and baseline require `powershell.exe` for durable journal
replacement; the engine refuses to start the transaction if it is
unavailable.

## Machine-readable output (`--output`)

`--output <path>` behaves differently per mode:

- **Dry-run** (with or without `--dry-run`): writes the JSON to the given file
  **instead of** stdout.
- **Apply**: writes the JSON to **both** the given file **and** stdout.
- **Baseline**: `--output` is **not supported**. The baseline branch always
  writes its result to stdout only and returns without writing an output
  file at all, even if `--output` is passed.

Workflow jobs rely on this: the dry-run job uploads
`sync-report/changeset.json` as a build artifact, and the update job uploads
`sync-report/result.json` — both read directly from the file `--output`
wrote.

## Content hashing and provenance

Every mapped skill is staged from its upstream clone using the same
exclusion and symlink policy the apply path uses, then hashed **before** any
transform or stamping — that pre-transform hash is exactly the value that
becomes a verified `contentHash` in the lockfile. Only after hashing does the
engine stamp upstream provenance onto the skill's `SKILL.md` frontmatter:
`x-source`, `x-source-ref`, `x-source-path`, `x-source-commit`, and
`x-version`.

Orphan and local skills have no upstream to hash against; their lockfile
`snapshotHash` instead records the hash of the committed tree itself, and
their `upstream` field is `null`.

## Transaction safety: journal, rollback, crash recovery

`--apply` and `--baseline` write through a durable transaction:

- workflow runs are serialized by the `sync-upstream-skills` concurrency
  group (`cancel-in-progress: false`), so a second dispatch waits rather than
  cancelling the active one,
- an **apply lock** file prevents two sync runs from mutating the repository
  at the same time,
- a **transaction journal** records the swap-in-progress so that a crash
  mid-swap can be detected and resolved (rolled forward or back) the next
  time any apply command runs, and
- after swapping candidate content into place, both `node scripts/validate.mjs`
  and an internal structural-integrity check must pass — if either fails, the
  swap is rolled back from its backup automatically. If the rollback itself
  fails, the error reports the backup location and preserves it for manual
  recovery instead of deleting it.

The lock is `.skills-sync-apply.lock` and the journal is
`.skills-sync-transaction.json`; both live in the Git common directory shown
by `git rev-parse --git-common-dir`. Stale locks are never reclaimed
automatically. After an interrupted run, verify the recorded process/host no
longer owns the lock, remove **only** the stale lock, preserve the journal,
and rerun the same apply command. The next run acquires a new lock and uses
the journal to roll forward or back. If recovery reports a preserved backup,
follow that exact path instead of deleting it.

## Change classification and release effects

The diff between the manifest/staged content and the current lockfile is
classified with strict precedence:

| Condition | Class | Release effect |
|---|---|---|
| Any removed mapping (including a rename/restructure represented as removal plus addition) | `major` | `feat(skills)!: sync upstream changes` |
| Otherwise, any addition | `minor` | `feat(skills): sync new upstream skills` |
| Otherwise, any in-place change | `patch` | `fix(skills): sync upstream updates` |
| Nothing changed | `none` | no commit; `applied: false` |

## Clone-unavailable and deletion guard behavior

An upstream that fails to clone (network failure, revoked access, removed
repository) is **never** treated as if its skills were deleted — it hard-
blocks the run instead, both in dry-run reporting and in apply/baseline,
which refuse outright when any mapped source is unavailable. Removals that
are genuinely declared (a mapping dropped from the manifest) instead go
through the shared deletion guard described in
[Skill management](skill-management.md#deletion-guard). The dry-run planner
and normal update engine share `buildDeletionGroups`, so their lifecycle
removal verdicts match. The one-time baseline engine does not perform mapping
removals; it independently requires every mapped source to stage and runs an
availability guard with `removed: 0`.

## The daily and manual workflow sequence

`.github/workflows/sync.yml` defines five jobs:

1. **`guard`** — always validates the workflow inputs first and fails when
   `baseline=true` is combined with `dry_run=true`. Every other job depends on
   this gate.
2. **`dry-run`** (manual dispatch, `dry_run=true`, `baseline=false`) — runs
   `npm test`, `node scripts/validate.mjs`, then
   `node scripts/sync.mjs --dry-run --output sync-report/changeset.json`, and
   uploads the JSON artifact. On failure it opens or updates a single, stable
   tracking issue rather than creating a new one each time.
3. **`baseline-apply`** (manual dispatch, `baseline=true`, `dry_run=false`,
   `main` only) — runs tests and validation, then
   `node scripts/sync.mjs --baseline`, re-validates, and only then performs
   the commit and tag **itself**: `git commit`, `git tag -a v<release>`, and
   an atomic `git push --atomic origin HEAD:<branch> refs/tags/v<release>`.
   The sync engine never does this; the workflow does.
4. **`update`** (`main` only) — runs on the daily `0 3 * * *` schedule (gated by
   `SKILLS_SYNC_ENABLED == 'true'`) or on a manual non-baseline,
   non-dry-run dispatch. It runs tests and validation, then
   `node scripts/sync.mjs --apply --output sync-report/result.json`, reads the
   `applied` field from that file, and — only when `applied` is `true` —
   commits with the engine's exact `commitMessage`, tags with its exact
   `nextTag`, and pushes both atomically. A no-op sync (`applied: false`)
   produces no commit at all. On failure, it opens or updates one stable
   `Daily upstream update failing` tracking issue and attaches the update
   report when available.
5. **`deploy`** (`main` only) — runs after exactly one of `baseline-apply` or `update`
   succeeds (and, for `update`, only when it actually applied something). It
   deploys the specific commit SHA that job just pushed, not the workflow's
   original triggering SHA, because a reusable workflow otherwise inherits
   the caller's pre-sync commit.

A manual apply or baseline dispatch from a non-`main` ref does not fail: the
apply and deploy jobs are skipped, so the workflow can appear green while
performing no sync. Select `main` for every mutating dispatch. A manual
dry-run may run on another ref because it never writes.

## See also

- [Architecture](architecture.md) — how these pieces fit into the overall
  data flow.
- [Website](website.md) — how `RELEASE_PUBLISHED` and the release tag feed the
  deployed site.
