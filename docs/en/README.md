# Skills Registry Documentation

[繁體中文](../zh-TW/README.md) | [**English**](../en/README.md) | [Documentation index](../README.md)

## What this repository is

This repository is a curated **registry** of AI coding agent skills. It vendors
third-party skills from several upstream projects under `skills/<source>/<skill>/`,
tracks exactly which upstream commit each one came from, and publishes the
result so other projects can install individual skills or whole collections
with a single command.

Three things make this a registry rather than a plain folder of Markdown:

- **`catalog/sources.yml`** — the manifest. It is the single declared source of
  truth for which skill paths are `mappings` (vendored from an upstream repo),
  `orphans` (frozen snapshots with no tracked upstream), or `local` (original to
  this repository).
- **`catalog/skills.lock.json`** — the lockfile. It records the exact upstream
  commit, content hash, license, and version for every skill, and the overall
  `release` version of the tree.
- **`scripts/sync.mjs`** and its supporting libraries — the engine that clones
  declared upstreams, detects additions/changes/removals, and safely rewrites
  the lockfile, `NOTICE`, and the generated blocks in the root `README.md`.

## Who this is for

### Consumers

If you only want to **install** one or more skills into your own project, start
with [Installation](installation.md) and [Usage](usage.md). You do not need to
understand the sync engine or the manifest format.

### Maintainers

If you add, update, or remove skills in this repository, or operate the daily
sync and release pipeline, read [Skill management](skill-management.md),
[Sync and releases](sync-and-releases.md), [Configuration](configuration.md),
and [Contributing](contributing.md).

## Quick start

| I want to... | Read |
|---|---|
| Install a skill into my project | [Installation guide](installation.md) |
| Browse the catalog or check a skill's provenance | [Usage guide](usage.md) |
| Configure the manifest or repository variables | [Configuration guide](configuration.md) |
| Add a mapped, local, or orphan skill | [Skill management](skill-management.md) |
| Run a sync, understand releases, or publish a tag | [Sync and releases](sync-and-releases.md) |
| Understand how the pieces fit together | [Architecture](architecture.md) |
| Run or test the catalog website | [Website guide](website.md) |
| Set up my environment and validate a change | [Contributing guide](contributing.md) |
| Fix a failing install, sync, or build | [Troubleshooting](troubleshooting.md) |

## Canonical sources of truth

Do not trust a cached number for how many skills exist or which release is
current — always check the live source:

- [`catalog/sources.yml`](../../catalog/sources.yml) — the declared manifest.
- [`catalog/skills.lock.json`](../../catalog/skills.lock.json) — the exact
  version, provenance, and count for every skill, and the current lock
  `release`.
- [`NOTICE`](../../NOTICE) — the generated per-upstream and per-license summary.
- The published website's `/status/` page — the live, build-time-resolved view
  of whether the lock `release` has actually been tagged and published (see
  [Installation](installation.md) for why this distinction matters).
