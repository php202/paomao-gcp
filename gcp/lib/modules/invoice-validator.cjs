/**
 * 📋 發票驗證模組
 * 負責所有開票前的參數驗證和檢查
 */

class InvoiceValidator {
  /**
   * 🛡️ 儲值金防護檢查
   */
  static isStoredValue(data) {
    const checkFields = [
      data.buyType,
      data.description, 
      data.feeType,
      data.content,
      data.buyerName,
      ...(data.items || []).map(item => item.name || '')
    ];

    return checkFields.some(field => {
      const str = String(field || '').toLowerCase();
      return str.includes('儲值金') || 
             str.includes('儲值') || 
             str.includes('月儲') ||
             str.includes('stored');
    });
  }

  /**
   * 📝 基本參數驗證
   */
  static validateParams(params) {
    const { buyerTaxId, amount, items } = params;
    const errors = [];

    if (!buyerTaxId) errors.push('缺少買方統編');
    if (!amount || amount <= 0) errors.push('金額必須大於 0');
    if (!items || items.length === 0) errors.push('缺少發票品項');

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 🔍 儲值金檢查（拋出異常版本）
   */
  static checkStoredValue(params) {
    if (this.isStoredValue(params)) {
      const error = new Error(`儲值金不開發票（統一防護）: ${params.buyerName || '未知'}`);
      error.type = 'STORED_VALUE_BLOCKED';
      throw error;
    }
  }
}

module.exports = { InvoiceValidator };