# 疑難排解

[**繁體中文**](../zh-TW/troubleshooting.md) | [English](../en/troubleshooting.md) | [文件首頁](README.md)

## 消費者常見問題

### `npx skills add` 無法解析 tag

**現象：** 指令在解析 `#<tag>` 時失敗（Git ref 查找錯誤）。

**原因：** `catalog/skills.lock.json` 中標示的 `v<release>` tag 尚未被推送到
GitHub。lockfile 的 `release` 欄位並不保證該 tag 已經存在 — 詳見
[安裝方式](installation.md) 的步驟一。

**解法：** 檢查這個 repository 的 Releases／tags 頁面，或網站的 `/status/`
頁面，找出目前實際存在的最新 tag，改用該 tag。

### 誤用 `@version` 而不是 `#tag`

**現象：** 安裝直接失敗，或安裝到錯誤（或沒有）的 skill。

**原因：** 在這個 registry 的安裝語法中，`#` 用來釘選 Git ref（永遠必須指定），
而 `@<name>` 是**依名稱**篩選單一 skill，不是依版本。並不支援 `@<version>`
語法 — 像 `@1.2.3` 這樣的值會被當作 skill 名稱篩選條件解讀，但沒有任何 skill
名叫 `1.2.3`。

**解法：** 永遠用 `#v<release>` 釘選 ref，只有在要依 frontmatter 名稱選取單一
skill 時才加上 `@<name>`（例如把 `vX.Y.Z` 換成已發布 tag 後使用
`#vX.Y.Z@agents-sdk`）。

### `npx skills add` 正在等待輸入，或只安裝了所選 skill

**原因：** 簡短的 `npx skills add "owner/repo#tag"` 形式會詢問無法推導的
project／global scope、agent、安裝模式與 skill 選項。唯一偵測到的 agent 可能
被自動選取，而所選 agent 只解析到一個目錄時也會跳過 copy／symlink 提示，因此
不同電腦不一定出現所有 prompts。自動跳過 prompts 不代表已選取全部 skill；
請選擇 `*` 或傳入 `--skill "*"`。
在 repository-root 範圍省略 `--full-depth`，也可能只從頂層
`.github/skills/` 得到「Found 1 skill」，或找不到位於 `skills/` 深處的 catalog
skill。

**解法：** 回答提示，或使用
[安裝方式](installation.md#非互動式-github-copilot-範例) 中釘選版本的非互動式
指令，明確設定 `--agent` 與 `--skill`。Repository-root 的完整或單一 skill
指令都要加上 `--full-depth`。

### 整個 registry 安裝進來了我不預期的 skill

**原因：** 完整 registry 安裝會選取釘選 release 的每個 active skill。2.0.0
包含 115 個 active skill，沒有受限制 skill。

**解法：** 不需要廣泛涵蓋時改裝單一來源或單一 skill。仍請查看
`catalog/skills.lock.json` 或網站狀態頁，因為未來 release 可能再次出現 active
restricted inventory。

### 過期或遺失的本機安裝

**原因：** 只有在選擇 project scope 時，`npx skills add` 才使用所選 agent 的
專案 skills 目錄。本 repository 的 `github-copilot` smoke case 位於
`.agents/skills/`；GitHub Copilot global scope 使用 `~/.copilot/skills/`，
其他 agent 可能使用不同目錄，而手動複製範例則使用 `.github/skills/`。

**解法：** 在消費端專案執行 `npx skills list` 查看 project scope，執行
`npx skills list -g` 查看 global scope。確認所選 scope、agent 與安裝模式，再
查看該 agent 的目錄，最後才決定是否要重新安裝或回報問題。

## 維護者常見問題

### 「the git working tree is not clean」

**原因：** `applyBaseline` 與 `applyUpdate` 都會拒絕在 `git status` 非空時執行，
確保交易（transaction）永遠不會把未提交的本機變更與同步產生的變更混在一起。

**解法：** 先提交或 stash 你的變更，再重新執行同步指令。

### 執行 update 時出現「tag/lock reconciliation failed」

**原因：** 每日 update 引擎要求最高的語意化版本 tag 必須恰好等於 lockfile 的
`release`，並且必須是 `HEAD` 的祖先。當 lockfile 的 `release` 已經被調高但對應
的 tag 從未推送，或是 tag 與 lockfile 已經分歧時，就會發生這個錯誤。

**解法：** 在重試 update 之前，先發布缺少的 tag（或修正分歧的歷史）。各個
workflow job 的確切 commit 與 tag 順序，請見
[同步與發布](sync-and-releases.md)。

### 刪除防護機制擋下了一次 update

**原因：** 在單次執行中移除超過允許比例的宣告上游 mapped skill，會被直接擋下 —
詳見 [技能管理](skill-management.md) 中的刪除防護規則。這是防止意外大量刪除的
安全機制，不是一個 bug。

**解法：** 先確認這些刪除確實是你想要的。小群組無法透過同步移除任何 mapping，
而拆分大型刪除也可能在群組縮小後擋住剩餘項目。請使用經過審查的 PR，並遵循正常
的產生輸出與發布流程，不要試圖用分批方式繞過防護。

### 某個上游 repository 無法連線

**原因：** 同步引擎無法 clone 某個宣告的上游（網路故障、存取權被撤銷，或
repository 被改名／刪除）。無法連線的上游永遠不會被靜默當成「全部 skill 都被
刪除」— 而是直接擋下整次執行。

**解法：** 確認 `catalog/sources.yml` 中該上游的 `repository`／`reference` 是否
仍然正確，並在上游恢復可連線後重試。

### GitHub Pages 部署失敗，出現「GitHub Pages is not enabled」

**原因：** 部署 workflow 會在建置前透過 GitHub API 驗證 Pages 是否已啟用，因為
`actions/configure-pages@v6` 無法用 workflow 自己的 token 啟用 Pages。

**解法：** 必須由 repository 管理員在 **Settings → Pages** 手動啟用一次，再重新
執行 workflow。

### E2E 測試因為 port 被佔用而失敗

**原因：** Playwright E2E 測試套件永遠會在 port `4331` 啟動自己的
`astro preview` 伺服器，並拒絕重複使用既有的伺服器；因此若該 port 已被其他程序
佔用，測試會立即失敗，而不是默默測試到錯誤的建置結果。

**解法：** 停止佔用 port 4331 的程序，或在執行
`npm --prefix site run test:e2e` 之前設定 `E2E_PORT` 為一個空閒的 port。

### 驗證錯誤提到一個不是我造成的失效連結

**原因：** 大部分失效的相對連結會讓驗證失敗，但有一小份明確列出的、屬於上游本身
問題的失效連結，會被記錄在 `catalog/sources.yml` 的 `linkExceptions` 中並回報
為警告而非錯誤，這樣別人上游的問題就不會擋住你不相關的變更。

**解法：** 如果這個警告是新出現、且尚未列在清單中，那代表你的變更確實有問題。
如果它符合既有的 `linkExceptions` 項目，那就是預期中的情況，可以安心忽略。
