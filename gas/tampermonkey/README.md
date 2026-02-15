# Tampermonkey 腳本 - 本機開發流程

讓你在專案資料夾編輯腳本後，**重新整理網頁**即可生效，無需手動複製貼上。

---

## 一、啟用「存取本機檔案」權限

1. 開啟 `chrome://extensions`
2. 找到 **Tampermonkey**，點「詳細資料」
3. 開啟 **「允許存取檔案網址」**（Allow access to file URLs）

---

## 二、安裝 Loader 腳本（只需做一次）

每個腳本都有一個對應的 `*.loader.user.js`，用來從本機檔案載入實際程式碼。

### 安裝方式

1. 開啟 Tampermonkey 儀表板
2. 點「**＋**」建立新腳本
3. 刪除預設內容，貼上對應的 loader 完整內容
4. 儲存（Ctrl+S）

### 腳本對照

| 功能 | Loader 檔 | 實際程式碼（你編輯的檔案） |
|------|-----------|----------------------------|
| SayDou Token 同步 | `SayDou-Token-Sync.loader.user.js` | `SayDou-Token-Sync.user.js` |
| Gogoshop Cookie 同步 | `Gogoshop-Cookie-同步器.loader.user.js` | `Gogoshop-Cookie-同步器.js` |
| SayDou 自動登入 | `SayDou-Auto-Login.loader.user.js` | `SayDou-Auto-Login.js`（由 build 產生） |

---

## 三、SayDou 自動登入：憑證從 .env 產生

SayDou 自動登入的帳密不寫在程式碼裡，改從 `gas/.env` 讀取：

1. 在 `gas/.env` 加入：
   ```
   SAYDOU_CSTCOD=你的客戶代碼
   SAYDOU_USRACC=你的帳號
   SAYDOU_PASSWD=你的密碼
   SAYDOU_AUTO_SUBMIT=true
   ```
2. 執行 `npm run build:tampermonkey`（從 `gas/` 目錄）
3. 會產生 `SayDou-Auto-Login.js`，Loader 會載入此檔

---

## 四、開發流程

1. 在 VS Code / Cursor 編輯 `gas/tampermonkey/` 底下的腳本
2. 儲存檔案
3. 在目標網頁按 **F5 重新整理**
4. 新程式碼會自動載入並執行

---

## 五、自動更新（從 GitHub 安裝時）

若從 GitHub Raw URL 安裝腳本，Tampermonkey 會依 `@updateURL` / `@downloadURL` 自動檢查更新：

| 腳本 | 安裝連結 |
|------|----------|
| SayDou Token 同步 | `https://raw.githubusercontent.com/php202/paomao/gas-only/node_express/gas/tampermonkey/SayDou-Token-Sync.user.js` |
| Gogoshop Cookie 同步 | `https://raw.githubusercontent.com/php202/paomao/gas-only/node_express/gas/tampermonkey/Gogoshop-Cookie-同步器.js` |

**SayDou 自動登入** 含憑證，僅能本機 build，不提供線上安裝。

---

## 六、路徑說明

Loader 內的 `@require file:///...` 路徑需與你電腦的專案路徑一致。

若專案不在預設路徑，請修改 loader 中的路徑，例如：

```
file:///Users/你的使用者名稱/node_express/gas/tampermonkey/檔名.js
```
