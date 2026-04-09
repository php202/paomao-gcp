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

## 預約相關 API

| 用途 | API 路徑 | Method | Body |
|------|----------|--------|------|
| 查會員預約紀錄 | `calendar/reservation/record/saydou/{membid}/{membid}?page=0&limit=20&sort=rsvtim&order=desc` | GET | — |
| 取消預約 | `calendar/reservation/status` | POST | `{ "rsvtid": 32480800, "status": "cancel" }` |
| 查空位 | `calendar/reservation/store/{storid}?date={YYYY-MM-DD}` | GET | — |

### 預約紀錄欄位（重要）
- `rsvtid` — 預約唯一 ID（用於取消等操作）
- `rsvrsn` — **不存在**，勿使用
- `membid` — 會員 ID
- `storid` — 門市 ID
- `rsvtim` — 預約時間 `YYYY-MM-DD HH:MM:SS`
- `endtim` — 結束時間
- `memcel` — `"Y"` 已取消 / `"N"` 有效
- `aprove` — `"Y"` 已確認
- `txtser` — 服務名稱（可能為 null，用 `services` 欄位）
- `services` — 服務名稱（完整）
- `stor.stonam` — 門市名稱
- `usrs.usrnam` — 美容師名稱
- `goods[]` — 服務項目陣列（含 `godnam`, `workhr`, `amount`）
- `source` — 來源（`web2` = 線上預約）

### 取消預約注意
- **用 `"cancel"` 不是 `"delete"`！** `"delete"` 回 status:true 但不會真的取消
- Response: `{ "status": true, "message": "失敗" }` — **status:true 代表成功**，message:"失敗" 可忽略
- 實際效果：預約的 `memcel` 從 `N` 變 `Y`（已取消）

其他專案請勿重複打 SayDou API，一律透過 Core 上述函式取得資料。
