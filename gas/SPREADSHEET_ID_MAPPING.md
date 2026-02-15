# 試算表 ID 對應表（改為 openById 用）

將 `getActiveSpreadsheet()` 改為 `SpreadsheetApp.openById(ssId)` 時，需使用下列試算表 ID。

---

## 一、全域試算表 ID（PaoMao_Core Config.js）

| 變數名稱 | 試算表 ID | 用途說明 |
|----------|-----------|----------|
| `EXTERNAL_SS_ID` | `17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE` | 請款單＿店家基本資訊表 |
| `DAILY_ACCOUNT_REPORT_SS_ID` | `1ZMutegYTLZ51XQHCbfFZ7-iAj1qTZGgSo5VTThXPQ5U` | 泡泡貓日報表 |
| `LINE_STORE_SS_ID` | `1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0` | 訊息一覽表＿店家基本資料（泡泡貓｜line@訊息回覆一覽表） |
| `LINE_STAFF_SS_ID` | `1GH2XbihFIY0AX8SMF9Tk6igrVKPpA_vMJVlkDkJjpe4` | 泡泡貓 員工打卡 line@ |
| `LINE_HQ_SS_ID` | `1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE` | 泡泡貓 門市資料 |
| `NEAR_TRACKING_SS_ID` | `1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE` | 網紅連結追蹤（與門市資料同） |
| `TOKEN_SHEET_SS_ID` (SayDou.js) | `1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE` | SayDou Token 試算表（與門市資料同） |

---

## 二、已確認試算表 ID（使用者提供）

| 專案 | 試算表 ID | 用途說明 |
|------|-----------|----------|
| **泡泡貓 門市 預約表單 PAOPAO** | `1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE` | 門市預約表單（與門市資料同） |
| **每週三：顧客退費** | `1b2-ZFkyKabVeQxpNSgFdrsAkPzDb35vNXDNQYR75XKA` | 顧客退費（回覆）表單，含「表單回應 2」 |
| **泡泡貓拉廣告資料** | `19NWuiZ1hI0pC6_eMxsKvQlzcf5aGrs4OJgtOTJANjjQ` | 預約清單（動態） |
| **請款表單內容** | `17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE` | 2026請款表（與 EXTERNAL_SS_ID 同） |

---

## 三、各店訊息一覽表（CustomerProfile.js CONFIG）

| 變數名稱 | 試算表 ID | 用途說明 |
|----------|-----------|----------|
| `CONFIG.INTEGRATED_SHEET_SS_ID` | `1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0` | 泡泡貓｜line@訊息回覆一覽表（整合表、客人消費狀態） |
| `CONFIG.EMPLOYEE_SHEET_ID` | `1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0` | 同上（員工填寫、訊息一覽） |
| `CONFIG.CUSTOMER_SHEET_ID` | `1wAfl4Dipag6Eh8msOYUc0ZUepaeQR_HnQNEcxIVUt3M` | 客人問卷（客人消費狀態） |
| `SAYDOU_FULL_CONFIG.SHEET_ID` | `1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0` | SayDou 完整資料表 |
| `REQUEST_EMPLOYEE_SS_ID` (login.js) | `1GH2XbihFIY0AX8SMF9Tk6igrVKPpA_vMJVlkDkJjpe4` | 請求員工 ID（與員工打卡同試算表） |

---

## 四、需改寫的 getActiveSpreadsheet() 對應

| 專案 | 檔案 | 行號 | 取得方式 | 建議改用 openById 的 ID |
|------|------|------|----------|-------------------------|
| **各店訊息一覽表** | Post-handleLineWebhook.js | 77, 184, 266, 286 | getActiveSpreadsheet → fallback CONFIG | `CONFIG.INTEGRATED_SHEET_SS_ID` |
| **各店訊息一覽表** | Action-getSlots.js | 7 | getActiveSpreadsheet → fallback | `CONFIG.INTEGRATED_SHEET_SS_ID` 或指令碼屬性 `GETSLOTS_SS_ID` |
| **各店訊息一覽表** | Action-replyMessage.js | 13 | getActiveSpreadsheet → fallback | `CONFIG.INTEGRATED_SHEET_SS_ID` |
| **各店訊息一覽表** | Action-getList.js | 7 | getActiveSpreadsheet | `CONFIG.INTEGRATED_SHEET_SS_ID` |
| **各店訊息一覽表** | Action-waitlist.js | 30 | getActiveSpreadsheet → fallback | `CONFIG.INTEGRATED_SHEET_SS_ID` |
| **各店訊息一覽表** | Action-handleDelete.js | 3 | getActiveSpreadsheet | `CONFIG.INTEGRATED_SHEET_SS_ID` |
| **各店訊息一覽表** | Auto-checkTimeout.js | 6, 69 | getActiveSpreadsheet | `CONFIG.INTEGRATED_SHEET_SS_ID` |
| **各店訊息一覽表** | tool.js | 2, 33 | getActiveSpreadsheet | `CONFIG.INTEGRATED_SHEET_SS_ID` |
| **各店訊息一覽表** | Get-saydouTotal.js | 19 | getActiveSpreadsheet().getSheetByName("門市業績狀態") | `CONFIG.INTEGRATED_SHEET_SS_ID` 或專用 ID（需確認「門市業績狀態」在哪個試算表） |
| **請款表單內容** | main.js | 23, 194 | getActiveSpreadsheet | `17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE` |
| **請款表單內容** | employeeFee.js | 2 | getActiveSpreadsheet | 同上 |
| **請款表單內容** | exportToExcel.js | 2 | getActiveSpreadsheet | 同上 |
| **請款表單內容** | payToReceipt.js | 2 | getActiveSpreadsheet | 同上 |
| **請款表單內容** | laborForm.js | 41 | getActiveSpreadsheet | 同上 |
| **泡泡貓 門市 預約表單 PAOPAO** | main.js | 165, 224, 240 | getActiveSpreadsheet | `1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE` |
| **泡泡貓 門市 預約表單 PAOPAO** | storeData.js | 6 | getActiveSpreadsheet().getSheetByName("儲值金請款test") | 同上 |
| **泡泡貓 門市 預約表單 PAOPAO** | gogoshopStock.js | 80, 84, 127 | getActiveSpreadsheet | 同上 |
| **泡泡貓 門市 預約表單 PAOPAO** | compareSalesData.js | 75, 76 | getActiveSpreadsheet | 同上 |
| **泡泡貓 門市 預約表單 PAOPAO** | reservationReport.js | 19 | getActiveSpreadsheet | 同上 |
| **每週三：顧客退費** | main.js | 49, 104 | getActiveSpreadsheet().getSheetByName('表單回應 2') | `1b2-ZFkyKabVeQxpNSgFdrsAkPzDb35vNXDNQYR75XKA` |
| **每週三：顧客退費** | exportToExcel.js | 12 | getActiveSpreadsheet | 同上 |
| **泡泡貓拉廣告資料** | todayReservation.js | 3 | getActiveSpreadsheet | `19NWuiZ1hI0pC6_eMxsKvQlzcf5aGrs4OJgtOTJANjjQ` |
| **泡泡貓拉廣告資料** | appointmentLists.js | 2 | getActiveSpreadsheet().getSheetByName("預約清單（動態）") | 同上 |
| **泡泡貓 員工打卡 Line@** | data_tools.js | 75, 107, 139 | getActiveSpreadsheet（網頁列表、公司列表、員工打卡紀錄） | `LINE_STAFF_SS_ID` (`1GH2XbihFIY0AX8SMF9Tk6igrVKPpA_vMJVlkDkJjpe4`) |
| **泡泡貓 員工打卡 Line@** | Archive_last_month.js | 10 | getActiveSpreadsheet | `LINE_STAFF_SS_ID` |

---

## 五、指令碼屬性（Script Properties）中的試算表 ID

| 屬性鍵名 | 用途 | 備註 |
|----------|------|------|
| `ERROR_LOG_SS_ID` | 錯誤紀錄寫入的試算表 | 各店訊息一覽表、Post-handleLineWebhook 使用 |
| `GETSLOTS_SS_ID` | 查空位用試算表 | Action-getSlots 使用，無則 fallback `ERROR_LOG_SS_ID` |

---

## 六、需手動查詢的試算表 ID

所有試算表 ID 已齊全，無需再查詢。

---

## 七、改寫範例

```javascript
// 改寫前
var ss = SpreadsheetApp.getActiveSpreadsheet();
if (!ss && typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID) {
  ss = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
}

// 改寫後（一律 openById）
var ssId = (typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID)
  ? CONFIG.INTEGRATED_SHEET_SS_ID
  : PropertiesService.getScriptProperties().getProperty("ERROR_LOG_SS_ID");
var ss = ssId ? SpreadsheetApp.openById(ssId) : null;
```
