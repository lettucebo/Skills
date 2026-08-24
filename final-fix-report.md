# Final Sync Planner Fix Report

## Scope

This follow-up fixes the remaining Important finding against
`fa0ecb7287a1a1f65e494d29e4d61c941a095d29`: dry-run planning had a
different staging policy from baseline/update application.

## Decision and implementation

`scripts/lib/hash.mjs` now owns `copyHashableDirectory`. It uses `lstat`
before deciding whether a path is excluded, rejects every symbolic link, and
uses the existing `isExcludedDirectoryName` and `isExcludedFileName` helpers.
This avoids duplicating the ignored-artifact policy.

Both `stageMappedSkills` and `planSync` call this helper. `planSync` also uses
`lstat` for every mapping source and rejects a mapping-source symlink with its
absolute source path. Consequently, a symlink named `node_modules` or
`.vscode` cannot be silently filtered before the fail-closed check. The
existing policy continues to exclude ignored caches and OS/editor artifacts
while retaining `.env`, which is explicitly tracked and hashed.

## TDD evidence

The new planner tests were written before the helper existed. Their initial
run failed because `copyHashableDirectory` was not exported. After the
minimal shared-helper implementation, the targeted regression command passed:

```text
node --test --test-name-pattern="symbolic|staging policy|false change" scripts/test/sync.test.mjs
4 pass, 0 fail
```

The tests cover a mapping-source symlink, nested `node_modules` and `.vscode`
symlinks, absent ignored staged artifacts with retained `.env`, and a verified
mapping that remains unchanged when ignored artifacts are present.

## Final verification

| Check | Result |
| --- | --- |
| `npm test` | 289 pass, 0 fail |
| `npm --prefix site test` | 272 pass, 0 fail |
| `npm run validate` | 103 skills validated; 3 known upstream broken links |
| `node scripts/sync.mjs --dry-run --output <temp>` | `dryRun=True`, 6 sources, 0 added, 0 changed, 0 unavailable |
| Browser E2E | Not rerun: this change does not touch `site/`; the `fa0ecb7` addendum in `files/e2e-verify/final-verification-report.md` records 70 passing Playwright tests |

An independent read-only review found no Critical or Important issues. The
review and tests confirm the planner and apply paths now share one staging and
hashing policy without changing the dry-run result format or clone behavior.
