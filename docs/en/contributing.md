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

**Validator** — structural checks across the whole `skills/` tree
(frontmatter, manifest coverage, relative links):

```bash
node scripts/validate.mjs
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
  `NOTICE`, or the `<!-- CATALOG:START -->`/`<!-- INSTALL:START -->` blocks in
  the root `README.md` — they are sync output (see
  [Skill management](skill-management.md#why-generated-outputs-cannot-be-edited-independently)).
- Preserve each vendored skill's upstream content and layout faithfully;
  route any genuinely upstream-side fix (including a broken link) through a
  `linkExceptions` entry or an upstream contribution, not a silent local
  edit (see [Skill management](skill-management.md#upstream-broken-link-exceptions)).
- Before writing new SDK- or platform-specific guidance into a skill, verify
  it against current official documentation rather than relying on training
  data that may already be stale.

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
