---
applyTo: "**"
---
# Review Guidelines

## Core Principles

⚠️ **Don't change what doesn't need changing** — Improve where it matters, skip cosmetic nitpicks.
⚠️ **Scope control** — Each change should trace to the task. Avoid drive-by rewrites of imported skill content.

## Review Checklist

When reviewing changes in this skills repository, check the following in order:

1. **Correctness** — Is the content accurate? Are SDK patterns, API signatures, and links current?
2. **Structure** — Does each skill have a `SKILL.md` with valid YAML frontmatter (`name`, `description`)?
3. **Links** — Are relative links valid? Do referenced files in `references/`, `scripts/`, or `assets/` actually exist?
4. **Conciseness** — Is `SKILL.md` kept concise (<500 lines)? Is detailed material in `references/` instead?
5. **No duplication** — Is content linked rather than copied from READMEs or other skills?
6. **Consistency** — Does the change follow the source collection's existing layout and naming conventions?

## Frontmatter Check

Every `SKILL.md` must have valid YAML frontmatter:

```yaml
---
name: skill-name
description: One-line trigger description for the skill.
---
```

- `name` and `description` are required
- `description` acts as the trigger mechanism — keep it actionable

## Feedback Format

```
[Type] file:line — explanation

Types:
- 🔴 Must fix (blocking)
- 🟡 Suggest improvement (non-blocking)
- 🟢 Optional nitpick
```
