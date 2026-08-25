# Final Verification Report

## Root-cause and TDD evidence

The interrupted diff was audited against `39dc8ac`. Its pre-fix code supplied
the RED evidence: planner and staging only `lstat`ed the final mapping path,
the planner treated matching `contentHash` as a no-op without comparing its
upstream tuple, `completeTransaction()` deleted backups without verifying a
pre-swap snapshot, and the deploy job accepted every successful update job.

The no-op deployment regression was made red during the resume: after adding
the requirement that `update.outputs.applied` must be exposed, it failed
because the workflow had no such job output. Adding that output and its deploy
gate made the same test green. Existing interrupted regressions were retained
only after checking that they prove the pre-fix semantic gaps above, rather
than trusting their passing state.

Focused regression matrix:

```text
node --test scripts/test/{baseline,update,sync,deploy-workflow,release-publication-workflow}.test.mjs
175 tests; 174 pass, 0 fail, 1 expected Windows POSIX-mode skip
```

It covers the ancestor-link escape in planner/baseline/update, all
repository/reference/source provenance fields plus dry-run/apply agreement,
edits after the clean check and after backup rename, validated version-2 and
legacy journal safety, locale-independent snapshot ordering, and
collision-resistant length-prefixed snapshot framing, and
main/feature/no-op/failure deployment combinations. The corrected version-2
partial-backup test, locale-order test, and concrete two-tree framing collision
test were each observed RED before their minimal implementation changes, then
GREEN.

Post-baseline adoption regression matrix:

```text
node --test scripts/test/{manifest,sync,update}.test.mjs
83 tests; 83 pass, 0 fail
```

The mapped-addition test was observed RED against the former fail-closed error,
then GREEN after the update engine learned to derive verified license,
provenance, lock, version, history, and generated catalog metadata. A separate
local-skill test was observed RED when the planner returned no additions, then
GREEN after declared local roots were included in planner/apply parity.
Post-apply validation failure also proves a newly adopted mapping rolls back
its skill tree, lock, and newly created history file.

## Merge-context baseline adoption

The pull request merge ref exposed 16 Google Play Console CLI skills that had
landed on `main` after the feature branch was cut. Exact registry coverage
correctly rejected them rather than silently treating them as local or orphan
content.

All 16 paths are now mapped to `tamtom/gplay-cli-skills` at commit
`10301b24639e4f768d009b2edda9315cb2149712` and included in the still-unpublished
`1.1.0` verified baseline. Fifteen vendored files were initially byte-identical
to that commit; `gplay-submission-checks` was older and was replaced with the
current upstream copy. The sync planner's own staged `preStampHash` values were
used for the baseline content hashes, closing a Windows parent-directory mode
variance found by the first real dry-run. A second real dry-run was a no-op.

The upstream-only `skills/gplay-preflight` directory remains reported as
`unadopted`; it was not added because it was not part of the 16 paths merged
from `main`. `gplay-submission-checks` contains an upstream-authored reference
to that skill, so the manifest records this known dependency without rewriting
the mirrored content.

## Final command results

| Check | Result |
| --- | --- |
| `npm test` | 341 tests; 340 pass, 0 fail, 1 expected Windows POSIX-mode skip |
| `npm --prefix site test` | 272 pass, 0 fail |
| `RELEASE_PUBLISHED=true npm --prefix site test` | 272 pass, 0 fail |
| `npm --prefix site run build` | Succeeded; 133 HTML files built; Pagefind indexed 119 pages, 11,477 words, and 3 filters |
| `npm --prefix site run test:e2e` | Built the site, started the configured Astro preview server, and passed 70 Playwright tests |
| `node scripts/validate.mjs` | 119 skills validated; 3 known upstream link exceptions |
| `node scripts/sync.mjs --dry-run --output <temp>` | 7 sources; 0 added, changed, removed, unavailable, or baseline-required; 365 upstream-only paths remain unadopted |
| `node scripts/smoke-npx.mjs --ref HEAD` | Full repo installed 119 of 119 skills; Azure subpath installed 9 of 9; single-skill install installed 1 of 1 |
| Workflow YAML parse/expression tests | 46 pass, 0 fail |
| `git diff --check` | Passed after the final report update |

The validator's known upstream exceptions are unchanged:

```text
skills/cloudflare/cloudflare/references/durable-objects/README.md -> ../websockets/README.md
skills/cloudflare/cloudflare/references/tunnel/README.md -> ../access/
skills/cloudflare/cloudflare/references/tunnel/README.md -> ../warp/
```

## Accepted operational prerequisites

- Windows may deny test symlink creation without Developer Mode or equivalent
  privilege. Each affected symbolic-link regression can skip independently on
  `EPERM`/`EACCES`; this verification host created those links, so its only
  skip was the POSIX mode-bit case. Linux CI executes the symbolic-link
  scenarios, while a separate Windows-only regression verifies junction
  rejection.
- Mappings must name canonical non-reparse paths. The boundary deliberately
  rejects symbolic links and junctions even when their current target remains
  inside the clone.
- Backup verification protects the demonstrated moved-backup overwrite window;
  it is not a global filesystem lock. Recovery preserves changed or
  snapshot-less validated journals for operator inspection.
- Ownership, ACL/security descriptors, extended attributes, and other
  non-portable metadata are outside the snapshot guarantee and must not be
  changed concurrently with an apply.

## Safety checks

No `v1.1.0` tag was created during merge-context adoption, so publication
remains pending. No commit was amended or force-pushed. Dry-run probes and
adoption helpers remained in the session workspace and were not added to the
repository.
