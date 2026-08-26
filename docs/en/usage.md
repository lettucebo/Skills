# Usage

[繁體中文](../zh-TW/usage.md) | [**English**](../en/usage.md) | [Documentation home](README.md)

This page covers browsing the catalog, choosing what to install, and verifying
exactly where a skill's content came from. For install commands themselves,
see [Installation](installation.md).

## Browsing the catalog

### The catalog website

The generated website (built from `site/`, see [Website](website.md)) lists
every skill, grouped by source. It provides full-text search (via Pagefind)
so you can find a skill by name or description without reading
`catalog/skills.lock.json` directly.

### Skill pages

Each skill has its own page at `/skills/<source>/<skill>/`. It renders the
skill's own `SKILL.md` description and body (for non-restricted skills only),
plus:

- its status label (`Synced`, `Frozen`, `Local`, or `Restricted`),
- its per-skill **version** and **license**,
- its available **upstream provenance** — repository and resolved commit, and
- its **history** — recorded version, change kind, and upstream commit.

Non-restricted detail pages also render a repository-root install command.
The current site template omits the CLI's required `--full-depth` flag, so
append that flag before running a copied single-skill command. The catalog
homepage's full-registry command has the same limitation. Source-page
commands target `skills/<source>` directly and do not need `--full-depth`.

For the category, upstream reference/source subpath, and any available
`diffUrl`, inspect the corresponding entries in `catalog/skills.lock.json`
and `catalog/history/*.json`; the current detail-page template does not render
those fields.

Restricted skills (see the restricted-content note in
[Installation](installation.md)) never have their `SKILL.md` body or
description rendered on the site. Their pages still show catalog metadata
such as name, version, license, status, available upstream provenance, and
history.

### Source pages

Each source collection (for example `skills/azure`) has a page at
`/sources/<source>/` listing every skill in that collection and, unless the
collection contains a restricted skill, the exact `npx skills add` command to
install that collection alone.

### Status page

The `/status/` page reports the live, build-time state of the registry:

- the lock `release` version and whether it has actually been published as a
  `v<release>` tag (see step 1 of [Installation](installation.md)),
- total, mapped, frozen (orphan), local, and restricted skill counts,
- baseline verification — how many mapped skills have a verified
  `contentHash` against their upstream,
- resolved upstream repositories and the commits currently pinned, and
- the current list of frozen orphan and restricted skills.

## Choosing what to install

Prefer the narrowest scope that meets your need:

- **Single skill** — the smallest surface; it avoids restricted-content risk
  only when that skill is not itself restricted.
- **Single source** — when you want a whole collection (for example all
  `skills/dotnet` skills) that does not contain a restricted skill.
- **Full registry** — only when you specifically need broad coverage and
  accept installing every skill currently marked restricted alongside it.

## Pinning versions

Every published install command from this registry pins an exact
`v<release>` tag. Do not substitute `#main`, a semver range, or an unpinned
ref. Although the external CLI provides a `skills update` command, this
registry's reproducible upgrade policy is to re-run the install with a newer
published tag so the selected ref stays explicit.

## Checking provenance

To verify exactly what you installed (or would install), check
`catalog/skills.lock.json` for the skill's entry:

- `upstream.repository` and `upstream.reference` — which repository and
  branch/tag it is mapped from,
- `upstream.source` — the path inside that upstream repository,
- `upstream.commit` — the exact commit the staged content was hashed from, and
- `contentHash` — the hash of the staged, pre-transform content, which a
  verified baseline matches exactly.

Every current entry has a `snapshotHash` for its committed tree. Mapped skills
also have the verified upstream `contentHash` described above; `orphan` and
`local` skills have `upstream: null`, so `snapshotHash` is their content
integrity record.

## Checking a skill's version and history

Each skill's per-skill `version` in the lockfile is independent of the overall
registry `release`. To see every version bump and why it happened, read
`catalog/history/<path-with-slashes-replaced-by-__>.json` — for example
`catalog/history/skills__azure__az-cost-optimize.json` — or the **History**
section of the skill's page on the website.

## See also

- [Skill management](skill-management.md) — how skills move through mapped,
  orphan, and local lifecycles.
- [Sync and releases](sync-and-releases.md) — how versions and releases are
  computed.
