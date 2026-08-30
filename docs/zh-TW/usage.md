# 使用方式

[**繁體中文**](../zh-TW/usage.md) | [English](../en/usage.md) | [文件首頁](README.md)

本頁說明如何瀏覽目錄、選擇要安裝什麼，以及如何確認某個 skill 的內容究竟來自何
處。安裝指令本身請見 [安裝方式](installation.md)。

## 瀏覽目錄

### 目錄網站

自動產生的網站（由 `site/` 建置，詳見 [網站](website.md)）依來源列出每一個
skill。它提供全文搜尋（透過 Pagefind），讓你不必直接閱讀
`catalog/skills.lock.json` 就能依名稱或描述找到某個 skill。

### Skill 頁面

每個 skill 都有自己的頁面，位於 `/skills/<source>/<skill>/`。它會渲染該 skill
本身 `SKILL.md` 的描述與內容（僅限非受限制的 skill），並附上：

- 它的狀態標籤（`Synced`、`Frozen`、`Local` 或 `Restricted`），
- 它個別的**版本**與**授權**，
- 它可取得的**上游來源證明** — repository 與解析出的 commit，以及
- 它的**歷史紀錄** — 記錄的版本、變更種類與上游 commit。

非受限制的詳情頁也會渲染 repository-root 安裝指令。Repository-root 與單一
skill 指令都會包含 CLI 必要的 `--full-depth` 旗標。來源頁面直接指向
`skills/<source>`，不需要 `--full-depth`。

若要查看分類、上游 reference／來源子路徑與可取得的 `diffUrl`，請查閱
`catalog/skills.lock.json` 與 `catalog/history/*.json` 中的對應項目；目前的詳情頁
template 不會渲染這些欄位。

受限制的 skill（見 [安裝方式](installation.md) 中關於受限制內容的說明）在網站
上永遠不會渲染其 `SKILL.md` 內容或 description。頁面仍會顯示名稱、版本、授權、
狀態、可取得的上游來源證明與歷史紀錄等 catalog metadata。

### 來源頁面

每個來源集合（例如 `skills/azure`）都有一個頁面位於 `/sources/<source>/`，
列出該集合中的每個 skill；除非該集合含有受限制的 skill，否則也會提供安裝整個
集合的確切 `npx skills add` 指令。

### 狀態頁面

`/status/` 頁面回報這個註冊庫即時、於建置時期解析出的狀態：

- lock 的 `release` 版本，以及它是否真的已經以 `v<release>` tag 發布（見
  [安裝方式](installation.md) 的步驟一），
- 總計、mapped、frozen（orphan）、local 與受限制 skill 的數量，
- baseline 驗證狀況 — 有多少 mapped skill 的 `contentHash` 已對照上游驗證，
- 目前解析出的上游 repository 與釘選的 commit，以及
- 目前 frozen orphan 與受限制 skill 的清單。

## 選擇要安裝的範圍

優先選擇符合需求的最小範圍：

- **單一 skill** — 影響範圍最小；只有在該 skill 本身不是受限制內容時，才沒有
  受限制內容風險。
- **單一來源** — 當你想要一整個集合（例如所有 `skills/dotnet` skill）且該集合
  不含受限制 skill 時。
- **整個 registry** — 只有在你確實需要廣泛涵蓋範圍，且能接受一併安裝目前所有
  被標示為受限制的 skill 時才選擇。

## 釘選版本

這個 registry 發布的每個安裝指令都會釘選一個確切的 `v<release>` tag。請勿換成
`#main`、semver 範圍或未釘選的 ref。外部 CLI 雖然提供 `skills update` 指令，
但本 registry 的可重現升級政策是用較新的已發布 tag 重新執行安裝，讓所選 ref
始終保持明確。

## 檢查來源證明

若要確認你實際安裝（或即將安裝）的內容，請查閱
`catalog/skills.lock.json` 中該 skill 的項目：

- `upstream.repository` 與 `upstream.reference` — 它是從哪個 repository 與
  branch/tag 對應而來，
- `upstream.source` — 它在該上游 repository 中的路徑，
- `upstream.commit` — staged 內容實際雜湊時所依據的確切 commit，以及
- `contentHash` — staged、轉換前內容的雜湊值，已驗證的 baseline 會與此完全相符。

目前每個項目都有一個記錄已提交樹的 `snapshotHash`。Mapped skill 另外具有上述
已驗證的上游 `contentHash`；`orphan` 與 `local` skill 的 `upstream` 為
`null`，因此 `snapshotHash` 是它們的內容完整性紀錄。

## 檢查 skill 的版本與歷史紀錄

lockfile 中每個 skill 個別的 `version` 與整個 registry 的 `release` 是彼此獨立
的。若要查看每一次版本更動及其原因，請閱讀
`catalog/history/<路徑中斜線替換為__>.json` — 例如
`catalog/history/skills__azure__az-cost-optimize.json` — 或網站上該 skill 頁面
的「History」區塊。

## 延伸閱讀

- [技能管理](skill-management.md) — skill 如何在 mapped、orphan 與 local 生命
  週期之間移動。
- [同步與發布](sync-and-releases.md) — 版本與發布如何被計算出來。
