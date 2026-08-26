# 貢獻指南

[**繁體中文**](../zh-TW/contributing.md) | [English](../en/contributing.md) | [文件首頁](README.md)

## 環境設定

需要 Node.js 22（與 `.github/workflows/*.yml` 一致）。在執行任何指令之前，先
安裝根目錄與 site 兩邊的相依套件：

```bash
npm ci
npm --prefix site ci
```

## 驗證指令

執行足以涵蓋你變更範圍的最小指令即可；只有在真的需要時才升級到更大範圍。

**針對性根目錄測試** — 單一指定測試檔案：

```bash
node --test scripts/test/docs.test.mjs
```

**具名根目錄測試** — 在所有根目錄測試檔案中，符合名稱樣式的測試：

```bash
node --test --test-name-pattern="DOC1" "scripts/test/**/*.test.mjs"
```

**完整根目錄測試** — 所有根目錄測試檔案：

```bash
npm test
```

**驗證器** — 針對整個 `skills/` 樹的結構檢查（frontmatter、manifest 涵蓋範圍、
相對連結）：

```bash
node scripts/validate.mjs
```

**先建置後單元測試的順序** — 之所以必要，是因為有少數網站單元測試會對照已建置
的 `site/dist/` 輸出進行斷言，否則會自動跳過：

```bash
npm --prefix site run build
npm --prefix site test
```

**單一網站測試**：

```bash
cd site
node --test test/catalog.test.ts --import tsx
```

**完整 E2E**：

```bash
npm --prefix site run test:e2e
```

**單一 E2E 規格**（請先建置，因為套件永遠會提供已建置的 `dist/`）：

```bash
cd site
npm run build
npx playwright test search.spec.ts
```

## 影響 skill 的變更：執行 smoke 檢查

每當你新增 skill、改名 skill，或改變它預期的安裝方式時，請先執行
`node scripts/sync.mjs --apply`，讓 lockfile 反映已提交的 skill 清單，再執行
下方 smoke 指令。Apply 必須符合[技能管理](skill-management.md#上線任何新-skill-的先決條件)
中的乾淨工作目錄、已驗證 baseline、上游可取得與 tag 對帳條件。

Mapped 與 orphan 新增也必須更新 `scripts/test/provenance.test.mjs` 中固定的數量；
`microsoft` 或 `cloudflare` 上游的新增還要更新該測試中精確核准的 source 清單。
這些變更必須在 workflow 的 apply 前 `npm test` 之前完成。

```bash
npm run smoke:npx -- --ref HEAD
```

這會針對你的本機簽出（而不是已發布的 tag）驅動釘選版本的 `npx skills` CLI，
涵蓋整個 registry、單一來源與單一 skill 三種範圍，並確認改名後的
`*-mcp-builder`／`*-skill-creator` skill 都存在，也確認該釘選版本的 CLI 仍然
提供這個 registry 所依賴的確切旗標（`--agent`、`--skill`、`--yes`、
`--copy`、`--full-depth`）。`--ref` 只會影響其摘要輸出中回顯的範例安裝指令，
不會影響實際被安裝的本機內容。

新 skill 若在 apply 之前執行 smoke，預期會失敗：本機資料夾與 lockfile 當時會
描述不同的清單。

## 何時需要進行網站測試

任何 `skills/` 或 `catalog/` 底下的變更都可能改變網站渲染的內容，因為網站的
載入器會直接讀取 `catalog/skills.lock.json` 與
`catalog/history/*.json`。每當你變動這兩棵樹時，就該執行網站單元測試（如果
變更不只是外觀調整，也要跑 E2E 套件），而不是只有在你變動 `site/` 本身時才做。

## CI 觸發條件，精確版

- 根目錄的 `validate` job（`npm test` + `node scripts/validate.mjs`）在每一次
  `pull_request` 與每一次 `push` 都會執行 — 沒有路徑過濾。
- **網站單元測試 job 無條件執行**於每一次 push 與 pull request，包括純文件
  變更，理由與上面相同。
- **E2E 有路徑過濾**：只有在 push 或 pull request 觸及 `site/**`、
  `catalog/**` 或 `skills/**` 時才會執行。像這次這樣的純文件變更不會觸發它。

## 產生的檔案、鏡射內容與時效性

- 絕不手動編輯 `catalog/skills.lock.json`、`catalog/history/*.json`、
  `NOTICE`，或根目錄 `README.md` 中的
  `<!-- CATALOG:START -->`／`<!-- INSTALL:START -->` 區塊 — 它們都是同步機制
  的輸出（見
  [技能管理](skill-management.md#為什麼產生的輸出不能被獨立編輯)）。
- 忠實保留每個 vendored skill 的上游內容與版面配置；任何真正屬於上游端的修正
  （包括失效連結），都應該透過 `linkExceptions` 項目或上游貢獻來處理，而不是
  靜默地在本機修改（見
  [技能管理](skill-management.md#上游失效連結例外)）。
- 在為某個 skill 撰寫新的 SDK 或平台相關指引之前，請先對照現行官方文件驗證，
  而不是依賴可能已經過時的訓練資料。

## Commit 訊息

遵循 [Conventional Commits](https://www.conventionalcommits.org/)，即使變更
只涉及文件，也一律使用英文撰寫：

```
docs: add bilingual documentation set under docs/
```

## 延伸閱讀

- [技能管理](skill-management.md) — 這些指令所驗證的上線步驟。
- [網站](website.md) — 完整的網站指令集。
