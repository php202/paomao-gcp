# GAS 與 GCP 說明：專案規模與排程對接

## 這個專案在 GAS 會太小嗎？

**不會。** 目前各店訊息一覽表的用途（CRM 整合、報表、每日/每月排程、LINE Push）用 **Google Apps Script（GAS）** 就夠用：

- 單次執行時間：一般 6 分鐘內、付費/Workspace 可到 30 分鐘，你的每日更新與報表都在範圍內。
- 排程：用 GAS 內建的「時間驅動觸發」即可，不需額外開 GCP。
- 試算表、LINE、SayDou API：GAS 的 `UrlFetchApp`、`SpreadsheetApp` 都能直接對接。

**什麼時候才需要開 GCP？**

- 單次要跑超過 6～30 分鐘（例如大量批次、複雜運算）。
- 需要更精準的排程（例如每 5 分鐘一次）或更複雜的排程邏輯。
- 要接 GCP 專屬服務（BigQuery、Cloud Storage、Vertex AI 等）。

目前你的需求用 GAS 即可，**不必為了「排程會更快」而開 GCP**；先用好 GAS 排程，真有瓶頸再考慮 GCP。

---

## 需要「開 GCP 給我用」嗎？

**我（AI）沒有辦法登入你的 Google / GCP 帳號**，也不能在你電腦或雲端上直接點「建立觸發」或改設定。  
我能做的是：

- 在專案裡**寫好程式**（例如一鍵建立觸發的腳本）。
- 你本機或 Apps Script 編輯器**執行一次**，就完成對接。

所以**不需要「開 GCP 給我用」**；需要的是**你在自己的環境執行一次我寫好的腳本**，排程就會建立好。

---

## 直接對接排程會更快：一鍵建立觸發

已在專案裡加上 **`Triggers.js`**，你只要**在 Apps Script 編輯器執行一次** `setupAllTriggers`，就會自動建立這些排程，不用一個一個手動加：

| 觸發 | 函式 | 預設時間（台灣） |
|------|------|------------------|
| 每日客人更新 | `runDailyCustomerUpdate` | 每日 21:00 |
| 明日預約報告 | `runTomorrowReservationReportAndPush` | 每日 8:00 |
| 昨日消費報告 | `runYesterdaySalesReportAndPush` | 每日 8:30 |
| 本月消費報告 | `runMonthlySalesReportAndPush` | 每月 1 號 8:00 |

**操作步驟：**

1. 在 [script.google.com](https://script.google.com) 開啟專案「各店訊息一覽表」。
2. 選函式 **`setupAllTriggers`**，按執行。
3. 第一次會要求授權（檢視/管理試算表、觸發等），同意後再執行一次。
4. 到 **編輯 → 目前專案的觸發條件** 確認 4 個時間驅動觸發已建立。

之後若要改時間，只要改 `Triggers.js` 裡的 `TRIGGERS_CONFIG`，再執行一次 `setupAllTriggers` 即可（會先刪除同函式的舊觸發再建立新的）。

**表單送出觸發**（`onFormSubmit_Survey`）仍要**手動加一次**：在「表單回應寫入的那個試算表」對應的 Apps Script 專案裡，新增「表單送出時」→ 函式選 `onFormSubmit_Survey`（若專案是「各店訊息一覽表」且表單回應也在同一專案，可再補一個用程式建立表單觸發的說明；若表單綁不同試算表，就維持手動）。

---

## 小結

- **GAS 對目前專案足夠**，不需為了「排程」特地開 GCP。
- **不需要開 GCP 給我用**；我透過程式幫你對接，你在自己環境執行一次即可。
- **排程對接**：執行一次 **`setupAllTriggers`** 就會建立上述 4 個排程，直接對接、會更快。
