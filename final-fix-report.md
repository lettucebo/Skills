# Final Sync Hardening Report

## Scope

This report records the sync and release-safety fixes layered on
`39dc8ac3ded0a8e757ef0bf51d19d590a3a6b7db`, including the four final
high-confidence findings and the correctness hardening identified by final
review.

## Decisions and implementation

### 1. Baseline provenance uses the staged upstream tuple

`buildVerifiedLock()` now requires and records the staged
`repository`, `reference`, `source`, and `commit` for every mapped skill.
`transformStaged()` now emits `x-source-ref` alongside the existing source,
path, commit, and version stamps. This makes a pre-baseline migration with
identical content auditable from the lock, vendored frontmatter, and history.
The migration regression test also confirms that a cross-repository history
entry has `diffUrl: null`.

The update engine deliberately retains the existing per-skill behavior for an
unrelated upstream commit that leaves a mapped directory byte-identical. Its
lock commit and stamp describe the commit that actually supplied the current
vendored bytes; treating every new repository HEAD as a content update would
incorrectly release all mappings from that upstream. Existing scoped-update
and convergence tests demonstrate this invariant.

### 2. Candidate swaps have durable, recoverable transaction state

Before each destructive rename, the transaction journal records the ordered
target and its phase (`moving-to-backup`, `backed-up`, `placing-candidate`, or
`placed`). Startup acquires the repository lock, recovers an unfinished journal
before the normal clean-tree gate, and restores the pre-transaction live tree
from backups. A durable `validated` state is written before cleanup, so a later
startup only removes safe residual artifacts.

The journal lives in the common Git directory and is never committed. On POSIX,
the temporary record is synced, atomically renamed, then its parent directory
is synced. On Windows, where Node cannot sync a directory handle, the apply
uses one controlled PowerShell worker per transaction to call
`MoveFileEx` with `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH` for
every journal replacement. This is the documented Windows write-through
operation, not a retry or a best-effort fallback:
<https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa>.

Candidate and backup roots are checkout-local `.baseline-work-*` and
`.update-work-*` directories, which are already ignored. Keeping them on the
checkout filesystem preserves atomic `rename` for linked worktrees whose
common Git metadata resides on another volume; the lock and journal remain
repository-wide under common `.git`.

Before a transaction is marked `validated`, candidate bytes and checkout
targets are synced. POSIX target renames sync their affected directories;
Windows uses the same write-through worker for the target relocations. This
prevents a durable `validated` journal from authorizing cleanup before the
swapped live tree is durable.

### 3. Applies fail closed on ownership and concurrent edits

The apply lock uses exclusive `wx` creation in the common Git directory and
carries an owner token. Automatic stale-lock deletion was intentionally removed:
a read-then-delete recovery can race with another process that has just
acquired a replacement lock. Operators receive explicit guidance to verify and
remove a stale lock manually; release also verifies the owner token before
unlinking.

Baseline and update snapshot `git status --porcelain` before staging and
recheck it after the durable first-move intent is journaled and immediately
before the first live-to-backup rename. A change detected there aborts and
recovers without mutating the live tree. The regression tests inject a mapped
skill edit at that boundary and prove the edit, lock, journal, lockfile, and
history are preserved.

### 4. Pages setup is accurate and least-privileged

`actions/configure-pages@v5` documents that `enablement: true` requires a
credential other than `GITHUB_TOKEN`. The workflow therefore does not make a
false automatic-enable claim. Its build job grants only `contents: read` and
`pages: write`, checks `/repos/{owner}/{repo}/pages` with `gh api`, and fails
with the documented Settings > Pages prerequisite when the endpoint is absent.
The deploy job retains only `pages: write` and `id-token: write`.

Source: <https://raw.githubusercontent.com/actions/configure-pages/v5/action.yml>.

### 5. Manual release paths are restricted to main

`baseline-apply`, manual `update`, and reusable `deploy` now require
`github.ref == 'refs/heads/main'`. A feature-branch `workflow_dispatch` can
still run an explicit dry-run, but cannot baseline, update, or deploy. Scheduled
updates require both `main` and `SKILLS_SYNC_ENABLED == 'true'`. Direct
pull-request site runs remain build-only, while a main push can still deploy.

### 6. Clone mapping paths cannot escape through an ancestor link

`assertClonePathBoundary()` is shared by the dry-run planner and the common
baseline/update staging pipeline. Starting from the trusted clone root, it
`lstat`s every source component, rejects symbolic links and Windows junctions,
then `realpath`s every existing component and proves it remains below the
canonical clone root. It returns a missing final component to the existing
missing-source path so that unavailable-source reporting is retained.

The regressions create an ancestor directory link to content outside the clone
and prove that dry-run, baseline, and update all fail before staging, hashing,
or swapping. They assert that skills, lock, and history remain unchanged.
Windows link-creation permission failures are conditional skips; the same
symbolic-link scenarios run unconditionally on Linux CI. A separate
Windows-only regression creates an escaping junction and verifies that the
shared boundary rejects it before traversal.

### 7. Dry-run recognizes provenance-only migrations

The planner now compares the staged `repository`, `reference`, and `source`
tuple with the lock entry in addition to `contentHash`. A same-byte migration
is emitted in `changed` with `reason: "provenance-change"` and per-field
`from`/`to` evidence, so normal classification produces the same patch release
shape as `applyUpdate`.

The regression migrates all three tuple fields while preserving bytes, confirms
the dry-run entry and patch classification, then runs apply against the same
fixture and proves its changed paths and commit class agree.

### 8. Moved backups are verified and recovery fails closed

Before a transaction journal is created, every live swap target receives an
exact snapshot of path topology, bytes, symbolic-link targets, and
POSIX mode bits. Version-2 transaction journals persist those
expected snapshots. Immediately after each live-to-backup rename and before
candidate placement, the backup is checked against its expected snapshot.
Backups are checked again immediately before destructive cleanup.

The snapshot intentionally does not claim to preserve ownership, ACL/security
descriptors, extended attributes, or other metadata Node does not expose
portably. Concurrent-edit protection covers bytes, topology, link targets, and
the recorded mode bits; operators changing other metadata must serialize that
administrative work outside a sync apply.

An edit that reaches the moved backup through an open handle therefore aborts
and restores the backup instead of committing the candidate. A validated
journal with a changed backup, including a crash during recursive cleanup, now
preserves its journal, candidate, and remaining artifacts for manual recovery
rather than risking restoration of partial data. Legacy version-1 journals
remain recoverable while swapping; a snapshot-less validated version-1 journal
also fails closed for manual recovery. This closes the demonstrated overwrite
window without claiming an impossible global filesystem lock.

### 9. Baseline releases use the same explicit deployment handoff

`baseline-apply` now creates and atomically pushes the release tag with its
baseline commit, then emits `head_sha` after the push. The single reusable
Pages deploy caller depends on guard, baseline, and update, runs only on main
when exactly one apply job succeeded, and selects that successful job's
post-push SHA. This does not rely on tag or `GITHUB_TOKEN` downstream workflow
semantics, which GitHub recursive-run protection suppresses.

The update job also publishes its `steps.apply.outputs.applied` value. A
successful no-op update is therefore excluded from deployment: no new tree was
committed or tagged. The workflow expression matrix covers main and feature
refs, successful baseline and applied-update paths, no-op update, dry-run,
failure, and conflicting dual-success states. It also proves there remains
exactly one reusable deploy caller.

## Council and Rubber Duck review outcome

The final component-by-component review checked clone containment,
planner/apply tuple convergence, journal-version compatibility, partial-backup
recovery, POSIX mode-bit edits, and the Pages workflow truth table. Two
recovery guards were retained from the interrupted work after verification:
validated partial backups and snapshot-less legacy validated journals preserve
artifacts for manual recovery instead of replacing a candidate or deleting
evidence. The review also found and corrected the remaining deploy no-op gap:
a successful update job is insufficient unless its engine output says
`applied == 'true'`.

The independent final review found that the partial validated-backup regression
used a version-1 journal and therefore exercised only the legacy guard. The
fixture now records production-generated expected snapshots in a version-2
journal and accepts only the changed-backup failure. Snapshot traversal also
uses code-unit ordering rather than locale collation; a RED/GREEN regression
proves that changing host collation cannot change a persisted snapshot hash.
The reviewer then supplied a concrete NUL-delimiter collision between two
different directory trees. Snapshot fields and file bytes now use
length-prefixed framing, and the reproduced collision is a passing regression,
so the persisted digest is unambiguous rather than merely fail-closed in normal
edits.

The clone boundary deliberately rejects a mapping through any symbolic link or
junction even when its current target is inside the clone; an operator must map
the canonical non-reparse source instead. On Windows, the regression skips only
when the host denies test-link creation (`EPERM`/`EACCES`); Linux CI runs it.
The backup check is a demonstrated moved-backup verification, not a claim of
global filesystem locking. No retry was added, so persistent filesystem errors
remain visible rather than being hidden.
