# 每天會有多少次 UrlFetch？（估算與量測）

在 **泡泡貓 員工打卡 Line@** 專案裡，每一次 `UrlFetchApp.fetch(...)` 都會算進 GAS 的「單日 urlfetch 次數」配額。

---

## 一、哪些行為會產生 fetch？

| 來源 | 每次約略 fetch 數 | 說明 |
|------|-------------------|------|
| **doPost 被呼叫時**（腳本載入） | 0～1 | `getCoreConfig()`：有快取時 0，快取冷掉時 1（約每 30 分鐘最多 1 次） |
| **LINE 回覆**（Core.sendLineReply） | 1 | 對 PaoMao_Core 的 `callPost("lineReply")` = 1 次 |
| **LINE 回覆**（直接打 LINE API） | 1 | `UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply')` = 1 次 |
| **查報告關鍵字** | 1～2 | `getReportHandlerFromKeyword` + `getReportTextForKeyword` |
| **明日預約 / 工作流程連結** | 1 | `getWorkflowLink` |
| **查詢打卡紀錄 / 店家列表** | 1 | `getLineSayDouInfoMap` |
| **預約時段** | 1 | `findAvailableSlots` |
| **取得顯示名稱** | 1 | `getUserDisplayName` |

也就是說：**每一則需要「對外連線」的動作，至少 1 次 fetch；若走 Core API，每次呼叫 = 1 次 fetch。**

---

## 二、每天「新」的 fetch 怎麼估？

沒有真實流量數字時，可用下面公式粗估「每天總 fetch 次數」：

```
每天 fetch ≈
  [ doPost 觸發次數 × getCoreConfig 實際打 API 次數 ]
  + [ 每則「會回覆」的 LINE 訊息的回覆數 × 1 ]
  + [ 其他 Core API 呼叫次數（查報告、查店家、預約、顯示名稱等）]
```

- **getCoreConfig**：有 30 分鐘快取 + Lock 後，理想約 **每 30 分鐘 1 次** → 一天約 **48 次**（若快取都命中則更少）。
- **其餘**：完全看實際使用量，例如：
  - 每天 100 則會觸發回覆的 LINE 訊息 → 至少約 100 次（回覆）
  - 再加上查報告、查打卡、預約、顯示名稱等，每做一次就多 1 次。

所以無法給一個固定數字，只能說：

- **getCoreConfig**：在目前快取設定下，一天大約是 **幾十次** 等級（例如 ≤ 48）。
- **真正會隨流量變動的**：是 **LINE 回覆** 和 **其他 Core API**（查報告、店家、預約、顯示名稱等），使用者用得越多，這些「新的 fetch」就越多。

---

## 三、怎麼知道「實際」每天多少 fetch？

### 方法 1：看 GAS 配額頁（最直接）

1. 開啟 [Google Apps Script 專案](https://script.google.com)
2. 左側 **「執行作業」** 或 **「專案設定」** 一帶會有配額／使用量
3. 若專案有綁到 Google Cloud 專案，也可在 **Google Cloud Console** → **APIs & Services** → **Quotas** 看對應 API 的用量

這裡看到的是「實際被算進去的」呼叫次數，包含所有 UrlFetch。

### 方法 2：用 Logs Explorer 粗估

在 **Google Cloud Logs Explorer**（你現在看錯誤的那個）：

- 查 **ERROR**：可以看到因 urlfetch 配額爆掉而產生的錯誤筆數。
- 若改查 **所有 severity**，並篩選 `resource.labels.function_name="doPost"`，可看到 **doPost 被呼叫的次數**（每次 doPost 至少有可能觸發 1 次 getCoreConfig，其餘要看程式有沒有再打 Core/LINE）。

用「doPost 次數 × 每 doPost 平均 fetch 數」可以反推一天大約多少 fetch（需主觀估「平均每 doPost 幾次 fetch」）。

### 方法 3：在程式裡自己數（選做）

在 `CoreApiClient.js` 的 `callGet` / `callPost` 裡加一行：

```javascript
// 寫入 Script Properties 或 Cache 做計數（僅供觀察，不影響邏輯）
var count = parseInt(PropertiesService.getScriptProperties().getProperty('urlfetch_count') || '0', 10);
PropertiesService.getScriptProperties().setProperty('urlfetch_count', String(count + 1));
```

再搭配一個「每日歸零」的排程（或手動歸零），就能看到「從上次歸零到現在」的總 fetch 次數。若要「每天」的數字，就每天固定時間歸零一次。

---

## 四、總結

- **每天會有多少「新」的 fetch？**  
  - **getCoreConfig**：在目前快取下，一天大約 **幾十次**（例如 ≤ 48）。  
  - **其餘**：完全看 **LINE 訊息量** 和 **查報告／店家／預約／顯示名稱** 的使用次數，每一筆對外呼叫都是 1 次 fetch，所以無法給一個固定數字。
- **要確切數字**：以 **GAS／Cloud 配額頁** 或 **Logs Explorer** 的實際數據為準；若要長期觀察，可在 CoreApiClient 做簡單計數 + 每日歸零。
