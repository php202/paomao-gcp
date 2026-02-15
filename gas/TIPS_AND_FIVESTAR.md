# 各店五星好評 + 上個月小費表（GAS 實作）

邏輯參考 **node_tools > runTips()**：表單（Google 表單回應）＋ SayDou 消費紀錄合併，產出小費表與消費追蹤；並加上 **星數**（本次潔顏師的表現幾顆星）。**實作全部在 GAS，不更動 node_tools。**

---

## 1. PaoMao_Core（上個月小費表）

- **Config.js**：`TIPS_FORM_SS_ID`（表單回應試算表）、`TIPS_FORM_SHEET_NAME`、`TIP_TABLE_SHEET_GID`（1792957916）、`LINE_STAFF_SS_ID`
- **SayDou.js**：`fetchMembersByDateRange(startDate, endDate)` 拉取 CRM 會員（供合併時取得手機、儲值金）
- **TipsReport.js**：
  - `getTipsFormDataFromSheet(startDate, endDate)`：從表單試算表讀取當月回應
  - `fetchAllStoresTransactions(startDate, endDate)`：全門店消費交易
  - `mergeTipsWithConsumption(formRows, transactions, memberMap)`：與 runTips 相同合併邏輯
  - `buildLastMonthTipsReport()`：產出上個月小費表資料
  - `writeLastMonthTipsToSheet()`：寫入試算表 **1GH2XbihFIY0AX8SMF9Tk6igrVKPpA_vMJVlkDkJjpe4** 內 **gid=1792957916** 的工作表
- **產出欄位**：建立時間、門店、地點、會員、手機、備註、總價、意見時間、小費、意見、差距小時、會員儲值金、**星數**

## 2. Core API

- **doGet ?action=lastMonthTipsReport**：執行 `writeLastMonthTipsToSheet()` 並回傳 `{ ok, startDate, endDate, rowCount }` 或錯誤訊息。

## 3. 管理者關鍵字「上月小費」

- **ReportHelpers.js**：`REPORT_KEYWORD_RULES` 新增 `{ keywords: ["上月小費"], handler: "lastMonthTips", label: "上月小費" }`；`getReportTextForKeyword("lastMonthTips", { managedStoreIds })` 呼叫 `buildLastMonthTipsReport()` 並依管理者門市過濾，產出文字報告。
- **泡泡貓 員工打卡 Line@**：與「昨日報告」「本月報告」相同流程，僅**管理者**傳「上月小費」可取得**所屬店家**的上月小費／五星好評摘要（不需改 main.js，由 Core.getReportHandlerFromKeyword / getReportTextForKeyword 處理）。

## 4. 依負責店家給出

可依「管理者清單」（與明日預約報告相同）取得各店負責人 LINE userId，再將該店的五星好評／小費摘要 Push 給對應管理者；可參考 `各店訊息一覽表/TomorrowReservationReport.js` 的 `getManagerUserIdsForStore`、`pushTomorrowReportToManagers`。
