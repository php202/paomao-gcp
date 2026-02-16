# 神美日報：GCP 報告頁與「神美日報_開啟紀錄」

## 問題說明

- 試算表 [泡泡貓 門市資料](https://docs.google.com/spreadsheets/d/1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE/edit?gid=182708797) 內「神美日報_開啟紀錄」工作表（gid=182708797）沒有記錄到開啟訊息。
- 舊連結 `https://www.paopaomao.tw/report?token=...` 仍指向 GAS，且 GAS 的 `writeDailyReportAccessLog` 寫入的是 Core 設定的 `DAILY_ACCOUNT_REPORT_SS_ID` 或 `LINE_STORE_SS_ID`，未必是「泡泡貓 門市資料」這份試算表。

## GCP 端實作（與 GAS odoo_report 同效果）

1. **報告頁**：`GET /report` 提供與 GAS `odoo_report.html` 相同的泡泡日報頁面，API 基底網址會自動設為目前主機的 `/report-api`。
2. **報告 API（免 key）**：`GET /report-api?action=...` 支援：
   - `consumeReportToken&token=xxx`：消耗 token、取得日報資料；若 token 為 GCP 建立，會先寫入「神美日報_開啟紀錄」再向 GAS 取資料。
   - `getReportByDate&sessionId=...&date=...`：管理者查指定日期。
   - `submitReportShare&sessionId=...&content=...`：心得分享。
3. **開啟紀錄寫入**：試算表由 `REPORT_ACCESS_LOG_SS_ID` 或 `LINE_HQ_SS_ID` 指定，工作表名稱為「神美日報_開啟紀錄」，欄位與 GAS `DAILY_REPORT_ACCESS_HEADERS` 一致：Timestamp, Date, Role, UserId, EmployeeCode, EmployeeName, StoreIds。

## 設定步驟

1. **試算表**：在「泡泡貓 門市資料」試算表（ID: `1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE`）中，新增或確認有名為「神美日報_開啟紀錄」的工作表，第一列為標題：`Timestamp`, `Date`, `Role`, `UserId`, `EmployeeCode`, `EmployeeName`, `StoreIds`。
2. **環境變數**（`set-env.sh` 或 Cloud Run 環境）：
   - `LINE_HQ_SS_ID=1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE`（或設 `REPORT_ACCESS_LOG_SS_ID` 指向同一份試算表）。
   - **方式 A**：`REPORT_PAGE_URL=https://<Cloud Run 服務網址>/report`，連結直接開 GCP 報告頁。
   - **方式 B（報告頁在官網）**：維持 `REPORT_PAGE_URL=https://www.paopaomao.tw/report`，並設定 `REPORT_API_BASE=https://<Cloud Run 服務網址>/report-api`；LINE 產生的連結會自動帶上 `api_base` 參數，官網報告頁即可正確呼叫 GCP report-api。
3. **Odoo／官網**：若官網或 Odoo 有嵌入報告頁，可改為嵌入 `https://<Cloud Run 服務網址>/report?token=...`（token 仍由 LINE 神美日報按鈕產生），或使用方式 B 讓連結維持官網網址並帶 `api_base`，開啟時會由 GCP 寫入「神美日報_開啟紀錄」。

## 流程對照

| 步驟 | GAS（舊） | GCP（新） |
|------|-----------|-----------|
| 使用者點 LINE「神美日報」 | Core createReportToken → 回傳連結（paopaomao.tw/report?token=xxx） | GCP createReportToken → 回傳連結（REPORT_PAGE_URL?token=xxx） |
| 使用者開啟連結 | 頁面呼叫 GAS consumeReportToken；GAS 寫入 Core 設定的試算表 | 頁面呼叫 GCP /report-api consumeReportToken；GCP 寫入 LINE_HQ_SS_ID「神美日報_開啟紀錄」後再向 GAS 取報表資料 |
| 報表資料來源 | GAS buildDailyReportPayload | 仍由 GAS buildDailyReportPayload（GCP 轉調 GAS） |

完成上述設定並將 `REPORT_PAGE_URL` 改為 GCP 報告頁後，開啟紀錄會寫入「泡泡貓 門市資料」的「神美日報_開啟紀錄」工作表。
