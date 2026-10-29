---
name: hub-memorize
description: 把「團隊中樞」某個群組的討論總結成結論，寫進各 Claude 成員的專案記憶。使用者說「把剛剛的討論存進記憶」「總結中樞的群組」「寫入記憶」時使用。
---

# 總結群組討論並寫入記憶

等同網頁上的「💾 總結並寫入記憶」：Gemini 把上次總結之後的新討論整理成「核心決議／技術規格變更／各成員分工」，寫進每位 Claude 成員的專案記憶資料夾（`~/.claude/projects/<專案>/memory/`）。回覆用繁體中文、白話。

控制腳本：`${CLAUDE_PLUGIN_ROOT}/scripts/hubctl.js`

## 步驟

1. 團隊中樞要開著。沒開的話，照 `hub-start` 技能先啟動。
2. 列出聊天室：`node "${CLAUDE_PLUGIN_ROOT}/scripts/hubctl.js" groups`
3. 決定是哪一個：
   - 使用者講了名字 → 對應到 `id`。
   - 只有一個群組，或對不上 → 把清單（名稱、成員）給使用者選，不要猜。
4. 執行：`node "${CLAUDE_PLUGIN_ROOT}/scripts/hubctl.js" memorize <id>`
5. 把結果白話告訴使用者：寫入了哪幾位成員的記憶、摘要的重點幾句。

## 注意

- 這會呼叫一次 Gemini（用的是使用者在中樞裡設好的金鑰，計入每日 Token 上限）。
- 回報「上次總結之後還沒有新的討論」時，直接告訴使用者沒有新內容，不要重試。
- 回報 Gemini 金鑰沒設定時，請使用者到中樞的「🔌 加入其他 AI」填金鑰，不要自己改 `.env`。
- 摘要內容不要含金鑰或密碼；若看到疑似機密，提醒使用者檢查。
