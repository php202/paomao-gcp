# GCP 程式碼模組化重構 Changelog

**日期：** 2026-03-14  
**執行者：** AI 自動重構（subagent）

---

## 新建模組

### `lib/odoo.cjs` （CommonJS）
- 統一 Odoo JSON-RPC 呼叫（fetch-based，不需 xmlrpc 依賴）
- 讀 `~/.openclaw/secrets/odoo-config.json`
- 模組級 UID 快取，避免重複 auth
- exports: `odooAuth()`, `odooCall(model, method, args, kwargs)`, `getOdooConfig()`, `resetOdooAuth()`
- 供 `scripts/*.cjs` 用 `require('../lib/odoo.cjs')`

### `lib/odoo.js` （ESM）
- 同上，ESM 版
- 供 `api/*.js` 用 `import { odooCall } from '../lib/odoo.js'`

### `lib/line.js` （ESM）
- 統一 LINE Messaging API
- exports: `pushMessage(to, text, token)`, `pushFlex(to, flexContents, altText, token)`, `replyText(replyToken, text, token)`, `sendAdminLinePush(text)`
- 相容原 `lib/line-push.js` 的 `sendAdminLinePush`

### `lib/giveme.js` （ESM）
- 統一 Giveme 電子發票 API 入口
- re-export `issueInvoice`, `getOdooInvoice` from `api/core-api.js`
- 供各模組 `import { issueInvoice } from '../lib/giveme.js'`

### `lib/ach.js` （ESM）
- 統一 ACH DB 操作
- exports: `getUnconfirmedAchRecords(year?)`, `getAchRecordById(id)`, `updateAchConfirmed(id, confirmedAt?)`, `insertAchRecord(record)`, `getPayeeByCode(code)`, `getPayees()`

### `lib/error-tracker.js` （ESM）
- 統一錯誤追蹤機制
- 錯誤寫入 DB 表 `module_errors`（已建表）
- 1 小時內同一函數錯誤 ≥ 3 次 → 發 Telegram 通知到辦公室群組 (-5220564261)
- exports: `trackError(moduleName, functionName, error)`, `withTracking(fn, moduleName, functionName)`, `ensureErrorTable()`

---

## 修改檔案

### `api/paopao-webhook.js` （ESM）
- 新增 import: `import { odooCall } from '../lib/odoo.js'`
- 移除 3 處各自重複的 inline `odooAuth` / `odooCall` 定義：
  - `handleConfirmPostback`（原行 594-619）
  - `handleDirectConfirmPostback`（原行 753-783）
  - `handleSOConfirmPostback`（原行 861-891）
- 業務邏輯完全不變，只替換 odoo 呼叫來源

### `scripts/ach_daily_push.cjs` （CJS）
- 移除 inline `ODOO_CONFIG_PATH`, `getOdooConfig`, `odooAuth`, `odooCall`
- 改用 `const { odooCall } = require('../lib/odoo.cjs')`
- 移除不再需要的 `fs`, `path` require（這些已在 lib/odoo.cjs 內部使用）

### `scripts/ach_automation.cjs` （CJS）
- 移除 inline `ODOO_CONFIG_PATH`, `getOdooConfig`, `odooAuth`, `odooCall` 區塊
- 改用 `const { odooCall } = require('../lib/odoo.cjs')`

### `scripts/notify_sent_orders.cjs` （CJS）
- 移除 inline `ODOO_CONFIG_PATH`, `getOdooConfig`, `odooAuth`, `odooCall`
- 改用 `const { odooCall } = require('../lib/odoo.cjs')`

### `scripts/monthly_consulting_fee.cjs` （CJS，原用 xmlrpc）
- 移除 `const xmlrpc = require('xmlrpc')` 依賴
- 移除 xmlrpc-based `odooCall`（原用 hardcoded uid=6）
- 改用 `const { odooCall } = require('../lib/odoo.cjs')` → JSON-RPC，有正規 auth

### `scripts/monthly_service_fee.cjs` （CJS，原用 xmlrpc）
- 同上，移除 xmlrpc 依賴，改用 lib/odoo.cjs

### `scripts/monthly_stored_value.cjs` （CJS，原用 xmlrpc）
- 移除 `const xmlrpc = require('xmlrpc')` 依賴
- 移除 xmlrpc-based `odooCall`（原有 None 回傳特殊處理）
- 改用 `const { odooCall } = require('../lib/odoo.cjs')` → JSON-RPC 中 null result 不拋錯

### `scripts/sync_odoo_orders_to_ach.cjs` （CJS，原用 xmlrpc）
- 同上，移除 xmlrpc 依賴，改用 lib/odoo.cjs

---

## DB 變更

- **新建表** `module_errors`：
  ```sql
  CREATE TABLE IF NOT EXISTS module_errors (
    id SERIAL PRIMARY KEY,
    module_name TEXT,
    function_name TEXT,
    error_message TEXT,
    stack TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  ```

---

## 語法驗證

所有修改檔案已通過 `node -c` / `node --check`：

```
lib/odoo.cjs         ✅
lib/odoo.js          ✅
lib/line.js          ✅
lib/ach.js           ✅
lib/giveme.js        ✅
lib/error-tracker.js ✅
scripts/ach_daily_push.cjs         ✅
scripts/ach_automation.cjs         ✅
scripts/notify_sent_orders.cjs     ✅
scripts/monthly_consulting_fee.cjs ✅
scripts/monthly_service_fee.cjs    ✅
scripts/monthly_stored_value.cjs   ✅
scripts/sync_odoo_orders_to_ach.cjs ✅
api/paopao-webhook.js              ✅
```

---

## GCP Server 重啟

```
launchctl kickstart -k gui/$(id -u)/com.paopaomao.gcp-server
```

重啟後 server 正常運行，port 3850。

---

## 重要說明

1. **xmlrpc → JSON-RPC 遷移**：`monthly_consulting_fee`, `monthly_service_fee`, `monthly_stored_value`, `sync_odoo_orders_to_ach` 原用 xmlrpc（via `NODE_PATH=~/泡泡貓/dashboard/node_modules`）。新版改用 fetch-based JSON-RPC，不再需要外部 xmlrpc 依賴，且使用正規 odoo auth（不再 hardcode uid=6）。

2. **UID 快取**：新版 lib/odoo.cjs 和 lib/odoo.js 在模組層級快取 UID，對長時間執行的程序（如 gcp-server）更高效。如遇 session 過期，可呼叫 `resetOdooAuth()` 強制重新 auth。

3. **不動業務邏輯**：所有業務邏輯、Odoo 呼叫參數、資料流均未更動。

4. **未觸及**：`~/泡泡貓/dashboard/server.js`（另一 repo，本次不動）。

---

### 2026-03-19: lib/store-group.cjs — 門市 LINE 群組查找模組

**新增** `lib/store-group.cjs`：`StoreGroupResolver` class
- `resolve(partnerId, partnerName)` — 單筆查找（odoo_id → parent_id → 名稱比對）
- `resolveBatch(items)` — 批量查找（減少 Odoo API 呼叫）
- `resolveByOdooId(partnerId)` — 只查 odoo_id 直配
- `resolveByName(partnerName)` — 只用名稱模糊比對

**改動** `scripts/notify_sent_orders.cjs`
- 移除內嵌的 SQL 查詢和 findStoreByName 邏輯
- 改用 `StoreGroupResolver.resolveBatch()` 統一查找
- 程式碼從 ~320 行縮到 ~180 行

**解決問題**：忠孝店(Kelly)/台大辛亥店(廖婕茹) 等 partner 無 parent_id 的 SO 可透過名稱比對找到群組
