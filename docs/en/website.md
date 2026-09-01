# Website

[繁體中文](../zh-TW/website.md) | [**English**](../en/website.md) | [Documentation home](README.md)

The catalog website lives entirely under `site/` and is built from
`catalog/skills.lock.json`, `catalog/history/*.json`, and fresh enabled
`catalog/enrichment/changelog/*.json` sidecars at build time — it never
queries the network at runtime. See [Architecture](architecture.md) for how it
fits into the overall data flow.

## Setup

```bash
npm --prefix site ci
```

## Local development

```bash
npm --prefix site run dev
```

Starts the Astro dev server. Astro uses prefix-all i18n routing for `en`,
`zh-tw`, and `zh-cn`, while retaining `base: '/Skills'` and
`trailingSlash: 'always'`. Every localized route therefore includes the site
base, locale, and trailing slash (for example `/Skills/en/status/` or
`/Skills/zh-tw/skills/github/github-issues/`).

The language switcher uses native links and preserves the current logical
home, install, status, source, or skill route. An explicit selection is saved
for the legacy `/Skills/` entry point only; it never overrides a directly
requested localized URL. Every former unprefixed route remains as a static
redirect with an English meta-refresh/canonical/anchor fallback, while the
root redirect may choose the saved or browser locale when JavaScript runs.

## Build and Pagefind

```bash
npm --prefix site run build
```

Runs `astro build`, then a `postbuild` step runs `pagefind --site dist`
automatically to generate the full-text search index used by the catalog
search UI. Pagefind reads each page's `<html lang>` and emits separate English,
Traditional Chinese, and Simplified Chinese indexes. Only localized skill
pages opt in with `data-pagefind-body`; legacy redirects and catalog/status
pages are excluded. The output lands in `site/dist/`.

## Structured skill summaries

Eligible skills have a human-oriented summary artifact with separate
**Purpose**, **When to use**, and **Outputs** fields. Detail pages render all
three fields, and Pagefind indexes them as part of the existing skill page.
Catalog cards use the summary purpose instead of the agent-trigger
frontmatter description.

Summary artifacts are accepted only when enrichment is enabled and the
artifact is fresh for the current lock entry. Each localized route requests
its matching enrichment locale. If that locale is disabled, missing, stale,
or invalid, the detail summary is omitted and its catalog card falls back to
the unchanged frontmatter description; generated English text is never used
as a Chinese fallback. Restricted skills are excluded before enrichment files
or `SKILL.md` content are read.

## Preview

```bash
npm --prefix site run preview
```

Serves the already-built `site/dist/` (run `build` first) at the same
`/Skills/` base path, for a production-accurate local check. Open a localized
route such as `/Skills/en/` rather than relying on the legacy redirect.

## Unit tests

```bash
npm --prefix site test
```

Runs `node --test src/**/*.test.ts test/**/*.test.ts --import tsx`. This
suite does not require a prior build to run: most tests exercise source
modules directly, and the small number of tests that assert against the
built `site/dist/` output (for example the Pagefind index) detect its absence
and skip themselves rather than fail on a clean checkout. Because of that,
CI additionally re-runs this suite immediately after `build` (see
[Contributing](contributing.md)) so the guarded tests execute for real at
least once before anything is deployed.

## End-to-end tests

```bash
npm --prefix site run test:e2e
```

Runs `npm run build` first, then the Playwright suite against a **fresh**
`astro preview` server on port `4331` by default — the suite never reuses an
already-running server, so a stray process on that port fails the run
loudly instead of silently testing a different build. Override the port with
`E2E_PORT` if `4331` is occupied (see
[Configuration](configuration.md#e2e_port)). The `baseURL` always includes the
`/Skills/` prefix to match the deployed site.

## Published vs. pending rendering

The site renders differently depending on whether the current lock
`release` has actually been published as a tag:

- **Published** (`RELEASE_PUBLISHED=true`) — install commands and the status
  page report the release as installable.
- **Pending** (anything else, including unset) — the status page reports the
  release as not yet tagged, so a build from an unpublished tree never
  advertises an install command that would fail.

`RELEASE_PUBLISHED` is always computed by the deploy workflow from real tag
ancestry and passed in as a build-time environment variable — it is never a
setting you configure on the site itself. See
[Configuration](configuration.md#release_published-is-not-operator-configured)
for the full explanation.

## Registry history and upstream changes

Eligible mapped skill pages can show two separate timelines:

- **Upstream changes** lists every non-merge upstream commit that affected the
  skill's `SKILL.md` through the exact commit pinned in the lockfile. Each
  entry links directly to that repository commit, preserves the original
  upstream subject, and uses the current route's localized generated summary.
- **History** remains the registry-release ledger from
  `catalog/history/*.json`, showing when this registry adopted or versioned
  the skill.

The two timelines are intentionally not combined: one describes upstream Git
history and the other describes registry releases. A missing or invalid
Chinese generated summary never falls back to English; when safe commit
metadata remains available, the original subject and metadata render without
a generated summary. Ineligible or unavailable changelog data is omitted while
the existing History section continues to render.

## Restricted content on the site

Restricted skills (see [Installation](installation.md)) never have their
`SKILL.md` body rendered. Source and single-skill commands are suppressed for
restricted scopes; the full-registry command remains available and installs
restricted skills, but the site no longer places an on-page restricted-content
warning beside it — consult `/Skills/en/status/` (or another locale) or the lockfile for the current
restricted inventory and licensing (see
[Architecture](architecture.md#restricted-content-isolation)).
Restricted and orphan pages also never read or render upstream changelog
sidecars.

## See also

- [Architecture](architecture.md) — the full manifest-to-site data flow.
- [Contributing](contributing.md) — when a change requires running the site
  test suite.
