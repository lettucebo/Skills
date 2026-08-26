# 網站

[**繁體中文**](../zh-TW/website.md) | [English](../en/website.md) | [文件首頁](README.md)

目錄網站完全位於 `site/` 之下，並且在建置時期由
`catalog/skills.lock.json` 與 `catalog/history/*.json` 建置而成 — 它在執行期
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

啟動 Astro 開發伺服器。由於 `astro.config.mjs` 設定了 `base: '/Skills'` 與
`trailingSlash: 'always'`，每個路由都會在 `/Skills/` 前綴之下並帶有結尾斜線
提供服務（例如 `/Skills/status/`），與已發布的 GitHub Pages URL 結構一致。

## 建置與 Pagefind

```bash
npm --prefix site run build
```

執行 `astro build`，接著 `postbuild` 步驟會自動執行
`pagefind --site dist`，為目錄搜尋介面產生全文搜尋索引。輸出結果會放在
`site/dist/`。

## 預覽

```bash
npm --prefix site run preview
```

以相同的 `/Skills/` base path，提供已經建置好的 `site/dist/`（請先執行
`build`），用來做貼近正式環境的本機檢查。

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

## 網站上的受限制內容

受限制的 skill（見 [安裝方式](installation.md)）永遠不會渲染其 `SKILL.md`
內容。受限制的來源與單一 skill 會抑制安裝指令；完整 registry 指令仍會顯示，
並明確警告其中含有受限制 skill — 見
[系統架構](architecture.md#受限制內容隔離)。

## 延伸閱讀

- [系統架構](architecture.md) — 完整的 manifest 到網站資料流。
- [貢獻指南](contributing.md) — 什麼樣的變更需要執行網站測試套件。
