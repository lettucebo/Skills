# Task 3 Report

## Scope completed

1. Extracted `createLinkExceptionKey` into a shared implementation in `scripts/lib/links.mjs`.
2. Rejected manifest link exception `sourcePath` values that are outside any discovered skill root.

## Decisions

### 1. Shared `createLinkExceptionKey` location

- **Option A — keep duplication in `manifest.mjs` and `validate.mjs`**
  - Pros: no new export surface.
  - Cons: preserves drift risk between manifest loading and validation matching.
- **Option B — extract to `scripts/lib/links.mjs`**
  - Pros: focused existing links library, reused by both manifest loading and validation, smallest diff.
  - Cons: slightly broadens the links module API.

**Chosen:** Option B, because both call sites are part of link exception handling and `links.mjs` is the narrowest shared home.

### 2. Where to reject invalid `linkExceptions[].sourcePath`

- **Option A — keep manifest permissive and let repository validation fail later**
  - Pros: no manifest logic change.
  - Cons: produces misleading stale-exception errors for files the walker never visits.
- **Option B — reject during manifest load using discovered skill roots**
  - Pros: fails at the configuration boundary with a precise error and matches actual walker scope.
  - Cons: adds one more manifest validation rule.

**Chosen:** Option B, because it fixes the root cause rather than a downstream symptom.

## TDD evidence

### RED

Focused manifest test run failed before implementation:

```text
npm test -- scripts/test/manifest.test.mjs
SyntaxError: The requested module '../lib/links.mjs' does not provide an export named 'createLinkExceptionKey'
```

This proved the new shared-helper test was exercising missing production behavior first.

### GREEN

Focused tests passed after the implementation:

```text
npm test -- scripts/test/manifest.test.mjs scripts/test/validate.test.mjs
29 tests passed, 0 failed
```

## Verification evidence

```text
npm test
32 tests passed, 0 failed
```

```text
node scripts/validate.mjs
Validated 99 skills
4 known upstream broken links
```

The four existing link exceptions were preserved; no mirrored skill files were changed.

## Council and Rubber Duck self-review

- Verified the shared helper is imported by both `scripts/lib/manifest.mjs` and `scripts/validate.mjs`.
- Verified manifest validation now checks discovered skill roots before file existence.
- Verified the new non-skill-root fixture fails manifest load with a direct configuration error instead of a later stale-exception message.
- Verified repository-level tests and validation remain green after the refactor.

## Minor notes carried forward only

- Actions are tag-pinned rather than SHA-pinned.
- `pathExists` still uses `access`.
- `upstreamUrl` format is not validated.
