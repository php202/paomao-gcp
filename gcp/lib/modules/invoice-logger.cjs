/**
 * 📊 發票日誌記錄模組
 * 負責所有開票相關的日誌記錄和錯誤追蹤
 */

const { logApiError } = require('../api-error-tracker.cjs');

class InvoiceLogger {
  /**
   * 📝 記錄開票請求
   */
  static logRequest(params) {
    console.log(`[invoice-logger] 開票請求: ${params.buyerName} 統編:${params.buyerTaxId} 金額:$${params.amount}`);
  }

  /**
   * ✅ 記錄開票成功
   */
  static logSuccess(invoiceNo, params) {
    console.log(`[invoice-logger] ✅ 開票成功: ${invoiceNo} (${params.buyerName} $${params.amount})`);
  }

  /**
   * ❌ 記錄開票失敗
   */
  static logError(error, params) {
    console.error(`[invoice-logger] ❌ 開票失敗: ${error.message}`);
  }

  /**
   * 🛡️ 記錄儲值金防護觸發
   */
  static logStoredValueBlocked(params) {
    console.warn('[invoice-logger] ❌ 儲值金記錄拒絕開發票:', {
      buyerName: params.buyerName,
      buyerTaxId: params.buyerTaxId,
      content: params.content,
      items: (params.items || []).map(i => i.name).join(', ')
    });
  }

  /**
   * 📈 記錄到錯誤追蹤系統
   */
  static async logToTracker(errorType, errorMessage, requestParams, callerInfo) {
    try {
      await logApiError({
        apiName: 'unified-invoice',
        endpoint: 'issueInvoice',
        method: 'POST',
        requestParams,
        errorType,
        errorMessage,
        callerScript: callerInfo.script || 'unknown',
        callerFunction: callerInfo.function || 'unknown',
        userName: callerInfo.user || 'system'
      });
    } catch (e) {
      console.error('[invoice-logger] 錯誤記錄失敗:', e.message);
    }
  }
}

module.exports = { InvoiceLogger };