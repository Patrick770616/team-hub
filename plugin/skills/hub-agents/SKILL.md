---
name: hub-agents
description: 把「團隊中樞」裡的 Claude 助手角色匯出成 Claude Code 的 subagent，讓 Claude Code 也能直接叫它們幫忙。使用者說「把中樞的助手匯出」「讓 Claude Code 用中樞的角色」「匯出成 subagent」時使用。
---

# 把中樞的助手匯出成 subagent

每位 Claude 助手會變成一個 subagent 檔（`hub-<助手編號>.md`），角色文字、模型、能不能上網都沿用中樞的設定。回覆用繁體中文、白話。

控制腳本：`${CLAUDE_PLUGIN_ROOT}/scripts/hubctl.js`

## 步驟

1. 團隊中樞要開著；沒開就照 `hub-start` 技能先啟動。
2. 看有哪些助手：`node "${CLAUDE_PLUGIN_ROOT}/scripts/hubctl.js" agents`，把名字和角色重點列給使用者。
3. 問清楚兩件事再動手（兩件都是使用者的決定）：
   - 要匯出哪幾位（預設全部）。
   - 放哪裡：**目前專案**（`./.claude/agents/`，只有這個專案能用，預設）或**全部專案**（`--user`，放 `~/.claude/agents/`）。
4. 執行：
   - 全部、放目前專案：`node "${CLAUDE_PLUGIN_ROOT}/scripts/hubctl.js" export-agents`
   - 指定幾位：後面接助手編號，例如 `export-agents a-1234abcd`
   - 放全部專案：加 `--user`
5. 回報寫了哪些檔。提醒使用者：新的 subagent 要重開 Claude Code（或在 `/agents` 裡重新載入）才看得到。

## 注意

- 匯出的 subagent 只能讀檔（Read、Glob、Grep），有開「上網」的才多 WebSearch、WebFetch；不會有改檔或執行指令的權限，這和中樞預設一致。
- 助手負責的資料夾路徑不會寫進檔案（那是這台電腦上的路徑）。
- 腳本遇到同名但不是從中樞匯出的檔案會略過，不會覆蓋；再匯出一次會覆蓋自己匯出過的檔。
- 只匯出 Claude 助手；綁定的舊對話、Gemini、其他 AI 不在其中。
- 匯出後 subagent 是各自獨立的副本：之後在中樞改了角色，要再匯出一次才會更新。
