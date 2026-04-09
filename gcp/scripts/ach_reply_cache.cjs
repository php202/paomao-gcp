#!/usr/bin/env node
/**
 * ach_reply_cache.cjs — 背景下載 ACH 回覆檔，存入 ach_reply_cache 表
 * 
 * Usage:
 *   node ach_reply_cache.cjs                    # 查最近 7 天
 *   node ach_reply_cache.cjs --days 14          # 查最近 14 天
 *   node ach_reply_cache.cjs --date 20260401    # 指定日期
 */
'use strict';

const { execFileSync } = require('child_process');
const { Pool } = require('pg');
const pool = new Pool({ database: 'paomao', host: 'localhost', port: 5432, max: 2 });

function todayStr() {
  const d = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()));
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

async function main() {
  const args = process.argv.slice(2);
  let dates = [];
  
  if (args.includes('--date')) {
    const idx = args.indexOf('--date');
    dates = [args[idx + 1]];
  } else {
    const days = args.includes('--days') ? parseInt(args[args.indexOf('--days') + 1]) : 7;
    const today = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()));
    // Generate dates in 5-day steps covering the range
    for (let i = days; i >= 0; i -= 5) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const ds = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
      dates.push(ds);
    }
    dates = [...new Set(dates)].sort();
  }

  console.log(`[ach-reply-cache] 查詢 ${dates.length} 批: ${dates.join(', ')}`);
  
  let totalNew = 0;
  for (const achDate of dates) {
    try {
      console.log(`[ach-reply-cache] 下載 ${achDate}...`);
      const output = execFileSync('/opt/homebrew/bin/node', [
        '/Users/paopaomao/paomao-gcp/gcp/scripts/sinopac_ach_reply.cjs',
        '--date', achDate
      ], { 
        timeout: 300000, // 5 min per batch
        encoding: 'utf8',
        cwd: '/Users/paopaomao/paomao-gcp/gcp/scripts',
        env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/Users/paopaomao' }
      });
      
      const lines = output.trim().split('\n');
      let data = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try { data = JSON.parse(lines[i]); break; } catch (_) {}
      }
      
      if (!data?.success) {
        console.log(`[ach-reply-cache] ${achDate} 查詢失敗: ${data?.error || '無回應'}`);
        continue;
      }
      
      if (!data.records?.length) {
        console.log(`[ach-reply-cache] ${achDate} 無紀錄`);
        continue;
      }

      // 需要 caseNo — 從 data.caseNos 或逐筆歸屬
      // sinopac_ach_reply.cjs 的 JSON 裡有 caseNos 嗎？
      const caseNo = data.caseNo || data.date || achDate;
      
      let inserted = 0;
      for (const r of data.records) {
        try {
          await pool.query(
            `INSERT INTO ach_reply_cache (case_no, status, amount, pin, seq, reply_date, raw_line)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (case_no, seq, amount) DO NOTHING`,
            [caseNo, r.status, r.amount, r.pin || r.payeeCode, r.seq, achDate, r.raw || '']
          );
          inserted++;
        } catch (dbErr) {
          if (!dbErr.message.includes('duplicate')) {
            console.error(`[ach-reply-cache] DB error: ${dbErr.message.slice(0, 100)}`);
          }
        }
      }
      console.log(`[ach-reply-cache] ${achDate}: ${data.records.length} 筆, ${inserted} 新增`);
      totalNew += inserted;
    } catch (err) {
      console.error(`[ach-reply-cache] ${achDate} 失敗: ${err.message?.slice(0, 100)}`);
    }
  }
  
  console.log(`[ach-reply-cache] 完成, 共新增 ${totalNew} 筆`);
  console.log(JSON.stringify({ success: true, totalNew }));
  await pool.end();
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
