# Council + Rubber Duck UX Fix Report

## Summary

Implemented all verified UI/UX findings from the Council + Rubber Duck review using strict TDD. All 39 new tests pass alongside 44 existing site tests (83 total) and 282 full repo tests.

## RED Phase — Failing Tests Before Implementation

30 new tests failed against current code (9 passed pre-existing matches for contrast calculation and structural matches). Tests covered:

- **A1–A9**: Contrast ratio calculations, accessible text tokens, reduced-motion, forced-colors
- **B1–B6**: Stale status content, favicon, aria-current nav, aria-hidden breadcrumbs, accurate stats
- **C1–C6**: Redundant aria-labels, noscript, no-JS dark theme, catalog hiding, no slice(0,20)
- **D1–D3**: Block card links, card descriptions, restricted guard
- **E1–E8**: InstallCommand component existence, copy button, aria-live, progressive enhancement
- **INT1–INT7**: Built HTML integration checks

## GREEN Phase — Changes Made

### A. Contrast and Visual Accessibility

**Files changed:** `site/src/styles/global.css`

| Decision | Rationale |
|----------|-----------|
| Added `--cp-warning-text: #7a4b00` (light) / `#fbbf24` (dark) | 6.75:1 and 7.11:1 contrast ratios vs. original 1.96:1 |
| Added `--cp-link-text: #0067b8` (light) / `#5aafff` (dark) | 5.27:1 and 4.78:1 vs. original 4.13:1 and 4.36:1 |
| Preserved original `--cp-warning` and `--cp-link` tokens | Decorative/border uses retain original values |
| Applied text tokens to: `a`, `.badge--pending`, `.badge--local`, `.pending-note`, `.breadcrumbs a`, `.detail-body a` | All text uses now meet WCAG AA 4.5:1 |
| Added `@media (prefers-reduced-motion: reduce)` for `.card`, `.card:focus-within` | Eliminates motion for users who prefer it |
| Added `@media (forced-colors: active)` for `.badge`, `.card`, `.warning-box` | Retains visible boundaries in high-contrast mode |
| Added `@media (prefers-color-scheme: dark)` for `html:not([data-theme])` | No-JS dark theme fallback while keeping scoutTheme as primary |

### B. Accurate UI Content and Navigation

**Files changed:** `site/src/pages/status.astro`, `site/public/favicon.svg` (new), `site/src/layouts/Layout.astro`, `site/src/pages/skills/[source]/[skill].astro`, `site/src/pages/sources/[source].astro`, `site/src/pages/index.astro`

| Decision | Rationale |
|----------|-----------|
| Removed stale "Search/filter is planned" from status page | Search/Pagefind is fully implemented |
| Created `site/public/favicon.svg` — accent-colored rounded rect with "S" | Simple, safe, uses existing `--cp-accent` color value |
| Added `aria-current="page"` to nav links via `isActive()` helper | Handles GitHub Pages `/Skills` base path |
| Added `aria-hidden="true"` to breadcrumb `/` separators | Decorative separators should not be announced by screen readers |
| Updated landing stats: total/synced/frozen/restricted | Accurate terminology with restricted count explicitly shown |

### C. Search/Filter UX and Progressive Enhancement

**Files changed:** `site/src/components/Search.astro`

| Decision | Rationale |
|----------|-----------|
| Removed `aria-label` from search input (keep `<label for>`) | Redundant — `<label for="search-input">` already provides accessible name |
| Removed `aria-label` from all 3 filter `<select>` elements | Each is wrapped in `<label>` with sr-only text |
| Added `<noscript>` info message about JS requirement | Users without JS see a clear message instead of broken controls |
| No-JS dark theme: `prefers-color-scheme: dark` on `html:not([data-theme])` | scoutTheme script remains primary; CSS fallback for no-JS |
| Search JS now hides `#full-catalog` when query/filter active | Clear state: either search results OR full catalog, never both |
| Catalog restores on: clear all criteria, Pagefind load error, search error | Graceful degradation in all error paths |
| Removed `slice(0, 20)` — renders all matching results | Only 103 skills total; all reported matches now reachable |

### D. Catalog Cards

**Files changed:** `site/src/pages/index.astro`, `site/src/styles/global.css`

| Decision | Rationale |
|----------|-----------|
| Card `<a>` now contains title, meta, and description | Block link fills card padding via negative margin technique |
| Added `.card a` block styling with negative margin / padding | Entire card is clickable; HTML5 allows flow content in anchors |
| Two-line descriptions via `loadSkillBody` for non-restricted skills | Uses existing `-webkit-line-clamp: 2` CSS |
| Restricted skills explicitly excluded from description loading | `loadSkillBody` already returns null; explicit skip avoids even the call |

### E. Install-Command Component

**Files changed:** `site/src/components/InstallCommand.astro` (new), `site/src/pages/index.astro`, `site/src/pages/skills/[source]/[skill].astro`, `site/src/pages/sources/[source].astro`

| Decision | Rationale |
|----------|-----------|
| Created reusable `InstallCommand.astro` component | Used by repo, source, and single-skill pages |
| Copy button has `aria-label="Copy install command"` | Explicit accessible name |
| `aria-live="polite"` feedback region for success/failure | Screen readers announce "Copied!" or error |
| Button starts `hidden`, JS reveals it | No-JS users don't see an inert control |
| Uses `navigator.clipboard.writeText` with try/catch | Catches failures; never silently claims success |
| Restricted pages render no InstallCommand | Existing `installCmd === null` guard |
| Release-pending note included in component | Single source of truth for pending warning |

## Verification Results

| Check | Result |
|-------|--------|
| UX hardening tests | 39/39 pass |
| Existing site tests | 44/44 pass |
| Full repo tests | 282/282 pass |
| Site build + Pagefind | 116 pages, 103 indexed |
| Restricted page: no copy/install/body | ✅ Verified |
| Public page: copy button, aria-hidden breadcrumbs | ✅ Verified |
| Index: noscript, card descriptions, restricted count, favicon | ✅ Verified |
| Status: no stale limitation | ✅ Verified |
| No unrelated registry/sync changes | ✅ Only site/ files modified |

## Files Modified

| File | Type |
|------|------|
| `site/src/styles/global.css` | Modified — tokens, anchor/badge colors, reduced-motion, forced-colors, card link, copy button styles |
| `site/src/layouts/Layout.astro` | Modified — aria-current nav links |
| `site/src/components/Search.astro` | Modified — remove redundant aria-labels, add noscript, hide catalog, render all results |
| `site/src/components/InstallCommand.astro` | **New** — reusable install command with copy |
| `site/src/pages/index.astro` | Modified — InstallCommand, descriptions, restricted count, full-catalog id |
| `site/src/pages/status.astro` | Modified — remove stale limitation |
| `site/src/pages/skills/[source]/[skill].astro` | Modified — aria-hidden breadcrumbs, InstallCommand |
| `site/src/pages/sources/[source].astro` | Modified — aria-hidden breadcrumbs, InstallCommand |
| `site/public/favicon.svg` | **New** — simple accent-colored SVG |
| `site/test/ux-hardening.test.ts` | **New** — 39 tests for all UX findings |

## Concerns

None. All behaviors verified. No scope creep beyond the verified findings.
