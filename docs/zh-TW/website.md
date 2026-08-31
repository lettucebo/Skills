# 網站

[**繁體中文**](../zh-TW/website.md) | [English](../en/website.md) | [文件首頁](README.md)

目錄網站完全位於 `site/` 之下，並且在建置時期由
`catalog/skills.lock.json`、`catalog/history/*.json`，以及已啟用且 freshness
有效的 `catalog/enrichment/changelog/*.json` sidecar 建置而成 — 它在執行期
永遠不會查詢網路。這個網站在整體資料流中的位置，請見
[系統架構](architecture.md)。

## 安裝相依套件

```bash
npm --prefix site ci
```

## 本機開發

```bash
npm --prefix site run dev
```

啟動 Astro 開發伺服器。Astro 對 `en`、`zh-tw` 與 `zh-cn` 使用 prefix-all
i18n 路由，同時保留 `base: '/Skills'` 與 `trailingSlash: 'always'`。因此每個
在地化路由都包含網站 base、locale 與結尾斜線（例如 `/Skills/en/status/` 或
`/Skills/zh-tw/skills/github/github-issues/`）。

語言切換器使用原生連結，並保留目前的首頁、安裝、狀態、來源或 skill 邏輯路徑。
明確選取的語言只會供舊版 `/Skills/` 入口使用，絕不覆蓋直接請求的在地化 URL。
每個舊版無語言前綴路由都保留為靜態 redirect，並提供英文 meta refresh、
canonical 與 anchor fallback；只有根 redirect 可在 JavaScript 執行時改用已儲存
或瀏覽器語言。

## 建置與 Pagefind

```bash
npm --prefix site run build
```

執行 `astro build`，接著 `postbuild` 步驟會自動執行
`pagefind --site dist`，為目錄搜尋介面產生全文搜尋索引。Pagefind 會讀取各頁的
`<html lang>`，分別產生英文、繁體中文與簡體中文索引。只有在地化 skill 頁以
`data-pagefind-body` 選擇加入索引；舊版 redirect、目錄與狀態頁不會被索引。輸出
結果會放在 `site/dist/`。

## 結構化 skill 摘要

符合資格的 skill 具有面向一般使用者的摘要成品，分為**用途**、**使用時機**與
**輸出結果**三個欄位。詳細頁面會顯示全部三個欄位，Pagefind 也會在既有的 skill
頁面中索引這些內容。目錄卡片則以摘要的用途取代給 agent 使用的 frontmatter
觸發描述。

只有在 enrichment 已啟用，而且摘要成品與目前 lock 項目保持最新時，網站才會
採用該摘要。每個在地化路由只請求對應的 enrichment locale。若該 locale 停用、
遺失、過期或無效，詳細頁面會省略摘要，目錄卡片則退回使用未翻譯的既有
frontmatter 描述；中文頁絕不退回英文生成內容。受限制的 skill 會在讀取
enrichment 檔案或 `SKILL.md` 內容之前就被排除。

## 預覽

```bash
npm --prefix site run preview
```

以相同的 `/Skills/` base path，提供已經建置好的 `site/dist/`（請先執行
`build`），用來做貼近正式環境的本機檢查。請開啟 `/Skills/en/` 等在地化路由，
不要依賴舊版 redirect。

## 單元測試

```bash
npm --prefix site test
```

執行 `node --test src/**/*.test.ts test/**/*.test.ts --import tsx`。這個測試
套件不需要事先建置就能執行：大部分測試直接針對原始模組，而少數需要對照已建置
`site/dist/` 輸出（例如 Pagefind 索引）的測試，會偵測到它不存在並自動跳過，
而不是在乾淨的簽出上直接失敗。正因如此，CI 會在 `build` 之後立即再執行一次這
個套件（見 [貢獻指南](contributing.md)），確保這些受保護的測試至少會在任何
東西被部署之前真正執行一次。

## End-to-end 測試

```bash
npm --prefix site run test:e2e
```

先執行 `npm run build`，然後針對預設在 port `4331` 上啟動的**全新**
`astro preview` 伺服器執行 Playwright 套件 — 這個套件永遠不會重複使用已經在
執行的伺服器，因此若該 port 已被其他程序佔用，測試會直接大聲失敗，而不是默默
測試到另一個不同的建置結果。若 `4331` 被佔用，可用 `E2E_PORT` 覆寫（見
[環境設定](configuration.md#e2e_port)）。`baseURL` 永遠包含 `/Skills/` 前綴，
與已部署的網站一致。

## 已發布與待發布的渲染差異

網站會依照目前 lock 的 `release` 是否真的已經以 tag 發布，而有不同的渲染方式：

- **已發布**（`RELEASE_PUBLISHED=true`）— 安裝指令與狀態頁面都會回報該版本可
  安裝。
- **待發布**（其他任何情況，包括未設定）— 狀態頁面會回報該版本尚未打上 tag，
  因此來自尚未發布樹狀態的建置，永遠不會宣傳一個必然失敗的安裝指令。

`RELEASE_PUBLISHED` 永遠由部署 workflow 依據真實的 tag 祖先關係計算，並以
建置時期環境變數的形式傳入 — 它從來不是你在網站本身設定的選項。完整說明請見
[環境設定](configuration.md#release_published-不是由操作者設定的)。

## Registry history 與上游變更

符合資格的 mapped skill 詳情頁可以顯示兩條彼此獨立的 timeline：

- **Upstream changes** 列出從最早到 lockfile 所釘選精確 commit 之間，每一個實際
  影響該 skill `SKILL.md` 的非 merge 上游 commit。每一筆都直接連到該 repository
  的 commit、保留原始上游 subject，並使用目前路由對應 locale 的生成摘要。
- **History** 維持原本來自 `catalog/history/*.json` 的 registry release 帳本，
  顯示這個 registry 何時採用該 skill 或調整其版本。

兩者刻意不合併：前者描述上游 Git history，後者描述 registry release。中文生成
摘要缺少或無效時絕不退回英文；若仍有安全的 commit metadata，頁面只顯示原始
subject 與 metadata，不顯示生成摘要。不符合資格或無可用 changelog 資料時則省略
Upstream changes，既有的 History 仍會正常渲染。

## 網站上的受限制內容

受限制的 skill（見 [安裝方式](installation.md)）永遠不會渲染其 `SKILL.md`
內容。受限制的來源與單一 skill 會抑制安裝指令；完整 registry 指令仍可使用，並會
安裝受限制 skill，但網站不再於指令旁顯示頁面內（on-page）受限制內容警告 — 請透過
`/Skills/zh-tw/status/`（或其他 locale）或 lockfile 確認目前的受限制清單與授權（見
[系統架構](architecture.md#受限制內容隔離)）。
Restricted 與 orphan 頁面也永遠不會讀取或渲染上游 changelog sidecar。

## 延伸閱讀

- [系統架構](architecture.md) — 完整的 manifest 到網站資料流。
- [貢獻指南](contributing.md) — 什麼樣的變更需要執行網站測試套件。
