# Installation

[繁體中文](../zh-TW/installation.md) | [**English**](../en/installation.md) | [Documentation home](README.md)

This page covers installing skills **from this registry into your own
project** as a consumer. If you are adding or updating a skill inside this
repository instead, see [Skill management](skill-management.md).

## Prerequisites

- Node.js and npm (to run `npx`).
- Git, if you use the direct-copy fallback instead of `npx skills`.

## Step 1: Confirm a release is actually published

The lockfile at [`catalog/skills.lock.json`](../../catalog/skills.lock.json)
always names a `release` version — currently `1.1.0`. That field describes
what the checked-in tree currently *is*, not whether anyone can install it yet.

Installation always uses a pinned `#<tag>` reference (never `@version` or a
semver range), and a `v<release>` tag only becomes installable once it has
actually been pushed to GitHub. Before running any command below, confirm the
tag is real:

- Check the repository's [Releases](https://github.com/lettucebo/Skills/releases)
  or [tags](https://github.com/lettucebo/Skills/tags) page for a `v<release>`
  entry, **or**
- Open the published website's
  [status page](https://lettucebo.github.io/Skills/status/), which reports
  whether the current lock release has been tagged and is installable.

If the matching tag does not exist yet, `npx skills add` fails because it
cannot resolve the ref — this is expected, not a bug. Use the most recent tag
that does exist. If Releases, tags, and `/status/` show that no tag has been
published, consumer installation is not available yet; wait for a release.

## Step 2: Choose what to install

Every command below uses `$TAG` for the confirmed, published tag. The
assignment is intentionally a non-resolving placeholder: replace it before
running any command.

```bash
TAG=REPLACE_WITH_PUBLISHED_TAG
```

```powershell
$TAG = "REPLACE_WITH_PUBLISHED_TAG"
```

### Install the entire registry

```bash
npx skills add "lettucebo/Skills#$TAG" --full-depth
```

This short form is interactive when choices are needed: choose project or
global scope, the target agent, copy/symlink mode, and the skills to install.
The CLI can auto-select a single detected agent, and it skips the
copy/symlink prompt when all selected agents use one skills directory (copy
is then used). Selecting all skills (`*`) also selects every restricted skill,
so read [Restricted content](#restricted-content) first.
`--full-depth` is required at repository-root scope; without it, the CLI stops
at the top-level `.github/skills/` directory instead of discovering the
registry under `skills/`.

### Install one source collection

```bash
npx skills add "lettucebo/Skills/skills/azure#$TAG"
```

Replace `skills/azure` with any other source folder (for example
`skills/cloudflare`, `skills/dotnet`, `skills/github`).

### Install one skill

```bash
npx skills add "lettucebo/Skills#$TAG@agents-sdk" --full-depth
```

`@<name>` filters to a single skill by its frontmatter `name`. Never combine
`@` with a version — `@` selects a skill, `#` pins a ref; the tag always comes
first. Repository-root single-skill selection also needs `--full-depth`.

### Non-interactive GitHub Copilot example

For automation, provide every selection explicitly. This repository validates
the following flag shape against pinned CLI version `skills@1.5.1`:

```bash
npx --yes skills@1.5.1 add "lettucebo/Skills#$TAG" \
  --agent github-copilot --copy -y --skill "*" --full-depth
```

```powershell
npx --yes skills@1.5.1 add "lettucebo/Skills#$TAG" --agent github-copilot --copy -y --skill "*" --full-depth
```

Replace `*` with a frontmatter skill name such as `agents-sdk` for one skill,
or replace the source with `lettucebo/Skills/skills/azure#$TAG` for one source
collection. The smoke test executes these selections against the local
checkout; separate contract tests protect the published `owner/repo#tag`,
subpath, and `#tag@skill` source strings. Run the published command once
before relying on it in unattended external automation.

## Restricted content

Some skills, currently under `skills/claude`, are marked
`"redistributable": false` in
[`catalog/skills.lock.json`](../../catalog/skills.lock.json) because their
upstream license is proprietary. A full-registry install includes them; each
restricted skill's own `LICENSE.txt` governs reuse, and the published
website deliberately does not render a restricted skill's `SKILL.md` body.
It suppresses source and single-skill commands for restricted scopes; the
full-registry command remains available and installs restricted skills, but
the site no longer places an on-page restricted-content warning beside it.

The set of restricted skills is not fixed — it changes whenever an upstream
license changes, so never assume a specific name, path, or count. To see the
current set, search the lockfile for every entry with
`"redistributable": false`, or open the published website's `/status/` page,
which lists every currently restricted skill under "Restricted Skills".

If you want to avoid restricted content, install a source whose current
inventory contains no restricted skill, or select a non-restricted single
skill. Check the lockfile or `/status/` first; a narrow scope is not safe when
that scope is itself restricted.

## Direct-copy fallback

If you cannot use `npx`, clone the exact published tag and copy the skill
folder directly into your project:

```bash
git clone --branch "$TAG" --depth 1 https://github.com/lettucebo/Skills.git
mkdir -p your-project/.github/skills
cp -r Skills/skills/dotnet/ef-core your-project/.github/skills/
```

```powershell
git clone --branch $TAG --depth 1 https://github.com/lettucebo/Skills.git
New-Item -ItemType Directory -Force your-project\.github\skills | Out-Null
Copy-Item Skills\skills\dotnet\ef-core your-project\.github\skills\ -Recurse
```

The manual-copy convention places skills under `.github/skills/<skill>/` in
the consuming project.

## Where skills land

`npx skills add` installs into the project skills directory for the agent you
select **when project scope is selected**. This repository's smoke test passes
`--agent github-copilot --copy -y`, which selects project scope and produces
`.agents/skills/<skill>/`; another agent can use a different directory.
Without `-y` and without `--global`, scope is prompted. With `-y` and without
`--global`, project is the default. Omitting `--agent` prompts only when the
CLI cannot auto-select one detected agent.

For GitHub Copilot global scope, `--global` installs under
`~/.copilot/skills/<skill>/`. Run `npx skills list` for project scope and
`npx skills list -g` for global scope. Manual copy in the example above uses
`.github/skills/<skill>/`, which is a separate convention.

If you mix methods or agents, identify the selected agent and installation
mode before assuming a skill is missing or stale; see
[Troubleshooting](troubleshooting.md).

## See also

- [Usage](usage.md) — browsing the catalog, pinning, and checking provenance.
- [Troubleshooting](troubleshooting.md) — fixes for common install failures.
