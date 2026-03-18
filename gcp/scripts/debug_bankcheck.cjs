#!/usr/bin/env node
/**
 * Debug version of bankCheck - 詳細記錄比對過程
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ host: '/tmp', database: 'paomao', user: 'paopaomao' });

function parseAmount(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[＄$,，\s]/g, '');
  return parseFloat(s) || 0;
}

function parseAchReplyLine(line) {
  if (line.length < 100) return null;
  try {
    const bIdx = line.indexOf('B94256530');
    if (bIdx < 0) return null;
    
    const amountStr = line.substring(bIdx - 10, bIdx);
    const amount = parseInt(amountStr, 10) / 100;
    
    const afterB = line.substring(bIdx + 11).trim();
    const pin = afterB.split(/\s/)[0].trim();
    
    const accountArea = line.substring(14, bIdx - 10);
    
    return { amount, pin, accountArea, rawLine: line };
  } catch (e) {
    return null;
  }
}

(async () => {
  console.log('=== Debug bankCheck ===');
  
  // 1. 檢查下載目錄的檔案
  const downloadDir = path.join(process.env.HOME, 'Downloads');
  const achFiles = fs.readdirSync(downloadDir)
    .filter(f => f.match(/^94256530_NEP01_M_\d{8}\.TXT$/))
    .sort()
    .reverse();
  
  console.log(`找到 ${achFiles.length} 個 ACH 回覆檔:`);
  achFiles.forEach(f => console.log(`  ${f}`));
  
  if (achFiles.length === 0) {
    console.log('沒有 ACH 檔案，結束');
    process.exit(0);
  }
  
  // 2. 解析檔案內容
  const allResults = [];
  for (const file of achFiles.slice(0, 3)) { // 前 3 個檔案
    console.log(`\n=== 解析 ${file} ===`);
    const content = fs.readFileSync(path.join(downloadDir, file), 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l.startsWith('RSD') || l.startsWith('NSD'));
    
    console.log(`  ${lines.length} 行資料`);
    
    for (const line of lines) {
      const record = parseAchReplyLine(line);
      if (record) {
        allResults.push({ ...record, sourceFile: file });
        console.log(`    PIN: ${record.pin}, 金額: $${record.amount}`);
      }
    }
  }
  
  console.log(`\n總共解析 ${allResults.length} 筆記錄`);
  
  // 3. 檢查 DB 中的待比對記錄
  const { rows: pendingRows } = await pool.query(`
    SELECT ar.id, ar.payee_id, ar.amount, ar.ach_released, ar.ach_confirmed, 
           p.id_number, p.code, p.store_label, ar.created_at
    FROM ach_records ar
    LEFT JOIN payees p ON ar.payee_id = p.id
    WHERE ar.is_active = true 
      AND ar.ach_released IS NOT NULL AND ar.ach_released != ''
      AND (ar.ach_confirmed IS NULL OR ar.ach_confirmed = '' OR ar.ach_confirmed = 'FALSE')
    ORDER BY ar.created_at DESC
    LIMIT 30
  `);
  
  console.log(`\nDB 中有 ${pendingRows.length} 筆待確認記錄:`);
  pendingRows.forEach(row => {
    console.log(`  ID:${row.id} PIN:${row.id_number} 金額:$${row.amount} 店家:${row.store_label}`);
  });
  
  // 4. 逐一比對
  console.log(`\n=== 開始比對 ===`);
  let matched = 0;
  
  for (const bankRecord of allResults) {
    console.log(`\n檢查銀行記錄: PIN=${bankRecord.pin}, 金額=$${bankRecord.amount}`);
    
    // 找相同 PIN 的 DB 記錄
    const matchingRows = pendingRows.filter(row => row.id_number === bankRecord.pin);
    console.log(`  找到 ${matchingRows.length} 筆相同 PIN 的 DB 記錄`);
    
    for (const dbRow of matchingRows) {
      const dbAmount = Math.abs(parseAmount(dbRow.amount));
      const bankAmount = bankRecord.amount;
      const amountDiff = Math.abs(dbAmount - bankAmount);
      
      console.log(`    DB記錄 ID:${dbRow.id} 金額:$${dbAmount} vs 銀行金額:$${bankAmount} 差額:$${amountDiff.toFixed(2)}`);
      
      if (amountDiff < 1) {
        console.log(`    ✅ 匹配！更新記錄 ID:${dbRow.id}`);
        
        const ts = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        const confirmValue = `${ts} 自動比對 (${bankRecord.sourceFile})`;
        
        await pool.query(`UPDATE ach_records SET ach_confirmed = $1 WHERE id = $2`, [confirmValue, dbRow.id]);
        matched++;
        break;
      } else {
        console.log(`    ❌ 金額不匹配`);
      }
    }
    
    if (matchingRows.length === 0) {
      console.log(`    ❌ 找不到相同 PIN 的 DB 記錄`);
    }
  }
  
  console.log(`\n=== 結果 ===`);
  console.log(`解析: ${allResults.length} 筆`);
  console.log(`匹配: ${matched} 筆`);
  
  // 5. 檢查是否有失敗檔
  const failFiles = fs.readdirSync(downloadDir)
    .filter(f => f.match(/^94256530_NEP01_M_\d{8}_F\.TXT$/))
    .sort()
    .reverse()
    .slice(0, 3);
  
  if (failFiles.length > 0) {
    console.log(`\n=== 失敗檔 (${failFiles.length} 個) ===`);
    
    for (const file of failFiles) {
      console.log(`檔案: ${file}`);
      const content = fs.readFileSync(path.join(downloadDir, file), 'utf8');
      const lines = content.split(/\r?\n/).filter(l => l.startsWith('RSD') || l.startsWith('NSD'));
      
      for (const line of lines) {
        const record = parseAchReplyLine(line);
        if (record) {
          console.log(`  失敗: PIN=${record.pin}, 金額=$${record.amount}`);
        }
      }
    }
  }
  
  await pool.end();
})();