# Final Sync Hardening Report

## Scope

This report records the five final sync and release-safety fixes against
`dba1df082f5ae8a232b992b1551a9c38c95d7f4f`, plus the correctness hardening
identified during the final review.

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

## Review outcome

The final Council/Rubber Duck pass examined phase ordering, journal durability,
linked-worktree paths, recovery semantics, lock ownership, user-edit timing,
Pages credentials, and the workflow expression matrix. Independent read-only
reviews found and drove fixes for journal directory durability, stale-lock
reclamation, final pre-swap timing, linked-worktree cross-device renames, and
Windows write-through durability. The proposed commit-only update change was
rejected with test evidence because it would violate the per-skill provenance
and scoped-release contract described above.

No transient Windows `EPERM` was observed. No retry was added, so persistent
filesystem errors remain visible rather than being hidden.
