/**
 * 🛡️ 終極儲值金防護守衛
 * 在所有可能開發票的地方部署最後一道防線
 * 絕對不允許儲值金開電子發票
 */

const { getPool } = require('./db-pool.cjs');
const { logApiError } = require('./api-error-tracker.cjs');

class UltimateStoredValueGuard {
  constructor() {
    this.pool = getPool();
    this.interceptCount = 0;
  }

  /**
   * 🔍 檢查是否為儲值金
   */
  async isStoredValueRecord(invoiceName) {
    if (!invoiceName) return false;
    
    try {
      const { rows } = await this.pool.query(`
        SELECT fee_type, store_name, amount, id 
        FROM ach_records 
        WHERE (odoo_invoice_id = $1 OR odoo_quote_id = $1) AND is_active = true 
        LIMIT 1
      `, [invoiceName]);
      
      if (rows[0] && rows[0].fee_type === '儲值金') {
        return {
          isStoredValue: true,
          record: rows[0]
        };
      }
      
      return { isStoredValue: false };
    } catch (error) {
      console.error('[guard] 儲值金檢查失敗:', error.message);
      return { isStoredValue: false };
    }
  }

  /**
   * 🚨 終極攔截 - 拋出異常阻止執行
   */
  async interceptStoredValue(invoiceName, callerInfo = {}) {
    const check = await this.isStoredValueRecord(invoiceName);
    
    if (check.isStoredValue) {
      this.interceptCount++;
      
      const error = new Error(`🛡️ 終極防護：儲值金絕對不開電子發票 - ${invoiceName}`);
      error.type = 'ULTIMATE_STORED_VALUE_BLOCK';
      error.invoiceName = invoiceName;
      error.record = check.record;
      
      // 記錄攔截
      console.error(`[ultimate-guard] 🚨 第 ${this.interceptCount} 次攔截儲值金開票嘗試:`);
      console.error(`[ultimate-guard]    發票: ${invoiceName}`);
      console.error(`[ultimate-guard]    店名: ${check.record.store_name}`);
      console.error(`[ultimate-guard]    金額: $${check.record.amount}`);
      console.error(`[ultimate-guard]    調用者: ${callerInfo.script || 'unknown'}.${callerInfo.function || 'unknown'}`);
      
      // 記錄到錯誤追蹤系統
      await this.logInterception(check.record, callerInfo);
      
      throw error;
    }
    
    return false; // 非儲值金，可以繼續
  }

  /**
   * 📊 記錄攔截事件
   */
  async logInterception(record, callerInfo) {
    try {
      await logApiError({
        apiName: 'ultimate-stored-value-guard',
        endpoint: 'intercept',
        method: 'BLOCK',
        requestParams: {
          invoiceName: record.id,
          storeName: record.store_name,
          amount: record.amount,
          feeType: record.fee_type
        },
        errorType: 'ULTIMATE_STORED_VALUE_BLOCK',
        errorMessage: `終極防護攔截儲值金開票: ${record.store_name} $${record.amount}`,
        callerScript: callerInfo.script || 'unknown',
        callerFunction: callerInfo.function || 'unknown',
        userName: callerInfo.user || 'system'
      });
    } catch (e) {
      console.error('[ultimate-guard] 攔截記錄失敗:', e.message);
    }
  }

  /**
   * 📈 獲取攔截統計
   */
  getInterceptStats() {
    return {
      totalIntercepts: this.interceptCount,
      status: this.interceptCount > 0 ? 'ACTIVE_PROTECTION' : 'STANDBY'
    };
  }
}

// 單例模式
let guardInstance = null;

function getUltimateGuard() {
  if (!guardInstance) {
    guardInstance = new UltimateStoredValueGuard();
  }
  return guardInstance;
}

/**
 * 🛡️ 便利函數：在任何開票前調用此函數
 */
async function guardAgainstStoredValue(invoiceName, callerInfo = {}) {
  const guard = getUltimateGuard();
  return await guard.interceptStoredValue(invoiceName, callerInfo);
}

module.exports = {
  UltimateStoredValueGuard,
  getUltimateGuard,
  guardAgainstStoredValue
};