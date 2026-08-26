# Troubleshooting

[繁體中文](../zh-TW/troubleshooting.md) | [**English**](../en/troubleshooting.md) | [Documentation home](README.md)

## Consumer issues

### `npx skills add` fails to resolve the tag

**Symptom:** the command fails while resolving `#<tag>` (a Git ref lookup
error).

**Cause:** the `v<release>` tag named in `catalog/skills.lock.json` has not
been pushed to GitHub yet. The lock file's `release` field is not a promise
that the tag exists — see step 1 of [Installation](installation.md).

**Fix:** check the repository's Releases/tags page or the website's
`/status/` page for the newest tag that actually exists, and use that tag
instead.

### Using `@version` instead of `#tag`

**Symptom:** the install either fails outright or installs the wrong (or no)
skill.

**Cause:** in this registry's install syntax, `#` pins a Git ref (always
required) and `@<name>` filters to a single skill **by name**, not by
version. There is no supported `@<version>` syntax — a value such as
`@1.2.3` is read as a skill-name filter, and no skill is named `1.2.3`.

**Fix:** always pin the ref with `#v<release>`, and only add `@<name>` to
select a single skill by its frontmatter name (for example
`#vX.Y.Z@agents-sdk`, after replacing `vX.Y.Z` with a published tag).

### `npx skills add` is waiting for input or installed only selected skills

**Cause:** the short `npx skills add "owner/repo#tag"` form asks for choices
that cannot be inferred: project/global scope, agent, installation mode, and
skill selection. A single detected agent may be auto-selected, and the
copy/symlink prompt is skipped when the selected agents resolve to one
directory, so not every prompt appears on every machine. Auto-skipped prompts
do not mean every skill was selected; choose `*` or pass `--skill "*"`.
At repository-root scope, omitting `--full-depth` can also produce only
"Found 1 skill" from the
top-level `.github/skills/`, or "No matching skills found" for a catalog
skill nested under `skills/`.

**Fix:** answer the prompts, or use the pinned non-interactive command in
[Installation](installation.md#non-interactive-github-copilot-example) and
set `--agent` and `--skill` explicitly. Add `--full-depth` to every
repository-root full or single-skill command.

### A full-registry install pulled in skills I didn't expect

**Cause:** installing the whole registry includes every redistributable skill
plus every skill currently marked `"redistributable": false` in the lockfile.
That set is not fixed — check `catalog/skills.lock.json` or the website's
`/status/` page for the current list of restricted skills.

**Fix:** install a source whose current inventory has no restricted skill, or
select one non-restricted skill — see
[Restricted content](installation.md#restricted-content) in Installation.

### Stale or missing local installs

**Cause:** `npx skills add` uses the project skills directory for the selected
agent only when project scope is selected. This repository's
`github-copilot` smoke case lands under `.agents/skills/`; GitHub Copilot
global scope uses `~/.copilot/skills/`, other agents can use another tree, and
the manual copy example uses `.github/skills/`.

**Fix:** run `npx skills list` from the consuming project for project scope
and `npx skills list -g` for global scope. Confirm the selected scope, agent,
and install mode, then inspect that agent's directory before reinstalling or
filing a bug.

## Maintainer issues

### "the git working tree is not clean"

**Cause:** `applyBaseline` and `applyUpdate` both refuse to run unless
`git status` is empty, so a transaction can never mix uncommitted local edits
with sync-generated changes.

**Fix:** commit or stash your changes, then re-run the sync command.

### "tag/lock reconciliation failed" during an update

**Cause:** the daily update engine requires the highest semantic-version tag
to exactly match the lock file's `release` and to be an ancestor of `HEAD`.
This fails when the lock's `release` was bumped but its tag was never pushed,
or when tags and the lock have diverged.

**Fix:** publish the missing tag (or fix the divergent history) before
retrying the update. See [Sync and releases](sync-and-releases.md) for the
exact commit-and-tag sequence each workflow job performs.

### Deletion guard blocked an update

**Cause:** removing more than the allowed share of a declared upstream's
mapped skills in one run is blocked outright — see the deletion guard rules in
[Skill management](skill-management.md). This is a safety net against an
accidental mass removal, not a bug.

**Fix:** verify the removals are intentional. Small groups cannot remove even
one mapping through sync, and splitting a large removal can eventually make
the group small enough to block the remainder. Use a reviewed PR and follow
the normal generated-output and release process rather than trying to evade
the guard by batching.

### An upstream repository is unavailable

**Cause:** the sync engine could not clone a declared upstream (network
failure, revoked access, or a renamed/deleted repository). Unavailable
upstreams are never silently treated as "all skills removed" — they hard-block
the run instead.

**Fix:** confirm the upstream `repository`/`reference` in
`catalog/sources.yml` are still correct, and retry once the upstream is
reachable again.

### GitHub Pages deploy fails with "GitHub Pages is not enabled"

**Cause:** the deploy workflow verifies Pages is enabled via the GitHub API
before building, because `actions/configure-pages@v5` cannot enable Pages
using the workflow's own token.

**Fix:** a repository administrator must enable Pages once under
**Settings → Pages**, then re-run the workflow.

### E2E tests fail with a port-in-use error

**Cause:** the Playwright E2E suite always starts its own `astro preview`
server on port `4331` and refuses to reuse an existing server, so a stray
process already bound to that port fails the run immediately instead of
silently testing the wrong build.

**Fix:** stop the process using port 4331, or set `E2E_PORT` to a free port
before running `npm --prefix site run test:e2e`.

### A validation error mentions a broken link I didn't introduce

**Cause:** most broken relative links fail validation, but a small, explicit
list of upstream-owned broken links is tracked as a known issue in
`catalog/sources.yml`'s `linkExceptions` and reported as a warning, not an
error, so an unrelated change is not blocked by someone else's upstream bug.

**Fix:** if the warning is new and not already listed, it is a real problem in
your change. If it matches an existing `linkExceptions` entry, it is expected
and safe to ignore.
