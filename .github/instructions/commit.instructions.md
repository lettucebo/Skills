---
applyTo: "**"
---
# Commit Message Guidelines

## Conventional Commits

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<optional scope>): <description>

[optional body]
```

### Types

- `feat`: New skill, new source collection, or new capability
- `fix`: Correct broken links, wrong frontmatter, or inaccurate content
- `docs`: Documentation-only changes (README, references, instructions)
- `refactor`: Reorganize folders or restructure without changing content
- `style`: Formatting, whitespace, or Markdown syntax adjustments
- `chore`: Repo tooling, CI config, dependency updates

## Principles

**Describe what was accomplished, not which files changed.**

❌ Wrong: `edit SKILL.md and references/api.md`
✅ Right: `feat(skills): add Cloudflare Workers AI skill`

## Language

- Write commit messages in **English**
- Technical terms stay as-is (e.g., SKILL.md, YAML, MCP)

## Examples

```
feat(skills): add Cloudflare Agents SDK skill and references

- Add SKILL.md with core SDK patterns
- Add references for callable methods, streaming, and workflows
```

```
docs: update skill authoring guidance in documentation instructions
```

```
refactor(instructions): align repo instructions with current structure

- Replace outdated Azure IaC guidance with skills-repo conventions
- Update commit rules to English
```
