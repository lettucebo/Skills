# 系統架構

[**繁體中文**](../zh-TW/architecture.md) | [English](../en/architecture.md) | [文件首頁](README.md)

本頁是一份跨檔案的參考，說明這個 registry 的各個元件如何組合在一起。每個階段
都連結到深入說明它的頁面。

## 資料流

```mermaid
flowchart LR
    A["catalog/sources.yml<br/>（manifest）"] --> B["scripts/sync.mjs<br/>（規劃／協調）"]
    B --> C["上游 git clone<br/>（shallow，釘選 ref）"]
    C --> D["Staged candidate 內容<br/>（scripts/lib/hash.mjs）"]
    D --> F["轉換前<br/>內容雜湊"]
    F --> E["scripts/transform.mjs<br/>（來源證明蓋章、改名）"]
    E --> G["catalog/skills.lock.json"]
    E --> H["catalog/history/*.json"]
    G --> M["scripts/catalog.mjs<br/>（確定性渲染）"]
    M --> I["NOTICE +<br/>README 產生區塊"]
    G --> N["scripts/lib/enrichment.mjs<br/>（schema、資格、freshness）"]
    H --> N
    N -. "後續 generator，且已啟用時" .-> O["catalog/enrichment/<br/>summaries + changelog"]
    G --> J["site/src/lib/catalog.ts<br/>（建置時期載入器）"]
    H --> J
    O --> P["site/src/lib/enrichment.ts<br/>（freshness gate 載入器）"]
    P --> K
    J --> K["Astro 靜態網站<br/>+ Pagefind 搜尋索引"]
    K --> L["GitHub Pages 部署"]
```

1. **`catalog/sources.yml`** 宣告每個上游、mapping、orphan、local root、
   override 與連結例外（見 [環境設定](configuration.md)）。
2. **`scripts/sync.mjs`** 讀取 manifest，並依模式進行規劃，或把真正的
   apply／baseline 委派給 **`scripts/lib/baseline.mjs`**；後者負責 apply lock、
   journal、candidate／backup swap 與復原（見
   [同步與發布](sync-and-releases.md)）。
3. 宣告的上游會在其釘選的 branch／tag 上進行 **shallow clone** — 絕不使用純
   commit SHA — 而 mapped 來源會在每一條程式路徑上都以相同的排除與符號連結
   規則，staging 到暫存工作區。
4. **`scripts/transform.mjs`** 會把上游來源證明（以及任何
   `rename-frontmatter-name` override）蓋章到 staged 的 `SKILL.md` 上，且永遠
   在內容已經雜湊**之後**才進行，因此記錄下來的 `contentHash` 反映的是真正的
   上游內容，而不是本機蓋章之後的內容。
5. 結果會寫入 **`catalog/skills.lock.json`**（每個 skill 的目前狀態）與
   **`catalog/history/*.json`**（每個 skill 一份帳本，記錄它曾經發生過的每一
   次版本調整）。
6. **`scripts/catalog.mjs`** 會依 lockfile 確定性地渲染 **`NOTICE`**，以及根目錄
   `README.md` 中的
   `<!-- CATALOG:START -->`／`<!-- INSTALL:START -->` 區塊 — 絕不手動編輯
   （見 [技能管理](skill-management.md#為什麼產生的輸出不能被獨立編輯)）。
7. 在建置時期，**`site/src/lib/catalog.ts`** 會為所有 catalog route 讀取
   lockfile，並在個別 skill 詳情頁讀取該 skill 的 history timeline（見
   [網站](website.md)）。
8. **`scripts/lib/enrichment.mjs`** 定義共用 sidecar schema、資格規則、
   freshness key 與 locale signature。後續 generator 只有在
   `catalog/enrichment/manifest.json` 中對應種類的持久化旗標已啟用時，才能填入
   `catalog/enrichment/summaries/` 與
   `catalog/enrichment/changelog/`。
9. **`site/src/lib/enrichment.ts`** 只會從新鮮且符合 schema 的 sidecar 讀取指定
   locale。受限制或 tombstone skill 會在碰觸 sidecar 路徑前被拒絕；過期、缺少或
   無效的 sidecar 一律回傳呼叫端既有的 fallback。
10. 建置完成的網站（包含其 Pagefind 搜尋索引）會部署到 **GitHub Pages**。

`node scripts/validate.mjs` 橫跨每一個階段：它會獨立於任何一次同步執行，走遍
整個 `skills/` 樹，檢查 frontmatter、manifest 涵蓋範圍與相對連結，而
兩個 apply 引擎都會在 candidate swap 後執行它，失敗時回溯。Workflow 另外執行
一次套用前驗證（baseline 也有明確的套用後驗證）。

Enrichment 驗證刻意位於這項交易之外。預設的
`npm run validate:enrichment` 永遠強制 sidecar 安全性：現有種類目錄中的每個
artifact 都必須符合 schema 且路徑安全，也不得指向 restricted、tombstone 或已
離開 lock 的 skill。已啟用種類還必須存在目錄；缺少與過期 artifact 都會通過。
發布時使用
`npm run validate:enrichment -- --strict`，再額外要求 artifact 集合與符合資格的
skill 完全相等，且每個 artifact 都是最新狀態。因此合法的上游 swap 不會只因為
選用 sidecar 尚未追上就被回溯。

## Enrichment sidecar 契約

兩種 artifact 都沿用 history 檔名慣例。例如
`skills/azure/az-cost-optimize` 在對應種類目錄中會成為
`skills__azure__az-cost-optimize.json`。共用結構凍結在 schema version 1：

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

Summary freshness 只含 `contentHash`。Changelog freshness 則包含上方完整的來源證明
tuple，因此即使內容位元組未改變，只要釘選 commit 更新，就會讓 changelog 失效。
Mapped skill 使用轉換前的 `contentHash`；orphan 與 local 的 summary artifact 則把
`snapshotHash` 放在 `contentHash` 欄位中。

Summary 的資格是「非 tombstone 且非 restricted」。Changelog 另外要求
`upstream != null`，因此 frozen orphan 不可能誤產生 changelog。每個 locale
signature 會雜湊 locale、schema version、producer、prompt ID、prompt hash、model
或 converter version、必要的 generator version，以及釘選的 Copilot CLI contract。
Generator version 是 generator 邏輯改變但 prompt 未變時，明確使 cache 失效的控制。

## 安全邊界

- **受保護的 root。** 不論 manifest 宣告什麼，同步機制永遠不能寫入
  `skills/lettucebo` — 這項保護獨立於 `local:` 區塊強制執行，因此單靠編輯
  manifest 無法解除這項保護。
- **路徑穿越與碰撞防護。** 如果 manifest 路徑解碼後含有 `..` 區段，就會被
  拒絕；兩個 mapping 也絕不能解析到相同或巢狀的目的地 — 這兩項檢查都會在任何
  clone 或寫入之前執行。
- **刪除防護機制。** 宣告 mapping 少於 10 個的群組會擋下任何移除；較大的群組
  會擋下超過 30% 的移除。無法取得的上游也會直接擋下，絕不被解讀為刪除（見
  [技能管理](skill-management.md#刪除防護機制)）。
- **交易、回溯與當機復原。** 每一次真正的寫入都會經過 apply lock、
  candidate／backup 替換，以及一份持久化日誌。套用後驗證失敗會立即回溯；替換
  途中的當機則會在安全清除 stale lock 後，於下一次 apply 依 journal 解決，或
  留下一份清楚回報、可供人工復原的備份（見
  [同步與發布](sync-and-releases.md#交易安全性日誌回溯與當機復原)）。
- **禁止 sidecar 修剪。** 上游更新 apply 完成後、commit 之前，
  `npm run enrich:prune` 會移除其 skill 已變成 restricted、變成 tombstone，或已
  離開 lock 的 artifact。它只會刪除檔案，不依賴 LLM、網路或 API key。

## 受限制內容隔離

每一個在 lockfile 中被標記為 `"redistributable": false` 的 skill，都會在**網站
資料層**被隔離：`loadSkillBody` 完全拒絕讀取其 `SKILL.md`。詳情頁仍會顯示名稱、
版本、狀態、授權、可取得的上游來源證明與 history，但不顯示 description、操作
說明或單一 skill 安裝指令。只要來源集合含受限制內容，來源層級指令也會被抑制。

完整 registry 指令是刻意保留的例外：catalog 仍會顯示它，而它會連同其他內容一併
安裝受限制 skill。網站不再於指令旁顯示頁面內（on-page）受限制內容警告，因此執行
前請透過 `/status/` 或 lockfile 確認目前的受限制清單與授權。Vendored 位元組也仍
存在於有 tag 的 repository tree，因此這項邊界是網站渲染與指令抑制，不是從 Git
移除內容。目前清單可在 `/status/` 查看，或在
lockfile 搜尋 `"redistributable": false`；本文件不會枚舉。

## 延伸閱讀

- [環境設定](configuration.md)、[技能管理](skill-management.md)、
  [同步與發布](sync-and-releases.md) 與 [網站](website.md) — 這份總覽所連結
  到的詳細頁面。
