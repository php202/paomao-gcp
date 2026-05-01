#!/usr/bin/env node
/**
 * 批量更新 ACH Case 編號
 * 根據 Robby 提供的發票編號對應表更新
 */

const { getPool } = require('../lib/db-pool.cjs');

// ACH Case 編號對應表
const ACH_CASE_MAPPINGS = [
  { invoice: 'INV/2026/04/000086', ach_case_no: '260414021166582' },
  { invoice: 'INV/2026/04/000083', ach_case_no: '260414021163450' },
  { invoice: 'INV/2026/04/000084', ach_case_no: '260414021163433' },
  { invoice: 'INV/2026/04/000080', ach_case_no: '260414021162965' },
  { invoice: 'INV/2026/04/000081', ach_case_no: '260414021162938' },
  { invoice: 'INV/2026/04/000069', ach_case_no: '260414021162902' },
  { invoice: 'INV/2026/04/000075', ach_case_no: '260414021162884' },
  { invoice: 'INV/2026/04/000056', ach_case_no: '260414021162812' },
  { invoice: 'INV/2026/04/000051', ach_case_no: '260414021162791' },
  { invoice: 'INV/2026/04/000055', ach_case_no: '260414021162772' },
  { invoice: 'INV/2026/04/000065', ach_case_no: '260414021162747' },
  { invoice: 'INV/2026/04/000068', ach_case_no: '260413021155845' },
  { invoice: 'INV/2026/04/000070', ach_case_no: '260413021155828' },
  { invoice: 'INV/2026/04/000071', ach_case_no: '260413021154429' },
  { invoice: 'INV/2026/04/000074', ach_case_no: '260413021154412' },
  { invoice: 'INV/2026/04/000072', ach_case_no: '260413021154390' },
  { invoice: 'INV/2026/04/000052', ach_case_no: '260413021151238' },
  { invoice: 'INV/2026/04/000053', ach_case_no: '260413021151210' },
  { invoice: 'INV/2026/04/000049', ach_case_no: '260413021151171' },
  { invoice: 'INV/2026/04/000048', ach_case_no: '260413021151119' }
];

async function updateAchCaseNumbers() {
  console.log('🔄 開始更新 ACH Case 編號...\n');
  
  try {
    const pool = getPool();
    
    let successCount = 0;
    let notFoundCount = 0;
    let errorCount = 0;
    
    for (const mapping of ACH_CASE_MAPPINGS) {
      try {
        console.log(`📋 處理 ${mapping.invoice} → ${mapping.ach_case_no}`);
        
        // 查找對應的記錄
        const { rows: existing } = await pool.query(
          'SELECT id, ach_case_no FROM ach_records WHERE odoo_invoice_id = $1',
          [mapping.invoice]
        );
        
        if (existing.length === 0) {
          console.log(`   ❌ 找不到記錄`);
          notFoundCount++;
          continue;
        }
        
        if (existing.length > 1) {
          console.log(`   ⚠️ 找到多筆記錄 (${existing.length} 筆)，更新所有記錄`);
        }
        
        // 更新 ACH Case 編號
        const { rowCount } = await pool.query(
          `UPDATE ach_records 
           SET ach_case_no = $1, updated_at = NOW()
           WHERE odoo_invoice_id = $2`,
          [mapping.ach_case_no, mapping.invoice]
        );
        
        console.log(`   ✅ 更新 ${rowCount} 筆記錄`);
        
        // 顯示更新前後對比
        if (existing.length === 1 && existing[0].ach_case_no !== mapping.ach_case_no) {
          console.log(`   📝 舊編號: ${existing[0].ach_case_no || 'NULL'}`);
          console.log(`   📝 新編號: ${mapping.ach_case_no}`);
        }
        
        successCount++;
        console.log('');
        
      } catch (error) {
        console.error(`   ❌ 更新失敗: ${error.message}`);
        errorCount++;
        console.log('');
      }
    }
    
    console.log('📊 **更新結果統計:**');
    console.log(`- 總計: ${ACH_CASE_MAPPINGS.length} 筆`);
    console.log(`- 成功更新: ${successCount} 筆`);
    console.log(`- 找不到記錄: ${notFoundCount} 筆`);
    console.log(`- 更新失敗: ${errorCount} 筆`);
    
    await pool.end();
    
    if (successCount > 0) {
      console.log('\n✅ ACH Case 編號更新完成！');
    }
    
  } catch (error) {
    console.error('❌ 批量更新失敗:', error.message);
  }
}

// 檢查特定發票的 ACH 資訊
async function checkInvoiceAch(invoiceNumber) {
  try {
    const pool = getPool();
    
    const { rows } = await pool.query(
      `SELECT 
        id, 
        store_name,
        amount,
        ach_case_no,
        odoo_invoice_id,
        status,
        TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI') as created_time
       FROM ach_records 
       WHERE odoo_invoice_id = $1`,
      [invoiceNumber]
    );
    
    if (rows.length === 0) {
      console.log(`❌ 找不到 ${invoiceNumber} 的 ACH 記錄`);
    } else {
      console.log(`📋 ${invoiceNumber} 的 ACH 資訊:`);
      rows.forEach((row, i) => {
        console.log(`記錄 ${i + 1}:`);
        console.log(`  - ID: ${row.id}`);
        console.log(`  - 門市: ${row.store_name}`);
        console.log(`  - 金額: ${row.amount}`);
        console.log(`  - ACH Case No: ${row.ach_case_no || 'NULL'}`);
        console.log(`  - 狀態: ${row.status}`);
        console.log(`  - 建立時間: ${row.created_time}`);
        console.log('');
      });
    }
    
    await pool.end();
    
  } catch (error) {
    console.error('❌ 檢查失敗:', error.message);
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args[0] === '--check' && args[1]) {
    // 檢查特定發票
    await checkInvoiceAch(args[1]);
  } else if (args[0] === '--dry-run') {
    // 乾跑模式 - 只查看不更新
    console.log('🔍 乾跑模式 - 檢查所有發票的 ACH 記錄狀態\n');
    
    const pool = getPool();
    for (const mapping of ACH_CASE_MAPPINGS) {
      const { rows } = await pool.query(
        'SELECT id, ach_case_no FROM ach_records WHERE odoo_invoice_id = $1',
        [mapping.invoice]
      );
      
      if (rows.length > 0) {
        const current = rows[0].ach_case_no || 'NULL';
        const status = current === mapping.ach_case_no ? '✅ 已正確' : '🔄 需更新';
        console.log(`${status} ${mapping.invoice}: ${current} → ${mapping.ach_case_no}`);
      } else {
        console.log(`❌ 找不到 ${mapping.invoice}`);
      }
    }
    await pool.end();
  } else {
    // 執行批量更新
    await updateAchCaseNumbers();
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { updateAchCaseNumbers, checkInvoiceAch };