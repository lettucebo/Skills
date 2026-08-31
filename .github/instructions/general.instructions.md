---
applyTo: "**"
---
# Skills Repository — General Guidelines

## Repository Purpose

This is a managed, versioned registry of AI coding agent skills and references, organized under `skills/<source>/`. The repository also contains a Node.js catalog/sync engine and an Astro static site.

## Directory Structure

```
skills/
├── microsoft/          ← Skills from microsoft/skills
│   ├── README.md
│   ├── Agents.md       ← Core agent-editing principles
│   └── <skill-name>/
│       ├── SKILL.md    ← Required
│       └── references/ ← Optional detailed docs
├── cloudflare/         ← Skills from cloudflare/skills
│   ├── README.md
│   └── <skill-name>/
│       ├── SKILL.md
│       └── references/
catalog/                ← Source manifest, lockfile, and per-skill history
scripts/                ← Registry validation, generation, and sync engine
site/                   ← Astro + Pagefind catalog website
```

### Skill Folder Layout

Each skill lives in its own folder with:

| Item | Required | Purpose |
|------|:--------:|---------|
| `SKILL.md` | ✅ | Entry point — YAML frontmatter (`name`, `description`) + concise instructions |
| `references/` | Optional | Detailed patterns, API docs, troubleshooting |
| `scripts/` | Optional | Deterministic helper scripts |
| `assets/` | Optional | Templates, images, boilerplate |

## Key Conventions

- **Use the repository gates** — Run root `npm test` and `npm run validate`; run site tests separately with `npm --prefix site test`. See `.github/copilot-instructions.md` for single-test, build, sync, and E2E commands.
- **Validate both behavior and structure** — The validator checks manifest coverage, YAML frontmatter, unique names, layout, and relative links; Node tests cover the registry/sync engine and site.
- **Preserve upstream layout** — Each `skills/<source>/` mirrors its origin repo's organization. Do not restructure imported content.
- **Surgical edits** — Touch only what is needed. Do not reformat unrelated Markdown or rename folders outside the task scope.
- **Regenerate catalog views** — When adding a source, declare it in `catalog/sources.yml`, add its `SOURCE_META` entry in `scripts/catalog.mjs`, and let catalog/sync tooling update generated README blocks, lock/history, and `NOTICE`.
- **Declare restricted policy explicitly** — Proprietary skills must be listed in `RESTRICTED_SKILL_PATHS` in `scripts/catalog.mjs`; license text and manifest metadata do not set `redistributable: false` automatically.

## Key Reference Files

| File | Purpose |
|------|---------|
| `README.md` | Repository purpose, structure, and usage instructions |
| `catalog/sources.yml` | Canonical upstream, mapping, orphan, local, override, and link-exception declarations |
| `catalog/skills.lock.json` | Materialized release and per-skill provenance state |
| `skills/microsoft/Agents.md` | Core agent-editing principles (simplicity, surgical changes, selective loading) |
| `skills/microsoft/skill-creator/SKILL.md` | Canonical guide for creating and structuring skills |
| `skills/cloudflare/README.md` | Cloudflare skill catalog and layout conventions |

## Self-Review

After completing a task, review your own changes once. Verify you are satisfied with accuracy and scope before finishing.
