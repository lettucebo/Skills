---
applyTo: "**"
---
# Validation Guidelines

The root Node.js suite covers registry, provenance, release, workflow, and sync behavior. The Astro site has separate unit and Playwright suites because it consumes `catalog/` and `skills/` at build time.

## Test Execution

Use the complete command matrix in `.github/copilot-instructions.md`. The
important sequencing and scope rules are:

- Root `npm test` runs only `scripts/test/**/*.test.mjs`; it does not replace
  the site unit suite.
- Build the site before unit tests when validating assertions against
  `site/dist` or Pagefind output.
- `npm --prefix site run test:e2e` always builds fresh output and must not reuse
  an arbitrary preview server.
- Prefer the narrowest existing selector while iterating:

```powershell
# One named root test
node --test --test-name-pattern="rejects duplicate coverage" scripts/test/manifest.test.mjs

# One site test file
Push-Location site
node --test test/catalog.test.ts --import tsx
Pop-Location

# One browser spec; the npm script builds first
npm --prefix site run test:e2e -- e2e/search.spec.ts
```

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

## Test Selection

- Registry or sync behavior belongs in `scripts/test/*.test.mjs` using Node's built-in test runner.
- Site data/loading/rendering behavior belongs in `site/test/*.test.ts`.
- Browser interaction, accessibility, restricted-content boundaries, and built-output health belong in `site/e2e/*.spec.ts`.
- Changes under `catalog/` or `skills/` can break the site even when `site/` is untouched; run the relevant site tests when changing generated inputs or exact counts.
- Do not add another test framework or standalone lint tool when the existing Node, Astro, validator, and Playwright gates cover the change.
