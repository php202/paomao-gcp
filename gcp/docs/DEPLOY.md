# 在 GCP 上固定排程執行

用 **Cloud Run Jobs** 跑腳本，再用 **Cloud Scheduler** 排程觸發，不需開 VM、不用本機常駐。

---

## 架構

```
Cloud Scheduler（排程）
    → 觸發 Cloud Run Job
        → 執行 node index.js check-token 或 employee-monthly-report
```

- **Token 檢查**：建議每日一次（例如每天 9:00）
- **員工業績月報**：見下方「員工業績月報 定期更新」建議。

---

## 員工業績月報 定期更新（2025 已收集完後）

表已經是員工每日資料的一部分，建議**每天跑一次**，只更新「當月」或「上月+當月」，不要每次重跑整年（API 多、耗時長）。

| 頻率 | 建議時間 | 跑哪幾個月 | 指令範例 |
|------|----------|------------|----------|
| **每日** | 凌晨 2:00 或 3:00 | 只更新**當月** | `node index.js 2026-02 2026-02` |
| **每日** | 凌晨 2:00 | **上月 + 當月**（補遲入單） | `node index.js 2026-01 2026-02` |

- **只更新當月**：每天跑、API 少、當月數字每天更新，員工早上看就是最新。
- **上月+當月**：若常有遲入單，可每天跑兩個月；或改為「每月 1 號跑上月，每天跑當月」（需兩條排程）。

**Cloud Scheduler / 本機 cron 範例（只更新當月，每日 2:00）：**

```bash
# 需動態帶入當月，例如 2026-02
YM=$(date +%Y-%m)
node index.js $YM $YM
```

或使用專用腳本（見 `gcp/run-monthly-report-daily.sh`）。

---

## 一、前置：GCP 專案與權限

1. 開 [Google Cloud Console](https://console.cloud.google.com/)，選好專案（或新建）。
2. 啟用 API：
   - [Cloud Run API](https://console.cloud.google.com/apis/library/run.googleapis.com)
   - [Artifact Registry API](https://console.cloud.google.com/apis/library/artifactregistry.googleapis.com)
   - [Cloud Scheduler API](https://console.cloud.google.com/apis/library/cloudscheduler.googleapis.com)
3. 安裝並登入 gcloud（若尚未）：
   ```bash
   gcloud auth login
   gcloud config set project 你的專案ID
   ```

---

## 二、把試算表權限給 Cloud Run 用的帳號

Cloud Run Job 會用「專案預設的 Compute Engine 服務帳戶」或你指定的服務帳戶去讀寫 Google 試算表。

1. 查服務帳戶 email：
   ```bash
   gcloud iam service-accounts list
   ```
   預設通常是：`專案編號-compute@developer.gserviceaccount.com`
2. 到每個用到的 **Google 試算表**（員工清單、店家基本資料、Token 試算表、產出試算表）：
   - 共用 → 新增「上述服務帳戶 email」→ 檢視者或編輯者（產出那張要編輯者）。

這樣 Job 裡就不必再放服務帳戶金鑰，用「應用程式預設憑證」即可。

---

## 三、建映像檔並推到 Artifact Registry

```bash
cd node_express/gcp

# 建立 Artifact Registry 倉庫（只需做一次）
export REGION=asia-east1
export PROJECT_ID=你的專案ID
gcloud artifacts repositories create gcp-scripts --repository-format=docker --location=$REGION

# 建映像檔並推送
gcloud builds submit --tag $REGION-docker.pkg.dev/$PROJECT_ID/gcp-scripts/pao-run:latest
```

之後程式有改，再執行一次 `gcloud builds submit ...` 即可更新映像。

---

## 四、建立 Cloud Run Job（兩個 Job 或一個 Job 兩種排程）

### 作法 A：兩個 Job（建議）

一個專門做 Token 檢查，一個專門做月報。

```bash
export REGION=asia-east1
export PROJECT_ID=你的專案ID
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/gcp-scripts/pao-run:latest
```

**1. Token 檢查 Job（每日跑）**

```bash
gcloud run jobs create pao-check-token \
  --image $IMAGE \
  --region $REGION \
  --task-timeout 5m \
  --set-env-vars "ADMIN_EMAIL=paopaomao.of@gmail.com" \
  --set-secrets "SAYDOU_BEARER_TOKEN=saydou-token:latest,GMAIL_USER=gmail-user:latest,GMAIL_APP_PASSWORD=gmail-app-password:latest"
```

若還沒用 Secret Manager，可先改用一般環境變數（較不建議放密碼）：

```bash
gcloud run jobs create pao-check-token \
  --image $IMAGE \
  --region $REGION \
  --task-timeout 5m \
  --set-env-vars "ADMIN_EMAIL=paopaomao.of@gmail.com,GMAIL_USER=paopaomao.of@gmail.com" \
  --update-env-vars "SAYDOU_BEARER_TOKEN=你的Token"
# GMAIL_APP_PASSWORD 建議放 Secret Manager，見下方
```

**2. 員工業績月報 Job（每月跑）**

```bash
gcloud run jobs create pao-employee-report \
  --image $IMAGE \
  --region $REGION \
  --task-timeout 60m \
  --set-env-vars "LINE_STAFF_SS_ID=1GH2Xbih...,LINE_STORE_SS_ID=1ZV_0vjt...,OUTPUT_SS_ID=1ZMutegY...,TOKEN_SHEET_SS_ID=1-t4KPVK..."
```

覆寫成執行月報指令（預設 CMD 是 check-token）：

```bash
gcloud run jobs update pao-employee-report --region $REGION \
  --command "node" \
  --args "index.js,employee-monthly-report"
```

---

### 作法 B：一個 Job，用排程參數區分

只建一個 Job，用 Cloud Scheduler 的「執行參數」區分要跑哪一個（需 Scheduler 呼叫 Run Jobs API 時帶參數，或建兩條排程各觸發同一個 Job 但用不同 Override）。實務上作法 A 較直覺，建議用作法 A。

---

## 五、設定 Secret Manager（建議，放 Token 與 Gmail 密碼）

```bash
# 建立 secret（值會要你輸入或從檔案讀）
echo -n "你的SayDou_Bearer_Token" | gcloud secrets create saydou-token --data-file=-
echo -n "paopaomao.of@gmail.com" | gcloud secrets create gmail-user --data-file=-
echo -n "你的Gmail應用程式密碼" | gcloud secrets create gmail-app-password --data-file=-
```

讓 Cloud Run 的服務帳戶能讀這些 secret：

```bash
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
for s in saydou-token gmail-user gmail-app-password; do
  gcloud secrets add-iam-policy-binding $s \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

建立 Job 時用 `--set-secrets`（如上面作法 A 的範例）。

---

## 六、用 Cloud Scheduler 固定排程

先讓 Scheduler 用的服務帳戶能觸發 Job（專案預設 Compute 帳戶通常已有權限，若 403 再執行）：

```bash
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
gcloud run jobs add-iam-policy-binding pao-check-token --region=$REGION \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/run.invoker"
gcloud run jobs add-iam-policy-binding pao-employee-report --region=$REGION \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/run.invoker"
```

**每日 9:00（UTC）跑 Token 檢查**（台灣 9:00 = UTC 1:00，排程可設 `0 1 * * *`）：

```bash
gcloud scheduler jobs create http pao-check-token-daily \
  --location $REGION \
  --schedule "0 1 * * *" \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/pao-check-token:run" \
  --http-method POST \
  --oauth-service-account-email ${PROJECT_NUMBER}-compute@developer.gserviceaccount.com
```

**每月 1 號 2:00（UTC）跑員工業績月報**（台灣 2:00 = UTC 18:00 前一天，例如 `0 18 1 * *` 或依需求調整）：

```bash
gcloud scheduler jobs create http pao-report-monthly \
  --location $REGION \
  --schedule "0 18 1 * *" \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/pao-employee-report:run" \
  --http-method POST \
  --oauth-service-account-email ${PROJECT_NUMBER}-compute@developer.gserviceaccount.com
```

排程語法為 **cron（UTC）**，台灣時間需減 8 小時換算。

---

## 七、在 Console 裡用介面排程（最直觀）

1. [Cloud Run](https://console.cloud.google.com/run) → **Jobs** → 選你建好的 Job（例如 `pao-check-token`）。
2. 點 **「排程」** / **「Schedule」** → 新增排程。
3. 選 **Cloud Scheduler**，設定 cron 或週期（例如每天 9:00）。
4. 儲存後，到 [Cloud Scheduler](https://console.cloud.google.com/cloudscheduler) 可看到剛建立的工作，之後會依排程觸發該 Job。

月報 Job（`pao-employee-report`）同理，另建一條排程（例如每月 1 號）。

---

## 八、檢查與除錯

- **執行紀錄**：Cloud Run → Jobs → 點 Job 名稱 → **「執行」** 分頁。
- **日誌**：點某次執行 → **「記錄」**，或到 [Logging](https://console.cloud.google.com/logs) 篩選該 Job。
- **手動跑一次**：在 Job 頁面點 **「執行」**，不設排程也可先確認會成功再綁 Scheduler。

---

## 九、環境變數整理（給 Job 用）

| 變數 | 用途 | 範例 |
|------|------|------|
| `ADMIN_EMAIL` | Token 異常時收信 | `paopaomao.of@gmail.com` |
| `GMAIL_USER` | 寄信用 Gmail | 同上 |
| `GMAIL_APP_PASSWORD` | Gmail 應用程式密碼 | 建議放 Secret Manager |
| `SAYDOU_BEARER_TOKEN` | SayDou API | 可改由試算表讀則不設 |
| `TOKEN_SHEET_SS_ID` | Token 試算表 | 從試算表讀 Token 時必填 |
| `LINE_STAFF_SS_ID` | 員工清單試算表 | 月報用 |
| `LINE_STORE_SS_ID` | 店家試算表 | 月報用 |
| `OUTPUT_SS_ID` | 產出試算表 | 月報用 |

試算表記得都要「共用」給 Cloud Run Job 使用的服務帳戶（第二步）。

---

完成以上步驟後，就會在 GCP 上固定排程執行 Token 檢查與員工業績月報，不需本機常駐。

---

## 十、部署打卡 API 為 Cloud Run Service（HTTP 常駐服務）

打卡 API（`node index.js serve`）可部署成 **Cloud Run Service**，對外提供 `POST /checkin`，供前端或 GAS 備援使用。

### 前置（與 Job 相同）

- 同一個 GCP 專案、已啟用 Cloud Run / Artifact Registry
- 已建過映像（上面「三、建映像檔」的 `gcloud builds submit`），或下面腳本會自動建
- **LINE_STAFF_SS_ID** 試算表（員工清單、管理者清單、公司列表、員工打卡紀錄）已**共用給 Cloud Run 使用的服務帳戶**（同 Job 的服務帳戶即可）

### 方式 A：用腳本一鍵部署

```bash
cd node_express/gcp
export PROJECT_ID=你的專案ID
export LINE_STAFF_SS_ID=你的員工試算表ID
# 可選：REGION=asia-east1、SERVICE_NAME=pao-checkin-api
chmod +x deploy-checkin-api.sh
./deploy-checkin-api.sh
```

結束後會印出服務 URL，例如：`https://pao-checkin-api-xxxxx.asia-east1.run.app`，打卡端點即 **該 URL + `/checkin`**。

### 方式 B：手動 gcloud 指令

```bash
export REGION=asia-east1
export PROJECT_ID=你的專案ID
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/gcp-scripts/pao-run:latest

# 若映像尚未存在，先建
gcloud builds submit --tag $IMAGE

# 部署為 Service，覆寫 CMD 為 node index.js serve
gcloud run deploy pao-checkin-api \
  --image $IMAGE \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --command "node" \
  --args "index.js,serve" \
  --set-env-vars "LINE_STAFF_SS_ID=你的試算表ID" \
  --min-instances 0 \
  --max-instances 10
```

### 權限說明

- Cloud Run 會使用專案預設的 Compute 服務帳戶（或你指定的帳戶）執行。
- 不需在環境變數設定 `GOOGLE_APPLICATION_CREDENTIALS`；只要把 **LINE_STAFF_SS_ID 試算表** 共用給該服務帳戶（編輯者），即可用「應用程式預設憑證」讀寫試算表。

### 取得服務 URL

```bash
gcloud run services describe pao-checkin-api --region asia-east1 --format='value(status.url)'
```

前端或備援請 POST 到 **`<上述 URL>/checkin`**，body 格式與 GAS 相同（`action`, `uuid`, `frontUuid`, `userId?`, `latitude?`, `longitude?`）。
