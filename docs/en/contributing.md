# Contributing

[繁體中文](../zh-TW/contributing.md) | [**English**](../en/contributing.md) | [Documentation home](README.md)

## Environment setup

Requires Node.js 22 (matching `.github/workflows/*.yml`). Install both the
root and site dependencies before running anything:

```bash
npm ci
npm --prefix site ci
```

## Validation commands

Run the smallest command that covers your change; escalate only as needed.

**Targeted root test** — one specific test file:

```bash
node --test scripts/test/docs.test.mjs
```

**Named root test** — tests matching a name pattern, across every root test
file:

```bash
node --test --test-name-pattern="DOC1" "scripts/test/**/*.test.mjs"
```

**Full root test** — every root test file:

```bash
npm test
```

**Pinned license metadata refresh** — real, networked metadata transaction;
run only from a clean tree whose current release tag is reconciled:

```bash
node scripts/sync.mjs --refresh-licenses --output sync-report/license-refresh.json
```

**Validator** — structural checks across the whole `skills/` tree
(frontmatter, manifest coverage, relative links):

```bash
node scripts/validate.mjs
```

**Enrichment safety validator** — always-on schema, path, restricted-content,
and enabled-directory checks. Missing and stale artifacts deliberately pass:

```bash
npm run validate:enrichment
```

**Enrichment strict validator** — publishing-only completeness and freshness
checks in addition to the default safety rules. Changelog locale signatures
must also match the pinned prompt, model, converter, and generator version:

```bash
npm run validate:enrichment -- --strict
```

**Changelog enrichment** — full-history generation for every eligible mapped
skill. The generator clones each distinct upstream once, stops at each
lockfile-pinned commit, sends all path-scoped commit patches for one skill in
one Copilot call, writes `en` and `zh-tw`, derives `zh-cn` with OpenCC, prunes
forbidden artifacts, and enables the manifest only after the complete set
passes strict validation:

```bash
npm run enrich:changelog
```

Use a path or unique skill name for a targeted cache warm-up or diagnosis.
Targeted generation never enables the global manifest:

```bash
npm run enrich:changelog -- --skill skills/github/github-issues
```

**Changelog check** — performs no clone, Copilot call, or write. It verifies
the enabled artifact set, full provenance freshness tuple, and locale
signatures:

```bash
npm run enrich:changelog -- --check
```

**Enrichment prune** — deterministic deletion of artifacts for skills that
became ineligible for their artifact kind, became tombstones, or left the
lock. This command never calls an LLM or the network:

```bash
npm run enrich:prune
```

**Site build-before-unit sequence** — required because a few site unit tests
assert against the built `site/dist/` output and otherwise skip themselves:

```bash
npm --prefix site run build
npm --prefix site test
```

**One site test**:

```bash
cd site
node --test test/catalog.test.ts --import tsx
```

**Full E2E**:

```bash
npm --prefix site run test:e2e
```

**One E2E spec** (build first, since the suite always serves the built
`dist/`):

```bash
cd site
npm run build
npx playwright test search.spec.ts
```

## Site translation conventions

All site-owned user-visible text belongs in the typed dictionaries under
`site/src/i18n/`; do not add locale ternaries or duplicate translated literals
inside page components or client scripts. Add every key to `en`, `zh-tw`, and
`zh-cn` together. Keep skill names, source names, raw `SKILL.md` descriptions
and bodies, install commands, URLs, technical proper nouns, and original
upstream commit subjects unchanged.

Use `localizedPath()` and the route-preserving locale helper for internal
links so `/Skills/`, the locale prefix, and trailing slash remain consistent.
Localized dynamic routes must expand all supported locales and call
`assertLocale()` so unsupported values fail closed. Legacy route files remain
small redirect wrappers and must preserve the exact English logical target.

When changing i18n behavior, run the focused locale/path and route tests, then
build before running the complete site unit suite so route counts and Pagefind
language indexes are checked against real output. Unit tests must consume the
prebuilt `dist/`; the AST regression under `site/src/lib/` rejects any unit
test that launches `npm run build`.

## Skill-affecting changes: run the smoke check

Whenever you add a skill, rename a skill, or change how it is meant to be
installed, first run `node scripts/sync.mjs --apply` so the lockfile reflects
the committed skill inventory, then run the smoke command below. Apply
requires the clean-tree, verified-baseline, reachable-upstream, and
tag-reconciliation conditions in
[Skill management](skill-management.md#preconditions-for-onboarding-any-new-skill).

Mapped and orphan additions must also update the fixed counts in
`scripts/test/provenance.test.mjs`; additions under the `microsoft` or
`cloudflare` upstream must update that test's exact approved source list.
These changes are required before the workflow's pre-apply `npm test`.

```bash
npm run smoke:npx -- --ref HEAD
```

This drives the pinned `npx skills` CLI against your local checkout (not a
published tag) for the full-registry, single-source, and single-skill
scopes, and confirms the renamed `*-mcp-builder`/`*-skill-creator` skills are
present and that the pinned CLI still exposes the exact flags this registry
depends on (`--agent`, `--skill`, `--yes`, `--copy`, `--full-depth`).
`--ref` only affects the example install commands echoed in its summary
output, not the local content actually being installed.

Running the smoke check before apply is expected to fail for a new skill:
the local folder and the lockfile would describe different inventories.

## When site testing is required

Any change under `skills/` or `catalog/` can change what the site renders,
because the site's loader reads `catalog/skills.lock.json` and
`catalog/history/*.json` directly. Run the site unit tests (and the E2E suite,
if the change is more than cosmetic) whenever you touch those trees, not only
when you touch `site/` itself.

## CI triggers, exactly

- The root `validate` job (`npm test` + `node scripts/validate.mjs`) runs on
  every `pull_request` and every `push` — no path filter.
- The **site unit-test job runs unconditionally** on every push and pull
  request, including docs-only changes, for the same reason as above.
- **E2E is path-filtered**: it only runs when a push or pull request touches
  `site/**`, `catalog/**`, or `skills/**`. A docs-only change (like this one)
  does not trigger it.

## Generated files, mirrored content, and freshness

- Never hand-edit `catalog/skills.lock.json`, `catalog/history/*.json`,
  `catalog/licenses/`, `NOTICE`, or the
  `<!-- CATALOG:START -->`/`<!-- INSTALL:START -->` blocks in
  the root `README.md` — they are sync output (see
  [Skill management](skill-management.md#why-generated-outputs-cannot-be-edited-independently)).
- Preserve each vendored skill's upstream content and layout faithfully;
  route any genuinely upstream-side fix (including a broken link) through a
  `linkExceptions` entry or an upstream contribution, not a silent local
  edit (see [Skill management](skill-management.md#upstream-broken-link-exceptions)).
- Before writing new SDK- or platform-specific guidance into a skill, verify
  it against current official documentation rather than relying on training
  data that may already be stale.

## Enrichment validator tiers

`catalog/enrichment/manifest.json` is the durable enablement state. Directory
existence is never treated as enablement, so deleting a generated directory
cannot silently turn validation off.

Tier 1 is the existing `validateRepository` call inside the atomic
baseline/update transaction. It remains completely unaware of enrichment so a
stale optional sidecar cannot roll back a legitimate registry sync. Tier 2
default (`npm run validate:enrichment`) always blocks forbidden or malformed
artifacts in directories that exist, including artifacts for skills absent
from the lock. Disabled kinds require no directory and no complete artifact
set. Missing and stale eligible artifacts pass. Tier 2 strict adds exact-set
completeness and freshness for enabled kinds, validates current changelog
locale signatures, and is reserved for first enablement and publishing a
complete enrichment artifact update. Routine registry sync remains able to
rely on the site's stale/missing fallback.

Eligibility is computed per kind: summaries include every non-tombstone,
non-restricted skill; changelogs additionally require a non-null `upstream`.
Mapped skills use their pre-transform `contentHash` for freshness. Orphan and
local summaries use `snapshotHash`.

Generate or refresh structured summaries with:

```bash
npm run enrich:summaries
npm run enrich:summaries -- --skill skills/vscode/code-review
npm run enrich:summaries -- --check
```

The generator filters eligibility from the lock before reading `SKILL.md`,
makes one Copilot request per stale or missing skill for both authored
locales, derives `zh-cn` deterministically, and prunes forbidden artifacts
only after a successful run. `--check` never generates or writes files and
fails when a selected artifact is missing, stale, or signature-mismatched.
The manifest is enabled only after the complete summary set passes strict
validation.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/), written
in English even when the change is documentation-only:

```
docs: add bilingual documentation set under docs/
```

## See also

- [Skill management](skill-management.md) — the onboarding steps these
  commands validate.
- [Website](website.md) — the full site command set.
