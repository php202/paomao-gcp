# GAS 專案對照表（資料夾名稱 = Apps Script 專案名稱）

以下為 **scriptId** 與 **本機資料夾名稱** 對應，與 [script.google.com](https://script.google.com/home/projects) 上的專案名稱一致。

| 本機資料夾名稱 | Apps Script 專案名稱 | scriptId |
|----------------|---------------------|----------|
| PaoMao_Core | PaoMao_Core | `1ZenbGdlvtpTjiKlyutqeV5bDjRKOhkK9O6-m4GnriftOzMU4f6RaaLm7` |
| 日報表 產出 | 日報表 產出 | `1tKLWvY9pdqyasg0MoapPW5XhoAxNTw8LZO4Zxvpsjkz6NoSwelDN6vrv` |
| 各店訊息一覽表 | 各店訊息一覽表 | `1Hd_wqI53-PRUH4MEekP8J7r7cAhZyJhwK0VaEVeZl_ovLXLx3CSe-Pes` |
| 每週三：顧客退費 | 每週三：顧客退費 | `10HtjCf74GZ99Vljxm6ogMNlSuh6Qq1bBiae8TstCt1YCh8ZXwb10WXz3` |
| 泡泡貓 員工打卡 Line@ | 泡泡貓 員工打卡 Line@ | `17ZpY-TsP38RFQbvmiX7TLsYjIw97tw5dR7iQSJ0FD1Cq1Ys5R-URSvzv` |
| 泡泡貓 門市 預約表單 PAOPAO | 泡泡貓 門市 預約表單 PAOPAO | `1LusFs1Y98mAbOvKRCHDZlelgnTPyspEEroiNd67n2hO7ayuK5_QBBLTu` |
| 泡泡貓拉廣告資料 | 泡泡貓拉廣告資料 | `1gcLehQYH5qzceBuECh08TyAKfha5XxJ9s3Fv8ep3iiwmypz8GuJv7r3k` |
| 請款表單內容 | 請款表單內容 | `10tL-Fvu8Zn17JallpciTfgwUXmBZL-42GQAnQOJi7gy1Dc8xrcsDrrP4` |

- 各專案資料夾內的 `.clasp.json` 的 `scriptId` 應與上表一致，`clasp push` 才會推到正確的 Apps Script 專案。
- 若對不起來：在該資料夾執行 `clasp clone --rootDir . <scriptId>`（或先刪除 `.clasp.json` 再 `clasp clone`）可重新綁定。
