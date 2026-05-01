/**
 * 🎮 Dashboard 適配器模組
 * 負責 Dashboard 相關的發票資料處理和格式轉換
 */

const { getPool } = require('../db-pool.cjs');

class DashboardAdapter {
  constructor() {
    this.pool = getPool();
  }

  /**
   * 📋 從 ACH 記錄獲取發票資訊
   */
  async getInvoiceDataFromACH(invoiceName) {
    const { rows } = await this.pool.query(`
      SELECT 
        ar.*,
        s.payee_tax as buyer_tax_id,
        s.payee_company as buyer_name,
        s.payee_email as buyer_email
      FROM ach_records ar
      LEFT JOIN stores s ON s.store_name = ar.store_name
      WHERE (ar.odoo_invoice_id = $1 OR ar.odoo_quote_id = $1) 
        AND ar.is_active = true
      LIMIT 1
    `, [invoiceName]);

    if (!rows[0]) {
      throw new Error(`找不到 ACH 記錄: ${invoiceName}`);
    }

    return rows[0];
  }

  /**
   * 🔄 轉換為統一發票格式
   */
  convertACHToInvoiceParams(achRecord, callerInfo = {}) {
    return {
      buyerTaxId: achRecord.buyer_tax_id,
      buyerName: achRecord.buyer_name || achRecord.store_name,
      buyerEmail: achRecord.buyer_email,
      amount: Math.abs(achRecord.amount),
      items: [{
        name: achRecord.fee_type || '貨款',
        money: Math.abs(achRecord.amount),
        number: 1
      }],
      content: `${achRecord.fee_type || '貨款'} - ${achRecord.store_name}`,
      feeType: achRecord.fee_type, // 用於儲值金檢查
      callerInfo: {
        ...callerInfo,
        script: 'dashboard',
        function: 'dashboard-adapter'
      }
    };
  }

  /**
   * 📄 從 Odoo 發票 ID 獲取資訊（預留）
   */
  async getInvoiceDataFromOdoo(invoiceId) {
    // TODO: 實現 Odoo 發票資料獲取
    throw new Error('Odoo 發票資料獲取尚未實現');
  }

  /**
   * 🎯 Dashboard 開票統一入口
   */
  async prepareInvoiceData({ invoiceId, invoiceName, callerInfo = {} }) {
    if (invoiceName) {
      const achRecord = await this.getInvoiceDataFromACH(invoiceName);
      return this.convertACHToInvoiceParams(achRecord, callerInfo);
    }
    
    if (invoiceId) {
      // 暫時不支援純 Odoo ID
      throw new Error('暫不支援純 Odoo ID 開票，需要 invoiceName');
    }
    
    throw new Error('需要提供 invoiceName 或 invoiceId');
  }
}

module.exports = { DashboardAdapter };