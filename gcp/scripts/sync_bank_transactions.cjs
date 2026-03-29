#!/usr/bin/env node
/**
 * sync_bank_transactions.cjs
 * 每天 09:30, 15:30 拉永豐 686 + 666 交易明細存 DB
 * 
 * Usage: node sync_bank_transactions.cjs [--date 2026-03-20]
 */

const { execSync } = require('child_process');
const { Pool } = require('pg');

const SINOPAC_SCRIPT = '/Users/paopaomao/paomao-gcp/gcp/scripts/sinopac_transfer.cjs';
const NODE_BIN = '/opt/homebrew/bin/node';
const ACCOUNTS = ['686', '666'];
const ACCOUNT_NUMBERS = { '686': '19201800238686', '666': '19201800234666' };

const pool = new Pool({
  user: 'paopaomao',
  database: 'paomao',
  host: '/tmp',
});

function parseAmount(raw) {
  if (!raw) return 0;
  return parseFloat(raw.replace(/,/g, '').replace(/\s/g, '')) || 0;
}

async function syncAccount(account, date) {
  console.log(`[sync] 查詢 ${account} 帳戶，日期 ${date}...`);
  
  let result;
  try {
    const output = execSync(
      `"${NODE_BIN}" "${SINOPAC_SCRIPT}" query --account ${account} --date ${date}`,
      {
        timeout: 120000,
        encoding: 'utf8',
        shell: '/bin/zsh',
        env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
      }
    );
    
    // Parse JSON from last line (script outputs logs then JSON)
    const lines = output.trim().split('\n');
    const jsonLine = lines[lines.length - 1];
    result = JSON.parse(jsonLine);
  } catch (e) {
    console.error(`[sync] ${account} 查詢失敗:`, e.message?.substring(0, 200));
    return { account, success: false, error: e.message?.substring(0, 200) };
  }
  
  if (!result.transactions || result.transactions.length === 0) {
    console.log(`[sync] ${account} 無交易紀錄`);
    return { account, success: true, inserted: 0, skipped: 0 };
  }
  
  console.log(`[sync] ${account} 取得 ${result.transactions.length} 筆交易`);
  
  let inserted = 0, skipped = 0;
  for (const tx of result.transactions) {
    const amt = parseAmount(tx.amount);
    const bal = parseAmount(tx.balance);
    // 判斷借/貸：description 含 "轉出"/"付款" 等 → debit，否則 credit
    // 簡單判斷：如果 amount 含負號或 description 暗示支出
    const isDebit = tx.description?.includes('轉出') || tx.description?.includes('付款') || amt < 0;
    
    try {
      await pool.query(
        `INSERT INTO bank_transactions (account, account_number, tx_date, description, debit, credit, balance, raw_amount, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (account, tx_date, description, raw_amount) DO NOTHING`,
        [
          account,
          ACCOUNT_NUMBERS[account],
          date,
          tx.description || '',
          isDebit ? Math.abs(amt) : 0,
          isDebit ? 0 : Math.abs(amt),
          bal,
          tx.amount || '',
        ]
      );
      inserted++;
    } catch (e) {
      if (e.code === '23505') { skipped++; } // duplicate
      else console.error(`[sync] insert error:`, e.message);
    }
  }
  
  console.log(`[sync] ${account}: ${inserted} 筆新增, ${skipped} 筆重複跳過`);
  return { account, success: true, inserted, skipped };
}

async function main() {
  const args = process.argv.slice(2);
  let date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }); // YYYY-MM-DD
  
  const dateIdx = args.indexOf('--date');
  if (dateIdx >= 0 && args[dateIdx + 1]) {
    date = args[dateIdx + 1];
  }
  
  console.log(`[sync] === 永豐交易同步 === ${date}`);
  
  const results = [];
  for (const account of ACCOUNTS) {
    const r = await syncAccount(account, date);
    results.push(r);
  }
  
  await pool.end();
  
  console.log(`\n[sync] === 完成 ===`);
  results.forEach(r => {
    if (r.success) {
      console.log(`  ${r.account}: ${r.inserted} 筆新增`);
    } else {
      console.log(`  ${r.account}: ❌ ${r.error}`);
    }
  });
  
  console.log(JSON.stringify({ success: true, date, results }));
}

main().catch(e => {
  console.error('[sync] fatal:', e.message);
  console.log(JSON.stringify({ success: false, error: e.message }));
  process.exit(1);
});
