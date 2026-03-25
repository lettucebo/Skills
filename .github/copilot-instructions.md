# Project Guidelines

## Repository Scope

This repository is a curated collection of AI coding agent skills and references, not an application or library with a workspace-level runtime.

- Main content lives under `skills/<source>/`, currently including `skills/microsoft/` and `skills/cloudflare/`
- Most changes are Markdown and folder-structure edits around `SKILL.md`, `references/`, `scripts/`, and source READMEs
- Preserve upstream-style organization when editing imported skill collections

## Build and Test

- There are no workspace-level build, test, or lint commands in this repository
- Do not invent `npm`, `pnpm`, `python`, or other root-level build steps unless a specific subdirectory clearly includes its own tooling
- Validate changes by checking Markdown structure, YAML frontmatter, relative links, and referenced file paths

## Conventions

- Each skill should live in its own folder with a required `SKILL.md` and optional `references/`, `scripts/`, or `assets/`
- Keep `SKILL.md` concise; move detailed supporting material into `references/`
- Prefer linking to existing docs instead of duplicating large sections of README content
- When adding a new source collection under `skills/`, update the root `README.md`
- Keep naming and directory conventions consistent with the source collection you are editing

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