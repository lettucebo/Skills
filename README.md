# Skills

我個人收集的 AI Coding Agent Skills 合集。

本 Repo 的目的是集中管理、分類並存放所有我認為實用的 [Agent Skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)，方便在不同專案中快速引用與複用。

[文件 / Documentation](docs/README.md)

---

## 目錄結構

```
skills/
├── azure/                 ← Azure 雲端服務技能
├── chrome/                ← Chrome DevTools 技能
├── claude/                ← Claude AI 相關技能
├── cloudflare/            ← Cloudflare Developer Platform 技能
├── dotnet/                ← .NET / C# 開發技能
├── github/                ← GitHub 工作流程技能
├── google-play-console-cli/ ← Google Play 發布與營運技能
├── gtm/                   ← GTM 與 Go-To-Market 策略技能
├── microsoft/             ← Microsoft AI Foundry / Azure SDK 技能
├── power-platform/        ← Power BI、Power Apps、Fabric 技能
├── tampermonkey/          ← Tampermonkey 使用者腳本技能
└── vscode/                ← VS Code 開發工作流程技能

hooks/                     ← Copilot Hook 腳本集合
```

每個 skill 位於獨立資料夾中，包含必要的 `SKILL.md` 與選用的 `references/`、`scripts/`、`assets/`。

---

## 目前收錄的 Skills

<!-- CATALOG:START -->
共 **115 個技能**，來自 12 個來源。

> 以下統計由 `scripts/catalog.mjs` 依 `catalog/skills.lock.json` 自動產生，請勿手動編輯。
>
> 全部 112 個 mapped 技能皆已 verified，每個技能的 upstream commit 與 contentHash 均已記錄。

| 來源 | 數量 | 說明 | 文件 |
|------|:----:|------|------|
| [azure](skills/azure/) | 9 | Azure 雲端架構、部署、定價、DevOps | — |
| [chrome](skills/chrome/) | 1 | Chrome DevTools 偵錯與效能分析 | — |
| [claude](skills/claude/) | 13 | Claude API、協作寫作、前端與創意工具 | — |
| [cloudflare](skills/cloudflare/) | 13 | Cloudflare Workers、Durable Objects、Agents SDK | [README](skills/cloudflare/README.md) |
| [dotnet](skills/dotnet/) | 14 | C# 測試（NUnit/xUnit/MSTest/TUnit）、EF Core、NuGet、非同步 | — |
| [github](skills/github/) | 8 | GitHub Issues、PR、CodeQL、Dependabot、gh CLI | — |
| [google-play-console-cli](skills/google-play-console-cli/) | 16 | Google Play 發布、審查、測試、定價與營運自動化 | — |
| [gtm](skills/gtm/) | 11 | GTM 技術整合、產品策略、企業銷售、AI GTM | — |
| [microsoft](skills/microsoft/) | 12 | Azure SDK、AI Foundry、Copilot SDK、MCP Builder | [README](skills/microsoft/README.md) |
| [power-platform](skills/power-platform/) | 8 | Power BI（DAX、模型、報表）、Power Apps、Fabric Lakehouse | — |
| [tampermonkey](skills/tampermonkey/) | 1 | Tampermonkey 使用者腳本開發（API、安全、除錯） | — |
| [vscode](skills/vscode/) | 9 | 重構、規格撰寫、README 生成、安全審查、Git commit | — |
<!-- CATALOG:END -->

> 各來源的完整技能清單、說明與 upstream commit 請見 [`catalog/skills.lock.json`](catalog/skills.lock.json) 或 [Skills Registry 網站](https://skill.yu.money/)。
> 本 README 不再手動維護逐一技能表格，以免與 lockfile 產生分歧。

---

## 如何使用

### 方法一：使用 `npx skills` 安裝（建議）

<!-- INSTALL:START -->
> 以下安裝指令由 `scripts/catalog.mjs` 依 `catalog/skills.lock.json` 自動產生，請勿手動編輯。

安裝一律使用 `#<tag>` 釘選版本（不支援 `@version` 或 semver range）。目前 lockfile 的 release 為 **v2.0.1**。

安裝整個 registry：

```bash
npx skills add lettucebo/Skills#v2.0.1
```

只安裝單一來源：

```bash
npx skills add lettucebo/Skills/skills/azure#v2.0.1
```

只安裝單一技能：

```bash
npx skills add "lettucebo/Skills#v2.0.1@agents-sdk"
```

> ⚠️ 上述指令需要 `v2.0.1` tag 已推送到 GitHub；若該 tag 尚未發布，`npx skills` 會找不到對應 ref 而失敗。
<!-- INSTALL:END -->

### 方法二：直接複製

將需要的 skill 資料夾複製到專案的 `.github/skills/` 目錄：

```bash
cp -r /path/to/Skills/skills/dotnet/ef-core your-project/.github/skills/
```

---

## 新增或更新 Skill

`catalog/sources.yml` 是唯一的宣告來源：每個 `SKILL.md` 都必須恰好被 `mappings`、`orphans`、`local` 其中一類涵蓋，否則驗證會失敗。

1. 將 skill 資料夾加入對應的 `skills/<source>/<skill>/` 路徑，並在 `catalog/sources.yml` 宣告
   - 有上游來源：加入對應 source 的 `mappings`（需指定 upstream repository 與 `source` 路徑）
   - 無上游來源、僅保留快照：加入 `orphans`
   - 本倉庫原創：放在 `skills/lettucebo/`，並加入 `local`
2. 先提交 skill 與 manifest，並確認目前 lock release 的 tag 已發布且為 `HEAD` 的 ancestor
3. 執行 `node scripts/sync.mjs --apply`；mapped skill 會從 upstream 重新 staging、驗證 provenance 並建立 `mapping-added` history，local/orphan skill 則會保留本地快照並建立對應的 added history。新 skill 都從 `1.0.0` 開始，並依 minor release 更新 lockfile、`NOTICE` 與本 README 的產生區塊
4. 執行 `npm test` 與 `node scripts/validate.mjs`，再提交同步器產生的變更

`scripts/catalog.mjs --bootstrap` 與 `node scripts/sync.mjs --baseline` 只供首次建立 registry 使用；verified baseline 建立後不可用來新增 mapping。請勿手動編輯 `<!-- CATALOG:START -->` 與 `<!-- INSTALL:START -->` 區塊。

`SKILL.md` 必要格式：

```yaml
---
name: skill-name
description: 觸發技能載入的一行說明。
---
```

---

## 每日自動同步

`.github/workflows/sync.yml` 每日 03:00 UTC 觸發，但**排程套用（apply）預設為關閉**。

同步引擎會以 release tag 與 lockfile 對帳；在 release tag 尚未推送之前，每次排程執行都會失敗並重複開啟追蹤 issue。因此排程 apply 由 repository variable `SKILLS_SYNC_ENABLED` 控制：

```bash
# 於 release tag（例如 v2.0.0）推送發布後再執行，才會啟用每日排程同步
gh variable set SKILLS_SYNC_ENABLED --body true
```

（亦可於 Settings → Secrets and variables → Actions → Variables 新增同名變數。）

變數值必須恰好是字串 `true`；未設定或其他值都會讓排程 job 直接 skip（不算失敗、不會產生噪音）。手動觸發（`workflow_dispatch`）的 dry-run 與 apply 不受此變數影響，隨時可用。

---


## 核心原則

以下原則摘自 [Agents.md](skills/microsoft/Agents.md)：

1. **選擇性載入** — 只載入與當前任務相關的 skills，避免 context rot
2. **先查文件** — 使用 SDK 前先查官方文件，不依賴過時的訓練資料
3. **簡潔優先** — 最少的程式碼解決問題，不做多餘的抽象
4. **精準修改** — 只動需要改的部分，不順手「改善」其他程式碼

---

## 授權

- 本 registry 的工具程式（`scripts/`、`hooks/`）與未來的 `skills/lettucebo/` 原創技能採用 MIT License，詳見 [LICENSE](LICENSE)。
- 各 vendored skill 保留其原始專案的授權；完整來源與授權對應請見 [NOTICE](NOTICE)。
- `claude/docx`、`claude/pdf`、`claude/pptx`、`claude/xlsx` 的專有鏡像已在 `2.0.0` 前移除；lock/history 保留 tombstone 稽核軌跡，而 `RESTRICTED_SKILL_PATHS` 永久保留為拒絕清單。