# Skills 註冊庫文件

[**繁體中文**](../zh-TW/README.md) | [English](../en/README.md) | [文件索引](../README.md)

## 這個 Repository 是什麼

這個 repository 是一個經過整理的 AI coding agent skills **註冊庫（registry）**。
它將多個上游專案的第三方 skills 收錄在 `skills/<source>/<skill>/` 之下，精確追蹤
每一個 skill 來自哪一個上游 commit，並將結果發布出去，讓其他專案可以用單一指令
安裝個別 skill 或整批收錄。

有三樣東西讓這裡是一個「註冊庫」而不只是一堆 Markdown 資料夾：

- **`catalog/sources.yml`** — 宣告清單（manifest）。這是唯一的宣告來源，決定每個
  skill 路徑屬於 `mappings`（從上游 repo vendored）、`orphans`（沒有追蹤上游的
  凍結快照）或 `local`（本倉庫原創）。
- **`catalog/skills.lock.json`** — lockfile。它記錄每個 skill 精確的上游 commit、
  內容雜湊（content hash）、授權與版本，以及整棵樹的 `release` 版本。
- **`scripts/sync.mjs`** 及其支援函式庫 — 同步引擎，負責 clone 宣告的上游、偵測
  新增／變更／刪除，並安全地重寫 lockfile、`NOTICE`，以及根目錄 `README.md` 中的
  產生區塊。

## 這份文件適合誰

### 消費者（Consumers）

如果你只想把一個或多個 skill **安裝**到自己的專案，請先閱讀
[安裝方式](installation.md) 與 [使用方式](usage.md)。你不需要理解同步引擎或
manifest 格式。

### 維護者（Maintainers）

如果你要在這個 repository 新增、更新或移除 skill，或是操作每日同步與發布流程，
請閱讀 [技能管理](skill-management.md)、[同步與發布](sync-and-releases.md)、
[環境設定](configuration.md) 與 [貢獻指南](contributing.md)。

## 快速開始

| 我想要... | 請閱讀 |
|---|---|
| 把一個 skill 安裝到我的專案 | [安裝方式](installation.md) |
| 瀏覽目錄或檢查某個 skill 的來源證明 | [使用方式](usage.md) |
| 設定 manifest 或 repository variables | [環境設定](configuration.md) |
| 新增 mapped、local 或 orphan skill | [技能管理](skill-management.md) |
| 執行同步、理解發布流程或推送 tag | [同步與發布](sync-and-releases.md) |
| 理解各個元件如何組合在一起 | [系統架構](architecture.md) |
| 執行或測試目錄網站 | [網站](website.md) |
| 設定開發環境並驗證變更 | [貢獻指南](contributing.md) |
| 排解安裝、同步或建置失敗的問題 | [疑難排解](troubleshooting.md) |

## 權威資料來源

不要相信任何快取下來的技能數量或目前發布版本 — 永遠以下列即時來源為準：

- [`catalog/sources.yml`](../../catalog/sources.yml) — 宣告的 manifest。
- [`catalog/skills.lock.json`](../../catalog/skills.lock.json) — 每個 skill 精確
  的版本、來源證明與數量統計，以及目前 lock 的 `release`。
- [`NOTICE`](../../NOTICE) — 自動產生的各上游與各授權彙總。
- 已發布網站的 `/status/` 頁面 — 即時、於建置時期解析出來的視圖，顯示 lock
  `release` 是否真的已經被打上 tag 並發布（原因請見
  [安裝方式](installation.md)）。
