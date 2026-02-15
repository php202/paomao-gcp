# PaoMao_Core － SayDou API 對照

以下 SayDou API 呼叫皆放在 **Core**（PaoMao_Core），其他專案透過 `Core.xxx()` 使用。  
Base URL：`https://saywebdatafeed.saydou.com`，認證：`Authorization: Bearer {token}`（Token 來自 `getBearerTokenFromSheet()`）。

| 用途 | Core 函式 | API 路徑 |
|------|-----------|----------|
| 用手機查會員（取 membid／儲值等） | `getMemApi(phone)` | GET `unearn/memberStorecash?keyword={phone}&...` |
| 會員個人資料（完整 view） | `getMemberViewByMembid(membid)` | GET `crm/member/{membid}?type=view` |
| 消費紀錄（一頁） | `fetchTransactionsByMembidPage(membid, page, limit)` | GET `finance/transaction?membid={membid}&page=...&limit=...` |
| 消費紀錄（全筆，分頁迴圈） | `getAllTransactionsByMembid(membid, pageSize)` | 同上，迴圈取完 |
| 儲值金使用紀錄（一頁） | `fetchStorecashUseRecordPage(membid, page, limit)` | GET `unearn/storecashUseRecord?membid={membid}&...&tabIndex=2` |
| 儲值金使用紀錄（全筆） | `getAllStorecashUseRecordByMembid(membid, pageSize)` | 同上，迴圈取完 |
| 儲值紀錄／加值（一頁） | `fetchStorecashAddRecordPage(membid, page, limit)` | GET `unearn/storecashAddRecord?membid={membid}&...&tabIndex=1` |
| 儲值紀錄／加值（全筆） | `getAllStorecashAddRecordByMembid(membid, pageSize)` | 同上，迴圈取完 |
| 消費摘要（給客人消費狀態／AI 用） | `getMemberHistorySummary(phone)`（SDconsume.js） | 內部用 getMemApi + getAllTransactionsByMembid |

其他專案請勿重複打 SayDou API，一律透過 Core 上述函式取得資料。
