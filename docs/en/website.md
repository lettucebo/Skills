# Website

[繁體中文](../zh-TW/website.md) | [**English**](../en/website.md) | [Documentation home](README.md)

The catalog website lives entirely under `site/` and is built from
`catalog/skills.lock.json` and `catalog/history/*.json` at build time — it
never queries the network at runtime. See [Architecture](architecture.md) for
how it fits into the overall data flow.

## Setup

```bash
npm --prefix site ci
```

## Local development

```bash
npm --prefix site run dev
```

Starts the Astro dev server. Because `astro.config.mjs` sets `base: '/Skills'`
and `trailingSlash: 'always'`, every route is served under the `/Skills/`
prefix with a trailing slash (for example `/Skills/status/`), matching the
published GitHub Pages URL structure.

## Build and Pagefind

```bash
npm --prefix site run build
```

Runs `astro build`, then a `postbuild` step runs `pagefind --site dist`
automatically to generate the full-text search index used by the catalog
search UI. The output lands in `site/dist/`.

## Preview

```bash
npm --prefix site run preview
```

Serves the already-built `site/dist/` (run `build` first) at the same
`/Skills/` base path, for a production-accurate local check.

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

## Restricted content on the site

Restricted skills (see [Installation](installation.md)) never have their
`SKILL.md` body rendered. Source and single-skill commands are suppressed for
restricted scopes; the full-registry command remains visible with an explicit
warning that it includes restricted skills — see
[Architecture](architecture.md#restricted-content-isolation).

## See also

- [Architecture](architecture.md) — the full manifest-to-site data flow.
- [Contributing](contributing.md) — when a change requires running the site
  test suite.
