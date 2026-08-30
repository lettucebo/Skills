# 安裝方式

[**繁體中文**](../zh-TW/installation.md) | [English](../en/installation.md) | [文件首頁](README.md)

本頁說明如何以**消費者**身份，將這個註冊庫中的 skill 安裝到你自己的專案。如果你
是要在這個 repository「內部」新增或更新 skill，請改看
[技能管理](skill-management.md)。

## 先決條件

- Node.js 與 npm（用來執行 `npx`）。
- Git，如果你要改用直接複製的備援方式。

## 步驟一：確認發布版本是否真的已經發布

[`catalog/skills.lock.json`](../../catalog/skills.lock.json) 的 lockfile 永遠
會標示一個 `release` 版本 — 目前是 `1.1.0`。這個欄位描述的是目前已提交的樹目前
「是」什麼版本，而不是任何人現在能不能安裝它。

安裝一律使用釘選的 `#<tag>` 參照（絕不使用 `@version` 或 semver 範圍），而
`v<release>` tag 只有在真正被推送到 GitHub 之後才能安裝。在執行下方任何指令之前，
請先確認該 tag 確實存在：

- 檢查這個 repository 的
  [Releases](https://github.com/lettucebo/Skills/releases) 或
  [tags](https://github.com/lettucebo/Skills/tags) 頁面是否有對應的
  `v<release>` 項目，**或者**
- 開啟已發布網站的
  [狀態頁面](https://lettucebo.github.io/Skills/status/)，該頁面會回報目前 lock
  的 release 是否已經打上 tag 並可供安裝。

如果對應的 tag 尚未存在，`npx skills add` 會因為無法解析該 ref 而失敗 — 這是
預期行為，不是 bug。請改用目前確實存在的最新 tag。如果 Releases、tags 與
`/status/` 都顯示沒有任何已發布 tag，代表目前尚不能供消費者安裝；請等待發布。

## 步驟二：選擇安裝內容

以下每個指令都用 `$TAG` 代表已確認、已發布的 tag。指定值刻意使用無法解析的
placeholder；執行任何指令前都必須換掉。

```bash
TAG=REPLACE_WITH_PUBLISHED_TAG
```

```powershell
$TAG = "REPLACE_WITH_PUBLISHED_TAG"
```

### 安裝整個 registry

```bash
npx skills add "lettucebo/Skills#$TAG" --full-depth
```

需要選項時，這個短指令會以互動方式詢問 project／global scope、目標 agent、
copy／symlink 模式，以及要安裝的 skill。CLI 可能自動選取唯一偵測到的 agent；
若所有所選 agent 共用同一個 skills 目錄，也會跳過 copy／symlink 提示並直接
copy。選擇全部 skill（`*`）也會選到所有受限制 skill，因此請先閱讀下方
[受限制內容](#受限制內容)。Repository-root 範圍必須使用 `--full-depth`；否則
CLI 會停在頂層 `.github/skills/`，不會找到 `skills/` 底下的 registry。

### 安裝單一來源集合

```bash
npx skills add "lettucebo/Skills/skills/azure#$TAG"
```

將 `skills/azure` 換成任何其他來源資料夾（例如 `skills/cloudflare`、
`skills/dotnet`、`skills/github`）。

### 安裝單一 skill

```bash
npx skills add "lettucebo/Skills#$TAG@agents-sdk" --full-depth
```

`@<name>` 會依照 frontmatter 的 `name` 篩選單一 skill。絕不要把 `@` 與版本混用 —
`@` 用來選取 skill，`#` 用來釘選 ref；tag 永遠寫在前面。Repository-root 的單一
skill 選取同樣需要 `--full-depth`。

### 非互動式 GitHub Copilot 範例

自動化時請明確提供所有選項。本 repository 會用釘選的 CLI 版本
`skills@1.5.1` 驗證以下旗標組合：

```bash
npx --yes skills@1.5.1 add "lettucebo/Skills#$TAG" \
  --agent github-copilot --copy -y --skill "*" --full-depth
```

```powershell
npx --yes skills@1.5.1 add "lettucebo/Skills#$TAG" --agent github-copilot --copy -y --skill "*" --full-depth
```

若只安裝一個 skill，請把 `*` 換成 `agents-sdk` 之類的 frontmatter 名稱；若只
安裝一個來源集合，則把來源換成 `lettucebo/Skills/skills/azure#$TAG`。Smoke
測試會對本機簽出實際執行這些選項；另外的契約測試則保護已發布的
`owner/repo#tag`、子路徑與 `#tag@skill` 來源字串。在無人看管的外部自動化依賴
已發布指令之前，請至少先實際執行一次。

## 受限制內容

目前有部分位於 `skills/claude` 的 skill 在
[`catalog/skills.lock.json`](../../catalog/skills.lock.json) 中被標記為
`"redistributable": false`，因為它們的上游授權是專有授權。安裝整個 registry
會包含它們；其重用條件由各自的 `LICENSE.txt` 規範，而已發布的網站刻意不渲染受
限制 skill 的 `SKILL.md` 內容。受限制的來源與單一 skill 會抑制安裝指令；完整
registry 指令仍可使用，並會安裝受限制 skill，但網站不再於指令旁顯示頁面內
（on-page）受限制內容警告。

受限制 skill 的清單並非固定不變 — 只要上游授權變更，這份清單就可能改變，因此
絕不要假設固定的名稱、路徑或數量。若要查看目前實際受限制的 skill，請在 lockfile
中搜尋所有 `"redistributable": false` 的項目，或開啟已發布網站的 `/status/`
頁面，該頁面會在「Restricted Skills」底下列出目前所有受限制的 skill。

如果你想避免受限制內容，請安裝目前清單中不含受限制 skill 的來源，或選擇一個
非受限制的單一 skill。請先查 lockfile 或 `/status/`；如果較小的範圍本身就是
受限制內容，縮小範圍並不會讓它變安全。

## 直接複製備援方案

如果你無法使用 `npx`，請先 clone 確切的已發布 tag，再把 skill 資料夾複製到
你的專案：

```bash
git clone --branch "$TAG" --depth 1 https://github.com/lettucebo/Skills.git
mkdir -p your-project/.github/skills
cp -r Skills/skills/dotnet/ef-core your-project/.github/skills/
```

```powershell
git clone --branch $TAG --depth 1 https://github.com/lettucebo/Skills.git
New-Item -ItemType Directory -Force your-project\.github\skills | Out-Null
Copy-Item Skills\skills\dotnet\ef-core your-project\.github\skills\ -Recurse
```

手動複製的慣例是將 skill 放在目標專案的 `.github/skills/<skill>/` 之下。

## Skill 會被安裝到哪裡

選擇 **project scope** 時，`npx skills add` 會把 skill 安裝到所選 agent 的專案
skills 目錄。本 repository 的 smoke 測試傳入
`--agent github-copilot --copy -y`，因此選取 project scope 並落在
`.agents/skills/<skill>/`；其他 agent 可能使用不同目錄。沒有 `-y` 且沒有
`--global` 時才會詢問 scope；有 `-y` 且未加 `--global` 時預設為 project。
省略 `--agent` 時，只有在 CLI 無法自動選取唯一偵測到的 agent 才會詢問。

GitHub Copilot 的 global scope 使用 `--global`，安裝到
`~/.copilot/skills/<skill>/`。請用 `npx skills list` 查看 project scope，
`npx skills list -g` 查看 global scope。上方手動複製範例使用
`.github/skills/<skill>/`，那是另一種獨立慣例。

如果你混用不同方法或 agent，請先確認所選 agent 與安裝模式，再判斷某個 skill
是否遺失或過期；詳見 [疑難排解](troubleshooting.md)。

## 延伸閱讀

- [使用方式](usage.md) — 瀏覽目錄、釘選版本與檢查來源證明。
- [疑難排解](troubleshooting.md) — 常見安裝失敗的排解方式。
