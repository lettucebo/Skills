# 環境設定

[**繁體中文**](../zh-TW/configuration.md) | [English](../en/configuration.md) | [文件首頁](README.md)

本頁說明驅動這個 registry 的宣告式 manifest，以及同步、Pages 與測試相關的操作
者設定。每日同步／發布機制本身請見 [同步與發布](sync-and-releases.md)。

## Manifest：`catalog/sources.yml`

`catalog/sources.yml` 是 `skills/` 底下每一個 skill 路徑唯一的宣告來源。每一個
含有 `SKILL.md` 的 skill 資料夾都必須恰好被 `mappings`、`orphans` 或某個宣告的
`local` root 其中**一項**涵蓋 — 未被涵蓋或被重複涵蓋的路徑都會讓 manifest 載入
失敗。

即使內容為空，`upstreams` map 與 `mappings`、`orphans`、`local`、`overrides`
array 仍然是必要欄位。只有 `linkExceptions` 可以省略（預設為空 array）。

### `upstreams`

具名的上游 repository 對照表：

```yaml
upstreams:
  awesome-copilot:
    repository: github/awesome-copilot
    reference: refs/heads/main
```

`reference` 必須是 branch 或 tag（`refs/heads/...` 或 `refs/tags/...`）；一個
純 40 字元的 commit SHA 會被直接拒絕，確保每次 clone 都是針對一個具名、可移動的
ref 進行，而不是一個可能悄悄與其 branch 脫節的凍結 commit。

### `mappings`

宣告一個 skill 是從具名上游 vendored 而來：

```yaml
mappings:
  - path: skills/azure/az-cost-optimize
    upstream: awesome-copilot
    source: skills/az-cost-optimize
```

`path` 是這個 repository 內的目的地；`source` 是上游 repository 內的路徑。
`path` 必須已經在磁碟上存在並含有 `SKILL.md` — 你需要同時新增 skill 資料夾與其
manifest 項目。

授權限制**不是**在這份 YAML manifest 中宣告。收編專有內容之前，請把目的路徑
加入 `scripts/catalog.mjs` 的 `RESTRICTED_SKILL_PATHS`；否則即使
`LICENSE.txt` 被辨識為 proprietary，catalog 也不會套用永久的散布限制。產生的
lockfile 是公開清單的結果，不是設定這項政策的位置。每個項目會記錄結構化證據：
restricted policy、skill-local 授權檔、frontmatter、lock 釘選 commit 的上游根
目錄授權檔，或明確 unresolved。既有 metadata 請用 `--refresh-licenses` 修正；
一般 apply 不監看只有根授權變動的情況。

四個已移除的 claude 文件格式路徑仍永久保留在 `RESTRICTED_SKILL_PATHS` 作為
denylist。Lock release 2.0.0 之後，validator 要求它們不存在於磁碟與 active
mapping，只允許 inactive lock tombstone。

### `orphans`

宣告一個沒有追蹤上游的凍結快照：

```yaml
orphans:
  - path: skills/dotnet/csharp-mcp-server-generator
    note: No verified upstream source repository is currently documented for this skill.
```

Orphan skill 永遠不會被同步機制觸碰；它們只有在第一次被收編時才會在 lockfile
中變動（詳見 [技能管理](skill-management.md)）。

### `local`

宣告一個保留給本倉庫原創 skill 的 root：

```yaml
local:
  - root: skills/lettucebo
    note: Reserved for future local/original skills.
```

同步機制拒絕用 staged 上游內容取代 local 內容；`skills/lettucebo` 更是獨立於
`local:` 宣告，無條件禁止被 mapping 指向。第一次收編時，交易會讓已提交的 local
樹通過 candidate swap，但只會驗證並記錄該內容，不會修改它。

### `overrides`

對 staged 的 skill 套用宣告式轉換。目前唯一支援的轉換是
`rename-frontmatter-name`，用於兩個上游各自獨立提供同名 frontmatter `name` 的
skill（例如 `mcp-builder` 同時來自 `anthropics/skills` 與
`microsoft/skills`）：

```yaml
overrides:
  - path: skills/claude/mcp-builder
    transform: rename-frontmatter-name
    source: skills/mcp-builder
    note: Renames the upstream frontmatter name "mcp-builder" to "claude-mcp-builder" to keep registry skill names globally unique.
```

目前兩層路徑的改名結果是 `<來源集合>-<skill 資料夾>`。實作會串接
`skills/` 後面的每一個區段，因此巢狀路徑也會把中間區段納入名稱。

### `linkExceptions`

記錄某個 vendored skill 內、上游本身就已經失效的特定相對連結，而這個 registry
必須逐位元組（byte-for-byte）鏡射它，而不是悄悄「修好」它：

```yaml
linkExceptions:
  - sourcePath: skills/cloudflare/cloudflare/references/durable-objects/README.md
    target: ../websockets/README.md
    reason: Upstream cloudflare/skills currently ships this broken relative link and the local mirror must remain unchanged until upstream fixes it.
    upstreamUrl: https://github.com/cloudflare/skills
```

驗證器（`node scripts/validate.mjs`）會把符合的項目回報為警告，而非錯誤。如果
某個宣告的例外連結現在竟然可以解析（代表這個例外已經過期，應該刪除），或是該
連結在來源檔案中已經完全不存在（代表這個例外已經孤立），驗證器也會回報失敗。

## Repository variables

### `SKILLS_SYNC_ENABLED`

控制 `.github/workflows/sync.yml` 中**排程**的每日 apply job 是否會執行：

```bash
gh variable set SKILLS_SYNC_ENABLED --body true
```

（等同於在 **Settings → Secrets and variables → Actions → Variables** 中設
定。）

請設定為小寫 `true`，這是本 repository 文件化且經測試的慣例。Workflow 條件是
`vars.SKILLS_SYNC_ENABLED == 'true'`；GitHub Actions 的字串比較不區分大小寫，
因此其他大小寫形式也可能啟用 job。未設定、`false`、`1` 與其他值會讓排程 job
安靜跳過。手動觸發的 `workflow_dispatch` dry-run 與 apply 執行永遠不受這個
變數影響。

只有在目前 lock `release`對應的 tag 已經發布**之後**才啟用它。update 引擎要求
該 tag 必須存在且是 `HEAD` 的祖先才會套用任何變更；在該 tag 發布之前啟用，每次
排程執行都會因為 tag/lock 對帳失敗，並不斷重新開啟追蹤 issue，卻毫無用處。

## GitHub Pages 前置條件

部署 workflow 需要由 repository 管理員在 **Settings → Pages** 手動啟用一次
Pages。`actions/configure-pages@v6` 無法用 workflow 自己的 `GITHUB_TOKEN` 啟用
Pages，因此該 workflow 會在建置前透過 GitHub API 驗證 Pages 是否已啟用，若尚未
啟用則以明確的錯誤訊息失敗。

## `E2E_PORT`

網站的 Playwright E2E 測試套件預設會在 port `4331` 提供建置好的網站，並拒絕重複
使用已經在執行的伺服器。若 `4331` 被佔用，可用 `E2E_PORT` 環境變數覆寫：

```bash
E2E_PORT=4400 npm --prefix site run test:e2e
```

```powershell
$env:E2E_PORT = "4400"
npm --prefix site run test:e2e
```

完整的測試／建置／預覽指令集請見 [網站](website.md)。

## `RELEASE_PUBLISHED` 不是由操作者設定的

`RELEASE_PUBLISHED` 看起來像是一個 repository variable，但其實不是。部署
workflow 會在建置時自行計算它，方式是檢查
`catalog/skills.lock.json` 的 `release` 所指名的 tag 是否真的存在且是目前部署
commit 的祖先，然後把結果以建置時期環境變數傳給 `npm run build`（以及建置後的
網站測試執行）。網站永遠不會在執行期查詢網路。請不要建立
`RELEASE_PUBLISHED` 這個 repository variable — 它對部署 workflow 不會有任何
作用。

## 延伸閱讀

- [技能管理](skill-management.md) — 建立在這份 manifest 之上的上線流程。
- [同步與發布](sync-and-releases.md) — manifest 與 lockfile 在同步過程中如何
  互動。
