# Project Guidelines

## Repository Scope

This repository is a versioned registry of AI coding-agent skills, not a
single application. It contains three connected products:

- Vendored and local skills under `skills/<source>/<skill>/`
- A Node.js registry/sync engine driven by `catalog/sources.yml`
- A static Astro + Pagefind catalog under `site/`, published at `/Skills/`

The root Node.js package owns registry validation, catalog generation, upstream
sync, release history, and `npx skills` smoke tests. The `site/` package is a
separate npm package with its own dependencies and test suite.

`hooks/` contains standalone Copilot hook scripts and is maintained
independently of the skill registry and sync transaction.

Root `instructions/` contains vendored instruction examples outside the skill
registry. It is not declared by `catalog/sources.yml` and is not validated as
installable skill content.

## Setup and Commands

Use Node.js 22, matching the GitHub Actions workflows.

`node scripts/sync.mjs --deproprietize` was the one-time, no-prior-tag
migration from unpublished `1.1.0` to publishable `2.0.0`. It atomically
removed the four proprietary anthropics mappings and directories, retained
tombstone/history audit state, and cannot be repeated.

```powershell
npm ci
npm --prefix site ci
```

### Registry and sync engine

```powershell
# All root tests (scripts/test only)
npm test

# One root test file
node --test scripts/test/manifest.test.mjs

# One named test within a file
node --test --test-name-pattern="rejects duplicate coverage" scripts/test/manifest.test.mjs

# Frontmatter, manifest coverage, unique names, layout, and relative links
npm run validate

# Networked, read-only upstream plan
node scripts/sync.mjs --dry-run --output sync-report/changeset.json

# Re-resolve licenses from lock-pinned upstream commits
node scripts/sync.mjs --refresh-licenses --output sync-report/license-refresh.json

# Verify npx installation against the current checkout
npm run smoke:npx -- --ref HEAD
```

`npm run catalog` invokes the one-time `--bootstrap` path. Do not use it for
routine updates after a verified baseline exists. Use `node scripts/sync.mjs
--apply` for declared post-baseline additions or upstream changes.
`node scripts/sync.mjs --baseline` is also a one-time migration from the
unverified `1.0.0` bootstrap to the verified `1.1.0` baseline; it is not an
onboarding path for later mappings.

### Catalog site

```powershell
# Build Astro output and Pagefind before the unit suite so dist-based tests run
npm --prefix site run build

# All site unit tests, including checks against the built output
npm --prefix site test

# One site unit test file
Push-Location site
node --test test/catalog.test.ts --import tsx
Pop-Location

# Fresh build plus all Playwright tests
npm --prefix site run test:e2e

# Fresh build plus one Playwright spec
npm --prefix site run test:e2e -- e2e/search.spec.ts
```

Playwright uses port 4331 by default and refuses to reuse an existing server.
Set `E2E_PORT` to another free port instead of attaching to a possibly stale
preview.

## Architecture and Data Flow

1. **Declaration:** `catalog/sources.yml` is the only hand-maintained registry
   definition. It declares upstream repositories, path mappings, frozen
   orphans, the local root, transforms, and explicit upstream link exceptions.
2. **Planning:** `scripts/sync.mjs` loads the manifest, clones each upstream
   once, stages declared skills, hashes upstream bytes before provenance
   transforms, and produces a deterministic change set. Upstream directories
   not declared in the manifest are reported as `unadopted`; they are never
   added automatically.
3. **Apply transaction:** `scripts/lib/baseline.mjs` builds and validates a
   complete candidate tree before swapping `skills/`, lock/history, `NOTICE`,
   generated README sections, and `catalog/licenses/`. The durable journal and
   backups are part of crash recovery and rollback; do not bypass them with
   direct copy logic.
4. **Materialized state:** `catalog/skills.lock.json` is the current release
   snapshot. `catalog/history/*.json` is the per-skill audit ledger. README
   catalog/install blocks and `NOTICE` are generated views of the same state.
5. **Website read model:** `site/src/lib/catalog.ts` reads the lockfile,
   histories, and allowed `SKILL.md` content at build time. Astro generates the
   catalog, install, source, skill, and status pages. The homepage groups
   browsable skills by source inside one canonical card collection; Pagefind
   supplies text-search matches over the static output. The site performs no
   runtime registry or GitHub API calls.
6. **Automation:** `validate.yml` runs root tests, site tests, and path-filtered
   E2E. `deploy-site.yml` builds on pull requests but deploys only non-PR runs.
   `sync.yml` invokes the same deploy workflow with the exact post-sync commit
   because bot pushes do not recursively trigger normal workflows.
   Workflow structure is itself tested under `scripts/test/*workflow.test.mjs`;
   preserve least-privilege permissions, path filters, the Pages prerequisite
   check, and build-before-test-before-upload ordering.
   These workflows target GitHub.com and GitHub Pages; do not assume artifact
   or Pages action versions are portable to GitHub Enterprise Server.

## Registry Invariants

- Every existing `SKILL.md` must be covered exactly once by `mappings`,
  `orphans`, or `local`. A source directory such as `skills/azure/` must not
  itself contain an installable `SKILL.md`.
- Skill frontmatter requires globally unique `name` and actionable
  `description` fields. Resolve upstream name collisions with a declarative
  entry in `overrides`; do not hand-edit a mirrored skill.
- Treat mapped skill content as an upstream mirror. Preserve its layout and
  style, including nonessential formatting differences. Put repository-owned
  skills only under `skills/lettucebo/` (create it when adding the first local
  skill); sync must never write that root.
- Provenance fields (`x-source`, `x-source-ref`, `x-source-path`,
  `x-source-commit`, `x-version`) are sync transforms. `contentHash` represents
  pre-transform upstream content; `snapshotHash` represents the stored skill.
  Reuse the hash helpers rather than calculating ad hoc hashes.
- Hashing covers vendored bytes under `skills/`. `.gitignore` deliberately
  re-includes skill-local build output, logs, and public upstream `.env` files
  so tracked bytes and hashes remain reproducible. Do not simplify those
  exceptions; only already-public, non-secret `.env` content may appear there,
  including under local skills. `node_modules/` remains excluded from both
  staging and hashing.
- Every lock entry carries structured `licenseEvidence`. Mapped evidence is
  resolved from the exact lock-pinned commit, never branch HEAD. Root-license
  text used by an entry is committed under `catalog/licenses/`; do not edit
  the bundle, lock evidence, history, or `NOTICE` independently.
- Manifest and upstream paths must stay inside their approved roots. Preserve
  traversal checks and the fail-closed rejection of symbolic links during
  staging and hashing.
- For a mapped or orphan adoption, update the manifest and skill tree together.
  A local skill under the already-declared `skills/lettucebo/` root needs no
  per-skill manifest entry. Update every root/site test that pins exact catalog
  counts or source inventories; `scripts/test/provenance.test.mjs` also carries
  approved source lists for the `microsoft` and `cloudflare` upstreams.
- Proprietary content must be added explicitly to `RESTRICTED_SKILL_PATHS` in
  `scripts/catalog.mjs`; this policy is not inferred from `LICENSE.txt`,
  frontmatter, or `catalog/sources.yml`. Verify the generated lock entry records
  `license: "Proprietary"` and `redistributable: false`.
- Commit the adoption declaration/content before running `sync --apply`. The
  completed `--deproprietize` migration was the sole exception: it changed the
  manifest and materialized state inside one journaled transaction. Apply
  requires a clean tree, a verified mapped baseline, reachable mapped sources,
  and fetched tags whose highest semantic `v*` tag exactly matches
  `lock.release` and is an ancestor of `HEAD`.
- New mapped, local, or orphan skills start at `1.0.0`. Any removed mapping
  (including a mapped rename/restructure) produces a major registry release;
  otherwise additions produce a minor release; otherwise an in-place mapped
  content or provenance-tuple change produces a patch release.
- Existing local/orphan content updates and removals are not handled by the
  current update engine: those lock entries pass through unchanged. Do not
  assume `sync --apply` will refresh their hash, version, or history without an
  explicit engine change and supported migration process.
- Mapping removals also pass deletion guards: groups with fewer than 10
  declared skills reject any removal; larger groups allow at most 30%.
  Unavailable upstreams are blockers and must never be interpreted as
  deletions.
- Do not hand-edit `catalog/skills.lock.json`, `catalog/history/`, `NOTICE`, or
  `catalog/licenses/`, or content between `CATALOG`/`INSTALL` markers in
  `README.md`. They must change together through the catalog/sync transaction.
- Root-license-only drift is intentionally not detected by ordinary
  `--apply`. Use explicit `--refresh-licenses`; additions and content/tuple
  updates still resolve evidence from the staged pinned commit.
- The release recorded in the lockfile and Git tag `v<release>` are distinct
  facts. Install commands always use `#vX.Y.Z` (never `@version`, a range, or a
  commit SHA). `v2.0.0` is the first publishable tag; `v1.1.0` must never be
  published.
- Scheduled apply remains disabled unless repository variable
  `SKILLS_SYNC_ENABLED` is exactly `true`. Enable it only after publishing the
  lockfile release tag; manual workflow dry-runs remain available.
- Broken relative links in mirrored content are only allowed through exact
  `linkExceptions` entries. Remove an exception when upstream fixes the link;
  do not patch the mirror locally.

## Skill and Documentation Conventions

- Each skill folder contains one required `SKILL.md` and optional
  `references/`, `scripts/`, or `assets/`. Keep `SKILL.md` under roughly 500
  lines and move detailed material to `references/`.
- Do not add README, CHANGELOG, or installation-guide files inside individual
  skill folders. Link to existing material instead of duplicating it.
- `docs/en/` and `docs/zh-TW/` are a synchronized bilingual documentation set.
  Update corresponding pages together and preserve their language-switch and
  relative links; DOC1-DOC4 in `scripts/test/docs.test.mjs` enforce this.
- Preserve the conventions of each upstream source. Read the nearest source
  documentation before structural changes, especially
  `skills/microsoft/Agents.md`, `skills/microsoft/skill-creator/SKILL.md`, and
  `skills/cloudflare/README.md`.
- When introducing a source, add `SOURCE_META` in `scripts/catalog.mjs`; the
  root README catalog is generated rather than manually enumerated.
- Hand-written README content is also tested: do not add stale hard-coded
  counts, recreate per-source skill tables, remove manifest/validator guidance,
  or contradict the current release/tag publication state.
- For Azure, Foundry, or other rapidly changing SDK guidance, verify current
  official documentation before changing imported technical instructions.

## Website Safety and Consistency

- Restricted skills are derived from `redistributable: false` in the lockfile.
  The site must never read or render their `SKILL.md` body and must not emit
  install/copy controls for them.
- Derive release labels, counts, restricted inventory, filters, and install
  commands from the lockfile. Do not duplicate exact skill counts in site code.
- Derive homepage navigation and source folders from non-tombstone skills so
  tombstone-only sources do not produce empty browsing UI. Keep one rendered
  card per browsable skill in a single canonical catalog collection.
- Source/license/origin filters operate directly on existing
  catalog cards without Pagefind. Only non-empty text queries load Pagefind.
  Do not reintroduce a second result list or runtime `innerHTML`; preserve
  stale-result protection, transient-load recovery, and initialization after
  the complete catalog DOM is available.
- Homepage source folders are native `<details>` elements, collapsed by
  default. Active search/filter results open folders with matches and hide
  empty folders; clearing restores the collapsed overview.
- Repository-root and single-skill `npx skills add` commands require
  `--full-depth`; source-subpath commands do not. Generate commands through the
  helpers in `site/src/lib/catalog.ts` rather than duplicating strings.
- `RELEASE_PUBLISHED` is a build-time, fail-closed flag: only the exact string
  `true` enables published install UX. The deploy workflow determines it from
  the real tag ancestry.
- Site build provenance is resolved after checkout with `git rev-parse HEAD`.
  A reusable workflow may build `inputs.ref`, so never use the inherited
  `github.sha` as the displayed commit. Build and site-test steps must consume
  the same `SITE_BUILD_COMMIT` and `SITE_BUILD_TIME` outputs.
- Theme choice supports Light, Dark, and System, persists explicit choices, and
  applies before first paint. Preserve the validated `scoutTheme=light|dark`
  preview override and live System preference behavior.
- Internal links and Playwright `baseURL` must include Astro's `/Skills/` base
  and trailing slash. A site test can be affected by changes under `site/`,
  `catalog/`, or `skills/`, because the static build reads all three.
- Keep URL sanitization and the restricted-content boundary in
  `site/src/lib/catalog.ts`/`url-policy.ts`; do not bypass them in page
  components or Pagefind rendering.

## Change Discipline

- Make surgical changes. Do not reformat or refactor unrelated imported skill
  content.
- Update tests that encode exact catalog counts or generated output whenever a
  registry transaction legitimately changes them.
- Commit messages use Conventional Commits in English: `feat` for a new skill
  or capability, `fix` for incorrect content/frontmatter/links, `docs` for
  documentation-only changes, and `refactor` for layout-only restructuring.
