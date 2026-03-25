---
applyTo: "**/*.md"
---
# Documentation Guidelines

## SKILL.md Structure

Every skill requires a `SKILL.md` with YAML frontmatter and concise instructions:

```yaml
---
name: skill-name
description: One-line trigger description for the skill.
---
```

### Body Guidelines

- **Keep under 500 lines** — Move detailed content to `references/` files
- **Progressive disclosure** — Metadata (~100 words) → SKILL.md body (<5k words) → references (unlimited)
- **Link, don't embed** — Reference existing docs instead of copying large blocks
- **Include retrieval sources** — Point to official docs or repos for SDK/API skills

## Bundled Resources

| Folder | Purpose | When to Include |
|--------|---------|-----------------|
| `references/` | Detailed patterns, API docs, troubleshooting | Content exceeds SKILL.md scope |
| `scripts/` | Deterministic helper scripts | Same code rewritten repeatedly |
| `assets/` | Templates, images, boilerplate | Reusable output resources |

**Do not include:** README.md, CHANGELOG.md, or installation guides inside skill folders.

## Root README

When adding a new source collection under `skills/`, update the root `README.md`:

- Add the source to the directory structure section
- Add a brief description and link
- Keep the existing table/list format consistent

## Markdown Conventions

- Use fenced code blocks with language identifiers (```typescript, ```bash, etc.)
- Use tables for feature comparisons and structured data
- Prefer relative links for cross-references within the repo
- Keep lines readable — no strict line-length limit, but avoid single-line paragraphs over ~200 characters

## Editing Imported Content

- **Preserve upstream style** — Each `skills/<source>/` mirrors its origin repo. Do not impose a different formatting convention.
- **Surgical edits only** — Fix errors or add missing content. Do not reformat entire files.
- **Check nearest docs first** — Read the source collection's README before restructuring.
