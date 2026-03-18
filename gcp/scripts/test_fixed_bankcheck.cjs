#!/usr/bin/env node
/**
 * 直接測試修正版 bankCheck（也處理失敗檔）
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ host: '/tmp', database: 'paomao', user: 'paopaomao' });

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_ROBBY_CHAT = '7956245081';

async function sendTg(chatId, text) {
  if (!TG_BOT_TOKEN) { console.log(`[TG skip] ${chatId}: ${text}`); return; }
  await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(e => console.error('[TG error]', e.message));
}

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
    
    return { amount, pin, accountArea };
  } catch (e) {
    return null;
  }
}

async function bankCheckFixed() {
  console.log('=== Phase 3A: 永豐銀行自動查帳 (修正版) ===');
  
  // 解析已下載的 ACH 回覆檔 - 包括成功檔和失敗檔
  const downloadDir = path.join(process.env.HOME, 'Downloads');
  
  // 成功檔
  const achFiles = fs.readdirSync(downloadDir)
    .filter(f => f.match(/^94256530_NEP01_M_\d{8}\.TXT$/))
    .sort()
    .reverse();
  
  // 失敗檔
  const failFiles = fs.readdirSync(downloadDir)
    .filter(f => f.match(/^94256530_NEP01_M_\d{8}_F\.TXT$/))
    .sort()
    .reverse();
  
  const allFiles = [...achFiles, ...failFiles];
  
  if (allFiles.length === 0) {
    console.log('  沒有找到 ACH 回覆檔，需先從永豐下載');
    return { parsed: 0 };
  }
  
  console.log(`  找到 ${achFiles.length} 個成功檔 + ${failFiles.length} 個失敗檔`);
  
  const results = [];
  
  for (const file of allFiles.slice(0, 10)) { // 最近 10 個檔
    const content = fs.readFileSync(path.join(downloadDir, file), 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l.startsWith('RSD') || l.startsWith('NSD'));
    
    for (const line of lines) {
      const record = parseAchReplyLine(line);
      if (record) {
        results.push({ 
          ...record, 
          sourceFile: file, 
          isFailure: file.includes('_F.TXT')
        });
      }
    }
  }
  
  console.log(`  解析到 ${results.length} 筆扣款記錄`);
  
  // 比對 DB 的 ACH 紀錄，標記已入帳
  let matched = 0;
  let failures = 0;
  
  for (const r of results) {
    // 用身分證/統編 + 金額比對：找已 Robby 放行但尚未確認的紀錄
    const { rows } = await pool.query(`
      SELECT ar.id, ar.sheet_row, ar.amount, ar.ach_released, ar.ach_confirmed, p.id_number, ar.created_at
      FROM ach_records ar
      LEFT JOIN payees p ON ar.payee_id = p.id
      WHERE p.id_number = $1 AND ar.amount IS NOT NULL
        AND ar.ach_released IS NOT NULL AND ar.ach_released != ''
        AND (ar.ach_confirmed IS NULL OR ar.ach_confirmed = '' OR ar.ach_confirmed = 'FALSE')
    `, [r.pin]);
    
    for (const dbRow of rows) {
      const dbAmount = Math.abs(parseAmount(dbRow.amount));
      if (Math.abs(dbAmount - r.amount) < 1) { // 金額差 < $1
        const ts = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        
        if (r.isFailure) {
          // 失敗檔：標記為失敗
          const failValue = `FAIL ${new Date().toISOString().slice(5, 16)}`;
          await pool.query(`UPDATE ach_records SET ach_confirmed = $1 WHERE id = $2`, [failValue, dbRow.id]);
          failures++;
          console.log(`    ❌ 失敗: PIN=${r.pin} $${r.amount} → DB ID=${dbRow.id}`);
        } else {
          // 成功檔：標記為成功
          const successValue = `OK ${new Date().toISOString().slice(5, 16)}`;
          await pool.query(`UPDATE ach_records SET ach_confirmed = $1 WHERE id = $2`, [successValue, dbRow.id]);
          matched++;
          console.log(`    ✅ 成功: PIN=${r.pin} $${r.amount} → DB ID=${dbRow.id}`);
        }
        break;
      }
    }
  }
  
  console.log(`  完成：${matched} 筆已比對入帳，${failures} 筆失敗`);
  
  // 發送失敗通知
  if (failures > 0) {
    const failList = results.filter(r => r.isFailure).map(f => `  ⚠️ ${f.pin} $${f.amount}`).join('\n');
    await sendTg(TG_ROBBY_CHAT, `❌ ACH 扣款失敗 ${failures} 筆:\n${failList}`);
  }
  
  return { parsed: results.length, matched, failures };
}

// 直接執行測試
bankCheckFixed().then(result => {
  console.log('\n=== 修正版結果 ===');
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}).catch(e => {
  console.error('錯誤:', e.message);
  process.exit(1);
}).finally(() => {
  pool.end();
});