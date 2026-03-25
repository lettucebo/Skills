# Skills

我個人收集的 AI Coding Agent Skills 合集。

本 Repo 的目的是集中管理、分類並存放所有我認為實用的 [Agent Skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)，方便在不同專案中快速引用與複用。

---

## 目錄結構

```
skills/
└── microsoft/             ← 來源：microsoft/skills（GitHub 開源專案）
    ├── README.md           ← 原始專案文件
    ├── Agents.md           ← Agent 設定模板與核心原則
    ├── context7.json       ← Context7 索引設定
    └── skills/             ← 依語言 → 分類 → 技能的 symlink 樹
        ├── dotnet/
        ├── java/
        ├── python/
        ├── rust/
        └── typescript/
```

每個 skill 來源目錄下以 **語言 → 分類 → 技能名稱** 的階層組織，便於快速查找。

---

## 目前收錄的 Skills

### 來源：[microsoft/skills](https://github.com/microsoft/skills)

Azure SDK 與 Microsoft AI Foundry 的 AI coding agent skills，涵蓋 132+ 個技能。

#### 語言分佈

| 語言 | 技能數量 | 命名後綴 | 範例 |
|------|---------|---------|------|
| Python | 41 | `-py` | `azure-ai-projects-py`, `azure-cosmos-py` |
| .NET | 29 | `-dotnet` | `azure-ai-projects-dotnet`, `azure-cosmos-dotnet` |
| Java | 26 | `-java` | `azure-ai-projects-java`, `azure-cosmos-java` |
| TypeScript | 25 | `-ts` | `azure-ai-projects-ts`, `azure-storage-blob-ts` |
| Rust | 7 | `-rust` | `azure-cosmos-rust`, `azure-identity-rust` |
| Core（跨語言） | 9 | — | `mcp-builder`, `skill-creator`, `copilot-sdk` |

#### 分類總覽

| 分類 | 說明 | dotnet | python | typescript | java | rust |
|------|------|:------:|:------:|:----------:|:----:|:----:|
| compute | 計算服務（Bot, Durable Task, Playwright 等） | ✓ | ✓ | ✓ | ✓ | |
| data | 資料存取（Cosmos DB, Blob, SQL, Redis 等） | ✓ | ✓ | ✓ | ✓ | ✓ |
| entra | 身分驗證（Identity, Key Vault） | ✓ | ✓ | ✓ | ✓ | ✓ |
| foundry | AI Foundry 服務（OpenAI, Search, 語音等） | ✓ | ✓ | ✓ | ✓ | |
| integration | 整合服務（API Center, App Configuration） | ✓ | ✓ | ✓ | ✓ | |
| messaging | 訊息服務（Event Hub, Service Bus, Event Grid） | ✓ | ✓ | ✓ | ✓ | ✓ |
| monitoring | 監控（OpenTelemetry, App Insights） | ✓ | ✓ | ✓ | ✓ | |
| m365 | Microsoft 365 代理程式 | ✓ | ✓ | ✓ | | |
| communication | 通訊服務（Call, Chat, SMS） | | | | ✓ | |
| frontend | 前端 UI（React Flow, Zustand） | | | ✓ | | |
| general | 一般服務（Maps） | ✓ | | | | |
| partner | 合作夥伴（Arize AI, MongoDB Atlas） | ✓ | | | | |

---

## 如何使用

### 方法一：直接引用

在你的專案中，將需要的 skill 複製或 symlink 到專案的 `.github/skills/` 目錄：

```bash
# 複製特定 skill 到你的專案
cp -r /path/to/Skills/skills/microsoft/skills/python/foundry/projects your-project/.github/skills/

# 或使用 symlink
ln -s /path/to/Skills/skills/microsoft/skills/python/foundry/projects your-project/.github/skills/azure-ai-projects-py
```

### 方法二：使用 npx 安裝器（來自原始 repo）

```bash
npx skills add microsoft/skills
```

透過互動式精靈選擇需要的技能。

---

## 新增 Skill 來源

本 Repo 的設計支援收錄來自不同來源的 skills。新增步驟：

1. 在 `skills/` 下建立以來源命名的目錄（例如 `skills/my-custom/`）
2. 放入對應的 skill 檔案，建議遵循 `SKILL.md` 的格式規範
3. 更新本 README 的收錄清單

---

## 核心原則

以下原則摘自 [Agents.md](skills/microsoft/Agents.md)，作為使用 skills 時的指導方針：

1. **選擇性載入** — 只載入與當前任務相關的 skills，避免 context rot（注意力稀釋、token 浪費）
2. **先查文件** — 使用 Azure SDK 前先查官方文件，不依賴過時的訓練資料
3. **簡潔優先** — 最少的程式碼解決問題，不做多餘的抽象
4. **精準修改** — 只動需要改的部分，不順手「改善」其他程式碼

---

## 授權

各 skill 來源的授權依其原始專案為準。`microsoft/skills` 採用 MIT License。