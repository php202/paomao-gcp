# 客人消費狀態（整合表）預期結構

試算表：泡泡貓｜line@訊息回覆一覽表  
工作表名稱：`客人消費狀態`

## 表頭（INTEGRATED_HEADERS）

| 欄位 | 說明 |
|------|------|
| 更新時間 | 最後更新時間 |
| 手機號碼 | 客人手機（唯一鍵） |
| 員工填寫摘要 | 員工在 line@ 一覽表填寫的摘要 |
| 客人問卷摘要 | 客人問卷歷史彙整 |
| 客人訊息摘要 | LINE 訊息一覽彙整 |
| SayDou消費 | SayDou 消費紀錄摘要 |
| SayDou儲值 | 儲值／儲值金消費摘要 |
| saydouUserId | SayDou 會員 ID |
| AI專用Prompt | 完整歷程文字，供 AI 產出接待話語 |
| lineUserId | LINE 使用者 ID（可多筆，逗號分隔） |
| AI分析結果 | 3 秒鐘接待戰報（由 AI 戰報函式寫入） |

## 本機驗證

在專案根目錄執行：

```bash
node gas/validate.js
```

會檢查 `CustomerProfile.js` 內 `INTEGRATED_HEADERS` 是否與上表一致。
