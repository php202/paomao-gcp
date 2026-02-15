# 測試「urlfetch 滿了」時使用者仍可正常使用

當 GAS 的 urlfetch 每日額度用盡時，可透過**備用機（GCP）**讓打卡頁與 LINE「我要打卡」仍能正常運作。

---

## 一、打卡頁（bind / check_in）

### 做法

- 打卡頁前端改用 **`postCheckin(body)`**（見 `gcp/frontend-checkin-with-fallback.js`）：先 POST 到 GAS，若逾時、5xx 或回應內容含 urlfetch/quota 等關鍵字，再 POST 到 GCP `/checkin`。
- 確保 GCP 服務已部署，且 `LINE_STAFF_SS_ID` 試算表已共用給 GCP 的 Service Account（編輯者）。

### 如何模擬「urlfetch 滿了」

1. **暫時把前端 GAS URL 改成無效網址**：前端會判定失敗並自動改打 GCP，可驗證整段 bind/check_in 是否正常。
2. 或 **不改網址**：等 GAS 真的額度用盡時，前端 fallback 會自動啟動。

### 驗證

- 用瀏覽器實際走一輪「綁定 → 點擊打卡 → 送出位置」，確認成功且試算表「員工打卡紀錄」有寫入。

---

## 二、LINE「我要打卡」

### 做法

- GCP 提供 **POST /line-webhook**，收到 LINE Webhook 後驗證簽章、只處理「我要打卡」：查權限、產生 uuid、寫入員工打卡紀錄、回傳打卡按鈕。
- 當 **urlfetch 滿了**時，到 LINE Developers 把 **Webhook URL** 從 GAS 改為 GCP：  
  `https://你的Cloud Run網址/line-webhook`

### 本機一鍵啟動

1. 在 `gcp` 目錄下複製環境變數範例並填寫：
   ```bash
   cd gcp
   cp .env.example .env
   # 編輯 .env，填上 LINE_CHANNEL_SECRET、LINE_TOKEN_PAOSTAFF、LINE_STAFF_SS_ID、GOOGLE_APPLICATION_CREDENTIALS
   ```
2. 啟動服務（會自動讀取 .env）：
   ```bash
   npm run serve
   ```
   或：`node index.js serve`
3. 看到 `[GCP] Server listening on port 8080` 即表示啟動成功。
4. **驗證服務**：另開終端執行 `curl http://localhost:8080/`，應回傳 `{"status":"ok","server":"gcp-backup"}`。
5. 本機測試 LINE Webhook 需用 **ngrok** 等工具把 `http://localhost:8080` 對外，再將 LINE Webhook URL 設為 `https://你的ngrok網址/line-webhook`。

### 如何測試（不一定要真的把 GAS 額度用完）

1. **部署 GCP 服務**  
   - 本機：如上 `npm run serve` + ngrok。  
   - 或部署到 Cloud Run，設定環境變數：`LINE_CHANNEL_SECRET`、`LINE_TOKEN_PAOSTAFF`、`LINE_STAFF_SS_ID`（可選 `CHECK_IN_LINK`）。

2. **切換 Webhook 到 GCP**  
   - LINE Developers → 你的頻道（泡泡貓 員工打卡）→ Messaging API → Webhook URL  
   - 改為：`https://你的 GCP 服務網址/line-webhook`  
   - 儲存。

3. **在 LINE 傳「我要打卡」**  
   - 若帳號在員工清單或管理者清單，應收到打卡按鈕；點擊後應開啟打卡頁並可完成打卡。  
   - 若帳號未開通，應收到「你的帳號尚未開通…」。

4. **確認試算表**  
   - 打開 `LINE_STAFF_SS_ID` 的「員工打卡紀錄」，應多一列（userId、時間、uuid）。

5. **測完可改回 GAS**  
   - 把 Webhook URL 改回原本的 GAS Web App URL，即恢復由 GAS 處理。

### 注意

- 備援目前**只處理「我要打卡」**，其他關鍵字（查詢打卡記錄、最新活動等）不會回覆；若要全功能備援需在 GCP 擴充對應邏輯。
- `LINE_CHANNEL_SECRET`、`LINE_TOKEN_PAOSTAFF` 請從 LINE Developers 取得，勿提交到版控。
