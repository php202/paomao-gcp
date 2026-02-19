# GCP 共用：員工業績月報、各店日報、打卡 API

避開 Google Apps Script `urlfetch` 每日限制；日報與打卡 API 移轉至 GCP 可減輕 GAS 負載。

## 各店日報（GCP 版）

使用 Node.js 直接呼叫 SayDou `dailyIncome`，並寫入「營收報表 / 營收報表_直營」。

```bash
# 跑單日
node index.js daily-report 2026-02-11

# 跑區間
node index.js daily-report 2026-02-10 2026-02-11
```

需要環境變數：
- `PAO_CAT_CORE_API_URL`、`PAO_CAT_SECRET_KEY`（用來取店家清單 / 核心設定）
- `SAYDOU_BEARER_TOKEN`（或 `TOKEN_SHEET_SS_ID`）
- `DAILY_ACCOUNT_REPORT_SS_ID`（可省略，未設會改讀 Core `getCoreConfig`）

### 每天凌晨自動跑（run acc）

已提供排程腳本 `setup-jobs-and-scheduler.sh`，會建立：
- Cloud Run Job：`pao-daily-report`
- Cloud Scheduler：`pao-daily-report-midnight`（時區 `Asia/Taipei`）

快速設定：

```bash
cd gcp
source set-env.sh
./setup-jobs-and-scheduler.sh
```

預設凌晨時間在 `set-env.sh`：

```bash
DAILY_REPORT_CRON="10 0 * * *"   # 每天 00:10（台灣時間）
```

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
| `FETCH_BATCH_SIZE` | 每批 API 數（預設 10） |
| `GOOGLE_APPLICATION_CREDENTIALS` | Service Account JSON 檔案路徑 |

---

## 打卡 API（bind / check_in）

將網頁打卡（paopaomao.tw/checkin）的 **bind**、**check_in** 改由 GCP 處理，可減少 GAS 的 doPost 與 getCoreConfig 呼叫次數。

### 本機測試

```bash
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
export LINE_STAFF_SS_ID="你的員工試算表ID"
node index.js serve
# POST http://localhost:8080/checkin  body: { "action": "bind", "uuid": "...", "frontUuid": "..." }
# POST http://localhost:8080/checkin  body: { "action": "check_in", "userId": "...", "uuid": "...", "frontUuid": "...", "latitude": 25.0, "longitude": 121.5 }
```

### 部署為 Cloud Run Service

1. 部署時 CMD 改為 `node index.js serve`，並設定 `LINE_STAFF_SS_ID`、`GOOGLE_APPLICATION_CREDENTIALS`（或專案預設 SA）。
2. 取得服務 URL（例：`https://xxx.run.app`）。
3. **前端改址**：將打卡頁面目前呼叫的 GAS Web App URL 改為 `https://xxx.run.app/checkin`（POST，body 格式不變：`{ action, uuid, frontUuid, userId?, latitude?, longitude? }`）。

### 試算表需求

- `LINE_STAFF_SS_ID` 試算表內需有：**員工清單**、**管理者清單**、**公司列表**、**員工打卡紀錄**（欄位與 GAS 版一致），且需共用給 Service Account（編輯者）。

---

## LINE Webhook 備援（GCP 本地指令 + 可選轉發 GAS）

當 GAS **urlfetch 每日額度用盡**時，LINE 可由 GCP 直接處理主要員工指令（如：我要打卡、查詢打卡記錄、Line問題集、店家回覆狀態、神美日報、上月小費等）。  
若仍有未搬遷指令，可用 `FORWARD_UNKNOWN_TO_GAS=1` 轉發到 GAS 主 webhook。

### 環境變數（`node index.js serve` 時）

| 變數 | 說明 |
|------|------|
| `LINE_CHANNEL_SECRET` | LINE Developers → 頻道 → Basic settings → Channel secret（用於驗證 Webhook 簽章） |
| `LINE_TOKEN_PAOSTAFF` | LINE Developers → Messaging API → Channel access token（發送回覆用） |
| `LINE_STAFF_SS_ID` | 員工試算表（同上，需含 員工清單、管理者清單、員工打卡紀錄） |
| `LINE_HQ_SS_ID` | 門市資料試算表（`Line問題集` 會用到「問題集」工作表） |
| `LINE_STORE_SS_ID` | 訊息一覽表（`店家回覆狀態` 會用到「店家基本資料」「訊息一覽」） |
| `PAO_CAT_CORE_API_URL` | Core API Web App URL（神美日報、上月小費、客人 AI 等指令） |
| `PAO_CAT_SECRET_KEY` | Core API 金鑰（需與 PaoMao_Core 一致） |
| `CHECK_IN_LINK` | 可選，預設 `https://www.paopaomao.tw/checkin` |
| `GAS_WEBHOOK_URL` | 建議設定。非「我要打卡」事件會轉發到此 GAS Webhook URL（例：`https://script.google.com/macros/s/xxxx/exec`） |
| `FORWARD_UNKNOWN_TO_GAS` | 可選，`1`=未搬遷指令轉發 GAS；`0`=僅走 GCP（預設） |
| `WEBHOOK_LOG_VERBOSE` | 可選，`1` 詳細事件 log；`0` 精簡 log |
| `GCS_BUCKET_ATTENDANCE` | 可選。若設定，店家／員工本月・上月出勤改產 Excel 上傳此 bucket，回傳下載按鈕（避免 Drive 配額不足） |

### 錯誤 log 在哪裡？

- **Cloud Logging（建議）**：Cloud Run Service / Job 的 `console.log`、`console.error` 都會進 **Logs Explorer**（或 Cloud Run → Logs）。
- **統一錯誤表（方便人工監控）**：`/line-webhook`、`/store-line-webhook` 以及未捕捉的 crash 會 best-effort 追加到「泡泡貓｜line@訊息回覆一覽表」的工作表 `錯誤紀錄`（欄位：時間、來源、錯誤訊息、上下文）。
  - 需把該試算表共用給 Cloud Run 執行身分（或金鑰的 Service Account）為**編輯者**，並啟用 **Google Sheets API**。
  - 目標試算表可用環境變數固定：`WEBHOOK_ERROR_LOG_SS_ID` / `UNIFIED_ERROR_LOG_SS_ID`（工作表名可用 `WEBHOOK_ERROR_LOG_SHEET_NAME`）。

### 出勤 Excel 資料保留與清理

- **GCS（`attendance/`）**：不會自動刪除。若要定期清掉舊檔，可一鍵設定 **90 天生命週期**：
  ```bash
  cd gcp/scripts
  source ../set-env.sh   # 會讀取 GCS_BUCKET_ATTENDANCE
  ./set-gcs-attendance-lifecycle.sh
  # 或指定 bucket：./set-gcs-attendance-lifecycle.sh pao-attendance-excel
  ```
- **試算表「請求表單紀錄」**：僅記錄 uuid、userId、月份、連結、時間，**不會自動清空**。若需控管筆數，可手動刪除舊列，或另建排程於試算表刪除過久紀錄。

### 啟用備援（urlfetch 滿了時）

1. 部署 GCP 服務（`node index.js serve`）到 Cloud Run，並設定上述環境變數。
2. 到 **LINE Developers Console** → 你的頻道 → **Messaging API** → **Webhook URL**，改為：  
   - **員工打卡**：`https://你的Cloud Run網址/line-webhook`  
   - **各店（客人 LINE／訊息一覽表）**：`https://你的Cloud Run網址/store-line-webhook`（已統一使用 GCP 入口，不再使用 GAS Web App 收 Webhook）
3. 儲存後，所有 LINE 訊息會打到 GCP：  
   - **已搬遷指令**：由 GCP 直接回覆  
   - **未搬遷指令**：若 `FORWARD_UNKNOWN_TO_GAS=1` 且有 `GAS_WEBHOOK_URL`，會轉發到 GAS 主 webhook
4. 建議先以 `FORWARD_UNKNOWN_TO_GAS=0` 測 GCP 本地處理，確認後再視需要開啟轉發。

### 本機 LINE Webhook 測試（除錯用）

不用一直部署，讓 LINE 直接打本機即可除錯：

1. **終端機 1**：`cd gcp && node index.js serve`（或 `./run-serve.sh`），需有 `.env` 或 `set-env.sh` 的變數。
2. **終端機 2**：用隧道把本機 port 曝露成 HTTPS，例如 `ngrok http 8080` 或 `./run-tunnel.sh`。
3. 到 **LINE Developers** → **Messaging API** → **Webhook URL** 暫時改成隧道網址 + `/line-webhook`（例：`https://xxx.ngrok-free.app/line-webhook`）。
4. 對 bot 發訊息，請求會進本機，可看 log、設中斷點。測完記得把 Webhook URL 改回正式環境。

詳見 **[docs/本機LINE_Webhook測試.md](docs/本機LINE_Webhook測試.md)**。

### 測試「urlfetch 滿了」情境

- **打卡頁**：前端使用 `postCheckin(body)` 先打 GAS、失敗再打 GCP，即可在 GAS 掛掉或額度滿時仍能打卡。
- **LINE 我要打卡**：將 Webhook URL 改為 GCP `/line-webhook` 後，在 LINE 傳「我要打卡」即可驗證；無須真的把 GAS 額度用完。詳見 `測試urlfetch滿了.md`。
