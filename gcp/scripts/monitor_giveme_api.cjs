/**
 * GiveMe API 監控腳本
 * 監控發票開立請求，特別關注儲值金防護機制
 */

const { getPool } = require('../lib/db-pool.cjs');
const fs = require('fs').promises;
const path = require('path');

const LOG_FILE = path.join(__dirname, '../logs/giveme-api-monitor.log');

// 確保 logs 目錄存在
async function ensureLogDir() {
  const logDir = path.dirname(LOG_FILE);
  try {
    await fs.mkdir(logDir, { recursive: true });
  } catch (e) {
    // 目錄已存在，忽略錯誤
  }
}

// 寫入監控日誌
async function writeLog(message) {
  const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const logLine = `[${timestamp}] ${message}\n`;
  
  try {
    await ensureLogDir();
    await fs.appendFile(LOG_FILE, logLine);
    console.log(logLine.trim());
  } catch (e) {
    console.error('寫入日誌失敗:', e.message);
  }
}

// 檢查最近的發票開立情況
async function checkRecentInvoices() {
  const pool = getPool();
  
  try {
    // 檢查最近 1 小時的發票記錄
    const { rows } = await pool.query(`
      SELECT id, store_name, amount, odoo_quote_id, odoo_invoice_id, 
             fee_type, description, status
      FROM ach_records 
      WHERE odoo_invoice_id IS NOT NULL 
        AND odoo_invoice_id != 'x'
        AND odoo_invoice_id != ''
        AND id > (SELECT COALESCE(MAX(id) - 50, 0) FROM ach_records)
      ORDER BY id DESC
      LIMIT 20
    `);
    
    const storedValueInvoices = rows.filter(r => 
      r.fee_type === '儲值金' || 
      (r.description && r.description.includes('儲值金'))
    );
    
    if (storedValueInvoices.length > 0) {
      await writeLog(`❌ 警告：發現 ${storedValueInvoices.length} 筆儲值金被誤開發票！`);
      for (const r of storedValueInvoices) {
        await writeLog(`   - ID:${r.id} ${r.store_name} $${r.amount} → ${r.odoo_invoice_id}`);
      }
      
      // 注意：不再清除 odoo_invoice_id，儲值金需要保留 INV 編號來走 ACH
      // 只清除 einvoice_no
      const { rowCount } = await pool.query(`
        UPDATE ach_records 
        SET einvoice_no = NULL, invoice_confirmed = NULL
        WHERE fee_type = '儲值金'
          AND einvoice_no IS NOT NULL 
          AND einvoice_no != ''
      `);
      
      await writeLog(`🔧 自動修正了 ${rowCount} 筆儲值金記錄`);
      
      // 發送 Telegram 警報
      try {
        const fetch = (await import('node-fetch')).default;
        const telegramRes = await fetch(`https://api.telegram.org/bot7782033529:AAHaaMZ9HF1Ec9m-DyXAHZp0lz3HXWCvJAE/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: '7956245081', // Robby
            text: `⚠️ GiveMe API 監控警報\n\n發現 ${storedValueInvoices.length} 筆儲值金被誤開發票！\n已自動修正 ${rowCount} 筆記錄。\n\n請檢查防護機制是否正常運作。`,
            parse_mode: 'Markdown'
          })
        });
        
        if (telegramRes.ok) {
          await writeLog('📱 已發送 Telegram 警報');
        } else {
          await writeLog('📱 Telegram 警報發送失敗');
        }
      } catch (e) {
        await writeLog(`📱 Telegram 警報發送錯誤: ${e.message}`);
      }
      
    } else {
      await writeLog(`✅ 檢查完成：最近 ${rows.length} 筆發票記錄正常，無儲值金誤開發票`);
    }
    
  } catch (error) {
    await writeLog(`❌ 監控檢查失敗: ${error.message}`);
  }
}

// 檢查防護機制狀態
async function checkProtectionStatus() {
  try {
    const scriptPath = path.join(__dirname, 'billing-issue-invoice.js');
    const apiPath = path.join(__dirname, '../api/giveme-invoice.js');
    
    // 檢查腳本防護
    const scriptContent = await fs.readFile(scriptPath, 'utf8');
    const hasScriptProtection = scriptContent.includes('儲值金不開發票');
    
    // 檢查 API 防護
    const apiContent = await fs.readFile(apiPath, 'utf8');
    const hasApiProtection = apiContent.includes('儲值金絕對不開發票');
    
    if (hasScriptProtection && hasApiProtection) {
      await writeLog('🛡️ 防護機制狀態正常：腳本層 ✅ API層 ✅');
    } else {
      await writeLog(`⚠️ 防護機制異常：腳本層 ${hasScriptProtection ? '✅' : '❌'} API層 ${hasApiProtection ? '✅' : '❌'}`);
    }
    
  } catch (error) {
    await writeLog(`❌ 防護機制檢查失敗: ${error.message}`);
  }
}

// 主監控函數
async function monitor() {
  await writeLog('🔍 GiveMe API 監控開始');
  await checkProtectionStatus();
  await checkRecentInvoices();
  await writeLog('🔍 GiveMe API 監控完成');
}

// 如果直接執行此腳本
if (require.main === module) {
  monitor().catch(error => {
    console.error('監控執行失敗:', error);
    process.exit(1);
  });
}

module.exports = { monitor, checkRecentInvoices, checkProtectionStatus };