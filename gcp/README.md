# 員工業績月報 GCP 版本

避開 Google Apps Script `urlfetch` 每日限制，在 GCP 或本機執行。

## 需要您提供的權限／設定

### 1. Google Cloud 專案

- 建立或選用現有 GCP 專案
- 啟用 **Google Sheets API**

### 2. Service Account

1. 到 GCP Console → IAM 與管理 → Service Accounts → 建立服務帳戶
2. 建立金鑰（JSON）並下載
3. 將金鑰檔案路徑設為環境變數 `GOOGLE_APPLICATION_CREDENTIALS`：
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS="/path/to/your-service-account.json"
   ```

### 3. 試算表共用

把以下試算表「共用」給 Service Account 的 Email（例：`xxx@project-id.iam.gserviceaccount.com`），並設為**編輯者**：

- 員工清單：`LINE_STAFF_SS_ID`
- 店家基本資料：`LINE_STORE_SS_ID`
- 產出試算表（員工業績月報）：`OUTPUT_SS_ID`
- （若從試算表讀 Token）Token 試算表：`TOKEN_SHEET_SS_ID`

### 4. SayDou Bearer Token

任選一種：

- 設定 `SAYDOU_BEARER_TOKEN` 環境變數  
  或
- 設定 `TOKEN_SHEET_SS_ID`，讓程式從該試算表「預約表單」C2 讀取，且該試算表需已共用給 Service Account

## 本機執行

```bash
cd gcp-employee-monthly-report
npm install

# 設定環境變數
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
export SAYDOU_BEARER_TOKEN="your-token"

# 執行（預設 2025-01 ~ 本月）
node index.js

# 指定月份範圍
node index.js 2025-07 2026-02
```

## GCP Cloud Run 部署（選用）

```bash
gcloud run deploy employee-monthly-report \
  --source . \
  --region asia-east1 \
  --set-env-vars "SAYDOU_BEARER_TOKEN=xxx,LINE_STAFF_SS_ID=xxx,..." \
  --set-secrets "GOOGLE_APPLICATION_CREDENTIALS=sa-key:latest"
```

或使用 Cloud Scheduler 排程觸發。

## 環境變數

| 變數 | 說明 |
|------|------|
| `SAYDOU_BEARER_TOKEN` | SayDou API Bearer Token（與 `TOKEN_SHEET_SS_ID` 二選一） |
| `TOKEN_SHEET_SS_ID` | 若未設 Token，從此試算表「預約表單」C2 讀取 |
| `LINE_STAFF_SS_ID` | 員工清單試算表 |
| `LINE_STORE_SS_ID` | 店家基本資料試算表 |
| `OUTPUT_SS_ID` | 員工業績月報產出試算表 |
| `TIPS_GODSID` | 小費品項 ID（預設 201969） |
| `FETCH_BATCH_SIZE` | 每批 API 數（預設 20） |
| `GOOGLE_APPLICATION_CREDENTIALS` | Service Account JSON 檔案路徑 |
