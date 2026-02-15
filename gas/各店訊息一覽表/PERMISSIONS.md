# 各店訊息一覽表 － 試算表權限說明

若出現 **「You do not have permission to access the requested document」**，代表**執行腳本的 Google 帳號**沒有權限開啟某個試算表。

請用**執行 runDebugTest / 整合腳本的那個 Google 帳號**，確認以下試算表都已**至少「可編輯」**：

| 試算表用途           | 試算表 ID | 哪裡用到 |
|----------------------|-----------|----------|
| **客人消費問卷**     | `1wAfl4Dipag6Eh8msOYUc0ZUepaeQR_HnQNEcxIVUt3M` | 問卷歷史（客人消費狀態 D 欄來源） |
| **員工填寫（LINE 訊息一覽表）** | `1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0` | 客人消費狀態、SayDou會員全貌、員工填寫紀錄、客人訊息 |
| **Core Token（預約表單）** | `1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE` | Core.getBearerTokenFromSheet() 讀 C2 的 Bearer Token |

## 檢查方式

1. 用**執行腳本的那個帳號**登入 Google。
2. 在瀏覽器開：`https://docs.google.com/spreadsheets/d/{試算表ID}/edit`  
   例如：`https://docs.google.com/spreadsheets/d/1wAfl4Dipag6Eh8msOYUc0ZUepaeQR_HnQNEcxIVUt3M/edit`
3. 若顯示「無法開啟」或「要求存取權」→ 請試算表擁有者把該帳號加入為**編輯者**（或至少檢視者，依需求）。

## 快速找出是哪一個沒權限

在 Apps Script 編輯器執行函式 **`checkSpreadsheetPermissions`**，會依序嘗試開啟上述三個試算表，並在紀錄中顯示哪一個成功、哪一個失敗。
