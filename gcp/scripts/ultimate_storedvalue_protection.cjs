/**
 * 終極儲值金開發票防護系統
 * 多層檢查，確保儲值金絕對不開發票
 */

const { getPool } = require('../lib/db-pool.cjs');
const fetch = require('node-fetch');

const TELEGRAM_BOT_TOKEN = '7782033529:AAHaaMZ9HF1Ec9m-DyXAHZp0lz3HXWCvJAE';
const ROBBY_CHAT_ID = '7956245081';

async function sendTelegramAlert(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ROBBY_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });
  } catch (e) {
    console.error('Telegram 警報發送失敗:', e.message);
  }
}

async function checkAndFixStoredValueInvoices() {
  const pool = getPool();
  
  try {
    console.log('=== 終極儲值金防護檢查 ===');
    
    // 檢查所有儲值金是否被誤開發票
    const { rows: violations } = await pool.query(`
      SELECT id, store_name, amount, odoo_quote_id, odoo_invoice_id, description
      FROM ach_records 
      WHERE fee_type = '儲值金'
        AND odoo_invoice_id IS NOT NULL 
        AND odoo_invoice_id != 'x'
        AND odoo_invoice_id != ''
    `);
    
    if (violations.length > 0) {
      console.log(`🚨 發現 ${violations.length} 筆儲值金被誤開發票！`);
      
      const alertDetails = violations.map(r => 
        `• ${r.store_name} $${r.amount} → ${r.odoo_invoice_id}`
      ).join('\n');
      
      await sendTelegramAlert(`🚨 **儲值金開發票警報**

發現 ${violations.length} 筆儲值金被誤開發票！

${alertDetails}

系統將自動修正這些記錄。`);
      
      // 注意：不再自動清除 odoo_invoice_id，因為儲值金需要保留 INV 編號來走 ACH 扣款
      // 只清除 einvoice_no（電子發票編號），防止儲值金開電子發票
      const { rowCount } = await pool.query(`
        UPDATE ach_records 
        SET einvoice_no = NULL, invoice_confirmed = NULL
        WHERE fee_type = '儲值金'
          AND einvoice_no IS NOT NULL 
          AND einvoice_no != ''
      `);
      
      console.log(`✅ 已自動修正 ${rowCount} 筆記錄`);
      
      await sendTelegramAlert(`✅ 已自動修正 ${rowCount} 筆儲值金記錄

請檢查 GiveMe 後台是否需要手動作廢對應發票。`);
      
    } else {
      console.log('✅ 沒有儲值金被誤開發票');
    }
    
    // 檢查防護機制狀態
    console.log('🛡️ 檢查防護機制...');
    const protectionFiles = [
      '~/paomao-gcp/gcp/scripts/billing-issue-invoice.js',
      '~/paomao-gcp/gcp/api/giveme-invoice.js',
      '~/paomao-gcp/gcp/api/core-api.js'
    ];
    
    const fs = require('fs').promises;
    const path = require('path');
    
    for (const file of protectionFiles) {
      try {
        const fullPath = file.replace('~', process.env.HOME);
        const content = await fs.readFile(fullPath, 'utf8');
        const hasProtection = content.includes('儲值金') && (
          content.includes('跳過') || 
          content.includes('拒絕') || 
          content.includes('不開發票')
        );
        console.log(`${hasProtection ? '✅' : '❌'} ${path.basename(fullPath)}: ${hasProtection ? '防護正常' : '缺少防護'}`);
      } catch (e) {
        console.log(`⚠️ ${path.basename(file)}: 無法檢查 (${e.message})`);
      }
    }
    
  } catch (error) {
    console.error('❌ 檢查失敗:', error.message);
    await sendTelegramAlert(`❌ **儲值金防護檢查失敗**

錯誤: ${error.message}

請手動檢查系統狀態。`);
  }
}

// 如果直接執行
if (require.main === module) {
  checkAndFixStoredValueInvoices().catch(console.error);
}

module.exports = { checkAndFixStoredValueInvoices };