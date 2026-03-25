---
applyTo: "**"
---
# Skills Repository — General Guidelines

## Repository Purpose

This is a curated collection of AI coding agent skills and references, organized under `skills/<source>/`. It is **not** an application or library — there is no workspace-level runtime, build, or test pipeline.

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

- **No build / test commands** — Do not invent `npm`, `pnpm`, `python`, or other root-level steps.
- **Validate via structure** — Check Markdown formatting, YAML frontmatter, relative links, and referenced file paths instead of running tests.
- **Preserve upstream layout** — Each `skills/<source>/` mirrors its origin repo's organization. Do not restructure imported content.
- **Surgical edits** — Touch only what is needed. Do not reformat unrelated Markdown or rename folders outside the task scope.
- **Update root README** — When adding a new source collection under `skills/`, update `README.md` accordingly.

## Key Reference Files

| File | Purpose |
|------|---------|
| `README.md` | Repository purpose, structure, and usage instructions |
| `skills/microsoft/Agents.md` | Core agent-editing principles (simplicity, surgical changes, selective loading) |
| `skills/microsoft/skill-creator/SKILL.md` | Canonical guide for creating and structuring skills |
| `skills/cloudflare/README.md` | Cloudflare skill catalog and layout conventions |

## Self-Review

After completing a task, review your own changes once. Verify you are satisfied with accuracy and scope before finishing.
