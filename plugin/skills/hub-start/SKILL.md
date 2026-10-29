---
name: hub-start
description: 啟動或關閉「團隊中樞」（多個 AI 同場聊天的本機網頁程式）。使用者說「開團隊中樞」「啟動中樞」「關掉團隊中樞」「中樞有沒有開」時使用。
---

# 啟動／關閉團隊中樞

控制腳本：`${CLAUDE_PLUGIN_ROOT}/scripts/hubctl.js`（只用 Node，不需安裝套件）。回覆用繁體中文、白話。

## 步驟

1. 先找資料夾：`node "${CLAUDE_PLUGIN_ROOT}/scripts/hubctl.js" where`
   - 印出路徑 → 到第 2 步。
   - 印出 `NOT_FOUND` → 使用者還沒有團隊中樞。**先問使用者**要不要下載（會下載約數 MB，並安裝一個套件），說明來源是 https://github.com/Patrick770616/team-hub.git ，預設放在 `~/team-hub`。同意後才執行：
     `git clone https://github.com/Patrick770616/team-hub.git "<家目錄>/team-hub"`
     再 `node "${CLAUDE_PLUGIN_ROOT}/scripts/hubctl.js" set-dir "<該路徑>"`。
     若使用者說已經有、放在別處，直接用 `set-dir <路徑>` 記住即可。
2. 要開：`node "${CLAUDE_PLUGIN_ROOT}/scripts/hubctl.js" start`
   - 第一次會自動安裝套件，要等約一分鐘，這是正常的，先告訴使用者。
   - 成功後瀏覽器會自動打開；網址是 http://localhost:8300 。
3. 要關：`node "${CLAUDE_PLUGIN_ROOT}/scripts/hubctl.js" stop`
4. 只想知道有沒有開：`node "${CLAUDE_PLUGIN_ROOT}/scripts/hubctl.js" status`

## 注意

- 登入密碼不要印出來、不要複述給使用者；瀏覽器會自動登入。
- 腳本找不到密碼或登入失敗時，把腳本的訊息白話轉述即可，不要自己去翻 `.env`。
- 團隊中樞需要 Node.js 20.6 以上；`node --version` 太舊就請使用者先更新。
- Claude 成員一律走使用者的 Claude Code 訂閱，不要建議使用者去設定按量計費的 API 金鑰。
