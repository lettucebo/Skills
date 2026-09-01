# 技能管理

[**繁體中文**](../zh-TW/skill-management.md) | [English](../en/skill-management.md) | [文件首頁](README.md)

本頁說明一個 skill 在這個 registry 中如何走過它的生命週期。本頁提到的 manifest
欄位請見 [環境設定](configuration.md)。同步實際如何執行，請見
[同步與發布](sync-and-releases.md)。

## Skill 生命週期

每個 skill 恰好屬於一種分類，宣告於 `catalog/sources.yml`，並記錄在
`catalog/skills.lock.json` 中：

### Mapped skill

從宣告的上游 vendored 而來（`mappings`）。同步機制每次執行都會從上游重新
staging mapped skill 的內容，偵測它是否變動，並且（一旦已建立驗證過的
baseline）能自動收編上游的原地變更。

### Orphan skill

沒有追蹤上游的凍結快照（`orphans`）。同步機制永遠不會重新 staging 或修改
orphan 的內容；它只會在收編當下被觸碰一次。

### Local skill

位於宣告的 `local` root（`skills/lettucebo`）之下的原創內容。同步機制在任何
時候都不會用上游內容取代它。收編時，交易會讓已提交的樹通過 candidate swap，
記錄其雜湊，但不會修改 skill 內容。

### 已移除 mapping 與專有內容 denylist

被移除的 mapping 會在 lock 中保留為 `removed` tombstone，並在 history 新增
`mapping-removed`。它不再計入 active 數量、安裝計畫、來源清單或網站 route，
且 vendored 目錄必須不存在。

`2.0.0` 使用已完成的一次性 `--deproprietize` 遷移，在任何 tag 發布前移除
`skills/claude/{docx,pdf,pptx,xlsx}`。這些路徑永久留在
`RESTRICTED_SKILL_PATHS`；自 2.0.0 起，validator 會拒絕它們出現在磁碟、active
mapping 或 active lock 項目。這次遷移是「先提交宣告／內容，再執行 `--apply`」
一般規則的刻意例外：manifest 與 materialized state 在同一個 journaled
transaction 中一起變更。

## 上線任何新 skill 的先決條件

不論分類為何，透過同步引擎（`node scripts/sync.mjs --apply`）新增一個 skill
都需要：

- **乾淨的工作目錄**（`git status` 必須沒有任何回報）— 引擎否則會拒絕執行，
  確保同步交易永遠不會與未提交的本機變更混在一起，以及
- **目前發布版本的 tag 是 `HEAD` 的祖先** — 最高的 `v<release>` tag 必須與
  `catalog/skills.lock.json` 的 `release` 欄位相符，且能從正在更新的 branch
  追溯到。這個檢查會在任何 staging 發生之前執行，對 mapped、orphan 與 local
  的新增都一樣適用；
- lockfile 中既有的每個 mapped 項目都已有**已驗證的 baseline**；以及
- 每個 mapped 上游與來源都可以存取。Orphan 與 local 收編仍會先 staging 完整的
  mapped 清單，因此不相關的上游中斷也會擋下它們。

## 新增一個 mapped skill

1. 如果尚未宣告，先在 `catalog/sources.yml` 的 `upstreams` 中加入該上游。
2. 在 `skills/<source>/<skill>/` 底下新增 skill 資料夾（一開始可以先複製上游
   內容），並在同一次 commit 中加入其 `mappings` 項目。
3. 更新 `scripts/test/provenance.test.mjs` 中固定的 mapping 數量。若 mapping
   屬於 `microsoft` 或 `cloudflare`，也要更新該測試中精確核准的 source 清單。
   Workflow 會在 apply 前執行這些斷言，因此 manifest 與 provenance 契約必須
   一起變更。
4. 如果其條款為專有授權，請把目的路徑加入 `scripts/catalog.mjs` 的
   `RESTRICTED_SKILL_PATHS`。這項政策不會從 `LICENSE.txt` 推導，也不在
   `catalog/sources.yml` 中設定。
5. 提交，並確認目前 lock `release` 的 tag 已經發布且是 `HEAD` 的祖先。
6. 執行 `node scripts/sync.mjs --apply`。引擎會從真正的上游重新 staging 該
   skill、驗證其來源證明、蓋上 `x-source*` frontmatter 欄位戳記，並記錄一筆
   從版本 `1.0.0` 開始的 `mapping-added` 歷史項目。
7. 完成[收編收尾流程](#收編收尾流程)中的驗證、commit、merge 與 tag 交接。

## 新增一個 orphan skill

1. 在 `skills/<source>/<skill>/` 底下新增 skill 資料夾。
2. 在同一次 commit 中加入其 `orphans` 項目（附上 `note` 說明為何沒有追蹤上
   游）。
3. 更新 `scripts/test/provenance.test.mjs` 中固定的 orphan 數量。
4. 如果其條款為專有授權，請把路徑加入 `scripts/catalog.mjs` 的
   `RESTRICTED_SKILL_PATHS`。
5. 在相同的乾淨工作目錄與目前 tag 的先決條件下執行
   `node scripts/sync.mjs --apply`。引擎會直接對已提交的內容原樣雜湊，並記錄
   一筆版本 `1.0.0` 的 `orphan-added` 歷史項目 — 它絕不會自行抓取或改寫內容。
6. 完成[收編收尾流程](#收編收尾流程)。

## 新增一個 local skill

1. 在宣告的 `local` root（`skills/lettucebo/<skill>/`）之下新增 skill 資料
   夾。
2. 除了既有的 `local` root 宣告之外不需要新增 manifest 項目，因為該 root 底下
   的每個路徑都會被自動涵蓋。
3. 如果其條款為專有授權，請把路徑加入 `scripts/catalog.mjs` 的
   `RESTRICTED_SKILL_PATHS`。
4. 在相同的先決條件下執行 `node scripts/sync.mjs --apply`。引擎會依據已提交
   內容的雜湊，記錄一筆版本 `1.0.0` 的 `local-added` 歷史項目。Candidate 交易
   會保留這些位元組，不會用 staged 上游內容取代它們。
5. 完成[收編收尾流程](#收編收尾流程)。

## 收編收尾流程

`--apply` 重新產生 lock 與衍生檔案之後：

1. 執行 `npm run smoke:npx -- --ref HEAD`，再執行 `npm test` 與
   `node scripts/validate.mjs`。Smoke 檢查必須在 lockfile 已包含新 skill **之後**
   執行。
2. 提交同步產生的 lockfile、history、`NOTICE` 與 README 區塊，再把經過審查的
   變更合併至 `main`。
3. Release 發布前保持排程同步停用。在更新後的 `main` 上，於合併後的 release
   commit 建立 lockfile 所指定的 annotated `v<release>` tag 並推送。不要在
   feature branch 上打 tag。由於 PR merge 時 commit 已先到遠端，這條手動路徑
   無法事後讓 commit 與 tag 的發布具備原子性。Merge push 也會在 tag 存在前先
   部署，而 tag push 不會觸發 `deploy-site.yml`；打 tag 後請重新執行先前的
   deploy workflow，讓它抓取 tags 並重新計算發布狀態。在 `main` 落下一筆後續
   commit 也會觸發新部署。

若要原子發布，請改用建議的操作者路徑：只先合併經審查的
source／manifest／policy 變更，然後在 `main` 手動觸發
`.github/workflows/sync.yml`，設定 `dry_run=false`、`baseline=false`。`update`
job 會執行收編與驗證、commit 產生輸出、建立確切的 `nextTag`，並原子推送 commit
與 tag。不要把這條 workflow 路徑與本機已產生的 release commit 混用。

## 更新上游 mapping

若要在保持相同目的 `path` 的情況下變更 mapping 的上游、`reference` 或
`source`，請一起編輯宣告、提交，再執行相同的 apply 與收尾流程。引擎會把它視為
原地 upstream-tuple 變更，分類為 `patch`。變更 `(repository, reference)` 配對
也會改變刪除防護群組，套用前請先檢查 dry-run 報告。

變更目的 `path` 則是以移除加新增表示的改名／重組，因此分類為 `major`。該移除
仍須通過[刪除防護機制](#刪除防護機制)：小群組會直接擋下改名；較大群組只有在
移除比例不超過 30% 時才允許。

## 為什麼產生的輸出不能被獨立編輯

`catalog/skills.lock.json`、`catalog/history/*.json`、根目錄 `README.md` 中的
`<!-- CATALOG:START -->`／`<!-- INSTALL:START -->` 區塊，以及 `NOTICE`，全部都
是依據 manifest 加上目前 staged 內容確定性地衍生出來的。手動編輯其中任何一個，
都只會產生一個下次同步執行時就會被直接覆蓋的值，而在那之前它還可能誤導使用者
真正能安裝的內容。請把它們當成建置輸出，而不是原始碼。

## 宣告式名稱覆寫

當兩個上游各自提供同名 frontmatter `name` 的 skill 時（例如 `mcp-builder`
同時來自 `anthropics/skills` 與 `microsoft/skills`），請在
`catalog/sources.yml` 的 `overrides` 中加入 `rename-frontmatter-name` 項目，
而不是手動編輯 vendored 的 `SKILL.md`。確切格式請見
[環境設定](configuration.md#overrides)。

## 上游失效連結例外

當一個 vendored skill 內含一個在上游 repository 本身就已經失效的相對連結時，
不要在本機「修好」它 — 鏡射內容必須忠實對應上游。請改在
`catalog/sources.yml` 中加入 `linkExceptions` 項目，記錄來源、目標、原因與
上游網址。詳見 [環境設定](configuration.md#linkexceptions)。

## 刪除防護機制

同步機制會依 `(repository, reference)` 配對將 mapped skill 分組，並擋下一次
會移除過多該群組成員的執行：

- 對於宣告數量少於 10 個 skill 的群組，**任何**移除都會被擋下；
- 對於宣告數量達到 10 個以上的群組，一旦移除比例超過該群組的 30%，就會被擋
  下。

這是為了防止意外的大量刪除（例如 manifest 打錯字，或上游改名）被靜默套用。
分批移除不是可靠的繞過方法：小群組會擋下任何移除，而大型群組也可能縮小後觸發
該規則。目前沒有 CLI override，只有 manifest PR 仍然會失敗。有意且被擋下的
移除，必須先以獨立、含測試的 engine／guardrail 變更定義受審查的授權例外，之後
再走正常的產生輸出與發布流程。

## 延伸閱讀

- [環境設定](configuration.md) — manifest 各欄位的確切格式。
- [同步與發布](sync-and-releases.md) — 一次同步執行如何從頭到尾被執行與發布。
