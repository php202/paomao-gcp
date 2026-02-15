# GAS 專案目錄說明

## 架構：只靠 Core 程式庫，不再複製到各專案

- **PaoMao_Core** 是共用程式碼來源（Config、Utils、LineBot、Odoo、SDapi、SayDou 等）。
- 其他專案的 `appsscript.json` 已掛 **Core 程式庫**（libraryId 指向 PaoMao_Core），直接呼叫 `Core.getCoreConfig()`、`Core.jsonResponse()`、`Core.getStoresInfo()` 等即可。
- **不再**把 Core 的檔案複製到各專案；維護共用程式碼請在 **PaoMao_Core** 內修改，並在 Apps Script 將 Core 專案「部署為程式庫」後，各專案即可使用新版本（若使用 `developmentMode: true` 則可即時更新）。

---

## Push / Deploy 行為（一律不 pull，以本機為準發布新版本）

- **不執行 `clasp pull`**。以本機程式碼為準，只做 push / ship 發布新版本；詳見 **DEPLOY.md**。
- **日常更新程式碼**：在對應專案資料夾內執行 `npm run push` 或 `clasp push --force`，只會更新程式碼，**不會**建立新版本或改變 Web App URL。
- **部署（更新既有 Web App）**：在該專案目錄執行 `npm run deploy` 或 `npm run ship`（先 push 再 deploy）。**必須**使用既有部署 ID：`clasp deploy -i <DEPLOYMENT_ID> -d 'Updated'`，詳見 **DEPLOY.md**。
- 各專案 **package.json** 已含 `push`、`deploy`、`ship`；請將 `deploy` 腳本中的 `YOUR_DEPLOYMENT_ID` 改為該專案在「管理部署」中的**網路應用程式**部署 ID。

---

## 各專案目錄對應

| 資料夾 | 說明 |
|--------|------|
| PaoMao_Core | 共用程式碼來源；對外 API 網址（PAO_CAT_CORE_API_URL）請用「網路應用程式」部署，見 **DEPLOY.md** |
| 日報表 產出 | 日報表；可部署為網路應用程式，以 URL 觸發產出（PAO_CAT_REPORT_API_URL?key=密鑰&action=runDailyReport），見 main.js 註解 |
| 各店訊息一覽表 | 各店訊息 |
| 每週三：顧客退費 | 顧客退費 |
| 泡泡貓 門市 預約表單 PAOPAO | 門市預約表單 |
| 泡泡貓 員工打卡 Line@ | 員工打卡 |
| 泡泡貓拉廣告資料 | 拉廣告資料 |
| 請款表單內容 | 請款表單 |

每個專案目錄內：`clasp pull` 拉遠端；`npm run ship` = push + 以既有部署 ID 更新部署（不變更網址）。根目錄 **gas** 的 `npm run ship` 會對所有子專案依序執行該專案的 `npm run ship`（push + deploy）。各專案須在 package.json 填寫既有部署 ID，見 **DEPLOY.md**。  
**資料夾名稱** = Apps Script 專案名稱（對照表與 scriptId 見 `GAS_PROJECTS.md`）。

---

## Debug / Test：每個專案都有 runDebugTest

- 每個專案目錄內都有一個 **DebugTest.js**，內含函式 **runDebugTest()**。
- 用途：快速檢查該專案是否可呼叫 Core（getCoreConfig 等）以及主要函式是否存在，方便除錯。
- 執行方式（擇一）：
  1. **指令列**（在該專案目錄下）：
     ```bash
     cd /Users/yutsunghan/node_express/gas/PaoMao_Core
     clasp run runDebugTest
     ```
  2. **Apps Script 編輯器**：開啟該專案 → 選函式 **runDebugTest** → 執行。
- 輸出會寫入 Logger（可在編輯器「檢視 → 紀錄」或 `clasp logs` 查看），並回傳一個結果物件（project 名稱、各項檢查 ok/error）。
- 可在各專案的 DebugTest.js 裡自行新增專案專用的測試邏輯。
- **不測試**：LINE reply（reply、sendLineReply）、SayDou 預約（createBooking、handleLineWebhook）等會實際影響客戶的函式，僅可做「存在檢查」、不要在此執行，以免發送訊息或建立預約。
- SayDou 其他 API（例如查詢時段、會員紀錄）可測試。

---

## 本機驗證與 Sheet 結構（validate.js、samples/）

- **本機跑驗證**：
  - **在專案根目錄 node_express 下**執行：`node gas/validate.js`
  - 若目前目錄**已在 gas**，請執行：`node validate.js`（勿在 gas 下執行 `node gas/validate.js`，會變成找 gas/gas/validate.js 而報錯）
  - 會檢查「各店訊息一覽表」內 `CustomerProfile.js` 的 `INTEGRATED_HEADERS`、`SayDouFullProfile.js` 的 `HEADERS` 以及 CONFIG 必要鍵是否符合預期；通過會顯示「全部通過」，未通過會列出差異。
- **預期結構說明**：`gas/samples/` 內有 `expected_客人消費狀態.md`、`expected_SayDou會員全貌.md`，說明兩張產出工作表的欄位。
- **看產出 Sheet 長什麼樣子**：在 Apps Script 編輯器（各店訊息一覽表專案）選函式 **debug_GetSheetSnapshots** 執行，到「檢視 → 紀錄」複製 JSON，可貼到本機 `gas/samples/actual_snapshots.json` 方便查看或讓我對照。詳見 `gas/samples/README.md`。
