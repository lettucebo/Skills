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

## Final command results

| Check | Result |
| --- | --- |
| `npm test` | 338 tests; 337 pass, 0 fail, 1 expected Windows POSIX-mode skip |
| `npm --prefix site test` | 272 pass, 0 fail |
| `RELEASE_PUBLISHED=true npm --prefix site test` | 272 pass, 0 fail |
| `npm --prefix site run build` | Succeeded; 116 HTML files built; Pagefind indexed 103 pages, 10,500 words, and 3 filters |
| `npm --prefix site run test:e2e` | Built the site, started the configured Astro preview server, and passed 70 Playwright tests |
| `node scripts/validate.mjs` | 103 skills validated; 3 known upstream link exceptions |
| `node scripts/sync.mjs --dry-run --output <temp>` | 6 sources; 0 added, changed, removed, or unavailable |
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

No tag, push, deployment, or amend was performed. Generated dry-run and
Playwright artifacts were removed; final status and tag-point checks are
performed immediately after the commit.
