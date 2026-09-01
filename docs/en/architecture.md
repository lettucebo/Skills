# Architecture

[繁體中文](../zh-TW/architecture.md) | [**English**](../en/architecture.md) | [Documentation home](README.md)

This page is a cross-file reference for how the registry's pieces fit
together. Each stage links to the page that documents it in depth.

## Data flow

```mermaid
flowchart LR
    A["catalog/sources.yml<br/>(manifest)"] --> B["scripts/sync.mjs<br/>(planner / orchestrator)"]
    B --> C["Upstream git clones<br/>(shallow, pinned ref)"]
    C --> D["Staged candidate content<br/>(scripts/lib/hash.mjs)"]
    D --> F["Pre-transform<br/>content hash"]
    F --> E["scripts/transform.mjs<br/>(provenance stamping, renames)"]
    E --> G["catalog/skills.lock.json"]
    E --> H["catalog/history/*.json"]
    G --> M["scripts/catalog.mjs<br/>(deterministic rendering)"]
    M --> I["NOTICE +<br/>README generated blocks"]
    G --> N["scripts/lib/enrichment.mjs<br/>(schema, eligibility, freshness)"]
    H --> N
    N --> Q["scripts/enrich-summaries.mjs<br/>(Copilot + OpenCC)"]
    G --> R["scripts/enrich-changelog.mjs<br/>(full clones, pinned traversal)"]
    N --> R
    Q --> O["catalog/enrichment/<br/>summaries + changelog"]
    R --> S["Copilot CLI<br/>(one bilingual call per skill)"]
    S --> O
    G --> J["site/src/lib/catalog.ts<br/>(build-time loader)"]
    H --> J
    O --> P["site/src/lib/enrichment.ts<br/>(freshness-gated loader)"]
    P --> K
    J --> K["Astro static site<br/>+ Pagefind search index"]
    K --> L["GitHub Pages deployment"]
```

1. **`catalog/sources.yml`** declares every upstream, mapping, orphan, local
   root, override, and link exception (see [Configuration](configuration.md)).
2. **`scripts/sync.mjs`** reads the manifest and either plans or delegates a
   real apply/baseline to **`scripts/lib/baseline.mjs`**, which owns the apply
   lock, journal, candidate/backup swap, and recovery (see
   [Sync and releases](sync-and-releases.md)).
3. Declared upstreams are **shallow-cloned** at their pinned branch/tag —
   never at a bare commit SHA — and mapped sources are staged into a
   temporary workspace using the same exclusion and symlink policy on every
   code path.
4. **`scripts/transform.mjs`** stamps upstream provenance (and applies any
   `rename-frontmatter-name` override) onto the staged `SKILL.md`, always
   *after* the content has already been hashed, so the recorded
   `contentHash` reflects the real upstream content, not the local stamp.
5. The result is written to **`catalog/skills.lock.json`** (current state per
   skill) and **`catalog/history/*.json`** (one ledger per skill, every
   version bump ever recorded).
6. **`scripts/catalog.mjs`** deterministically renders the lock file into
   **`NOTICE`** and the
   `<!-- CATALOG:START -->`/`<!-- INSTALL:START -->` blocks in the root
   `README.md` — never edited by hand (see
   [Skill management](skill-management.md#why-generated-outputs-cannot-be-edited-independently)).
7. **`scripts/lib/enrichment.mjs`** defines the shared sidecar schema,
   eligibility rules, freshness keys, and locale signatures.
   **`scripts/enrich-summaries.mjs`** makes one Copilot request per eligible
   skill for English and Traditional Chinese, derives Simplified Chinese with
   OpenCC, and writes each artifact atomically. The first complete summary set
   is validated before the generator enables summaries in
   `catalog/enrichment/manifest.json`.
8. **`scripts/enrich-changelog.mjs`** filters eligible skills from the lock
   before any per-skill data access, skips fully cached upstream groups, and
   full-clones each remaining distinct upstream once. It traverses each
   `SKILL.md` through the exact pinned commit with NUL-delimited, no-merge,
   rename-aware Git history. Copy history is crossed only when a later source
   deletion proves a migration; otherwise the artifact records truncation.
   Every commit patch is restricted to the tracked path (or explicit
   transition pair) before one bilingual Copilot request is made per skill.
9. At build time, **`site/src/lib/catalog.ts`** reads the lock file for every
   catalog route and reads a skill's registry-release history ledger for its
   History timeline (see [Website](website.md)).
10. **`site/src/lib/enrichment.ts`** reads only the requested locale from a
   fresh, schema-valid sidecar. Restricted or tombstoned skills are rejected
   before a sidecar path is touched; orphan skills are also rejected for
   changelogs. A missing artifact, stale artifact, or
   missing requested locale returns the caller's existing fallback. The
   mandatory manifest and any artifact that exists must parse and validate;
   unexpected I/O or schema failures stop the build.
11. Skill pages render changelog data as a separate Upstream changes timeline;
    upstream commits are never conflated with registry releases.
12. The built site (including its Pagefind search index) deploys to **GitHub
   Pages**.

`node scripts/validate.mjs` cuts across every stage: it walks the whole
`skills/` tree independently of any one sync run, checking frontmatter,
manifest coverage, and relative links. Both apply engines run it after the
candidate swap and roll back on failure. The workflow also runs a separate
pre-apply validation (and an explicit post-apply validation for baseline).

Enrichment validation is deliberately outside that transaction. The default
`npm run validate:enrichment` command always enforces sidecar safety:
every artifact in an existing kind directory must be schema-valid and
path-safe, and artifacts cannot refer to skills that are restricted,
tombstoned, or absent from the lock. An enabled kind must also have its
directory. Missing and stale artifacts pass. Publishing uses
`npm run validate:enrichment -- --strict`,
which additionally requires the artifact set to exactly match the eligible
skills, every artifact to be fresh, and changelog locale signatures to match
the current prompt/model/converter/generator contract. Both generators apply
the same completeness gate before first enablement. Routine registry sync and
site fallback behavior remain decoupled, so a legitimate upstream swap is not
rolled back merely because optional sidecars have not caught up.

## Enrichment sidecar contract

Both artifact kinds use the history filename convention. For example,
`skills/azure/az-cost-optimize` maps to
`skills__azure__az-cost-optimize.json` below its kind directory. The shared
shape is frozen at schema version 1:

```json
{
  "path": "skills/azure/az-cost-optimize",
  "schemaVersion": 1,
  "freshnessKey": {
    "contentHash": "sha256:...",
    "repository": "github/awesome-copilot",
    "reference": "refs/heads/main",
    "source": "skills/az-cost-optimize",
    "pinnedCommit": "..."
  },
  "locales": {
    "en": {
      "signature": "sha256:...",
      "producer": "llm",
      "model": "gpt-5.4",
      "promptHash": "sha256:...",
      "generatorVersion": 1,
      "content": {}
    },
    "zh-tw": {
      "signature": "sha256:...",
      "producer": "llm",
      "model": "gpt-5.4",
      "promptHash": "sha256:...",
      "generatorVersion": 1,
      "content": {}
    },
    "zh-cn": {
      "signature": "sha256:...",
      "producer": "opencc",
      "converterVersion": "1.0.6",
      "generatorVersion": 1,
      "content": {}
    }
  }
}
```

Summary freshness contains only `contentHash`. Changelog freshness contains
the full provenance tuple shown above, so a new pinned commit invalidates a
changelog even when the upstream bytes are unchanged. Mapped skills use their
pre-transform `contentHash`; orphan and local summary artifacts use
`snapshotHash` as the value of the `contentHash` field.

Summary eligibility is `not tombstone AND not restricted`. Changelog
eligibility adds `upstream != null`, so frozen orphans cannot accidentally
receive changelogs. Each locale signature hashes the locale, schema version,
producer, prompt ID, prompt hash, model or converter version, mandatory
generator version, and the pinned Copilot CLI contract. The generator version
is the explicit cache invalidation control for logic-only changes.

Changelog locale content contains a deterministic newest-first `commits`
array. Each entry records the upstream SHA, author date, untranslated subject,
exact commit URL, `pathAtCommit`, resolution method, localized summary, and an
auditable rename/copy transition when applicable. A still-live copy source
adds `truncatedAt` instead of inheriting unrelated source history.

`scripts/lib/localization.mjs` is the single deterministic Chinese conversion
boundary. It uses `opencc-js` with the Taiwan-phrases-to-Simplified
`twp -> cn` preset and records `opencc-js:twp-to-cn@<version>` in both the
`zh-cn` locale artifact and its signature. When either enrichment kind is
enabled, generators must materialize all three locale slots (`en`, `zh-tw`,
and `zh-cn`) even though localized site routes are not exposed yet. No custom
glossary is embedded here; later editorial vocabulary work remains tracked by
[issue #12](https://github.com/lettucebo/Skills/issues/12).

## Safety boundaries

- **Protected roots.** `skills/lettucebo` can never be written by sync,
  regardless of what the manifest declares — this is enforced independently
  of the `local:` section, so a manifest edit alone cannot lift the
  protection.
- **Path-traversal and collision guards.** Manifest paths are rejected if
  they decode to a `..` segment, and two mappings can never resolve to the
  same or a nested destination — both checks run before any clone or write.
- **Deletion guard.** A group with fewer than 10 declared mappings blocks any
  removal; larger groups block removal above 30%. An unavailable upstream is
  also a hard block and is never interpreted as deletion (see
  [Skill management](skill-management.md#deletion-guard)).
- **Transaction, rollback, and crash recovery.** Every real write goes
  through an apply lock, a candidate/backup swap, and a durable journal, so a
  failed post-apply validation is rolled back immediately. A crash mid-swap
  is resolved from the journal on the next apply after a stale lock is
  safely cleared, or leaves a clearly reported, manually recoverable backup
  (see [Sync and releases](sync-and-releases.md#transaction-safety-journal-rollback-crash-recovery)).
- **Forbidden-sidecar pruning.** After an applied upstream update and before
  its commit, `npm run enrich:prune` removes artifacts whose skill became
  restricted, became a tombstone, or left the lock. It performs deletion only
  and has no LLM, network, or API-key dependency.

## Restricted content isolation

Every skill marked `"redistributable": false` is isolated in the **website
data layer**: `loadSkillBody` refuses to read its `SKILL.md` body. Its detail
page still shows catalog metadata (name, version, status, license, available
upstream provenance, and history), but no description, instructions, or
single-skill install command. Source-level commands are also suppressed when
that source contains restricted content.

The full-registry command is the deliberate exception: the catalog still
renders it, and it installs restricted skills along with everything else. The
site no longer places an on-page restricted-content warning beside it, so
consult `/status/` or the lockfile for the current restricted inventory and
licensing before running it. The vendored bytes also remain present in tagged
repository trees, so this
boundary is website rendering and command suppression, not removal from Git.
The current restricted set is visible on `/status/` or by searching the
lockfile for `"redistributable": false`; it is never enumerated here.

## See also

- [Configuration](configuration.md), [Skill management](skill-management.md),
  [Sync and releases](sync-and-releases.md), and [Website](website.md) — the
  detailed pages this overview links into.
