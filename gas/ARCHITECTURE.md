# GAS 泡泡貓專案架構說明

## 一、整體架構圖

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    外部系統 / 資料來源                     │
                    ├──────────────┬──────────────┬──────────────┬────────────┤
                    │  SayDou API  │ Google Sheets│  LINE 平台   │ Google Form│
                    │ (預約/交易/   │ (客人消費狀態│ (Webhook /   │ (問卷/員工  │
                    │  會員/儲值)   │  員工清單等)  │  Push)       │  填寫)      │
                    └──────┬───────┴──────┬───────┴──────┬───────┴──────┬──────┘
                           │              │              │              │
                           ▼              ▼              ▼              ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │                   PaoMao_Core 共用程式庫                  │
                    │  Config | Utils | LineBot | SayDou | SDapi | SDconsume   │
                    │  Odoo | Invoice | LineStaff                              │
                    └──────────────────────────┬──────────────────────────────┘
                                               │ Core.xxx() 呼叫
         ┌─────────────────────────────────────┼─────────────────────────────────────┐
         │                                     │                                     │
         ▼                                     ▼                                     ▼
┌─────────────────┐                 ┌─────────────────────┐                 ┌─────────────────┐
│ 各店訊息一覽表   │                 │ 泡泡貓 門市 預約表單  │                 │ 泡泡貓 員工打卡  │
│ (CRM/報表/預約)  │                 │ PAOPAO / 拉廣告資料  │                 │ Line@ / 日報表   │
└─────────────────┘                 └─────────────────────┘                 └─────────────────┘
         │                                     │                                     │
         ▼                                     ▼                                     ▼
┌─────────────────┐                 ┌─────────────────────┐                 ┌─────────────────┐
│ 請款表單內容     │                 │ 每週三：顧客退費     │                 │ (門市列表→Core)  │
└─────────────────┘                 └─────────────────────┘                 └─────────────────┘
```

---

## 二、PaoMao_Core 共用程式庫

**角色**：所有業務專案共用的設定、工具、SayDou API、LINE、Odoo 等，以「程式庫」方式被引用，不複製到各專案。

| 檔案 | 職責 |
|------|------|
| **Config.js** | `getCoreConfig()`：試算表 ID、LINE Token、SayDou 等設定 |
| **Utils.js** | 工具：`getEmployeeCodeToNameMap()`（員工清單）、`clearMyCache()` 等 |
| **LineBot.js** | LINE：`sendLineReply()`、`sendLinePushText()`、`jsonResponse()`、`getUserDisplayName()` 等 |
| **SayDou.js** | SayDou：`getStoresInfo()`、`getTransactionsForStoreByDate()`、`getTransactionsForStoreByDateRange()`、預約/會員/交易 API |
| **SDapi.js / SDconsume.js** | SayDou 底層呼叫、消費紀錄解析 |
| **Odoo.js / Invoice.js / LineStaff.js** | Odoo、發票、LINE 員工相關 |

**部署**：在 script.google.com 將 PaoMao_Core 專案「部署為程式庫」，其他專案在 `appsscript.json` 的 `libraries` 引用，呼叫時使用 `Core.xxx()`。

---

## 三、各專案與職責

| 專案資料夾 | 主要職責 | 關鍵檔案 / 功能 |
|------------|----------|------------------|
| **各店訊息一覽表** | 各店 CRM、預約、報表、LINE Webhook | CustomerProfile（客人消費狀態、客人樣貌摘要）、SayDouFullProfile（會員全貌）、**runDailyCustomerUpdate**（每日更新客人消費）、明日/昨日/本月報告（Push + 寫入試算表）、**員工每月樣態**、**Triggers.js**（一鍵建立排程 `setupAllTriggers`）、表單送出觸發 |
| **泡泡貓 門市 預約表單 PAOPAO** | 門市預約、銷售資料 | main, reservationReport, storeData, pushOutstanding |
| **泡泡貓拉廣告資料** | 廣告／預約資料 | todayReservation, appointmentLists |
| **泡泡貓 員工打卡 Line@** | 員工打卡、出勤、Excel | BE-HandleCheckIn, getAtt, sendAtt, SendExcel |
| **日報表 產出** | 日報表產出 | main, onOpen |
| **每週三：顧客退費** | 顧客退費流程 | main, exportToExcel |
| **請款表單內容** | 請款、登入、表單 | login, laborForm, employeeFee, payToReceipt |

門市列表 API 已整合至 **PaoMao_Core** 的 `action=storeList`，由 near-redirect-snippet.html 呼叫。

專案與 scriptId 對照見 **GAS_PROJECTS.md**。

---

## 四、各店訊息一覽表：資料流與模組

此專案是「各店訊息 + CRM + 報表」中樞，依賴 Core 與多張試算表。

### 4.1 資料來源與試算表

| 來源 | 用途 |
|------|------|
| **SayDou API** | 店家列表、預約、交易、會員、儲值紀錄 |
| **Google 試算表（客人消費狀態等）** | 客人消費狀態、SayDou 會員全貌、員工清單、管理者清單、訊息一覽、表單回覆 3 |
| **LINE** | Webhook 收訊、Push 給管理者（報表、提醒） |
| **Google Form** | 問卷／員工填寫 → 觸發寫入客人消費狀態 |

### 4.2 主要流程

```
表單送出 ──► onFormSubmit_Survey ──► 以手機為 key Upsert「客人消費狀態」
                                          └► 彙整問卷／員工填寫／SayDou／儲值／LINE 訊息 → AI專用Prompt

LINE Webhook ──► Post-handleLineWebhook ──► 預約／查詢／刪除等 Action（Action-*.js）

手動/排程 ──► refreshAllCustomersByPhone ──► 依「客人消費狀態」手機欄重拉 SayDou 並更新該表
手動/排程 ──► scheduledDailyRefreshLineMessages ──► 依 lineUserId 從「訊息一覽」更新客人訊息摘要與 AI專用Prompt
手動/排程 ──► scanMessageListAndSyncLineUserIdToCustomerState ──► 掃「訊息一覽」有填手機的列，把該列 lineUserId 寫入「客人消費狀態」對應手機那一列的 lineUserId（可合併多個 ID）

每日排程 ──► runTomorrowReservationReportAndPush ──► 明日預約報告 → LINE Push + 寫入試算表「明日預約報告」
每日排程 ──► runYesterdaySalesReportAndPush ──► 昨日消費報告（總額 + 依經手人）→ LINE Push + 寫入「昨日消費報告」
每月排程 ──► runMonthlySalesReportAndPush ──► 本月消費報告 → LINE Push + 寫入「本月消費報告」+「員工每月樣態」

每日排程 ──► runDailyCustomerUpdate ──► 掃訊息一覽對 lineUserId → 依手機重整客人消費狀態 → 更新 LINE 訊息摘要 → 產出「客人樣貌摘要」
```

### 4.3 報表可見化（試算表）

| 工作表名稱 | 來源 | 欄位概要 |
|------------|------|----------|
| **昨日消費報告** | runYesterdaySalesReportAndPush | 日期、店名、總額、依經手人摘要 |
| **本月消費報告** | runMonthlySalesReportAndPush | 年月、起訖、店名、總額、依經手人摘要 |
| **明日預約報告** | runTomorrowReservationReportAndPush | 日期、店名、報告全文 |
| **員工每月樣態** | runMonthlySalesReportAndPush | 年月、店名、員工代碼、員工姓名、當月總額、筆數 |
| **客人樣貌摘要** | runDailyCustomerUpdate / buildCustomerProfileSummarySheet | 手機、最後更新時間、有無LINE、消費紀錄摘要、儲值摘要 |

以上工作表皆寫入「客人消費狀態」同一份試算表（INTEGRATED_SHEET_SS_ID），方便開一份試算表即可看報表、員工每月樣態與客人樣貌。

### 4.4 報表邏輯（昨日 / 本月）

- **資料**：Core `getTransactionsForStoreByDate(storeId, dateStr)` / `getTransactionsForStoreByDateRange(storeId, start, end)`
- **彙總**：依交易備註的員工代碼（如 nk001）用 `sumTransactionsByRemark` 加總
- **姓名**：Core `getEmployeeCodeToNameMap()` 讀「員工清單」對應代碼→姓名
- **推送**：`getManagerUserIdsForStore(storeId, storeName)` 讀「管理者清單」取得 LINE userId，再 `Core.sendLinePushText()` 送各店報告

---

## 五、觸發建議與一鍵建立

**一鍵建立排程**：在 Apps Script 編輯器選函式 **`setupAllTriggers`** 執行一次，會自動建立下列 4 個時間觸發（見專案內 `Triggers.js`）。表單送出觸發需另在「表單回應的試算表」手動加一次。

| 觸發條件 | 函式名稱 | 說明 |
|----------|----------|------|
| 表單送出 | `onFormSubmit_Survey` | 問卷／員工填寫表單送出時寫入客人消費狀態（需手動設一次） |
| **每日 21:00** | **`runDailyCustomerUpdate`** | 掃訊息一覽對 lineUserId → 重整客人消費狀態 → 更新 LINE 訊息摘要 → 產出客人樣貌摘要 |
| 每日 8:00 | `runTomorrowReservationReportAndPush` | 明日預約報告 Push + 寫入試算表 |
| 每日 8:30 | `runYesterdaySalesReportAndPush` | 昨日消費報告 Push + 寫入試算表 |
| 每月 1 號 8:00 | `runMonthlySalesReportAndPush` | 本月消費報告 Push + 寫入試算表與員工每月樣態（不傳參數＝當月；可傳年、月報上個月） |

---

## 六、本機與部署

| 項目 | 說明 |
|------|------|
| **clasp** | 各專案目錄下 `clasp push` 更新程式碼；不例行 `clasp deploy` |
| **Core 更新** | 改 PaoMao_Core 後 push，並在 script.google.com 將 Core 部署為程式庫；各專案若設 `developmentMode: true` 可即時用新版 |
| **DebugTest** | 各專案有 `runDebugTest()`，可檢查 Core 是否載入、主要函式是否存在 |
| **驗證** | 專案根目錄執行 `node gas/validate.js` 檢查各店訊息一覽表 CONFIG／欄位預期 |

---

## 七、文件對照

| 文件 | 內容 |
|------|------|
| **GAS_PROJECTS.md** | 資料夾名稱 ↔ Apps Script 專案名稱 ↔ scriptId |
| **README.md** | 目錄、Core 使用方式、push 行為、DebugTest 使用方式 |
| **CORE_ALIGN.md** | 與 Core 對齊的呼叫方式、不測試的函式 |
| **DEBUGTEST_REPORT.md** | DebugTest 功能與執行方式 |
| **各店訊息一覽表/PERMISSIONS.md** | 試算表權限與檢查方式 |
| **samples/** | 客人消費狀態、SayDou 會員全貌等產出欄位預期說明 |
