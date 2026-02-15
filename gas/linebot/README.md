# LINE Bot 客服小幫手（Chrome 擴充）

此資料夾為 Chrome 擴充功能，需在 Chrome 安裝「未封裝的擴充功能」後使用。

## 從 Google Drive 取得新版本

若此資料夾是從 Google Drive 連結下載或同步而來，取得最新檔案後：

1. 開啟 Chrome → 擴充功能 → 管理擴充功能
2. 若已安裝過本擴充，點「重新載入」即可套用新版本
3. 若尚未安裝：開啟「開發人員模式」→ 點「載入未封裝項目」→ 選擇此 `linebot` 資料夾

## 發布者：將本機版本推到 Google Drive

**不需要提供 Drive 資料夾的「連結」**：腳本用的是您電腦上的**本機路徑**（Google Drive 同步到本機後的那個資料夾路徑）。您把檔案同步到那個資料夾後，再到 Google Drive 網頁對該資料夾「取得連結」分享給同事即可。

在專案根目錄 `gas/` 下執行：

```bash
# 執行 push-all 時會一併同步 linebot 到 Google Drive（GAS 專案 push 完後自動跑）
npm run push-all

# 或只同步 linebot（不跑 clasp push）
npm run push-linebot
```

首次使用請確認本機有 Google Drive 路徑（擇一）：

- **自動偵測**：已安裝 **Google Drive for Desktop** 時，腳本會自動找「My Drive」並在底下建立 `linebot` 資料夾
- **手動指定**：`export GOOGLE_DRIVE_LINEBOT_PATH="/本機路徑/到/Google Drive/My Drive/linebot"`  
  （例如 macOS：`~/Library/CloudStorage/GoogleDrive-你的帳號/My Drive/linebot`）

若希望每次 ship（push+deploy）時一併同步 linebot，可執行：

```bash
npm run ship-with-linebot
```

## 發布到 Chrome 線上應用程式商店（npm run deploy）

上傳擴充需 Google OAuth 憑證，請寫入 **`gas/.env`**（已加入 .gitignore，不會被 push）。從 `gas/` 載入 .env 再執行 linebot 的 deploy，子行程會繼承環境變數，linebot 拉得到。

1. 在 **gas/** 目錄複製範本並填入憑證：
   ```bash
   cd /path/to/gas
   cp .env.example .env
   # 用編輯器開啟 .env，填入 CHROME_WEB_STORE_CLIENT_ID、CLIENT_SECRET、REFRESH_TOKEN
   ```

2. 從 gas/ 載入 .env 後執行 linebot deploy：
   ```bash
   cd /path/to/gas
   set -a && source .env && set +a && cd linebot && npm run deploy
   ```
   （Windows CMD 請改為先手動設定環境變數或使用 cross-env。）

若曾把憑證 push 到 GitHub，請在 Google Cloud Console 撤銷並重新建立 OAuth 憑證，並用 `git rebase -i` 改寫歷史移除該 commit 中的憑證後再 push。
