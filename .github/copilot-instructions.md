# Project Guidelines

## Repository Scope

This repository is a curated collection of AI coding agent skills and references, not an application or library with a workspace-level runtime.

Top-level structure:
- `skills/<source>/` — skill collections, each mirroring its upstream repo's layout
- `hooks/` — standalone Copilot hook scripts (secrets-scanner, session-logger, tool-guardian, governance-audit, dependency-license-checker, session-auto-commit)
- `.github/instructions/` — scoped instruction files (`general`, `documentation`, `commit`, `code-review`, `testing`)

Current skill sources under `skills/`: `azure`, `chrome`, `claude`, `cloudflare`, `dotnet`, `github`, `google-tag-manager`, `microsoft`, `power-platform`, `tampermonkey`, `vscode`

## Build and Test

There are no workspace-level build, test, or lint commands. Validate changes structurally:

```powershell
# Find SKILL.md files missing frontmatter
Get-ChildItem -Recurse -Filter SKILL.md | Where-Object { (Get-Content $_.FullName -Raw) -notmatch '^---' }

# Find skill folders without SKILL.md
Get-ChildItem -Path skills -Recurse -Directory | Where-Object { -not (Test-Path "$($_.FullName)\SKILL.md") }
```

## SKILL.md Structure

Every `SKILL.md` must start with valid YAML frontmatter:

```yaml
---
name: skill-name
description: One-line actionable description that triggers skill loading.
---
```

- `name` and `description` are required; `description` is the trigger mechanism — keep it actionable
- Body should stay under ~500 lines; overflow belongs in `references/`
- Progressive disclosure: metadata (~100 words) → SKILL.md body (<5k words) → `references/` (unlimited)
- Do not include README.md, CHANGELOG.md, or installation guides inside skill folders

## Conventions

- Each skill lives in its own folder with a required `SKILL.md` and optional `references/`, `scripts/`, or `assets/`
- Prefer linking to existing docs instead of duplicating large sections of content
- When adding a new source collection under `skills/`, update the root `README.md`
- Keep naming and directory conventions consistent with the source collection being edited
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) in **English**; use `feat` for new skills, `fix` for broken links/frontmatter, `docs` for README/reference edits, `refactor` for restructuring

## Editing Guidance

- Make surgical content edits; avoid broad rewrites of imported skill libraries
- Do not reformat unrelated Markdown or rename folders unless the task requires it
- Read the nearest source documentation before making structural changes:
  - `README.md` for repository purpose and top-level organization
  - `skills/microsoft/Agents.md` for core agent-editing principles
  - `skills/microsoft/skill-creator/SKILL.md` for canonical skill structure and authoring guidance
  - `skills/cloudflare/README.md` for Cloudflare skill catalog and layout

## Agent-Specific Pitfalls

- This repo is documentation-first; treat missing build scripts as intentional, not as something to fix
- Avoid loading or editing more skill content than the task requires; this repo explicitly values selective context over bulk changes
- For Azure or Foundry skill content, verify current official documentation before introducing new SDK guidance
- After any rename, move, or restructure, verify all relative links in affected files still resolve and check for orphaned files in `references/`, `scripts/`, or `assets/`