# GCP 固定排程執行 - 權限與執行指南

您需要**自己在 GCP 上操作**，以下列出您需要的權限與完整步驟。

---

## 一、您需要給 GCP 什麼權限？（不是給 AI）

AI 無法存取您的 GCP，需要您在 GCP Console 或本機 terminal 自己執行。重點是：

| 對象 | 需要的權限 |
|------|-----------|
| **您的 Google 帳號** | 專案的 Owner 或 Editor（才能啟用 API、建 Job、建排程） |
| **Cloud Run Job 的服務帳戶** | 試算表「共用」給它（編輯者），能讀 Secret Manager |
| **Cloud Scheduler** | 能觸發 Cloud Run Job（run.invoker） |

---

## 二、第一次執行前：GCP 設定清單

### 1. 啟用 API（GCP Console）

到 [API 與服務 → 已啟用的 API](https://console.cloud.google.com/apis/library)，確保已啟用：

- [Cloud Run API](https://console.cloud.google.com/apis/library/run.googleapis.com)
- [Artifact Registry API](https://console.cloud.google.com/apis/library/artifactregistry.googleapis.com)
- [Cloud Scheduler API](https://console.cloud.google.com/apis/library/cloudscheduler.googleapis.com)
- [Secret Manager API](https://console.cloud.google.com/apis/library/secretmanager.googleapis.com)（若要用 Secret 存 Token）
- [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)

### 2. 本機安裝並登入 gcloud

```bash
# 若未安裝：https://cloud.google.com/sdk/docs/install
gcloud auth login
gcloud config set project 你的專案ID
```

### 3. 試算表共用給 Cloud Run 用的服務帳戶

1. 查服務帳戶 email：
   ```bash
   gcloud iam service-accounts list
   ```
   預設為：`專案編號-compute@developer.gserviceaccount.com`

2. 到每個試算表 → **共用** → 新增上述 email → **編輯者**（產出試算表必須可寫）

試算表包括：員工清單、店家、Token 試算表、產出試算表。

---

## 三、依序執行（複製貼上到終端機）

請在專案根目錄 `node_express/gcp` 底下執行：

```bash
cd /Users/yutsunghan/node_express/gcp

# === 變數（請改成你的專案）===
export REGION=asia-east1
export PROJECT_ID=你的專案ID   # 例如：gen-lang-client-0828139766
gcloud config set project $PROJECT_ID

# === 1. 建立 Artifact Registry 倉庫（只需一次）===
gcloud artifacts repositories create gcp-scripts \
  --repository-format=docker --location=$REGION

# === 2. 建映像檔並推送 ===
gcloud builds submit --tag $REGION-docker.pkg.dev/$PROJECT_ID/gcp-scripts/pao-run:latest

# === 3. 建立 Secret（Token、Gmail 密碼，建議用 Secret Manager）===
# 若已建過可跳過
echo -n "你的SayDou_Bearer_Token" | gcloud secrets create saydou-token --data-file=-
echo -n "paopaomao.of@gmail.com" | gcloud secrets create gmail-user --data-file=-
echo -n "你的Gmail應用程式密碼" | gcloud secrets create gmail-app-password --data-file=-

# 讓 Cloud Run 服務帳戶能讀 Secret
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
for s in saydou-token gmail-user gmail-app-password; do
  gcloud secrets add-iam-policy-binding $s \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done

# === 4. 建立兩個 Cloud Run Job ===
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/gcp-scripts/pao-run:latest

# Job 1：Token 檢查（每日）
gcloud run jobs create pao-check-token \
  --image $IMAGE \
  --region $REGION \
  --task-timeout 5m \
  --set-env-vars "ADMIN_EMAIL=paopaomao.of@gmail.com" \
  --set-secrets "SAYDOU_BEARER_TOKEN=saydou-token:latest,GMAIL_USER=gmail-user:latest,GMAIL_APP_PASSWORD=gmail-app-password:latest"

# Job 2：員工業績月報（每月）
gcloud run jobs create pao-employee-report \
  --image $IMAGE \
  --region $REGION \
  --task-timeout 60m \
  --set-env-vars "LINE_STAFF_SS_ID=1GH2Xbih...,LINE_STORE_SS_ID=1ZV_0vjt...,OUTPUT_SS_ID=1ZMutegY...,TOKEN_SHEET_SS_ID=1-t4KPVK..."

gcloud run jobs update pao-employee-report --region $REGION \
  --command "node" \
  --args "index.js,employee-monthly-report"

# === 5. 給 Scheduler 觸發 Job 的權限 ===
gcloud run jobs add-iam-policy-binding pao-check-token --region=$REGION \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/run.invoker"
gcloud run jobs add-iam-policy-binding pao-employee-report --region=$REGION \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/run.invoker"

# === 6. 建立 Cloud Scheduler 排程 ===
# 每日 9:00 台灣 = 1:00 UTC
gcloud scheduler jobs create http pao-check-token-daily \
  --location $REGION \
  --schedule "0 1 * * *" \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/pao-check-token:run" \
  --http-method POST \
  --oauth-service-account-email ${PROJECT_NUMBER}-compute@developer.gserviceaccount.com

# 每月 1 號 10:00 台灣 = 2:00 UTC
gcloud scheduler jobs create http pao-report-monthly \
  --location $REGION \
  --schedule "0 2 1 * *" \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/pao-employee-report:run" \
  --http-method POST \
  --oauth-service-account-email ${PROJECT_NUMBER}-compute@developer.gserviceaccount.com
```

**重要**：請把 `LINE_STAFF_SS_ID`、`LINE_STORE_SS_ID`、`OUTPUT_SS_ID`、`TOKEN_SHEET_SS_ID` 改成您實際的試算表 ID。

---

## 四、若 Secret 已存在（跳過建立）

若 `saydou-token` 等 secret 已建立過，執行 create 會失敗，可改為更新：

```bash
echo -n "新的Token值" | gcloud secrets versions add saydou-token --data-file=-
```

---

## 五、之後程式有改動時

只需重新建映像並推送：

```bash
cd /Users/yutsunghan/node_express/gcp
export REGION=asia-east1
export PROJECT_ID=你的專案ID
gcloud builds submit --tag $REGION-docker.pkg.dev/$PROJECT_ID/gcp-scripts/pao-run:latest
```

Cloud Run Job 會自動用新映像，不需重建 Job。

---

## 六、檢查與手動執行

- **手動跑一次**：Cloud Run → Jobs → 選 Job → 點「執行」
- **看日誌**：Job 執行紀錄 → 點某次執行 → 記錄
- **排程**：Cloud Scheduler 可編輯 cron 時間

---

## 七、AI 能幫您什麼、不能幫您什麼

| 能幫 | 不能幫 |
|------|--------|
| 幫您寫/改程式、修正指令、解答錯誤訊息 | 登入您的 GCP、執行 gcloud、存取您的 Secret / 試算表 |
| 根據錯誤訊息建議修正 | 代您按 GCP Console 按鈕 |

請在本機 terminal 執行上述指令，若有錯誤可貼給我，我可以幫您排查。
