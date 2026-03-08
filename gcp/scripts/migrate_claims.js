/**
 * Claims 遷移腳本 - 從 Google Sheet 遷移到 PostgreSQL
 * 使用方式：cd ~/paomao-gcp/gcp && GOOGLE_APPLICATION_CREDENTIALS=~/.openclaw/secrets/gcp-service-account.json node -e "import('./scripts/migrate_claims.js').then(m => m.run())"
 */

import { getAuth } from '../lib/auth.js';
import { readSheet } from '../lib/sheets.js';
import pool from '../lib/db.js';

const SHEET_ID = '17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE';
const SHEET_RANGE = "'2026請款表'!A:V";

/**
 * 清理數值字段 - 移除非數字字符並轉換
 */
function cleanNumeric(value) {
  if (!value || value === '') return null;
  const cleaned = String(value).replace(/[^0-9.-]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * 執行遷移
 */
export async function run() {
  console.log('🚀 開始 Claims 遷移...');
  
  try {
    // 1. 讀取 Google Sheet 資料
    console.log('📊 讀取 Google Sheet 資料...');
    const auth = await getAuth();
    const sheetData = await readSheet(auth, SHEET_ID, SHEET_RANGE);
    
    if (!sheetData || sheetData.length < 2) {
      throw new Error('Google Sheet 資料為空或格式錯誤');
    }
    
    const headers = sheetData[0];
    const rows = sheetData.slice(1);
    
    console.log(`📋 找到 ${rows.length} 筆資料`);
    console.log(`🏷️  表頭：${headers.join(', ')}`);
    
    // 2. 清空現有資料（謹慎操作）
    console.log('🗑️  清空現有 claims 資料...');
    await pool.query('TRUNCATE TABLE claims RESTART IDENTITY');
    
    // 3. 準備批次插入
    console.log('💾 準備寫入 PostgreSQL...');
    
    const insertQuery = `
      INSERT INTO claims (
        year, num, date, requester, confirmed, unit, reason, qty,
        preTax, tax, total, currency, rate, claimAmount, signed,
        plannedPay, payLogged, payId, released, payDate, invoiceOk, odooAP, odooId
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23
      )
    `;
    
    let successCount = 0;
    let errorCount = 0;
    
    // 4. 逐筆處理資料
    for (const [index, row] of rows.entries()) {
      try {
        const values = [
          2026, // year - 固定為 2026
          row[0] || null,  // num
          row[1] || null,  // date
          row[2] || null,  // requester
          row[3] || null,  // confirmed
          row[4] || null,  // unit
          row[5] || null,  // reason
          row[6] || null,  // qty
          cleanNumeric(row[7]),   // preTax
          cleanNumeric(row[8]),   // tax
          cleanNumeric(row[9]),   // total
          row[10] || null, // currency
          cleanNumeric(row[11]),  // rate
          cleanNumeric(row[12]),  // claimAmount
          row[13] || null, // signed
          row[14] || null, // plannedPay
          row[15] || null, // payLogged
          row[16] || null, // payId
          row[17] || null, // released
          row[18] || null, // payDate
          row[19] || null, // invoiceOk
          row[20] || null, // odooAP
          row[21] || null  // odooId
        ];
        
        await pool.query(insertQuery, values);
        successCount++;
        
        // 進度報告
        if ((index + 1) % 10 === 0) {
          console.log(`✅ 已處理 ${index + 1}/${rows.length} 筆`);
        }
        
      } catch (error) {
        errorCount++;
        console.error(`❌ 第 ${index + 1} 筆資料失敗:`, error.message);
        console.error(`   資料: ${JSON.stringify(row.slice(0, 5))}...`);
      }
    }
    
    // 5. 驗證結果
    const countResult = await pool.query('SELECT COUNT(*) as count FROM claims WHERE year = 2026');
    const dbCount = parseInt(countResult.rows[0].count);
    
    console.log('\n📊 遷移結果：');
    console.log(`✅ 成功：${successCount} 筆`);
    console.log(`❌ 失敗：${errorCount} 筆`);
    console.log(`🗃️  資料庫總筆數：${dbCount} 筆`);
    
    if (dbCount === successCount && errorCount === 0) {
      console.log('🎉 遷移完成！所有資料已成功寫入資料庫');
    } else {
      console.log('⚠️  遷移完成但有部分問題，請檢查錯誤訊息');
    }
    
    return {
      success: successCount,
      errors: errorCount,
      dbCount: dbCount
    };
    
  } catch (error) {
    console.error('💥 遷移失敗:', error);
    throw error;
  } finally {
    // 關閉資料庫連線
    await pool.end();
  }
}

// 如果直接執行此腳本
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(console.error);
}