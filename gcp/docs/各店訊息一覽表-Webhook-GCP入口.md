# 各店訊息一覽表：LINE Webhook 全部改為 GCP 入口

各店（客人 LINE／訊息一覽表）的 LINE Webhook **應全部改為 GCP** 處理，不再使用 GAS Web App 接收 Webhook。

若 Webhook 仍指向 GAS，客人發「線上預約」時會走 GAS 邏輯（例如「近幾天都滿了」可能沒有除錯行）。**請將每一店的頻道 Webhook URL 都改為 GCP**。

---

## 如何確認目前是 GAS 還是 GCP？

- **已走 GCP**：客人發「線上預約」後，若回覆中有 **「（除錯：…；請將此整則訊息貼給管理員）」** 這一行（尤其當「都滿了」時），代表該店 Webhook 已指向 GCP。
- **仍走 GAS**：回覆只有「近幾天都滿了，可以呼叫貓小編…」且**沒有**上述除錯行，代表該店 Webhook 仍指向 GAS，請到 LINE Developers 將該店頻道的 Webhook URL 改為 GCP（見下方步驟）。

---

## 遷移步驟（每店都要做）

1. **部署 GCP 服務**  
   使用 `gcp/deploy-line-webhook.sh`（或既有 Cloud Run 部署）完成部署，並設定 `LINE_STORE_SS_ID`／`INTEGRATED_SHEET_SS_ID`、`LEGACY_GAS_STORES_API_URL`（若要用與客服小幫手同一來源查空位）等環境變數。

2. **取得 Cloud Run 服務網址**  
   部署完成後腳本會印出服務網址，或至 GCP Console → Cloud Run → 你的服務 → 複製「服務網址」。

3. **各店頻道 Webhook URL（每一店都要改）**  
   到 **LINE Developers Console** → 選擇**該店**的頻道（客人 LINE，非員工打卡）→ **Messaging API** → **Webhook URL**，設為：
   ```
   https://<Cloud Run 服務網址>/store-line-webhook
   ```
   例如：`https://pao-checkin-api-xxxxx-as.a.run.app/store-line-webhook`  
   然後按 **Update** 儲存。

4. **驗證**  
   用該店客人帳號發送「線上預約」；若回覆在「都滿了」時會多一行「（除錯：…」即表示已改為 GCP。

---

## 遷移後 GCP 負責的項目

- 寫入「訊息一覽」、準客挽留清單
- 關鍵字：線上預約（查空位＋回覆）、我的會員、課程介紹、送出預約、您已取消預約
- 查空位：可與客服小幫手同源（需設 `LEGACY_GAS_STORES_API_URL` 與店家基本資料 G 欄 botId），或使用 GCP 查空位 API
- 「都滿了」時一律附除錯行，方便貼給管理員或對 Log

**Postback（一鍵預約 `action=book_reengagement`）**：目前 GCP 尚未實作，收到 postback 時不會回覆。若需一鍵預約功能，可暫時保留該店 Webhook 指向 GAS，或後續在 GCP 補上實作。

---

## 說明

- **GAS 各店訊息一覽表**仍保留：Web App（查詢空位 searchAvailability、挽留清單後台、Chrome 外掛等）仍會呼叫 GAS；**僅「LINE 推播進來的 Webhook」改由 GCP 接收**。
- 同一 Cloud Run 服務同時提供 `/line-webhook`（員工）與 `/store-line-webhook`（各店），依 path 分流。
- 詳見 [各店關鍵字與權限對照.md](各店關鍵字與權限對照.md)、[CUTOVER_RUNBOOK.md](CUTOVER_RUNBOOK.md) Stage 2。
