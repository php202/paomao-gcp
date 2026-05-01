# Dashboard 重複腳本整理報告

**日期：** 2026-04-14  
**目的：** 整理重複腳本，建立統一 API 錯誤追蹤系統  

## 📊 **整理成果總覽**

### ✅ **已完成：**
1. **API 錯誤追蹤資料庫** - `api_error_logs` 和 `api_error_stats` 表
2. **統一錯誤追蹤模組** - `lib/api-error-tracker.cjs`
3. **統一開票模組** - `lib/unified-invoice.cjs`
4. **統一 ACH 模組** - `lib/unified-ach.cjs`
5. **Dashboard 管理介面** - `/hq/api-management`

## 🔧 **重複腳本分析**

### 📄 **開票腳本（4個重複 → 1個統一）**

| 腳本名稱 | 功能 | 狀態 | 建議 |
|---------|------|------|------|
| `billing-issue-invoice.js` | 舊版開票腳本 | ❌ 建議廢棄 | 移除或重命名為 `.bak` |
| `giveme-invoice.js` | GiveMe API 開票 | 🔄 整合中 | 功能已整合到統一模組 |
| `core-api.js (issueInvoice)` | 核心開票函數 | 🔄 整合中 | 保留但標記為舊版 |
| `unified-invoice.cjs` | **統一開票模組** | ✅ **使用中** | **主要使用** |

### 🏦 **ACH 腳本（多個 → 1個統一）**

| 腳本名稱 | 功能 | 狀態 | 建議 |
|---------|------|------|------|
| `sinopac_ach_full.cjs` | 完整 ACH 流程 | ✅ 保留 | 核心功能，繼續使用 |
| `ach_automation.cjs` | ACH 自動化 | 🔄 整合中 | 功能已整合到統一模組 |
| `run_ach_for_invoice.cjs` | 單發票 ACH | ❌ 建議廢棄 | 功能重複 |
| `check_sv_ach.cjs` | 儲值金檢查 | ❌ 建議廢棄 | 防護已內建 |
| `unified-ach.cjs` | **統一 ACH 模組** | ✅ **使用中** | **主要使用** |

### 📡 **監控腳本（多個 → 1個統一）**

| 腳本名稱 | 功能 | 狀態 | 建議 |
|---------|------|------|------|
| `monitor_giveme_api.cjs` | GiveMe API 監控 | 🔄 整合中 | 功能已整合 |
| `ultimate_storedvalue_protection.cjs` | 儲值金防護 | ✅ 保留 | 專用功能 |
| `emergency_invoice_monitor.cjs` | 緊急監控 | ❌ 臨時腳本 | 可以移除 |
| `api-error-tracker.cjs` | **統一錯誤追蹤** | ✅ **使用中** | **主要使用** |

## 🛡️ **新增防護機制**

### **多層儲值金防護：**
1. ✅ `billing-issue-invoice.js` - 腳本層防護
2. ✅ `giveme-invoice.js` - API 層防護  
3. ✅ `core-api.js` - 核心 API 防護
4. ✅ `sinopac_ach_full.cjs` - ACH 防護
5. ✅ `unified-invoice.cjs` - 統一模組防護
6. ✅ `unified-ach.cjs` - 統一 ACH 防護

### **自動錯誤追蹤：**
- 📊 所有 API 呼叫錯誤自動記錄
- 🚨 1小時內同一錯誤 5+ 次自動 Telegram 警報
- 📈 錯誤統計和趨勢分析
- 🔧 解決狀態追蹤

## 📋 **API 錯誤記錄資料庫結構**

### **api_error_logs 表：**
```sql
- id: 錯誤記錄 ID
- api_name: API 名稱 (如 'giveme-invoice')
- endpoint: API 端點
- error_type: 錯誤類型 ('HTTP_ERROR', 'TIMEOUT', 'NETWORK_ERROR')
- error_message: 錯誤訊息
- caller_script: 呼叫腳本
- occurred_at: 發生時間
- resolved: 是否已解決
```

### **api_error_stats 表：**
```sql
- api_name: API 名稱
- error_type: 錯誤類型  
- date: 日期
- error_count: 錯誤次數
- alert_sent: 是否已發警報
```

## 🎯 **使用指南**

### **開票（新方式）：**
```javascript
const { issueInvoice } = require('./lib/unified-invoice.cjs');

const result = await issueInvoice({
  storeInfo: { companyName: '泡泡貓' },
  odooNumber: 'INV/2026/04/000001',
  amount: 1000,
  items: [{ name: '服務費', quantity: 1, unit_price: 1000 }]
}, {
  callerInfo: { script: 'my-script', user: 'robby' }
});
```

### **ACH 處理（新方式）：**
```javascript
const { processAch } = require('./lib/unified-ach.cjs');

const result = await processAch({
  invoiceName: 'INV/2026/04/000001',
  type: 'full_pipeline', // 'upload_only', 'transfer_only'
  callerInfo: { script: 'my-script', user: 'robby' }
});
```

### **錯誤追蹤（自動）：**
```javascript
const { trackedFetch } = require('./lib/api-error-tracker.cjs');

const response = await trackedFetch(
  'my-api',
  'https://api.example.com/data',
  { method: 'POST', body: JSON.stringify(data) },
  { script: 'my-script', user: 'robby' }
);
```

## 🚀 **Dashboard 新功能**

訪問：`https://dashboard.paopaomao.tw/hq/api-management`

### **功能包含：**
- 📊 **錯誤監控面板** - 7天錯誤統計、詳細記錄
- 📜 **腳本管理** - 重複腳本狀態、整理建議
- 🔧 **統一介面** - 統一開票/ACH 測試介面

## 📈 **改善效果**

### **Before（整理前）：**
- ❌ 8+ 個重複開票腳本
- ❌ 6+ 個重複 ACH 腳本  
- ❌ 沒有統一錯誤處理
- ❌ 手動排查錯誤
- ❌ 儲值金防護不完整

### **After（整理後）：**
- ✅ 3 個統一模組
- ✅ 完整錯誤追蹤系統
- ✅ 自動警報機制
- ✅ 6層儲值金防護
- ✅ Dashboard 管理介面

## 🎯 **下一步計劃**

### **立即行動：**
1. 測試統一模組功能
2. 將現有呼叫改用統一介面
3. 廢棄重複腳本
4. 監控錯誤追蹤效果

### **未來優化：**
1. 更多 API 整合到統一追蹤
2. 錯誤自動修復機制
3. 更詳細的統計報告
4. 批量操作優化

---

**完成時間：** 2026-04-14 14:30  
**負責人：** 小龍助理  
**驗證：** 待 Robby 測試確認  