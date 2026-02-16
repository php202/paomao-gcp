# 本機 LINE Webhook 測試

讓 LINE 把訊息打到你本機，不用一直部署就能除錯。

## 做法概覽

1. 本機啟動服務（`node index.js serve`）。
2. 用 **隧道** 把本機 port 曝露成一個 **公網 HTTPS 網址**。
3. 在 LINE Developers 把 **Webhook URL** 暫時改成該網址（例如 `https://xxx.ngrok.io/line-webhook`）。
4. 用手機或模擬器對 bot 發訊息，請求會進你本機，可直接看 log、設中斷點除錯。

測完記得把 Webhook URL 改回正式環境（Cloud Run 或 GAS）。

---

## 步驟一：本機啟動服務

在專案目錄下（要有 `.env` 或 `set-env.sh` 的變數）：

```bash
cd gcp
# 若有 .env（建議）：已含 LINE_CHANNEL_SECRET、LINE_TOKEN_PAOSTAFF、LINE_STAFF_SS_ID、GOOGLE_APPLICATION_CREDENTIALS 等
node index.js serve
# 或
./run-serve.sh
```

看到 `[GCP] Server listening on port 8080` 表示服務已起（port 可用 `PORT=3000` 改）。

---

## 步驟二：開隧道（二選一）

### 方式 A：ngrok（建議，需註冊）

1. 安裝：<https://ngrok.com/download> 或 `brew install ngrok`
2. 另開一個終端機：
   ```bash
   ngrok http 8080
   ```
3. 畫面上會出現一行 **Forwarding**，例如：
   ```text
   https://a1b2c3d4.ngrok-free.app -> http://localhost:8080
   ```
4. 你的 **公網 Webhook 網址** 就是：  
   `https://a1b2c3d4.ngrok-free.app/line-webhook`  
   （每次重開 ngrok 網址可能會變；付費可固定網域。）

### 方式 B：localtunnel（免註冊）

1. 另開終端機：
   ```bash
   npx localtunnel --port 8080
   ```
2. 會給一個網址，例如 `https://xxx.loca.lt`，**第一次用瀏覽器開會要你點「Click to Continue」**。
3. Webhook URL 設為：  
   `https://xxx.loca.lt/line-webhook`

---

## 步驟三：LINE Developers 設定 Webhook

1. 打開 [LINE Developers Console](https://developers.line.biz/console/)
2. 選你的 **Provider** → **Channel**（員工打卡用的那一個）
3. **Messaging API** 分頁 → **Webhook URL** 改成你在步驟二得到的網址，例如：
   - `https://a1b2c3d4.ngrok-free.app/line-webhook`
4. 按 **Update**，可順便按 **Verify** 確認 LINE 打得到（會回 200）。

---

## 步驟四：發訊息測試

用手機或模擬器對該 bot 發訊息（例如「本月出勤」「明日預約清單」），本機跑 `node index.js serve` 的那個終端機就會收到請求、印 log，你也能用 IDE 設中斷點除錯。

---

## 注意事項

- **同一時間** Webhook URL 只能填一個；改成本機隧道時，正式環境（Cloud Run）就收不到 LINE 事件，測完記得改回正式 URL。
- ngrok 免費版重開後網址會變，每次本機測試都要再改一次 Webhook URL（或使用 ngrok 固定網域）。
- 本機需能連 Google（試算表、Core API 等），且 `.env` 裡 `GOOGLE_APPLICATION_CREDENTIALS`、`LINE_STAFF_SS_ID`、`LINE_CHANNEL_SECRET`、`LINE_TOKEN_PAOSTAFF` 等要正確。
- 若希望未處理的指令轉發到 GAS，可設 `GAS_WEBHOOK_URL` 與 `FORWARD_UNKNOWN_TO_GAS=1`。

---

## 一鍵開隧道（可選）

專案內有 `run-tunnel.sh`，若已安裝 ngrok，可在 **另一個終端機** 執行：

```bash
cd gcp
./run-tunnel.sh
```

會執行 `ngrok http 8080`，你只要把畫面上的 `https://xxx.ngrok-free.app` 加上 `/line-webhook` 填到 LINE 的 Webhook URL 即可。
