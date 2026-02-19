# 各店訊息一覽表：LINE Webhook 使用 GCP 入口

各店（客人 LINE／訊息一覽表）的 LINE Webhook 已**統一改為 GCP** 處理，不再使用 GAS Web App 接收 Webhook。

## 設定步驟

1. **部署 GCP 服務**  
   使用 `gcp/deploy-line-webhook.sh`（或既有 Cloud Run 部署）完成部署，並設定 `LINE_STORE_SS_ID`、`INTEGRATED_SHEET_SS_ID` 等環境變數。

2. **取得 Cloud Run 服務網址**  
   部署完成後腳本會印出服務網址，或至 GCP Console → Cloud Run → 你的服務 → 複製「服務網址」。

3. **各店頻道 Webhook URL**  
   到 **LINE Developers Console** → 選擇**各店**的頻道（非員工打卡頻道）→ **Messaging API** → **Webhook URL**，設為：
   ```
   https://<Cloud Run 服務網址>/store-line-webhook
   ```
   例如：`https://pao-checkin-api-xxxxx-as.a.run.app/store-line-webhook`

4. **儲存**後，該店客人傳送的訊息會由 GCP `api/store-line-webhook.js` 處理（寫入訊息一覽、線上預約查空位、挽留清單等）。

## 說明

- **GAS 各店訊息一覽表**仍保留並使用：Web App（查詢空位 searchAvailability、挽留清單後台、Chrome 外掛等）仍會呼叫 GAS；僅 **LINE 推播進來的 Webhook** 改由 GCP 接收。
- 同一 Cloud Run 服務同時提供 `/line-webhook`（員工）與 `/store-line-webhook`（各店），依 path 分流。
- 詳見 [各店關鍵字與權限對照.md](各店關鍵字與權限對照.md)、[CUTOVER_RUNBOOK.md](CUTOVER_RUNBOOK.md) Stage 2。
