# 技能管理

[**繁體中文**](../zh-TW/skill-management.md) | [English](../en/skill-management.md) | [文件首頁](README.md)

本頁說明一個 skill 在這個 registry 中如何走過它的生命週期。本頁提到的 manifest
欄位請見 [環境設定](configuration.md)。同步實際如何執行，請見
[同步與發布](sync-and-releases.md)。

## Skill 生命週期

每個 registry skill 恰好屬於一種分類，宣告於 `catalog/sources.yml`，並記錄在
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

## 更新已收錄技能

更新既有 skill 與其 metadata 時，使用內部
[update-repo-skill 入口](../../.github/skills/update-repo-skill/SKILL.md)。
它會在存取上游前核對已收錄範圍與實際工具足跡。候選探索／新增收錄與發布
屬於獨立需求；篩選報告不會限制完整 clone 或候選內容掃描的範圍。
若沒有符合邊界的受支援工具，交付本機發現與涵蓋限制，不默默擴大工作。

## 新增收錄流程

儲存庫內部的 [adding-skills 入口](../../.github/skills/adding-skills/SKILL.md)
將新增／匯入需求導向本頁。本頁是統一操作流程，英文對照頁描述相同流程。

1. **確認範圍與權利。** 辨識上游 repository、reference、來源資料夾、目的路徑、
   既有 mapping／名稱衝突與要求的 metadata。複製前檢查實際上游 skill 及附屬
   檔案、最近的來源指引與再散布條款。拒絕 proprietary 或 denylist 內容；
   新增 denylist 項目不等於取得再散布權利。以 manifest overrides 解決支援的
   名稱衝突，不手改鏡射。
2. **選擇分類。** 追蹤上游用 mapped、明確凍結的快照用 orphan，公開原創內容
   放在 `skills/lettucebo/` 並用 local。僅供儲存庫操作的流程放在
   `.github/skills/<name>/SKILL.md`，標記 `metadata.internal: true`：驗證連結、
   discovery 與行為，但不新增 registry mapping、lock 項目、enrichment 或
   release 版本。若要更新既有 local／orphan 內容，先停止並規劃受支援的
   engine／migration 變更：apply 會原樣保留這些項目，不能更新其版本、雜湊與歷史。
3. **規劃與審查。** 遵循目前儲存庫的 review 與 skill 撰寫規定。公開新增項目
   依下方分類步驟準備宣告／內容。新增 source 時補上 `SOURCE_META`。
   搜尋 `scripts/test/`、`site/test/`、`site/src/`（含 `i18n/routes.test.ts`）
   與 `site/e2e/` 中受影響的 inventory／數量斷言，涵蓋 active／mapped／orphan／
   source 數量、各語系 routes、相容性 redirects 與 Pagefind 輸出。不要只更新
   provenance 測試，也不要在本流程寫死當前總數。
4. **準備已提交的 candidate。** 將宣告、鏡射或原創內容與受影響的 apply 前斷言
   一起提交。先更新遠端 refs／tags，再檢查[先決條件](#上線任何新-skill-的先決條件)。
   保留無關工作檔案；使用隔離環境，不 stash 或覆寫別人的變更。
5. **套用前檢視。** 在儲存庫根目錄執行：

   ```powershell
   node scripts\sync.mjs --dry-run --output sync-report\changeset.json
   ```

   檢查新增、更新、移除、無法取得的來源、guards 與受影響路徑。Apply 會重新
   staging 全部 mapped skills，不會採用手動篩選的報告，也沒有單一 skill 的
   apply 旗標。如果無關變更超出授權範圍，停止並取得範圍決策，或另行規劃、
   審查受支援的來源選擇方式。不得默默擴大收錄、修改產生的狀態、捏造上游
   commit，或重用 `--bootstrap`、`--baseline`、`--deproprietize`。
6. **套用並核對結果。** 僅在工作目錄乾淨、內容已提交且 changeset 經核准後執行：

   ```powershell
   node scripts\sync.mjs --apply --output sync-report\result.json
   ```

   核對 `applied`、`release`、`nextTag` 與受影響 skills 是否符合核准計畫。
   失敗時保留 journals／backups。接著完成 [metadata](#metadata-完成條件)
   與[本機驗證](#收編收尾流程)。讀到 `nextTag` 不代表獲准建立該 tag。

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
3. 更新統一流程辨識出的所有受影響斷言，包含 `scripts/test/provenance.test.mjs`
   中固定的 mapping 數量。若 mapping
   屬於 `microsoft` 或 `cloudflare`，也要更新該測試中精確核准的 source 清單。
   Workflow 會在 apply 前執行這些斷言，因此 manifest 與 provenance 契約必須
   一起變更。
4. 確認再散布權利。拒絕 proprietary 與永久 denylist 內容；
   `RESTRICTED_SKILL_PATHS` 是拒絕政策，不是收錄機制。
5. 提交，並確認目前 lock `release` 的 tag 已經發布且是 `HEAD` 的祖先。
6. 執行 `node scripts/sync.mjs --apply`。引擎會從真正的上游重新 staging 該
   skill、驗證其來源證明、蓋上 `x-source*` frontmatter 欄位戳記、在該 staged
   commit 解析授權證據、需要時更新第三方根授權原文包，並記錄一筆從版本
   `1.0.0` 開始的 `mapping-added` 歷史項目。
7. 完成[收編收尾流程](#收編收尾流程)中的 metadata、驗證與 commit。

## 新增一個 orphan skill

1. 在 `skills/<source>/<skill>/` 底下新增 skill 資料夾。
2. 在同一次 commit 中加入其 `orphans` 項目（附上 `note` 說明為何沒有追蹤上
   游）。
3. 更新所有受影響斷言，包含 `scripts/test/provenance.test.mjs` 中固定的
   orphan 數量。
4. 確認再散布權利，拒絕 proprietary／denylist 內容。
   提交宣告、內容與受影響的 apply 前斷言。
5. 檢視 dry-run，再於相同的乾淨工作目錄與目前 tag 的先決條件下執行
   `node scripts/sync.mjs --apply`。引擎會直接對已提交的內容原樣雜湊，並記錄
   一筆版本 `1.0.0` 的 `orphan-added` 歷史項目 — 它絕不會自行抓取或改寫內容。
6. 完成[收編收尾流程](#收編收尾流程)。

## 新增一個 local skill

1. 在宣告的 `local` root（`skills/lettucebo/<skill>/`）之下新增 skill 資料
   夾。
2. 除了既有的 `local` root 宣告之外不需要新增 manifest 項目，因為該 root 底下
   的每個路徑都會被自動涵蓋。
3. 確認再散布權利，拒絕 proprietary／denylist 內容。
   更新受影響的 inventory 斷言，並提交內容與測試。
4. 檢視 dry-run，再於相同的先決條件下執行 `node scripts/sync.mjs --apply`。引擎會依據已提交
   內容的雜湊，記錄一筆版本 `1.0.0` 的 `local-added` 歷史項目。Candidate 交易
   會保留這些位元組，不會用 staged 上游內容取代它們。
5. 完成[收編收尾流程](#收編收尾流程)。

## Metadata 完成條件

檢查兩組不同的 metadata，兩者不能互相替代：

| 類型 | 驗收依據 |
|---|---|
| Registry 交易 | 正確的 category／name／path、從 `1.0.0` 開始的 skill 版本、雜湊、適用的 provenance 欄位與釘選上游 commit、符合事實的結構化授權證據／原文包、收錄歷史，以及一致的 README／NOTICE 產生檢視 |
| Enrichment sidecars | `catalog/enrichment/` 中符合資格且本次要求的 summaries 與上游 changelog；對應目前 lock、具有 schema 正確的 `en`／`zh-tw`／`zh-cn` 內容與有效的 locale signatures |

需求包含 metadata 時，在同一次收錄中完成符合資格的 sidecars；目標 artifacts
缺少就代表**未完成**，不能默默改成後續工作。Summaries 支援 active 且可再散布的
registry 項目；changelog 需要上游 provenance。不符合資格的種類記為 N/A，
不要捏造歷史或停用 enrichment。Internal skills 兩種都不適用。

產生前先確認 `scripts/lib/llm.mjs` 當前 generator 的 model／effort 契約符合
適用政策。衝突時停止產生；修改契約／signatures 需要獨立審查的重新產生計畫。
將 `$SkillPath` 設為精確的 lock 項目路徑，僅對符合資格的種類執行下列對應指令
（mapped 收錄通常兩種都執行）：

```powershell
$SkillPath = 'skills/github/plantuml-ascii'
npm run enrich:summaries -- --skill $SkillPath
npm run enrich:changelog -- --skill $SkillPath
npm run enrich:summaries -- --skill $SkillPath --check
npm run enrich:changelog -- --skill $SkillPath --check
npm run validate:enrichment
```

確認三種語系、摘要有來源支持、原始 commit subject 保持原樣，且歷史來自
lock 釘選 revision，不是即時上游 HEAD。提交前檢查 pruning 副作用；只能移除
不再符合資格的 artifacts，不能為了讓檢查通過而刪除符合資格但過期的項目。

Default safety 刻意允許符合資格的 artifacts 缺少或過期：
**通過它不等於本次要求的 metadata 已完整**。Targeted `--check` 驗證收錄 skill
的新鮮度，不重新產生無關 artifacts。全庫 strict freshness 是獨立的
[發布門檻](#發布已收錄的版本)。

## 收編收尾流程

`--apply` 重新產生 lock 與衍生檔案之後，完成上方要求的 metadata。
僅收錄的工作在本節結束，不代表獲准 push、merge、tag、GitHub Release、
workflow 發布、部署或變更排程同步。

1. 提交**全部**交易輸出，包括 `skills/**`、lockfile、history、
   `catalog/licenses/`、`NOTICE` 與 README 區塊。納入產生／清除 artifacts
   所產生的 `catalog/enrichment/` 變更，以及相關網站與測試變更。
   確認 `git status --porcelain` 沒有輸出；報告放在儲存庫外，或已忽略的
   `sync-report/`。
2. 執行 `npm test`、`npm run validate`、default enrichment safety 與上方的
   targeted freshness 檢查，再執行 `npm run smoke:npx -- --ref HEAD`。
   Smoke 檢查必須在 lockfile 與全部 skill 內容**已提交之後**執行。
   完成相關網站建置、單元與 E2E 檢查，並親自檢視受影響頁面、搜尋與安裝控制。
   依目前政策，針對最終 diff 與檢查證據完成必要的獨立審查。
3. 回報收錄路徑／分類、metadata 完整性、指令／結果、審查、未解問題與未發布狀態。
   必要檢查失敗或要求的 metadata 缺少時，工作未完成。有證據證明與本次無關的
   既有 freshness 失敗，本身不阻擋其他條件皆已驗證的本機收錄，但仍會阻擋發布；
   不得宣稱全庫 freshness 通過，也不得默默豁免其他失敗的檢查。

## 發布已收錄的版本

僅在取得明確發布授權後，使用內部 `release` skill 與
[同步／發布指引](sync-and-releases.md)。發布前，兩種全庫 cache 檢查與 strict
completeness 都必須通過：

```powershell
npm run enrich:summaries -- --check
npm run enrich:changelog -- --check
npm run validate:enrichment -- --strict
```

若採用經審查且已在本機產生快照的路徑，獲得授權後才把經過審查的變更合併至
`main`。Release 發布前保持排程同步停用。在更新後的 `main` 上，於合併後的 release
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
是依據 manifest、目前 staged 內容與釘選授權證據確定性地衍生出來的。
`catalog/licenses/` 也會一起產生，保存精確的上游根授權位元組與證據索引。手動編輯其中任何一個，
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
