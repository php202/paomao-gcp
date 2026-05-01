/**
 * API 錯誤追蹤統一模組
 * 用於記錄和分析所有 API 呼叫錯誤
 */

const { getPool } = require('./db-pool.cjs');

class ApiErrorTracker {
  constructor() {
    this.pool = getPool();
  }

  /**
   * 記錄 API 錯誤
   * @param {Object} errorInfo - 錯誤資訊
   * @returns {Promise<number>} 錯誤日誌 ID
   */
  async logError({
    apiName,           // API 名稱 (必填)
    endpoint,          // API 端點 URL
    method = 'GET',    // HTTP 方法
    requestParams,     // 請求參數
    errorType,         // 錯誤類型
    httpStatusCode,    // HTTP 狀態碼
    errorMessage,      // 錯誤訊息
    errorDetails,      // 詳細錯誤資訊
    callerScript,      // 呼叫的腳本
    callerFunction,    // 呼叫的函數
    userName           // 操作用戶
  }) {
    try {
      const { rows } = await this.pool.query(`
        SELECT log_api_error($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as log_id
      `, [
        apiName,
        endpoint,
        method,
        requestParams ? JSON.stringify(requestParams) : null,
        errorType,
        httpStatusCode,
        errorMessage,
        callerScript,
        callerFunction,
        userName
      ]);

      const logId = rows[0].log_id;
      
      // 檢查是否需要發送警報
      await this.checkAndSendAlert(apiName, errorType);
      
      return logId;
    } catch (error) {
      console.error('[api-error-tracker] Failed to log error:', error.message);
      return null;
    }
  }

  /**
   * 檢查是否需要發送警報
   * 規則：同一 API 同一錯誤類型 1小時內超過 5 次
   */
  async checkAndSendAlert(apiName, errorType) {
    try {
      const { rows } = await this.pool.query(`
        SELECT COUNT(*) as error_count
        FROM api_error_logs
        WHERE api_name = $1 
          AND error_type = $2 
          AND occurred_at > NOW() - INTERVAL '1 hour'
      `, [apiName, errorType]);

      const errorCount = parseInt(rows[0].error_count);
      
      if (errorCount >= 5) {
        // 檢查是否已發送警報
        const { rows: alertRows } = await this.pool.query(`
          SELECT alert_sent FROM api_error_stats 
          WHERE api_name = $1 AND error_type = $2 AND date = CURRENT_DATE
        `, [apiName, errorType]);

        if (alertRows.length > 0 && !alertRows[0].alert_sent) {
          await this.sendAlert(apiName, errorType, errorCount);
          
          // 標記已發送警報
          await this.pool.query(`
            UPDATE api_error_stats 
            SET alert_sent = TRUE 
            WHERE api_name = $1 AND error_type = $2 AND date = CURRENT_DATE
          `, [apiName, errorType]);
        }
      }
    } catch (error) {
      console.error('[api-error-tracker] Failed to check alert:', error.message);
    }
  }

  /**
   * 發送警報到 Telegram
   */
  async sendAlert(apiName, errorType, errorCount) {
    try {
      const message = `🚨 **API 錯誤警報**

**API:** ${apiName}
**錯誤類型:** ${errorType}
**1小時內發生:** ${errorCount} 次

請檢查並修復此 API 問題。`;

      await fetch(`https://api.telegram.org/bot7782033529:AAHaaMZ9HF1Ec9m-DyXAHZp0lz3HXWCvJAE/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: '7956245081', // Robby
          text: message,
          parse_mode: 'Markdown'
        })
      });

      console.log(`[api-error-tracker] Alert sent for ${apiName}:${errorType}`);
    } catch (error) {
      console.error('[api-error-tracker] Failed to send alert:', error.message);
    }
  }

  /**
   * 獲取錯誤統計
   */
  async getErrorStats(days = 7) {
    try {
      const { rows } = await this.pool.query(`
        SELECT 
          api_name,
          error_type,
          SUM(error_count) as total_errors,
          COUNT(DISTINCT date) as affected_days,
          MAX(last_occurred_at) as last_error
        FROM api_error_stats 
        WHERE date > CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY api_name, error_type
        ORDER BY total_errors DESC
      `);

      return rows;
    } catch (error) {
      console.error('[api-error-tracker] Failed to get stats:', error.message);
      return [];
    }
  }

  /**
   * 標記錯誤已解決
   */
  async markResolved(apiName, errorType, resolutionNotes) {
    try {
      await this.pool.query(`
        UPDATE api_error_logs 
        SET resolved = TRUE, resolved_at = NOW(), resolution_notes = $3
        WHERE api_name = $1 AND error_type = $2 AND resolved = FALSE
      `, [apiName, errorType, resolutionNotes]);

      await this.pool.query(`
        UPDATE api_error_stats 
        SET status = 'resolved'
        WHERE api_name = $1 AND error_type = $2
      `, [apiName, errorType]);

      console.log(`[api-error-tracker] Marked ${apiName}:${errorType} as resolved`);
    } catch (error) {
      console.error('[api-error-tracker] Failed to mark resolved:', error.message);
    }
  }

  /**
   * 封裝 fetch 呼叫，自動記錄錯誤
   */
  async trackedFetch(apiName, url, options = {}, callerInfo = {}) {
    const startTime = Date.now();
    
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30000), // 預設 30 秒 timeout
        ...options
      });

      // 記錄成功的呼叫（可選）
      if (!response.ok) {
        const errorMessage = `HTTP ${response.status} ${response.statusText}`;
        const responseText = await response.text().catch(() => 'Unable to read response');
        
        await this.logError({
          apiName,
          endpoint: url,
          method: options.method || 'GET',
          requestParams: options.body ? { body: options.body } : null,
          errorType: 'HTTP_ERROR',
          httpStatusCode: response.status,
          errorMessage,
          errorDetails: { responseText, duration: Date.now() - startTime },
          callerScript: callerInfo.script,
          callerFunction: callerInfo.function,
          userName: callerInfo.user
        });

        throw new Error(errorMessage);
      }

      return response;
    } catch (error) {
      let errorType = 'UNKNOWN_ERROR';
      let httpStatusCode = null;

      if (error.name === 'TimeoutError') {
        errorType = 'TIMEOUT';
      } else if (error.message.includes('fetch failed') || error.message.includes('network')) {
        errorType = 'NETWORK_ERROR';
      } else if (error.message.startsWith('HTTP ')) {
        errorType = 'HTTP_ERROR';
        const match = error.message.match(/HTTP (\d+)/);
        if (match) httpStatusCode = parseInt(match[1]);
      }

      await this.logError({
        apiName,
        endpoint: url,
        method: options.method || 'GET',
        requestParams: options.body ? { body: options.body } : null,
        errorType,
        httpStatusCode,
        errorMessage: error.message,
        errorDetails: { duration: Date.now() - startTime },
        callerScript: callerInfo.script,
        callerFunction: callerInfo.function,
        userName: callerInfo.user
      });

      throw error;
    }
  }
}

// 單例模式
let instance = null;

function getApiErrorTracker() {
  if (!instance) {
    instance = new ApiErrorTracker();
  }
  return instance;
}

module.exports = {
  ApiErrorTracker,
  getApiErrorTracker,
  
  // 便利函數
  logApiError: async (errorInfo) => {
    const tracker = getApiErrorTracker();
    return await tracker.logError(errorInfo);
  },
  
  trackedFetch: async (apiName, url, options, callerInfo) => {
    const tracker = getApiErrorTracker();
    return await tracker.trackedFetch(apiName, url, options, callerInfo);
  }
};