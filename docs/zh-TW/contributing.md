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

**Enrichment 安全驗證器** — 永遠執行 schema、路徑、受限制內容與已啟用目錄檢查。
缺少與過期 artifact 會刻意通過：

```bash
npm run validate:enrichment
```

**Enrichment 嚴格驗證器** — 在預設安全規則之外，加入只供發布使用的完整性與
freshness 檢查。Changelog locale signature 也必須符合釘選的 prompt、model、
converter 與 generator version：

```bash
npm run validate:enrichment -- --strict
```

**Changelog enrichment** — 為每個符合資格的 mapped skill 產生完整 history。
Generator 會對每個不同上游只 clone 一次、在各 skill 的 lockfile 釘選 commit
停止、以單次 Copilot 呼叫送出該 skill 所有 path-scoped commit patch、寫入 `en`
與 `zh-tw`、用 OpenCC 推導 `zh-cn`，並在完整集合通過 strict validation 後才修剪
禁止 artifact 並啟用 manifest：

```bash
npm run enrich:changelog
```

可用路徑或唯一 skill 名稱執行針對性 cache warm-up 或診斷。針對性產生不會啟用
全域 manifest：

```bash
npm run enrich:changelog -- --skill skills/github/github-issues
```

**Changelog 檢查** — 不執行 clone、Copilot 呼叫或寫入；只驗證已啟用 artifact
集合、完整來源證明 freshness tuple 與 locale signature：

```bash
npm run enrich:changelog -- --check
```

**Enrichment 修剪** — 確定性刪除其 skill 對該 artifact 種類已不符合資格、變成
tombstone，或已離開 lock 的 artifact。這個指令絕不呼叫 LLM 或網路：

```bash
npm run enrich:prune
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

## 網站翻譯慣例

所有由網站擁有、使用者可見的文字都必須放在 `site/src/i18n/` 下的型別化字典；
不要在頁面元件或 client script 中加入 locale ternary 或重複的翻譯 literal。
每個 key 必須同時加入 `en`、`zh-tw` 與 `zh-cn`。Skill 名稱、來源名稱、原始
`SKILL.md` description 與 body、安裝指令、URL、技術專有名詞，以及原始上游
commit subject 保持不變。

內部連結使用 `localizedPath()` 與保留路由的 locale helper，確保 `/Skills/`、
locale 前綴與結尾斜線一致。在地化動態路由必須展開所有支援 locale，並呼叫
`assertLocale()`，讓不支援的值 fail closed。舊版路由檔案維持為小型 redirect
wrapper，並保留精確的英文邏輯目標。

變更 i18n 行為時，先執行針對性的 locale/path 與 route 測試，再建置網站並執行
完整網站單元測試，讓路由數量與 Pagefind 語言索引針對真實輸出驗證。單元測試只能
使用預先建置的 `dist/`；`site/src/lib/` 下的 AST regression 會拒絕任何自行啟動
`npm run build` 的單元測試。

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

## Enrichment 驗證層級

`catalog/enrichment/manifest.json` 是持久化的啟用狀態。目錄是否存在絕不會被視為
啟用狀態，因此刪除產生目錄不能靜默關閉驗證。

Tier 1 是原本位於 atomic baseline/update 交易中的 `validateRepository`。它必須
完全不知道 enrichment，避免選用 sidecar 過期時回溯合法的 registry sync。Tier 2
預設模式（`npm run validate:enrichment`）永遠會擋下現有目錄中的禁止或格式錯誤
artifact，包括 skill 已離開 lock 的 artifact；但停用種類不要求目錄存在，也不
要求完整 artifact 集合。符合資格的 artifact 缺少或過期仍會通過。Tier 2 strict
只對已啟用種類再加入 artifact exact-set 完整性與 freshness、驗證目前 changelog
locale signature，並保留給第一次啟用與發布完整 enrichment artifact 更新時使用。
日常 registry sync 仍可依賴網站對過期／缺少 artifact 的 fallback。

資格會依種類分別計算：summary 包含所有非 tombstone、非 restricted skill；
changelog 另外要求 `upstream` 非 null。Mapped skill 的 freshness 使用轉換前
`contentHash`；orphan 與 local summary 使用 `snapshotHash`。

使用下列指令產生或更新結構化摘要：

```bash
npm run enrich:summaries
npm run enrich:summaries -- --skill skills/vscode/code-review
npm run enrich:summaries -- --check
```

Generator 會先從 lock 篩選資格，才讀取 `SKILL.md`；每個缺少或過期的 skill
只呼叫一次 Copilot，同時產生兩個由模型撰寫的 locale，再確定性地衍生
`zh-cn`。只有成功執行後才會 prune 禁止的 artifact。`--check` 絕不產生或
寫入檔案，且所選 artifact 缺少、過期或 signature 不符時會失敗。只有完整摘要
集合通過 strict 驗證後，manifest 才會啟用。

## Commit 訊息

遵循 [Conventional Commits](https://www.conventionalcommits.org/)，即使變更
只涉及文件，也一律使用英文撰寫：

```
docs: add bilingual documentation set under docs/
```

## 延伸閱讀

- [技能管理](skill-management.md) — 這些指令所驗證的上線步驟。
- [網站](website.md) — 完整的網站指令集。
