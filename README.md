# Skills

我個人收集的 AI Coding Agent Skills 合集。

本 Repo 的目的是集中管理、分類並存放所有我認為實用的 [Agent Skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)，方便在不同專案中快速引用與複用。

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
共 **103 個技能**，來自 11 個來源。

> 以下統計由 `scripts/catalog.mjs` 依 `catalog/skills.lock.json` 自動產生，請勿手動編輯。
>
> 目前所有 mapped 技能的 `baseline` 為 `unverified`，代表 lockfile 記錄的是目前 vendored 的內容快照（`snapshotHash`），尚未對應到已驗證的上游 commit。

| 來源 | 數量 | 說明 | 文件 |
|------|:----:|------|------|
| [azure](skills/azure/) | 9 | Azure 雲端架構、部署、定價、DevOps | — |
| [chrome](skills/chrome/) | 1 | Chrome DevTools 偵錯與效能分析 | — |
| [claude](skills/claude/) | 17 | Claude API、文件生成、創意工具（PDF/PPTX/XLSX 等） | — |
| [cloudflare](skills/cloudflare/) | 13 | Cloudflare Workers、Durable Objects、Agents SDK | [README](skills/cloudflare/README.md) |
| [dotnet](skills/dotnet/) | 14 | C# 測試（NUnit/xUnit/MSTest/TUnit）、EF Core、NuGet、非同步 | — |
| [github](skills/github/) | 8 | GitHub Issues、PR、CodeQL、Dependabot、gh CLI | — |
| [gtm](skills/gtm/) | 11 | GTM 技術整合、產品策略、企業銷售、AI GTM | — |
| [microsoft](skills/microsoft/) | 12 | Azure SDK、AI Foundry、Copilot SDK、MCP Builder | [README](skills/microsoft/README.md) |
| [power-platform](skills/power-platform/) | 8 | Power BI（DAX、模型、報表）、Power Apps、Fabric Lakehouse | — |
| [tampermonkey](skills/tampermonkey/) | 1 | Tampermonkey 使用者腳本開發（API、安全、除錯） | — |
| [vscode](skills/vscode/) | 9 | 重構、規格撰寫、README 生成、安全審查、Git commit | — |
<!-- CATALOG:END -->

### azure（9 個）

| 技能 | 說明 |
|------|------|
| `az-cost-optimize` | 分析 IaC 或資源群組以優化 Azure 費用 |
| `azure-architecture-autopilot` | 自動產生 Azure 架構圖與建議 |
| `azure-deployment-preflight` | 部署前驗證 Azure 資源配置 |
| `azure-devops-cli` | Azure DevOps CLI 操作輔助 |
| `azure-pricing` | 查詢與比較 Azure 服務定價 |
| `azure-resource-health-diagnose` | 診斷 Azure 資源健康狀態 |
| `azure-resource-visualizer` | 視覺化 Azure 資源關係 |
| `azure-role-selector` | 選擇適當的 Azure RBAC 角色 |
| `azure-static-web-apps` | Azure Static Web Apps 部署與設定 |

### chrome（1 個）

| 技能 | 說明 |
|------|------|
| `chrome-devtools` | Chrome DevTools 偵錯、效能分析與網路監控 |

### claude（17 個）

| 技能 | 說明 |
|------|------|
| `algorithmic-art` | 生成演算法藝術圖像 |
| `brand-guidelines` | 品牌指南分析與應用 |
| `canvas-design` | Canvas 互動設計工具 |
| `claude-api` | Claude API 整合（Python/TypeScript） |
| `doc-coauthoring` | 文件協作撰寫 |
| `docx` | 生成 Word 文件（.docx） |
| `frontend-design` | 前端 UI 設計輔助 |
| `internal-comms` | 內部溝通文稿生成 |
| `mcp-builder` | MCP Server 建構指引 |
| `pdf` | 生成 PDF 文件 |
| `pptx` | 生成 PowerPoint 簡報（.pptx） |
| `skill-creator` | 建立 Claude 技能的指引 |
| `slack-gif-creator` | 生成 Slack 用 GIF |
| `theme-factory` | 主題風格生成 |
| `web-artifacts-builder` | Web 元件生成與原型 |
| `webapp-testing` | Web 應用程式測試輔助 |
| `xlsx` | 生成 Excel 試算表（.xlsx） |

### cloudflare（9 個）

| 技能 | 說明 |
|------|------|
| `agents-sdk` | Cloudflare Agents SDK 開發 |
| `building-ai-agent-on-cloudflare` | 在 Cloudflare 上建構 AI Agent |
| `building-mcp-server-on-cloudflare` | 在 Cloudflare 上建構 MCP Server |
| `cloudflare` | Cloudflare 全平台參考（Workers、D1、R2 等） |
| `durable-objects` | Durable Objects 狀態管理 |
| `sandbox-sdk` | Cloudflare Sandbox SDK |
| `web-perf` | Web 效能優化（Cloudflare 生態） |
| `workers-best-practices` | Cloudflare Workers 最佳實踐 |
| `wrangler` | Wrangler CLI 操作與設定 |

### dotnet（14 個）

| 技能 | 說明 |
|------|------|
| `csharp-async` | C# 非同步程式設計模式 |
| `csharp-docs` | C# XML 文件註解撰寫 |
| `csharp-mcp-server-generator` | 生成 C# MCP Server 骨架 |
| `csharp-mstest` | MSTest 單元測試撰寫 |
| `csharp-nunit` | NUnit 單元測試撰寫 |
| `csharp-tunit` | TUnit 測試框架使用 |
| `csharp-xunit` | xUnit 單元測試撰寫 |
| `dotnet-best-practices` | .NET 開發最佳實踐 |
| `dotnet-design-pattern-review` | 設計模式審查與建議 |
| `dotnet-timezone` | .NET 時區處理 |
| `dotnet-upgrade` | .NET 版本升級輔助 |
| `editorconfig` | EditorConfig 設定生成 |
| `ef-core` | Entity Framework Core 操作 |
| `nuget-manager` | NuGet 套件管理 |

### github（8 個）

| 技能 | 說明 |
|------|------|
| `codeql` | CodeQL 安全掃描設定 |
| `create-github-pull-request-from-specification` | 從規格文件建立 Pull Request |
| `dependabot` | Dependabot 設定與管理 |
| `gh-cli` | GitHub CLI（gh）操作輔助 |
| `git-flow-branch-creator` | Git Flow 分支管理 |
| `github-issues` | GitHub Issues 管理與操作 |
| `publish-to-pages` | 發布到 GitHub Pages |
| `secret-scanning` | GitHub Secret Scanning 設定 |

### gtm（11 個）

| 技能 | 說明 |
|------|------|
| `gtm-0-to-1-launch` | 產品 0 到 1 上市策略 |
| `gtm-ai-gtm` | AI 產品 Go-To-Market 策略 |
| `gtm-board-and-investor-communication` | 董事會與投資人溝通 |
| `gtm-developer-ecosystem` | 開發者生態系建構 |
| `gtm-enterprise-account-planning` | 企業客戶規劃 |
| `gtm-enterprise-onboarding` | 企業客戶導入流程 |
| `gtm-operating-cadence` | 營運節奏與 OKR 管理 |
| `gtm-partnership-architecture` | 合作夥伴架構設計 |
| `gtm-positioning-strategy` | 產品定位策略 |
| `gtm-product-led-growth` | 產品主導成長（PLG） |
| `gtm-technical-product-pricing` | 技術產品定價策略 |

### microsoft（12 個）

| 技能 | 說明 |
|------|------|
| `cloud-solution-architect` | Azure 雲端解決方案架構設計 |
| `continual-learning` | 持續學習與知識更新 |
| `copilot-sdk` | GitHub Copilot SDK 整合 |
| `entra-agent-id` | Microsoft Entra Agent ID 設定 |
| `frontend-design-review` | 前端設計審查 |
| `github-issue-creator` | 從程式碼自動建立 GitHub Issue |
| `mcp-builder` | Microsoft 生態的 MCP Server 建構 |
| `microsoft-agent-framework` | Microsoft Agent Framework 開發 |
| `microsoft-code-reference` | Microsoft 官方程式碼範例查詢 |
| `microsoft-docs` | Microsoft Learn 文件搜尋 |
| `podcast-generation` | Podcast 內容生成 |
| `skill-creator` | Azure SDK skill 建立指引 |

### power-platform（8 個）

| 技能 | 說明 |
|------|------|
| `fabric-lakehouse` | Microsoft Fabric Lakehouse 設計 |
| `power-apps-code-app-scaffold` | Power Apps Code App 鷹架生成 |
| `power-bi-dax-optimization` | Power BI DAX 效能優化 |
| `power-bi-model-design-review` | Power BI 資料模型設計審查 |
| `power-bi-performance-troubleshooting` | Power BI 效能問題診斷 |
| `power-bi-report-design-consultation` | Power BI 報表設計諮詢 |
| `power-platform-mcp-connector-suite` | Power Platform MCP 連接器套件 |
| `powerbi-modeling` | Power BI 模型建構最佳實踐 |

### tampermonkey（1 個）

| 技能 | 說明 |
|------|------|
| `tampermonkey` | Tampermonkey 使用者腳本開發（API、GM 函式、安全、TypeScript） |

### vscode（9 個）

| 技能 | 說明 |
|------|------|
| `code-review` | 程式碼審查（orphan：尚未驗證上游來源） |
| `create-implementation-plan` | 生成功能實作計畫 |
| `create-readme` | 自動生成專案 README |
| `create-specification` | 撰寫功能規格文件 |
| `generate-custom-instructions-from-codebase` | 從程式碼庫生成 Copilot 自訂指示 |
| `git-commit` | 生成 Conventional Commit 訊息 |
| `refactor` | 程式碼重構輔助 |
| `refactor-plan` | 重構計畫生成 |
| `security-review` | 程式碼安全審查 |

---

## 如何使用

### 方法一：直接複製

將需要的 skill 資料夾複製到專案的 `.github/skills/` 目錄：

```bash
cp -r /path/to/Skills/skills/dotnet/ef-core your-project/.github/skills/
```

### 方法二：使用 npx 安裝器（適用 microsoft/skills）

```bash
npx skills add microsoft/skills
```

透過互動式精靈選擇需要的技能。

---

## 新增 Skill 來源

1. 在 `skills/` 下建立以來源命名的目錄（例如 `skills/my-custom/`）
2. 每個技能放入獨立子目錄，包含符合格式的 `SKILL.md`
3. 更新本 README 的收錄清單

`SKILL.md` 必要格式：

```yaml
---
name: skill-name
description: 觸發技能載入的一行說明。
---
```

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
- `claude/docx`、`claude/pdf`、`claude/pptx`、`claude/xlsx` 為專有授權（Restricted，`redistributable: false`），使用前請先閱讀各技能資料夾內的 `LICENSE.txt`。