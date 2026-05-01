/**
 * 統一 ACH 處理模組
 * 整合 sinopac_ach_full.cjs, ach_automation.cjs 等功能
 * 提供統一的 ACH 處理介面
 */

const { trackedFetch, logApiError } = require('./api-error-tracker.cjs');
const { getPool } = require('./db-pool.cjs');
const { execSync } = require('child_process');
const path = require('path');

class UnifiedAchService {
  constructor() {
    this.pool = getPool();
    this.scriptPath = path.join(__dirname, '../scripts');
  }

  /**
   * 儲值金防護檢查
   */
  async checkStoredValueProtection(invoiceName, achRecordId) {
    try {
      const { rows } = await this.pool.query(
        'SELECT fee_type FROM ach_records WHERE id = $1 OR odoo_quote_id = $2 OR odoo_invoice_id = $2',
        [achRecordId, invoiceName]
      );

      if (rows.length > 0 && rows[0].fee_type === '儲值金') {
        throw new Error(`儲值金不進行 ACH 處理（統一防護）: ${invoiceName}`);
      }

      return true;
    } catch (error) {
      await logApiError({
        apiName: 'unified-ach',
        endpoint: 'checkStoredValueProtection',
        method: 'CHECK',
        requestParams: { invoiceName, achRecordId },
        errorType: 'STORED_VALUE_BLOCKED',
        errorMessage: error.message,
        callerScript: 'unified-ach',
        callerFunction: 'checkStoredValueProtection'
      });

      throw error;
    }
  }

  /**
   * 統一 ACH 處理入口點
   */
  async processAch(options = {}) {
    const {
      invoiceName,
      invoiceId,
      type = 'full_pipeline', // 'full_pipeline', 'upload_only', 'transfer_only'
      callerInfo = {}
    } = options;

    console.log(`[unified-ach] ACH 處理請求: ${invoiceName} (${type})`);

    try {
      // 儲值金防護檢查
      await this.checkStoredValueProtection(invoiceName, invoiceId);

      let result;
      
      switch (type) {
        case 'full_pipeline':
          result = await this.processFullPipeline(options, callerInfo);
          break;
        case 'upload_only':
          result = await this.uploadAchFile(options, callerInfo);
          break;
        case 'transfer_only':
          result = await this.processTransfer(options, callerInfo);
          break;
        default:
          throw new Error(`不支援的 ACH 處理類型: ${type}`);
      }

      console.log(`[unified-ach] ✅ ACH 處理成功: ${result.caseNo || 'completed'}`);
      return result;

    } catch (error) {
      console.error(`[unified-ach] ❌ ACH 處理失敗: ${error.message}`);
      
      await logApiError({
        apiName: 'unified-ach',
        endpoint: 'processAch',
        method: 'POST',
        requestParams: options,
        errorType: error.name || 'ACH_ERROR',
        errorMessage: error.message,
        callerScript: callerInfo.script || 'unknown',
        callerFunction: callerInfo.function || 'unknown',
        userName: callerInfo.user
      });

      throw error;
    }
  }

  /**
   * 完整 ACH 流程 (產檔 + 上傳 + 送審)
   */
  async processFullPipeline(options, callerInfo) {
    const { invoiceName, invoiceId } = options;
    
    try {
      console.log(`[unified-ach] 執行完整 ACH 流程: ${invoiceName}`);
      
      // 呼叫 sinopac_ach_full.cjs
      const scriptPath = path.join(this.scriptPath, 'sinopac_ach_full.cjs');
      const command = `/opt/homebrew/bin/node ${scriptPath} --invoice-name "${invoiceName}"`;
      
      const result = execSync(command, {
        timeout: 240000, // 4 分鐘 timeout
        encoding: 'utf8',
        cwd: this.scriptPath
      });

      // 解析結果
      const lines = result.trim().split('\n');
      let jsonResult = null;
      
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          jsonResult = JSON.parse(lines[i]);
          break;
        } catch (_) {}
      }

      if (jsonResult?.success) {
        return {
          success: true,
          caseNo: jsonResult.caseNo,
          type: 'full_pipeline',
          details: jsonResult
        };
      } else {
        throw new Error(jsonResult?.error || '處理失敗');
      }

    } catch (error) {
      await logApiError({
        apiName: 'sinopac-ach-full',
        endpoint: 'full_pipeline',
        method: 'EXEC',
        requestParams: options,
        errorType: 'SCRIPT_ERROR',
        errorMessage: error.message,
        callerScript: 'unified-ach',
        callerFunction: 'processFullPipeline',
        userName: callerInfo.user
      });

      throw error;
    }
  }

  /**
   * 僅上傳 ACH 檔案
   */
  async uploadAchFile(options, callerInfo) {
    const { filePath, invoiceName } = options;
    
    if (!filePath) {
      throw new Error('上傳 ACH 檔案需要提供 filePath');
    }

    try {
      console.log(`[unified-ach] 上傳 ACH 檔案: ${filePath}`);
      
      const scriptPath = path.join(this.scriptPath, 'sinopac_ach_upload.cjs');
      const command = `/opt/homebrew/bin/node ${scriptPath} --file "${filePath}"`;
      
      const result = execSync(command, {
        timeout: 120000, // 2 分鐘 timeout
        encoding: 'utf8',
        cwd: this.scriptPath
      });

      return {
        success: true,
        type: 'upload_only',
        result: result.trim()
      };

    } catch (error) {
      await logApiError({
        apiName: 'sinopac-ach-upload',
        endpoint: 'upload_only',
        method: 'EXEC',
        requestParams: options,
        errorType: 'UPLOAD_ERROR',
        errorMessage: error.message,
        callerScript: 'unified-ach',
        callerFunction: 'uploadAchFile',
        userName: callerInfo.user
      });

      throw error;
    }
  }

  /**
   * 僅處理 666→686 轉帳
   */
  async processTransfer(options, callerInfo) {
    const { invoiceName, partnerName, amount } = options;
    
    try {
      console.log(`[unified-ach] 處理 666→686 轉帳: ${invoiceName} $${amount}`);
      
      // 使用 Dashboard API 處理轉帳
      const response = await trackedFetch(
        'dashboard-transfer-666-686',
        'http://localhost:3000/api/accounting/transfer-666-686',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-key': 'unified-ach-transfer'
          },
          body: JSON.stringify({
            invoiceName,
            partnerName,
            amount,
            skipInvoiceCheck: true
          })
        },
        callerInfo
      );

      const result = await response.json();
      
      if (!result.ok) {
        throw new Error(result.error || '轉帳失敗');
      }

      return {
        success: true,
        caseNo: result.caseNo,
        type: 'transfer_only',
        details: result
      };

    } catch (error) {
      await logApiError({
        apiName: 'dashboard-transfer',
        endpoint: 'transfer-666-686',
        method: 'POST',
        requestParams: options,
        errorType: 'TRANSFER_ERROR',
        errorMessage: error.message,
        callerScript: 'unified-ach',
        callerFunction: 'processTransfer',
        userName: callerInfo.user
      });

      throw error;
    }
  }

  /**
   * 批量處理 ACH
   */
  async batchProcessAch(achList, options = {}) {
    const results = [];
    let successCount = 0;
    let failedCount = 0;

    for (const [index, achData] of achList.entries()) {
      try {
        console.log(`[unified-ach] 處理第 ${index + 1}/${achList.length} 筆 ACH`);
        
        const result = await this.processAch({
          ...achData,
          ...options,
          callerInfo: { ...options.callerInfo, function: 'batchProcessAch' }
        });
        
        results.push({ index, success: true, result });
        successCount++;
        
        // 批量處理間隔
        if (options.delay && index < achList.length - 1) {
          await new Promise(resolve => setTimeout(resolve, options.delay));
        }
        
      } catch (error) {
        results.push({ index, success: false, error: error.message });
        failedCount++;
        
        // 失敗後是否繼續
        if (options.stopOnError) {
          break;
        }
      }
    }

    console.log(`[unified-ach] 批量 ACH 處理完成: ${successCount} 成功, ${failedCount} 失敗`);
    
    return {
      total: achList.length,
      success: successCount,
      failed: failedCount,
      results
    };
  }

  /**
   * 取得 ACH 處理統計
   */
  async getAchStats(days = 7) {
    try {
      const { rows } = await this.pool.query(`
        SELECT 
          DATE(occurred_at) as date,
          api_name,
          COUNT(*) as total_errors,
          COUNT(CASE WHEN error_type = 'STORED_VALUE_BLOCKED' THEN 1 END) as blocked_stored_value
        FROM api_error_logs
        WHERE (api_name LIKE '%ach%' OR api_name = 'unified-ach')
          AND occurred_at > NOW() - INTERVAL '${days} days'
        GROUP BY DATE(occurred_at), api_name
        ORDER BY date DESC, api_name
      `);

      return rows;
    } catch (error) {
      console.error('[unified-ach] 無法獲取統計:', error.message);
      return [];
    }
  }
}

// 單例模式
let achService = null;

function getUnifiedAchService() {
  if (!achService) {
    achService = new UnifiedAchService();
  }
  return achService;
}

module.exports = {
  UnifiedAchService,
  getUnifiedAchService,
  
  // 便利函數
  processAch: async (options) => {
    const service = getUnifiedAchService();
    return await service.processAch(options);
  },
  
  batchProcessAch: async (achList, options) => {
    const service = getUnifiedAchService();
    return await service.batchProcessAch(achList, options);
  }
};