# 與 Core 對齊說明

## 1. 只靠 Core 程式庫，不再複製到各專案

其他專案已改為僅依賴 **Core 程式庫**（appsscript.json 的 libraries 指向 PaoMao_Core），不再在本地保留 Config.js、LineBot.js、Utils.js 等副本。共用函式請一律以 **Core.xxx()** 呼叫，例如：

- `Core.getCoreConfig()`、`Core.clearMyCache()`
- `Core.getBankInfoMap()`、`Core.getLineSayDouInfoMap()`、`Core.getStoresInfo()`
- `Core.jsonResponse(data)`、`Core.sendLineReply()`、`Core.getUserDisplayName()`、`Core.getGroupName()`
- `Core.getBearerTokenFromSheet()`、`Core.findAvailableSlots()`、`Core.issueInvoice()` 等

維護共用程式碼請在 **PaoMao_Core** 內修改，並將 Core 專案部署為程式庫後，各專案即可使用新版本。

---

## 2. 已對齊：與 Core 邏輯相同的函式

以下專案內原本有「與 Core 相同邏輯」的函式，已改為呼叫 Core 的實作（對齊 Core）：

| 專案 | 檔案 | 原本 | 對齊後 |
|------|------|------|--------|
| 日報表 產出 | main.js | outputJSON(data) 自己建 ContentService.createTextOutput(JSON.stringify...) | outputJSON(data) 改為呼叫 jsonResponse(data)（Core LineBot.jsonResponse） |
| 日報表 產出 | BE-HandleCheckIn.js | responseJSON(data) 自己建 ContentService.createTextOutput(JSON.stringify...) | responseJSON(data) 改為呼叫 jsonResponse(data) |
| 請款表單內容 | login.js | 多處 ContentService.createTextOutput(JSON.stringify(...)) | 改為 jsonResponse({ status, message }) |
| 請款表單內容 | Post-handleLineWebhook.js | return ContentService.createTextOutput(JSON.stringify({status:'ok'}))... | 改為 return jsonResponse({ status: 'ok' }) |

之後若有「回傳 JSON 給前端」的需求，請統一使用 **jsonResponse(data)**（來自 Core 的 LineBot.js），不要再複製 ContentService.createTextOutput(JSON.stringify...) 的寫法。

**各店訊息一覽表**：無 doGet/doPost 回傳 JSON，僅寫入試算表，不需改 jsonResponse。另已修正 `todayReservation.js` 中未定義變數 `startDateVal`，改為使用當日 `new Date()`。

---

## 3. 不測試、避免影響客戶

- **LINE reply**：reply、sendLineReply、sendLineReplyObj、handleLineWebhook 等會實際發送訊息，DebugTest 不呼叫。
- **SayDou 預約**：createBooking 等會實際建立預約，DebugTest 不呼叫。
- **SayDou 其他 API**：findAvailableSlots、getMemberHistorySummary、getBearerTokenFromSheet 等查詢類可測試（僅檢查函式存在或讀取測試用資料）。
- **SayDou 會員全貌**：Core 新增 `getMemberViewByMembid(membid)`、`getAllTransactionsByMembid(membid)`、`getAllStorecashUseRecordByMembid(membid)`；各店訊息一覽表專案內 **SayDouFullProfile.js** 以手機呼叫 `Core.getMemApi(phone)` 取得 membid 後拉取上述三項並寫入試算表「SayDou會員全貌」，含「備註(Update)」欄位供員工標記。

---

## 4. 之後新增時請對齊 Core

- 回傳 JSON：用 **Core.jsonResponse(data)**，不要再寫 ContentService.createTextOutput(JSON.stringify...).
- 設定／工具：能放在 Core（Config / Utils / Odoo / SDapi 等）就放在 Core，並將 Core 專案部署為程式庫後，各專案以 Core.xxx() 呼叫。
- 若專案內出現與 Core 同名的函式（例如自己寫了一個 normalizePhone），請改為使用 **Core.xxx()**，避免重複實作。
