# Configuration

[繁體中文](../zh-TW/configuration.md) | [**English**](../en/configuration.md) | [Documentation home](README.md)

This page documents the declarative manifest that drives the registry, and
the operator-facing settings around sync, Pages, and testing. For the daily
sync/release mechanics themselves, see [Sync and releases](sync-and-releases.md).

## The manifest: `catalog/sources.yml`

`catalog/sources.yml` is the single declared source of truth for every skill
path under `skills/`. Every skill directory that contains a `SKILL.md` must be
covered by **exactly one** of `mappings`, `orphans`, or a declared `local`
root — an uncovered or double-covered path fails manifest loading.

The `upstreams` map and the `mappings`, `orphans`, `local`, and `overrides`
arrays are required even when an array is empty. Only `linkExceptions` may be
omitted (it defaults to an empty array).

### `upstreams`

A named map of upstream repositories:

```yaml
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
```

`reference` must be a branch or tag (`refs/heads/...` or `refs/tags/...`);
a bare 40-character commit SHA is rejected outright so every clone is
reproducible against a named, movable ref rather than a frozen commit that
can silently drift out of sync with its branch.

### `mappings`

Declares a skill as vendored from a named upstream:

```yaml
mappings:
  - path: skills/azure/az-cost-optimize
    upstream: awesome-copilot
    source: skills/az-cost-optimize
```

`path` is the destination inside this repository; `source` is the path inside
the upstream repository. `path` must already exist on disk with a `SKILL.md`
— you add the skill folder and its manifest entry together.

License restrictions are **not** declared in this YAML manifest. Before
adopting proprietary content, add its destination path to
`RESTRICTED_SKILL_PATHS` in `scripts/catalog.mjs`; otherwise the catalog
defaults it to `redistributable: true`, even when a `LICENSE.txt` is detected
as proprietary. The generated lockfile is the resulting public inventory, not
the place to set this policy. Update apply preserves an existing lock entry's
license and redistribution fields, so correcting a missed classification
after adoption requires a reviewed engine/data migration with tests; adding
the path later is not enough.

### `orphans`

Declares a frozen snapshot with no tracked upstream:

```yaml
orphans:
  - path: skills/dotnet/csharp-mcp-server-generator
    note: No verified upstream source repository is currently documented for this skill.
```

Orphan skills are never touched by sync; they only move in the lockfile when
first adopted (see [Skill management](skill-management.md)).

### `local`

Declares a root reserved for skills original to this repository:

```yaml
local:
  - root: skills/lettucebo
    note: Reserved for future local/original skills.
```

Sync refuses to replace local content with staged upstream content.
`skills/lettucebo` is additionally protected unconditionally from mappings,
independent of the `local:` declaration. During first adoption the transaction
copies the committed local tree through its candidate swap, but verifies and
records that content rather than modifying it.

### `overrides`

Applies a declarative transform to a staged skill. Today the only supported
transform is `rename-frontmatter-name`, used when two upstreams independently
ship a skill with the same frontmatter `name` (for example `mcp-builder` from
both `anthropics/skills` and `microsoft/skills`):

```yaml
overrides:
  - path: skills/claude/mcp-builder
    transform: rename-frontmatter-name
    source: skills/mcp-builder
    note: Renames the upstream frontmatter name "mcp-builder" to "claude-mcp-builder" to keep registry skill names globally unique.
```

For the current two-segment paths, the renamed name is
`<source-collection>-<skill-folder>`. The implementation joins every segment
after `skills/`, so a nested path includes its intermediate segments too.

### `linkExceptions`

Documents a specific relative link inside a vendored skill that is broken in
the upstream repository itself, and that this registry must mirror
byte-for-byte rather than silently "fix":

```yaml
linkExceptions:
  - sourcePath: skills/cloudflare/cloudflare/references/durable-objects/README.md
    target: ../websockets/README.md
    reason: Upstream cloudflare/skills currently ships this broken relative link and the local mirror must remain unchanged until upstream fixes it.
    upstreamUrl: https://github.com/cloudflare/skills
```

The validator (`node scripts/validate.mjs`) reports a matching entry as a
warning, not an error. It also fails if a declared exception's link now
resolves (the exception is stale and should be deleted) or if the link no
longer exists in the source file at all (the exception is orphaned).

## Repository variables

### `SKILLS_SYNC_ENABLED`

Controls whether the **scheduled** daily apply job in
`.github/workflows/sync.yml` runs at all:

```bash
gh variable set SKILLS_SYNC_ENABLED --body true
```

(Equivalently: **Settings → Secrets and variables → Actions → Variables**.)

Set the value to lowercase `true`, which is the repository's documented and
tested convention. The workflow condition is
`vars.SKILLS_SYNC_ENABLED == 'true'`; GitHub Actions compares strings without
case sensitivity, so casing variants can also enable the job. Unset, `false`,
`1`, and other values skip the scheduled job quietly. Manual
`workflow_dispatch` dry-run and apply runs are never gated by this variable.

Only enable it **after** the tag matching the current lock `release` has been
published. The update engine requires that tag to exist and be an ancestor of
`HEAD` before it will apply anything; until it is published, every scheduled
tick would fail tag/lock reconciliation and repeatedly reopen the tracking
issue for no useful reason.

## GitHub Pages prerequisite

The deploy workflow needs Pages enabled once by a repository administrator
under **Settings → Pages**. `actions/configure-pages@v6` cannot enable Pages
using the workflow's own `GITHUB_TOKEN`, so the workflow verifies Pages is
already enabled via the GitHub API before building, and fails with a clear
error if it is not.

## `E2E_PORT`

The site's Playwright E2E suite serves the built site on port `4331` by
default and refuses to reuse an already-running server. Override the port
with the `E2E_PORT` environment variable if `4331` is occupied:

```bash
E2E_PORT=4400 npm --prefix site run test:e2e
```

```powershell
$env:E2E_PORT = "4400"
npm --prefix site run test:e2e
```

See [Website](website.md) for the full test/build/preview command set.

## `RELEASE_PUBLISHED` is not operator-configured

`RELEASE_PUBLISHED` looks like a repository variable but is not one. The
deploy workflow computes it itself at build time by checking whether the tag
named by `catalog/skills.lock.json`'s `release` actually exists and is an
ancestor of the commit being deployed, then passes the answer as a build-time
environment variable to `npm run build` (and to the post-build site test
run). The site never queries the network at runtime. Do not create a
`RELEASE_PUBLISHED` repository variable — it would have no effect on the
deploy workflow.

## See also

- [Skill management](skill-management.md) — onboarding flows built on top of
  this manifest.
- [Sync and releases](sync-and-releases.md) — how the manifest and lockfile
  interact during a sync.
