# 同步與發布

[**繁體中文**](../zh-TW/sync-and-releases.md) | [English](../en/sync-and-releases.md) | [文件首頁](README.md)

本頁說明 `scripts/sync.mjs` 以及驅動它從頭到尾執行的 workflow。它讀取的
manifest 欄位請見 [環境設定](configuration.md)；如何新增特定 skill 請見
[技能管理](skill-management.md)。

## 四種模式

### Dry-run（預設）

```bash
node scripts/sync.mjs
```

```bash
node scripts/sync.mjs --dry-run
```

兩種寫法都會計算出完全相同、唯讀的變更集：至少被一個 mapping 引用的上游會被
clone 到暫存工作區，mapped skill 會被 staging 並雜湊，然後把新增／變更／移除／
無法取得／未收編／需要 baseline 清單、SemVer 分類、刪除防護判定，以及
`baseline: { ready, blockers }` 的 go/no-go 摘要，以 JSON 回傳。沒有 mapping
引用的已宣告上游不會被 clone。**這兩種寫法都絕不會寫入 repository** —
`--dry-run` 只會改變輸出 JSON 中記錄的 `dryRun` 欄位，不會改變行為。

### Apply

```bash
node scripts/sync.mjs --apply
```

執行一次真正的更新：重新 staging 每一個 mapped skill、計算自 lockfile 以來有
什麼變動，並且 — 如果確實有東西要套用 — 透過一次原子交易（見下方
[交易安全性](#交易安全性日誌回溯與當機復原)）寫入更新後的
`catalog/skills.lock.json`、`catalog/history/*.json`、skill 資料夾、
`NOTICE`，以及 README 的產生區塊。它要求每個 mapped skill 的 lockfile 項目都
已經有已驗證的 baseline，且工作目錄乾淨。Repository 至少要有一個語意化版本
tag；最高的 `v*` 語意化版本 tag 必須恰好等於 lockfile 的 `release`，且是
`HEAD` 的祖先（見
[技能管理](skill-management.md#上線任何新-skill-的先決條件)）。如果沒有任何
變動，它會回傳 `applied: false` 且不寫入任何東西。

**`--apply` 絕不會 commit 或打 tag。** Commit 與推送 tag 永遠是呼叫它的
workflow（或你本機）另外執行的步驟 — 見
[每日與手動 workflow 順序](#每日與手動-workflow-順序)。

### Baseline（一次性）

```bash
node scripts/sync.mjs --baseline
```

把這個 registry 從最初 `1.0.0` 的 bootstrap 狀態（每個 mapped skill 的
baseline 都是 `unverified`）遷移到完全驗證過的 `1.1.0` baseline。它要求明確的
baseline 模式與乾淨工作目錄，並拒絕被執行超過一次：lock `release` 必須仍恰好是
`1.0.0`、每個 mapped skill 必須仍是 `unverified`、history 不能含
`baseline-verified`，且目標 tag 不得存在。每個 mapped source 也必須可取得且
完成 staging，baseline availability guard 必須通過。任何失敗都會直接結束，
不會默默重複或只建立一部分 baseline。

### Deproprietize（已完成的一次性遷移）

```bash
node scripts/sync.mjs --deproprietize
```

這個一次性模式刻意在不要求既有 tag 的情況下，把尚未發布的 `1.1.0` registry
遷移到可發布的 `2.0.0`。它要求乾淨工作目錄，以及四個精確的 anthropics 專有
mapping（`docx`、`pdf`、`pptx`、`xlsx`）仍為 active。遷移在同一個 candidate
中移除宣告與 vendored 目錄、保留 lock tombstone 與逐 skill history、重新產生
全部衍生檢視，並沿用一般刪除防護（4/17，低於 30% 上限）。它不會呼叫
`assertTagReconciled`；因此 `v2.0.0` 才是第一個可以發布的 tag，`v1.1.0` 永遠
不得發布。精確的 `1.1.0` 前置條件也讓此命令無法重複執行。

`--apply`、`--baseline`、`--deproprietize` 與 `--dry-run` 彼此互斥；組合多個
模式會在任何工作開始之前被拒絕。

在 Windows 上，apply、baseline 與 deproprietize 需要 `powershell.exe` 進行
持久化 journal 替換；若找不到，交易開始前就會被拒絕。

## 機器可讀輸出（`--output`）

`--output <path>` 在每種模式下行為都不同：

- **Dry-run**（不論是否加上 `--dry-run`）：把 JSON 寫入指定檔案，**取代**
  stdout。
- **Apply**：把 JSON**同時**寫入指定檔案**與** stdout。
- **Deproprietize**：與 apply 相同，把 JSON**同時**寫入指定檔案**與** stdout。
- **Baseline**：**不支援** `--output`。Baseline 分支永遠只把結果寫到
  stdout，就算傳入 `--output` 也完全不會寫出任何輸出檔案。

Workflow job 依賴這個行為：dry-run job 會上傳
`sync-report/changeset.json` 作為建置產物，而 update job 會上傳
`sync-report/result.json` — 兩者都直接讀取 `--output` 寫出的檔案。

## 內容雜湊與來源證明

每個 mapped skill 都會用與 apply 路徑相同的排除與符號連結規則，從上游 clone
中 staging，然後在**任何**轉換或蓋章之前先雜湊 — 這個轉換前的雜湊值，就正是
未來會成為 lockfile 中已驗證 `contentHash` 的那個值。只有在雜湊完成之後，引擎
才會把上游來源證明蓋章到該 skill 的 `SKILL.md` frontmatter 上：
`x-source`、`x-source-ref`、`x-source-path`、`x-source-commit` 與
`x-version`。

Orphan 與 local skill 沒有上游可以雜湊比對；它們的 lockfile
`snapshotHash` 改為記錄已提交樹本身的雜湊值，且它們的 `upstream` 欄位為
`null`。

## 交易安全性：日誌、回溯與當機復原

`--apply`、`--baseline` 與 `--deproprietize` 都透過一個持久化交易來寫入：

- Workflow 由 `sync-upstream-skills` concurrency group 序列化
  （`cancel-in-progress: false`），因此第二次 dispatch 會等待，不會取消正在
  執行的同步，
- 一個 **apply lock** 檔案，防止兩個同步執行同時修改 repository，
- 一份**交易日誌**，記錄正在進行中的替換動作，讓下一次任何 apply 指令執行時，
  都能偵測並解決一次中途當機（前進完成或回溯），以及
- 在把 candidate 內容替換上去之後，`node scripts/validate.mjs` 與內部的結構
  完整性檢查都必須通過 — 只要其中一項失敗，就會自動從備份回溯這次替換。如果
  回溯本身也失敗，錯誤訊息會回報備份位置，並保留它以供人工復原，而不是刪除
  它。

Manifest `catalog/sources.yml` 與 `skills/`、history、lock、`NOTICE`、README
同屬共用 swap target。因此 rollback 或當機復原不可能讓宣告與 materialized
狀態停在遷移的不同側。

Lock 檔名為 `.skills-sync-apply.lock`，journal 檔名為
`.skills-sync-transaction.json`；兩者都位於
`git rev-parse --git-common-dir` 顯示的 Git common directory。Stale lock
絕不會自動回收。執行中斷後，先確認 lock 記錄的 process／host 已不再持有它，
只刪除 stale lock、保留 journal，再重新執行相同 apply 指令。下一次執行取得新
lock 後，會利用 journal 前進完成或回溯。若復原錯誤回報保留的 backup，請依該
確切路徑人工處理，不要刪除它。

## 變更分類與發布效果

manifest／staged 內容與目前 lockfile 之間的差異，會依照嚴格優先順序分類：

| 條件 | 類別 | 發布效果 |
|---|---|---|
| 任何被移除的 mapping（包含以移除加新增表示的改名／重組） | `major` | `feat(skills)!: sync upstream changes` |
| 否則，任何新增 | `minor` | `feat(skills): sync new upstream skills` |
| 否則，任何原地變更 | `patch` | `fix(skills): sync upstream updates` |
| 沒有任何變動 | `none` | 不 commit；`applied: false` |

## 無法連線的上游與刪除防護行為

一個 clone 失敗的上游（網路故障、存取權被撤銷、repository 被移除）**絕不會**
被當成它的 skill 都被刪除了 — 它會直接擋下整次執行，不論是在 dry-run 回報中，
還是在 apply／baseline 中（只要任何 mapped 來源無法連線就直接拒絕）。真正被
宣告的移除（manifest 中被移除的 mapping）則會經過共用的刪除防護機制，詳見
[技能管理](skill-management.md#刪除防護機制)。Dry-run 規劃器與一般 update
引擎共用 `buildDeletionGroups`，因此生命週期移除判定一致。一次性的 baseline
引擎不執行 mapping 移除；它會獨立要求每個 mapped source 完成 staging，並以
`removed: 0` 執行 availability guard。

## 每日與手動 workflow 順序

`.github/workflows/sync.yml` 定義了五個 job：

1. **`guard`** — 永遠先驗證 workflow 輸入；`baseline=true` 與
   `dry_run=true` 同時出現時直接失敗。其他所有 job 都依賴這個 gate。
2. **`dry-run`**（手動觸發，`dry_run=true`、`baseline=false`）— 執行
   `npm test`、`node scripts/validate.mjs`，接著執行
   `node scripts/sync.mjs --dry-run --output sync-report/changeset.json`，
   並上傳 JSON 產物。失敗時會開啟或更新單一、穩定的追蹤 issue，而不是每次都
   建立一個新的。
3. **`baseline-apply`**（手動觸發，`baseline=true`、`dry_run=false`，僅限
   `main`）— 執行測試與驗證，接著執行
   `node scripts/sync.mjs --baseline`，重新驗證，然後才**自行**執行 commit
   與 tag：`git commit`、`git tag -a v<release>`，以及原子性的
   `git push --atomic origin HEAD:<branch> refs/tags/v<release>`。同步引擎
   本身從不做這件事；是這個 workflow 做的。
4. **`update`**（僅限 `main`）— 依每日 `0 3 * * *` 排程執行（由
   `SKILLS_SYNC_ENABLED == 'true'` 把關），或由非 baseline、非 dry-run 的手動
   觸發執行。它執行測試與驗證，接著執行
   `node scripts/sync.mjs --apply --output sync-report/result.json`，讀取該
   檔案中的 `applied` 欄位，並且**只有**在 `applied` 為 `true` 時，才用引擎
   給出的確切 `commitMessage` commit、用確切的 `nextTag` 打 tag，並原子性地
   一併推送。沒有變動的同步（`applied: false`）完全不會產生任何 commit。
   失敗時會開啟或更新單一、穩定的 `Daily upstream update failing` 追蹤 issue，
   並在可取得時附上 update report。
5. **`deploy`**（僅限 `main`）— 只有在 `baseline-apply` 或 `update` 恰好其中一個成功之後
   才執行（對 `update` 而言，還必須是它確實套用了變更）。它會部署那個 job
   剛剛推送的確切 commit SHA，而不是 workflow 原始觸發時的 SHA，因為 reusable
   workflow 否則會繼承呼叫者同步前的 commit。

若從非 `main` ref 手動觸發 apply 或 baseline，workflow 不會失敗：apply 與
deploy jobs 會被跳過，因此畫面可能是綠色，卻沒有進行任何同步。所有會寫入的
dispatch 都必須選擇 `main`。手動 dry-run 不寫入，因此可以在其他 ref 執行。

## 延伸閱讀

- [系統架構](architecture.md) — 這些元件如何組成整體的資料流。
- [網站](website.md) — `RELEASE_PUBLISHED` 與發布 tag 如何餵給已部署的網站。
