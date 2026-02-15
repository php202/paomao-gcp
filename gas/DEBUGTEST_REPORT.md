# runDebugTest 檢查報告

## 0. Core 程式庫驗證（放在 DebugTest 最前面）

專案 **日報表 產出、各店訊息一覽表、每週三：顧客退費…** 等（非 PaoMao_Core）的 `runDebugTest()` 開頭已加上 **Core 程式庫檢查**：一次列出多個 `Core.xxx` 函式是否為 `function`，跑一次就能驗證「有沒有拉到 Core」。

- 檢查項目（依專案略有增減）：`Core.getCoreConfig`、`Core.getLineSayDouInfoMap`、`Core.getStoresInfo`、`Core.jsonResponse`、`Core.getBankInfoMap`、`Core.getBearerTokenFromSheet`、`Core.sendLineReply`、`Core.sendLineReplyObj` 等。
- 若 **Core 未載入** 或某個函式不存在，該項會標示 `ok: false`，方便快速排查。
- 執行後在「檢視 → 紀錄」看 JSON 輸出，先看 `Core.xxx` 那幾項是否都 `ok: true`，即可確認 Core 有拉到。

---

## 1. 實際執行結果（clasp push / clasp run）

- **Apps Script API 已啟用**：已在 https://script.google.com/home/usersettings 開啟 API，**clasp push** 可正常使用（例如 PaoMao_Core 已驗證 push 成功）。
- **clasp run** 若要從指令列遠端執行 `runDebugTest`，需**額外**完成「部署為 API 可執行」：
  - 在 [Apps Script 編輯器](https://script.google.com) 開啟該專案 → **發佈** → **部署為 API 可執行**（並依畫面建立部署）。
  - 未做此部署時，執行 `clasp run runDebugTest` 會出現：`Script function not found. Please make sure script is deployed as API executable.`

**本機 vs 網站：**

| 方式 | 本機用 `clasp run runDebugTest` | 在網站上執行 |
|------|-------------------------------|--------------|
| 要不要多做事 | 要。需在編輯器對該專案做「發佈 → 部署為 API 可執行」一次 | 不用。直接開專案選 runDebugTest 執行即可 |
| 目前狀況 | 會出現：`Script function not found. Please make sure script is deployed as API executable.` | 可用，建議用這個 |

**建議操作（最快）：**

1. **在網站上跑**（不用額外設定）  
   - 開 [script.google.com](https://script.google.com) → 選要測的專案（例如 PaoMao_Core 或 各店訊息一覽表）  
   - 上方函式選 **runDebugTest** → 按 **執行**（▶）  
   - 下方「檢視 → 紀錄」看 JSON，確認 `Core.xxx` 等項是否 `ok: true`

2. **想在本機用 `clasp run` 再設**  
   - 在編輯器對該專案：**發佈** → **部署為 API 可執行** → 依畫面建立部署  
   - 之後在該專案目錄執行：`clasp run runDebugTest` 即可從本機跑

---

## 2. 靜態檢查：各專案 DebugTest 檢查的函式是否存在

已對照各專案程式碼，**DebugTest 裡檢查的函式在該專案中都有定義**，沒有「檢查了不存在的函式」或名稱打錯的問題。

| 專案 | 檢查的函式 | 狀態 |
|------|------------|------|
| PaoMao_Core | getCoreConfig, getBankInfoMap, getLineSayDouInfoMap, getStoresInfo, clearMyCache | ✅ 皆存在 |
| 日報表 產出 | getCoreConfig, outputJSON, doPost, handleCheckInAPI, handleBindSession | ✅ 皆存在 |
| 各店訊息一覽表 | getCoreConfig, getLineSayDouInfoMap, todayReservation, appointmentLists, onOpen | ✅ 皆存在 |
| 每週三：顧客退費 | getCoreConfig, runReservationReport, storeData, dailyCheckAndPush, onOpen, doPost, compareSalesData, gogoshopStocksReport | ✅ 皆存在 |
| 泡泡貓 門市 預約表單 PAOPAO | getCoreConfig, onOpen, main, payToReceipt, payToEmployee, achP01, exportToExcelWithFilter, cleanupTempSheets | ✅ 皆存在 |
| 泡泡貓 員工打卡 Line@ | getCoreConfig, onOpen, runAccNeed | ✅ 皆存在 |
| 泡泡貓拉廣告資料 | getCoreConfig, onOpen, getPhonesFromSheet, cleanupTempSheets, exportToExcelWithFilter, refund | ✅ 皆存在 |
| 請款表單內容 | getCoreConfig, doPost, doGet, getSlots, totalMoney, getList, checkMember, handleDelete, getStoreConfig, findStoreConfig | ✅ 皆存在 |

**結論：** 依目前程式碼，不需要為了「通過 runDebugTest」而改 DebugTest.js 或補函式；只要 push 成功並能執行 runDebugTest，預期檢查都會通過。

---

## 3. 若之後執行 runDebugTest 有錯誤

- **Core 未載入 / getCoreConfig 等找不到**：確認該專案 `appsscript.json` 已掛 **Core 程式庫**（libraryId 指向 PaoMao_Core），且 PaoMao_Core 已部署為程式庫。
- **「找不到 ID 為 Core 的程式庫」**：見下方 **3.1 找不到 Core 程式庫**。
- **請款表單內容 的 doGet**：使用 `Core.jsonResponse`，需依賴 Core 程式庫。

### 3.1 找不到 ID 為 Core 的程式庫（可能已遭刪除，或是你沒有讀取權限？）

此錯誤表示「日報表 產出」無法讀取 PaoMao_Core 專案（程式庫 ID = PaoMao_Core 的 scriptId）。依序檢查：

1. **同一個 Google 帳號**
   - 確認「日報表 產出」和「PaoMao_Core」都是用**同一個 Google 帳號**在 [script.google.com](https://script.google.com) 開啟。
   - 若日報表 產出是 A 帳號、PaoMao_Core 是 B 帳號，就會出現沒有讀取權限。

2. **共用 PaoMao_Core（若為不同帳號）**
   - 用**擁有 PaoMao_Core 的帳號**開啟 [PaoMao_Core 專案](https://script.google.com/home/projects/1ZenbGdlvtpTjiKlyutqeV5bDjRKOhkK9O6-m4GnriftOzMU4f6RaaLm7/edit)。
   - 左側 **專案設定**（齒輪）→ 下方 **共用** 或從 **檔案 → 專案屬性** 查看擁有者 → 新增「日報表 產出」使用的那個 Google 帳號，至少 **檢視者** 權限。
   - 回到「日報表 產出」專案，重新整理或重新加入程式庫。

3. **在「日報表 產出」重新加入 Core 程式庫**
   - 開啟 [日報表 產出](https://script.google.com/home/projects/1tKLWvY9pdqyasg0MoapPW5XhoAxNTw8LZO4Zxvpsjkz6NoSwelDN6vrv/edit) → 左側 **程式庫**。
   - 若 Core 顯示紅字或錯誤，可先點 Core 右側 **移除**。
   - 點 **+**（新增程式庫）→ **程式庫 ID** 輸入：`1ZenbGdlvtpTjiKlyutqeV5bDjRKOhkK9O6-m4GnriftOzMU4f6RaaLm7`。
   - 版本選 **開發模式**（或「頭版」），識別碼填 **Core** → **新增**。
   - 儲存後重新載入專案，錯誤應會消失。

4. **PaoMao_Core 曾刪除或重新建立**
   - 若 PaoMao_Core 專案曾刪除或複製成新專案，script ID 會變。
   - 到本機 `gas/PaoMao_Core/.clasp.json` 查看目前的 `scriptId`，或從 PaoMao_Core 專案網址取得。
   - 把「日報表 產出」的 `appsscript.json` 裡 Core 的 `libraryId` 改成新的 scriptId，存檔後在「日報表 產出」目錄執行 `npm run push`（或 `clasp push`），再在編輯器重新整理。

---

## 4. 路徑有空格或特殊字元時

在終端機對 **泡泡貓 員工打卡 Line@** 等含空格或特殊字元的資料夾下指令時，路徑請用引號，例如：

```bash
cd "/Users/yutsunghan/node_express/gas/泡泡貓 員工打卡 Line@"
clasp push
clasp run runDebugTest
```

路徑若少引號會出現 `unmatched "` 或指令錯誤。

---

## 5. 特別紀錄：查詢空位時間修正（2026-02-05）

- **問題**：查詢未來日期（例如 2026-02-24）時仍顯示「（無）」。
- **根因**：`findAvailableSlots` 用 `dateString === startDate` 判定「今天」，導致未來日期被誤當今天，進而套用「過去時間過濾」把時段清空。
- **修正**：改為只在 `dateString === todayStr` 時過濾過去時間。
- **同步調整**：
  - 櫃檯人員不計入產能、其排休不計入忙碌。
  - 關閉 baseData 與人力池快取（每次即時抓最新資料）。
  - 新增 `runFindAvailableSlotsDebug` 便於後台驗證。
  - 新增 `EXTRA_STORE_STAFF` 以手動補強個別店家人力（例如內湖店 4229 補 21617/22569）。
