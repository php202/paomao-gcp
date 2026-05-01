#!/usr/bin/env node
/**
 * 為儲值金發票建立 ACH 記錄
 * Robby澄清：儲值金發票需要ACH，但不需要透過GiveMe開立電子發票
 */

const { getPool } = require('../lib/db-pool.cjs');
const { odooCall } = require('../lib/odoo.cjs');

// 儲值金發票 ACH 對應表
const STORED_VALUE_ACH_MAPPINGS = {
  'INV/2026/04/000056': '260414021162812',
  'INV/2026/04/000051': '260414021162791', 
  'INV/2026/04/000055': '260414021162772',
  'INV/2026/04/000068': '260413021155845',
  'INV/2026/04/000052': '260413021151238',
  'INV/2026/04/000053': '260413021151210',
  'INV/2026/04/000049': '260413021151171',
  'INV/2026/04/000048': '260413021151119'
};

async function bindStoredValueAch() {
  console.log('🔄 為儲值金發票建立 ACH 記錄...\n');
  
  try {
    const pool = getPool();
    let createdCount = 0;
    let existingCount = 0;
    
    for (const [invoice, achCase] of Object.entries(STORED_VALUE_ACH_MAPPINGS)) {
      console.log(`📋 處理 ${invoice} → ${achCase}`);
      
      // 檢查是否已存在 ACH 記錄
      const { rows: existing } = await pool.query(
        'SELECT id, ach_case_no FROM ach_records WHERE odoo_invoice_id = $1',
        [invoice]
      );
      
      if (existing.length > 0) {
        console.log(`   ✅ ACH 記錄已存在 (ID: ${existing[0].id}, Case: ${existing[0].ach_case_no})`);
        existingCount++;
      } else {
        // 從 Odoo 獲取發票資訊
        const invoiceIds = await odooCall('account.move', 'search', [
          [['name', '=', invoice]]
        ]);
        
        if (invoiceIds.length === 0) {
          console.log(`   ❌ Odoo 中找不到發票`);
          continue;
        }
        
        const invoiceData = await odooCall('account.move', 'read', [invoiceIds, [
          'name', 'partner_id', 'amount_total', 'invoice_origin'
        ]]);
        
        const inv = invoiceData[0];
        const storeName = inv.partner_id[1].replace('泡泡貓｜', '').replace('泡泡貓', '');
        
        // 建立 ACH 記錄
        const { rows: [newRecord] } = await pool.query(`
          INSERT INTO ach_records (
            ach_case_no,
            amount,
            store_name,
            odoo_invoice_id,
            odoo_quote_id,
            status,
            created_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, 'completed', NOW(), NOW())
          RETURNING id
        `, [
          achCase,
          inv.amount_total,
          storeName,
          invoice,
          inv.invoice_origin
        ]);
        
        console.log(`   ✅ 建立新 ACH 記錄 (ID: ${newRecord.id})`);
        console.log(`      門市: ${storeName}`);
        console.log(`      金額: ${inv.amount_total}`);
        console.log(`      來源: ${inv.invoice_origin}`);
        
        createdCount++;
      }
      console.log('');
    }
    
    console.log('📊 **處理結果統計:**');
    console.log(`- 總計: ${Object.keys(STORED_VALUE_ACH_MAPPINGS).length} 筆`);
    console.log(`- 新建立: ${createdCount} 筆`);
    console.log(`- 已存在: ${existingCount} 筆`);
    
    await pool.end();
    
    if (createdCount > 0) {
      console.log('\n✅ 儲值金發票 ACH 記錄建立完成！');
    }
    
  } catch (error) {
    console.error('❌ 處理失敗:', error.message);
    console.error(error.stack);
  }
}

if (require.main === module) {
  bindStoredValueAch();
}

module.exports = { bindStoredValueAch };