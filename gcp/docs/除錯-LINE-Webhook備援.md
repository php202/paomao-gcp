# LINE Webhook 備援「不行」時這樣查

當 Webhook URL 已改為 GCP 但 LINE 沒反應或驗證失敗，依下面順序檢查。

---

## 1. 確認端點存在

你的服務網址：`https://pao-checkin-api-vkffbzouva-de.a.run.app`

在終端執行：

```bash
curl -s "https://pao-checkin-api-vkffbzouva-de.a.run.app/line-webhook"
```

- **有回傳** `{"status":"ok","message":"LINE Webhook 端點存在..."}` → 代表有部署到含 `/line-webhook` 的版本，繼續下一步。
- **`{"status":"failed","text":"Not Found"}` 或 404** → 代表目前 Cloud Run 映像**沒有**含 `/line-webhook` 的程式，需要**重新建映像並部署**（見下方「重新部署」或執行 `./deploy-line-webhook.sh`）。

---

## 2. 確認 Cloud Run 環境變數

LINE Webhook 一定要有這三個環境變數，少一個就會「不行」：

| 變數 | 用途 |
|------|------|
| `LINE_CHANNEL_SECRET` | 驗證 LINE 簽章；沒設會回 401，LINE 驗證會失敗 |
| `LINE_TOKEN_PAOSTAFF` | 發送回覆給使用者；沒設無法回「我要打卡」 |
| `LINE_STAFF_SS_ID` | 員工試算表；沒設會回「系統設定不完整」 |

到 **GCP Console** → **Cloud Run** → 點選服務 **pao-checkin-api** → **修訂版本**（或「編輯與部署新修訂版本」）→ **變數與密碼**，確認上面三個都有設。

或用指令查（把 `REGION` 換成你實際區域，例如 `asia-east1` 或 `europe-west1`）：

```bash
gcloud run services describe pao-checkin-api --region=REGION --format="yaml(spec.template.spec.containers[0].env)"
```

若沒有這三個，要**補上並部署新修訂**（見下）。

---

## 3. 補上環境變數並部署新修訂

一次補齊三個（請換成你自己的值）：

```bash
# 先確認你的區域（從網址看：xxx-de.a.run.app 可能是 europe-west1，xxx.asia-east1.run.app 就是 asia-east1）
export REGION=asia-east1
# 若你的網址是 -de.a.run.app，可試：export REGION=europe-west1

gcloud run services update pao-checkin-api \
  --region=$REGION \
  --set-env-vars "LINE_CHANNEL_SECRET=你的Channel Secret,LINE_TOKEN_PAOSTAFF=你的Channel Access Token,LINE_STAFF_SS_ID=你的試算表ID"
```

若本來就有部分變數，想**只加一個**，例如只加 `LINE_CHANNEL_SECRET`：

```bash
gcloud run services update pao-checkin-api \
  --region=$REGION \
  --set-env-vars "LINE_CHANNEL_SECRET=你的Channel Secret"
```

更新後再到 LINE 傳「我要打卡」試一次。

---

## 4. 重新部署（端點 404 或確定要換成最新程式時）

若 `curl .../line-webhook` 是 404，代表跑的是舊映像，需要從專案裡**重新建映像並部署**：

```bash
cd /path/to/node_express/gcp

export PROJECT_ID=你的GCP專案ID
export REGION=asia-east1
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/gcp-scripts/pao-run:latest

# 建新映像（會把目前程式含 server.js、line-webhook 打進去）
gcloud builds submit --tag $IMAGE

# 部署，並帶上 LINE 需要的環境變數
gcloud run deploy pao-checkin-api \
  --image $IMAGE \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --command "node" \
  --args "index.js,serve" \
  --set-env-vars "LINE_STAFF_SS_ID=你的試算表ID,LINE_CHANNEL_SECRET=你的Channel Secret,LINE_TOKEN_PAOSTAFF=你的Channel Access Token" \
  --min-instances 0 \
  --max-instances 10
```

部署完成後，再執行一次：

```bash
curl -s "https://你的服務網址/line-webhook"
```

應看到 `{"status":"ok","message":"LINE Webhook 端點存在..."}`。

---

## 5. 看 Cloud Run 記錄

到 **Cloud Run** → **pao-checkin-api** → **記錄**，在 LINE 傳「我要打卡」時看有沒有：

- `[line-webhook] event error:` → 代表處理事件時出錯（例如試算表權限、LINE API 錯誤）。
- `401` / `unauthorized` → 多半是 `LINE_CHANNEL_SECRET` 沒設或設錯。
- 完全沒有對 `/line-webhook` 的請求 → 可能是 Webhook URL 沒設對，或 LINE 沒打到這台。

---

## 6. 試算表權限

`LINE_STAFF_SS_ID` 那張試算表必須**共用給 Cloud Run 使用的服務帳戶**（編輯者）。  
服務帳戶通常是：`專案編號-compute@developer.gserviceaccount.com`，或你在部署時指定的服務帳戶。

到試算表 **共用** → 新增該 email → 編輯者，儲存後再試一次「我要打卡」。

---

## 快速對照

| 狀況 | 可能原因 | 對應章節 |
|------|----------|----------|
| LINE 按「驗證」失敗 | 401：`LINE_CHANNEL_SECRET` 未設或錯 | §2、§3 |
| 傳「我要打卡」沒回覆 | 沒設 Token / 試算表 / 或 500 錯誤 | §2、§5、§6 |
| curl /line-webhook 是 404 | 映像沒有含 /line-webhook 的程式 | §1、§4 |
