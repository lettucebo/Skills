---
applyTo: "**"
---
# Review Guidelines

## Core Principles

⚠️ **Don't change what doesn't need changing** — Improve where it matters, skip cosmetic nitpicks.
⚠️ **Scope control** — Each change should trace to the task. Avoid drive-by rewrites of imported skill content.

## Review Checklist

Choose the checks for the product area changed; this repository is not only a
collection of Markdown skills.

### Registry and sync engine

1. **Declaration** — `catalog/sources.yml` remains the canonical source for
   mappings, orphans, local roots, overrides, and link exceptions.
2. **Transaction safety** — apply paths build and validate a complete candidate
   before swapping generated state; failures retain rollback/recovery behavior.
3. **Provenance** — compare pre-transform `contentHash` and stored
   `snapshotHash` through shared helpers; do not hand-edit lock/history output.
4. **Restricted policy** — every proprietary adoption updates
   `RESTRICTED_SKILL_PATHS`, and generated lock state is explicitly
   `redistributable: false`; this is not inferred from license text.
5. **Release safety** — additions/changes/removals classify correctly, and tag
   reconciliation still fails closed before apply.
6. **Planner/apply parity** — dry-run and apply use the same mapping, staging,
   exclusion, and deletion-guard semantics.
7. **Category limits** — do not claim existing local/orphan edits or removals
   are versioned by apply; the current engine only adopts new entries and
   passes existing ones through.

### Catalog website

1. **Data derivation** — versions, counts, sources, install commands, and
   restricted inventory come from the lockfile rather than literals.
2. **Restricted boundary** — restricted `SKILL.md` bodies are never read or
   rendered; restricted skill/source install controls remain suppressed.
3. **Search and grouping** — one canonical card set is filtered in place;
   matching source folders are visible/open, and no duplicate result DOM or
   runtime HTML injection is introduced.
4. **Install contract** — repository-root and single-skill commands include
   `--full-depth`; source-subpath commands do not.
5. **Build/deploy identity** — Pages builds the checked-out ref, resolves build
   provenance after checkout, tests built output before upload, and never
   deploys pull requests.
6. **Routing and UX** — `/Skills/` base paths and trailing slashes are
   preserved; theme, no-JS behavior, keyboard access, and forced-colors support
   do not regress.

### Skill content

When reviewing skill changes, check the following in order:

1. **Correctness** — Is the content accurate? Are SDK patterns, API signatures, and links current?
2. **Structure** — Does each skill have a `SKILL.md` with valid YAML frontmatter (`name`, `description`)?
3. **Links** — Are relative links valid? Do referenced files in `references/`, `scripts/`, or `assets/` actually exist?
4. **Conciseness** — Is `SKILL.md` kept concise (<500 lines)? Is detailed material in `references/` instead?
5. **No duplication** — Is content linked rather than copied from READMEs or other skills?
6. **Consistency** — Does the change follow the source collection's existing layout and naming conventions?

### Copilot instructions

1. **Target state** — refresh remote refs and verify architecture and command
   claims against the intended target branch, not a stale local checkout.
2. **Executable commands** — run representative Windows/Node 22 commands;
   check single-test examples as well as full-suite names.
3. **Scope and conflicts** — inspect `applyTo` overlap and contradictions
   between the repository-wide and scoped instruction files.
4. **Operational safety** — recheck bootstrap/baseline/apply/tag rules,
   generated-file ownership, and restricted onboarding policy.
5. **Context size** — keep shared rules in the root instructions and avoid
   repeating full command or architecture blocks in every scoped file.

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
- 🔴 Must fix — concrete correctness, security, data-loss, or requirement failure
- 🟡 Non-blocking defect — real behavior/reliability issue below the blocking threshold
- 💡 Suggestion — directly relevant follow-up only; never style, naming, or cosmetic nitpicks
```
