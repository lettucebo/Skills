---
applyTo: "**"
---
# Validation Guidelines

This repository has no runtime, build pipeline, or test suite. Validate changes structurally instead.

## YAML Frontmatter

Every `SKILL.md` must start with valid YAML frontmatter:

```yaml
---
name: skill-name
description: One-line description of the skill.
---
```

- `name` and `description` are **required**
- No trailing whitespace inside the `---` block
- `description` should be actionable (it triggers skill loading)

## Relative Links

After any rename, move, or restructure:

- Verify all relative links in affected `SKILL.md` and `references/*.md` files still resolve
- Check that `references/` entries listed in a skill's reference table actually exist on disk
- Look for orphaned files in `references/`, `scripts/`, or `assets/` that are no longer linked

## Markdown Structure

- Each skill folder should contain exactly one `SKILL.md`
- `SKILL.md` should stay under ~500 lines; overflow belongs in `references/`
- Fenced code blocks should have a language identifier

## Quick Checks

Use these lightweight commands when in doubt:

```bash
# Find SKILL.md files missing frontmatter
grep -rL "^---" skills/**/SKILL.md

# Find potential broken relative links (look for paths that don't resolve)
grep -rn '](references/' skills/ | while read line; do
  file=$(echo "$line" | cut -d: -f1)
  dir=$(dirname "$file")
  link=$(echo "$line" | grep -oP '\]\(references/[^)]+\)' | tr -d ']()')
  [ -n "$link" ] && [ ! -f "$dir/$link" ] && echo "BROKEN: $file -> $link"
done

# List skill folders without SKILL.md
find skills -mindepth 2 -maxdepth 3 -type d | while read d; do
  [ ! -f "$d/SKILL.md" ] && echo "Missing SKILL.md: $d"
done
```

## What NOT to Do

- Do not invent `npm test`, `pnpm build`, `python -m pytest`, or any runtime test commands
- Do not create test files — this repo has no test infrastructure
- Do not add CI pipelines for code linting — there is no application code to lint
