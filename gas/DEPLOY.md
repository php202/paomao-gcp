# GAS 部署策略（Clasp）

## 先 pull 一次、改完內容、取得目前版本 ID（Core API 要是「網路應用程式」／網頁）

1. **全部 pull 一次**：在 gas 目錄執行 `npm run pull-all`，會對每個子專案執行 `clasp pull`，把 GAS 上的程式碼拉回本機（會覆寫本機檔案）。
2. **改完內容**：在本機改程式、註解（Core API 相關請維持「**網路應用程式**」部署網址，勿寫成其他類型）。
3. **取得目前版本的 ID（Core API 必須是網頁）**：
   - 開 **PaoMao_Core** 專案 → **部署** → **管理部署**。
   - 找到**類型＝網路應用程式**（網頁）、**URL 結尾 /exec** 的那一筆（不是 Head、不是其他類型）。
   - 複製該筆的**部署 ID**，貼到本文件「固定 Core API 部署」的 Deployment ID、Web App URL（URL = `https://script.google.com/macros/s/<ID>/exec`），以及 `gas/PaoMao_Core/package.json` 的 `deploy` 腳本（`-i` 後面）、各專案 CoreApiClient 的 404 提示 URL。
4. 之後發布：`npm run ship`（以本機為準 push + deploy，不再 pull）。

## 平常：以本機為準，只做 push / ship

- 平常**不執行**單獨的 `clasp pull`；以本機程式碼為準，只做 `npm run push` 或 `npm run ship` 發布新版本。
- 若在 GAS 編輯器改過程式，請把修改貼回本機後再 ship。
- 跑 `npm run ship` 前請確認本機 Core API 相關註解為「**網路應用程式**」部署網址。

## 原則（CRITICAL）

1. **不要建立新部署**（會改變 Web App URL），除非明確要求。
2. **一律更新既有部署**，以維持 URL 不變。
3. 指令格式必須為：
   ```bash
   clasp deploy -i <DEPLOYMENT_ID> -d <DESCRIPTION>
   ```

## 各專案 package.json

每個有 `.clasp.json` 的專案目錄都有 **package.json**，內含：

| 指令 | 說明 |
|------|------|
| `npm run push` | `clasp push --force`，只更新程式碼，不建立新版本 |
| `npm run deploy` | `clasp deploy -i YOUR_DEPLOYMENT_ID -d 'Updated'`，更新既有 Web App 部署 |
| `npm run ship` | `npm run push && npm run deploy`，先 push 再 deploy |

## 設定 Deployment ID

1. 在該專案的 **Apps Script 編輯器**：**部署** → **管理部署**。
2. 找到現有的 **網路應用程式** 部署，複製其 **部署 ID**（一串英數字）。
3. 在該專案的 **package.json** 裡，把 `deploy` 腳本中的 **YOUR_DEPLOYMENT_ID** 替換成這串 ID。

範例（替換後）：

```json
"deploy": "clasp deploy -i AKfycbx...你的實際ID... -d 'Updated'"
```

## PaoMao_Core（Core API）特別注意

**本段 ID 與 URL 僅指「網路應用程式」部署（結尾 /exec），勿與其他類型混淆。**

- **Core API 的網址不能做變動**。各店訊息一覽表、泡泡貓 員工打卡 Line@ 等專案都依賴此 URL（`PAO_CAT_CORE_API_URL`），一旦改變會全部失效。
- **絕對不要**對 PaoMao_Core 執行 `clasp deploy`（無 `-i`），那會產生新部署、新 URL。
- **PAO_CAT_CORE_API_URL 必須是「網路應用程式」部署的網址**（PaoMao_Core 部署→管理部署→類型為「網路應用程式」那筆，結尾 /exec）。
- **一律**使用 `clasp deploy -i <既有部署ID> -d '...'` 更新既有「**網路應用程式**」部署。更新後在「管理部署」仍是**同一筆**（同一 ID），**版本號**（如 @17、@18）會遞增，不會多出一筆新部署。
- **固定 Core API 部署（請勿更換）**：以下即為**目前在線**的網路應用程式部署；執行 `npm run ship` 會以本機**目前程式碼**更新此部署（URL 不變）。
  - **Deployment ID**：`AKfycby5ibTcUxvPD-Xj1-lOHOJ5oI27CbyyaHv2K3cvNd1PwMiPvwGCpjlzi6UbW4fwip2UaA`
  - **Web App URL**：`https://script.google.com/macros/s/AKfycby5ibTcUxvPD-Xj1-lOHOJ5oI27CbyyaHv2K3cvNd1PwMiPvwGCpjlzi6UbW4fwip2UaA/exec`
  - 各呼叫端（各店訊息一覽表、泡泡貓 員工打卡 Line@ 等）的指令碼屬性 **PAO_CAT_CORE_API_URL** 請設為上述 URL，不要再更換。
- **若 deploy 後仍看不到「網路應用程式」那筆更新**：表示 `-i` 填成了其他類型那筆的 ID。請在 **部署 → 管理部署** 中，找**類型＝網路應用程式**、**URL 結尾 /exec** 的那一筆，複製其**部署 ID**，貼到 `gas/PaoMao_Core/package.json` 的 `deploy` 腳本（`-i` 後面），並與本段「固定 Core API 部署」的 Deployment ID 一致。`scripts/ship.js` 會檢查兩者一致才允許 ship。

## 泡泡貓 員工打卡 Line@（Webhook URL）特別注意

- **員工打卡的 Web App URL 不能做變動**。LINE 後台設定的 Webhook 網址指向此 URL，一旦改變需重新設定 Webhook 且可能影響打卡。
- **一律**使用 `clasp deploy -i <既有部署ID> -d '...'` 更新既有「網路應用程式」部署，勿用 `clasp deploy` 產生新部署。
- **固定 員工打卡 Web App 部署（請勿更換）**：
  - **Deployment ID**：`AKfycby4JvdNSueVmq1_gG-mrRL0IfR4kPm1nX2itxMDg1c7MWIvEgP2xd7rmSfoxmM3Lung2w`
  - **Web App URL**：`https://script.google.com/macros/s/AKfycby4JvdNSueVmq1_gG-mrRL0IfR4kPm1nX2itxMDg1c7MWIvEgP2xd7rmSfoxmM3Lung2w/exec`
  - LINE 開發者後台 Webhook 請設為上述 URL，不要再更換。

## 查詢失敗（404）排除步驟

當「泡泡貓 員工打卡 Line@」呼叫 Core API 收到 404 時，請依序檢查：

1. **PAO_CAT_CORE_API_URL** 是設在「**泡泡貓 員工打卡 Line@**」的指令碼屬性（不是 PaoMao_Core）。
2. 網址從 **PaoMao_Core** 的「部署 → 管理部署」複製「**網路應用程式**」那筆，結尾為 **/exec**（勿用「測試部署」網址）。
3. 瀏覽器開啟「該網址?key=您的密鑰&action=token」若也 404，表示網址錯或未選類型「網路應用程式」。

實際請求網址已記在員工打卡專案的**執行紀錄**（Apps Script 編輯器 → 執行作業），可對照確認。

## 門市列表 API（storeList）

- 由 PaoMao_Core 的 `action=storeList` 提供（公開，無需 key）。
- **API 網址**：`<Core API URL>?action=storeList`（即上述 Web App URL + `?action=storeList`）
- **呼叫端**：`gas/PaoMao_Core/near-redirect-snippet.html`

## 根目錄 gas 的 ship

在 **gas** 根目錄執行 `npm run ship` 會對**所有**子專案依序執行該專案的 `npm run ship`，即 **push + 以既有部署 ID deploy**（不建立新部署、不變更網址）。  
各專案 **package.json** 的 `deploy` 腳本必須已將 `YOUR_DEPLOYMENT_ID` 改為該專案在「管理部署」中的**既有 Web App 部署 ID**，否則 deploy 會失敗。  
若要只對單一專案 push + deploy，請進入該專案目錄執行 `npm run ship`。
