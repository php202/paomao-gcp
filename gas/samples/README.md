# Sheet 結構與快照

## 1. 本機直接跑驗證（看有沒有符合標準）

在 **專案根目錄**（node_express）執行：

```bash
node gas/validate.js
```

會檢查：

- `各店訊息一覽表/CustomerProfile.js` 的 `INTEGRATED_HEADERS` 是否與預期一致  
- `各店訊息一覽表/SayDouFullProfile.js` 的 `HEADERS` 是否與預期一致  
- `CustomerProfile.js` 的 CONFIG 必要鍵是否存在  

通過會顯示「全部通過」，未通過會列出差異並 `exit 1`。

## 2. 預期結構說明

- `expected_客人消費狀態.md`：整合表「客人消費狀態」的欄位說明  
- `expected_SayDou會員全貌.md`：SayDou 全貌工作表的欄位說明  

## 3. 看產出的 Sheet 長什麼樣子（實際快照）

因為 Sheet 在 Google 雲端，本機無法直接讀。可以用以下方式「看到」實際內容：

### 方式 A：在 Apps Script 裡跑快照函式，把結果貼到本機

1. 開啟 **各店訊息一覽表** 專案（Apps Script 編輯器或 `clasp open`）。
2. 選函式 **`debug_GetSheetSnapshots`** → 執行。
3. 在「檢視 → 紀錄」中會看到 JSON，內容為兩張工作表的 **表頭 + 前 3 列資料**。
4. 複製該 JSON，貼到本機檔案 `gas/samples/actual_snapshots.json`（可自行建立此檔）。
5. 之後可用文字編輯器或 `node -e "console.log(JSON.parse(require('fs').readFileSync('gas/samples/actual_snapshots.json','utf8')))"` 查看，或讓我讀 `actual_snapshots.json` 幫你對照。

### 方式 B：直接開 Google 試算表

- 客人消費狀態：泡泡貓｜line@訊息回覆一覽表 → 工作表「客人消費狀態」  
- SayDou會員全貌：客人問卷試算表 → 工作表「SayDou會員全貌」  

### 方式 C：從 Google 試算表匯出 CSV

在試算表「檔案 → 下載 → 逗號分隔值 (.csv)」，把檔案放到 `gas/samples/`（例如 `客人消費狀態.csv`），之後本機可直接開檔或讓我讀取幫你對照。
