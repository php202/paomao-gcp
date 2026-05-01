/**
 * 🎯 統一開票服務 - 模組化版本
 * 整合所有開票邏輯，使用模組化架構便於維護
 */

const { InvoiceValidator } = require('./modules/invoice-validator.cjs');
const { GiveMeClient } = require('./modules/giveme-client.cjs');
const { InvoiceLogger } = require('./modules/invoice-logger.cjs');
const { DashboardAdapter } = require('./modules/dashboard-adapter.cjs');

class UnifiedInvoiceService {
  constructor(config = {}) {
    this.givemeClient = new GiveMeClient(config.giveme);
    this.dashboardAdapter = new DashboardAdapter();
  }

  /**
   * 📄 統一開票主方法
   * @param {Object} params 開票參數
   * @param {string} params.buyerTaxId 買方統編
   * @param {string} params.buyerName 買方名稱
   * @param {number} params.amount 開票金額
   * @param {Array} params.items 發票品項
   * @param {string} params.content 備註內容
   * @param {Object} params.callerInfo 調用者資訊
   */
  async issueInvoice(params) {
    const { buyerTaxId, buyerName, buyerEmail, amount, items = [], content = '', callerInfo = {} } = params;

    // 📝 記錄請求
    InvoiceLogger.logRequest(params);

    try {
      // 🔍 儲值金防護檢查
      InvoiceValidator.checkStoredValue(params);
      
      // ✅ 基本參數驗證
      const validation = InvoiceValidator.validateParams(params);
      if (!validation.valid) {
        throw new Error(`參數驗證失敗: ${validation.errors.join(', ')}`);
      }

      // 🔌 呼叫 GiveMe API
      const result = await this.givemeClient.issueInvoice({
        buyerTaxId,
        buyerName,
        buyerEmail,
        amount,
        items,
        content
      });

      // 📊 記錄成功
      InvoiceLogger.logSuccess(result.invoiceNo, params);
      
      return {
        ok: true,
        invoiceNo: result.invoiceNo,
        amount: amount,
        message: `發票 ${result.invoiceNo} 已開立`
      };

    } catch (error) {
      // 📊 記錄錯誤
      if (error.type === 'STORED_VALUE_BLOCKED') {
        InvoiceLogger.logStoredValueBlocked(params);
        await InvoiceLogger.logToTracker('STORED_VALUE_BLOCKED', error.message, params, callerInfo);
      } else {
        InvoiceLogger.logError(error, params);
        await InvoiceLogger.logToTracker('INVOICE_FAILED', error.message, params, callerInfo);
      }
      
      throw error;
    }
  }

  /**
   * 🎮 Dashboard 專用開票介面
   */
  async issueDashboardInvoice({ invoiceId, invoiceName, callerInfo = {} }) {
    console.log(`[unified-invoice] Dashboard 開票請求: ${invoiceName} (ID: ${invoiceId})`);

    try {
      // 🔄 準備發票資料
      const invoiceParams = await this.dashboardAdapter.prepareInvoiceData({
        invoiceId,
        invoiceName,
        callerInfo
      });

      // 🎯 執行開票
      return await this.issueInvoice(invoiceParams);
      
    } catch (error) {
      console.error(`[unified-invoice] Dashboard 開票失敗: ${error.message}`);
      throw error;
    }
  }

  /**
   * 🔄 Legacy 相容性介面
   */
  async issueGiveMeInvoice(opts) {
    const { amount, buyerTaxId, buyerName, buyerEmail, items, content } = opts;
    
    return await this.issueInvoice({
      buyerTaxId,
      buyerName,
      buyerEmail,
      amount,
      items,
      content,
      callerInfo: { script: 'legacy', function: 'issueGiveMeInvoice' }
    });
  }
}

// 🔧 工廠函數和單例
let instance = null;

function createUnifiedInvoiceService(config = {}) {
  return new UnifiedInvoiceService(config);
}

function getUnifiedInvoiceService(config = {}) {
  if (!instance) {
    instance = createUnifiedInvoiceService(config);
  }
  return instance;
}

// 📤 導出
module.exports = {
  UnifiedInvoiceService,
  createUnifiedInvoiceService,
  getUnifiedInvoiceService,
  
  // 🎯 便利函數
  issueInvoice: async (params) => {
    const service = getUnifiedInvoiceService();
    return service.issueInvoice(params);
  },
  
  // 🔄 Legacy 導出
  issueGiveMeInvoice: async (opts) => {
    const service = getUnifiedInvoiceService();
    return service.issueGiveMeInvoice(opts);
  }
};