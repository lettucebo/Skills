# Registered update workflow

This is a navigation and operating reference. Read the current
[repository instructions](../../../copilot-instructions.md), the
[canonical runbook](../../../../docs/en/skill-management.md) and its
[Traditional Chinese counterpart](../../../../docs/zh-TW/skill-management.md).
Their transaction and validation contracts remain authoritative.

## 1. Preflight and scope

Use isolation; preserve unrelated work rather than restore, stash, or overwrite
it. Record the intended base and refresh repository refs/tags before relying on
them. Record an unavailable verification as unknown, not current.

Build a scope record before upstream access:

| Required field | Evidence |
|---|---|
| Baseline | Repository, branch, HEAD, manifest/lock identity, observation time and source |
| Targets | Explicit authorized paths; reconcile active lock entries with manifest coverage; separate mapped, local, orphan and removed |
| Exclusions | No candidate metadata exploration/adoption or undeclared sources by default |
| Tool footprint | Existing script, accepted arguments, repositories/paths downloaded, checked out and read |
| Authorization | Distinguish exploration, apply, generation, commits and external side effects |
| Metadata | Requested kinds/locales, eligibility, target checks and completion level |

Read `catalog/sources.yml`, `catalog/skills.lock.json`, relevant histories,
allowed registered frontmatter and current sidecars. Restrictions on reading
content still apply. Removed entries are audit tombstones, not update targets.
Existing local/orphan entries pass through apply unchanged; their edits or
removals need separately planned, supported engine/migration work.

Compare the complete mapped directory's upstream pre-transform `contentHash`,
stored `snapshotHash`, provenance tuple (repository/reference/source/commit),
stamps, and pinned license evidence using existing staging/hash helpers.
Upstream HEAD movement or a SKILL.md-only comparison is insufficient.
Do not strip stamps or normalize bytes to manufacture an equivalent hash.
See [hash helpers](../../../../scripts/lib/hash.mjs) and
[sync implementation](../../../../scripts/sync.mjs).

### Tool capability gate

Inspect the current CLI and clone helper before selecting a network command.
Do not assume a prior branch's discovery script is installed here, or invent
`--registered-only`, per-skill apply, or exclusion flags.

Standard sync uses full shallow clones before mapped staging and may list
incidental `unadopted` paths. A path-only observation is not permission to
parse candidate bodies or adopt them. A discovery command parsing all
candidates is a different task; filtering its report does not narrow its
download/checkout/read footprint.

If extra candidate downloads/checkouts exceed the authorized boundary, or
touch known blocked paths, do not run that command. Deliver local inventory,
explicit remote-coverage gaps and a separate tooling proposal. Do not silently
broaden scope to finish. A safe path-scoped tool must actually exist and its
boundaries must be verified; this reference adds no engine capability.

## 2. Plan and review

List proposed updates, unchanged evidence, unknowns, missing sources,
hash/license drift, metadata deliverables, expected transaction outputs, and
exact authorization. Review the plan with one independent Rubber Duck.
Simple implementations use one independent Duck; high-risk changes use the
minimum necessary Council under current policy.

Check reviewer model metadata and highest applicable effort against policy.
Disclose unavailable entitlement/fallback telemetry rather than inventing
qualification. A Blocking requires evidence and concrete harm. Freeze clean
scope; defer nonblocking items. Correct only Blocking findings and their
direct effects, then perform targeted verification. Unresolved disagreement,
failed required checks, or unqualified review stops the gate, not a new panel.

## 3. Transaction preparation

Only after scope, footprint and review gates pass, use the runbook's standard
dry-run. Inspect the complete changeset, not a filtered report. Apply re-stages
all mapped skills and does not consume a saved report or offer single-skill
apply; additional upstream drift can change its result.

Require a clean committed candidate, verified mapped baseline, reachable
sources, fetched real semantic tags, and highest tag matching `lock.release`
with correct HEAD ancestry. Stop on an out-of-scope changeset. Use authorized
journaled apply with candidate validation and rollback, never direct copying.
Inspect its actual outputs again. Commit all transaction-owned content,
lock/history, license bundle, NOTICE and generated README changes together.

Use explicit `--refresh-licenses` only for lock-pinned metadata-only license
refresh; ordinary apply does not detect root-license-only drift. Do not
hand-edit generated state, mirrored content or reuse bootstrap/baseline/
deproprietize migrations. Consult the runbook for mapping changes and deletion
guards; an unavailable source is never a deletion.

## 4. Errors and protection

| Observation | Response |
|---|---|
| Confirmed Defender event | Correlate exact repository/ref/path and event evidence. Create/update a tracking issue first. Only with applicable user authorization and supported exact exclusion may work continue outside that boundary. |
| Known blocked bytes | No quarantine restoration, antivirus disablement/exclusion, alternate alias/blob retrieval, or repeated unsafe checkout. Do not attach the blocked content to the issue. |
| Excluded registered mapping | Mark unknown/not assessed and blocking, not unchanged or apply-ready. Candidate exclusions cannot waive complete mapped staging. |
| Generic UNKNOWN/I/O failure | Investigate separately; no presumed Defender cause, broad catch, silent ignore or success-shaped fallback. |
| Invalid YAML or missing/sunset source | Stop affected update/apply. Do not repair the mirror, loosen parsing, or auto-remove/rename/orphan mappings. |
| CRLF/LF or other hash drift | Compare working, committed and lock bytes through shared helpers in isolation; do not normalize hashes, rewrite lock evidence or change global Git settings. |
| Tag/lock mismatch | Stop; no fake tag, automatic old-version publication or manual release rewrite. Plan supported reconciliation separately. |
| Tool/engine defect | Record an issue and correction plan, obtain required review/authorization, implement and verify only that scope. |

Preserve journals/backups for recovery. Never delete user files or shared
worktrees; temporary cleanup is limited to explicitly resolved,
invocation-owned children with applicable permission. Update related issues
with evidence; close only a resolved issue, not an unresolved upstream blocker.
Do not cancel runs, change shared settings, enable scheduling, or deploy as an
implicit part of an update.

## 5. Metadata and verification

Registry provenance/version/license/history and enrichment sidecars are
different deliverables. Follow the runbook's
[metadata completion](../../../../docs/en/skill-management.md#metadata-completion)
with the actual post-transaction lock. Preserve source-supported summaries,
original commit subjects and history at the pinned revision, not live HEAD.

Requested eligible summaries/changelog require `en`, `zh-tw`, and `zh-cn`,
valid schemas, freshness and locale signatures. Record ineligible kinds N/A.
Before generation, inspect the current model/effort contract in
[llm.mjs](../../../../scripts/lib/llm.mjs) against current policy.
A conflict blocks generation; do not change signatures to evade it.

| Gate | Meaning |
|---|---|
| Targeted kind `--check` | Requested eligible target artifacts must be complete and fresh |
| Default `validate:enrichment` | Global safety; missing/stale eligible artifacts may pass, so not proof of target completeness |
| Global cache checks plus `validate:enrichment -- --strict` | Exact eligible set/freshness and locale signatures required for publication |

Do not regenerate unrelated eligible stale artifacts or delete them to force
green. Evidence-backed unrelated freshness problems can remain publication
blockers without preventing otherwise verified local completion. Failed
required checks or missing target metadata still mean incomplete.

### Local-only example

From the repository root with Node.js 22 and existing dependencies, this
inventories lock metadata and checks cached sidecars for one eligible mapped
entry. It does not fetch upstreams or generate anything. It is a local
diagnostic, not all-target or remote-update verification; a stale/missing
cache produces a visible failure. Reconcile the inventory with manifest
coverage and choose actual authorized targets for a real update.

```powershell
$ErrorActionPreference = 'Stop'
$lock = Get-Content -LiteralPath 'catalog\skills.lock.json' -Raw | ConvertFrom-Json
$active = @($lock.skills | Where-Object { $_.category -ne 'removed' })
$active | Sort-Object path | Select-Object path, category, version, snapshotHash
$target = $active | Where-Object {
    $_.category -eq 'mapped' -and $_.redistributable -eq $true -and $_.upstream.commit
} | Sort-Object path | Select-Object -First 1
if ($null -eq $target) { throw 'No eligible mapped target in the lock.' }
$SkillPath = $target.path
npm run enrich:summaries -- --skill $SkillPath --check
if ($LASTEXITCODE -ne 0) { throw "Summary cache check failed: $SkillPath" }
npm run enrich:changelog -- --skill $SkillPath --check
if ($LASTEXITCODE -ne 0) { throw "Changelog cache check failed: $SkillPath" }
npm run validate:enrichment
if ($LASTEXITCODE -ne 0) { throw 'Enrichment safety validation failed.' }
```

For actual registry updates use the runbook's
[finishing gates](../../../../docs/en/skill-management.md#finishing-an-adoption):
root tests/validator, requested metadata checks, committed-HEAD npx smoke, site
build before site unit tests, relevant E2E, and personal browser inspection of
affected pages/search/install controls. Select checks by actual registry/site
inputs, not merely whether a site source file changed.
Internal-reference-only work instead needs its applicable documentation,
discovery, behavior and root checks; it has no registry enrichment transaction.

## 6. Delivery and publication boundary

Report in this order:

1. Completion level and assessed/unassessed scope.
2. Decisions, reasons and changed paths.
3. Registry metadata and target sidecar coverage, including N/A.
4. Commands actually run and observed output, with `path:line` or full URLs.
5. Review role, actual model/effort, verdict and qualification limits.
6. Unresolved blockers, deferred items and known limitations.
7. Persistent commit and publication state.

No remote check means no claim of up-to-date upstream content. A local
inventory or blocked partial investigation can be delivered truthfully without
claiming the requested update is complete.

Use **required sub-skill** `release` only with explicit publication
authorization for the exact snapshot. A reported `nextTag` is not permission.
Keep local completion distinct from publication; no implicit push, merge,
tag, GitHub Release, workflow dispatch, deployment or scheduled-sync change.
New-candidate adoption instead requires **sub-skill** `adding-skills` and its
own scope decision.
