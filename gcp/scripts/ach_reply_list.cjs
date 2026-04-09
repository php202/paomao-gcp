#!/usr/bin/env node
/**
 * ach_reply_list.cjs — 從永豐 ACH 回覆檔列表抓案件編號+狀態，存入 ach_reply_cache
 * 不下載 TXT，只讀列表，秒完成。
 * 
 * Usage:
 *   node ach_reply_list.cjs                    # 查最近 7 天
 *   node ach_reply_list.cjs --days 14          # 查最近 14 天
 *   node ach_reply_list.cjs --date 20260401    # 指定起始日
 */
'use strict';

const puppeteer = require('puppeteer-core');
const { Pool } = require('pg');
const pool = new Pool({ database: 'paomao', host: 'localhost', port: 5432, max: 2 });

const CDP_URL = 'http://127.0.0.1:18800';

function todayStr() {
  const d = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()));
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

async function main() {
  const args = process.argv.slice(2);
  let startDate, endDate;
  
  if (args.includes('--date')) {
    const d = args[args.indexOf('--date') + 1];
    startDate = `${d.slice(0,4)}/${d.slice(4,6)}/${d.slice(6,8)}`;
  } else {
    const days = args.includes('--days') ? parseInt(args[args.indexOf('--days') + 1]) : 7;
    const today = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()));
    const start = new Date(today); start.setDate(start.getDate() - days);
    startDate = `${start.getFullYear()}/${String(start.getMonth()+1).padStart(2,'0')}/${String(start.getDate()).padStart(2,'0')}`;
  }
  endDate = todayStr();
  
  console.error(`[ach-reply-list] 查詢區間: ${startDate} ~ ${endDate}`);

  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes('b2b.sinopac.com')) || pages[0];
  
  // Navigate to ACH 結果回覆
  await page.goto('https://b2b.sinopac.com/B2B/faces/cac/ctwactxqu/CTWACTXQU_1.xhtml', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));
  
  const frames = page.frames();
  const mainFrame = frames.find(f => f.url().includes('CTWACTXQU')) || page.mainFrame();
  
  // Set date range
  await mainFrame.evaluate((startD, endD) => {
    const inputs = document.querySelectorAll('input[id*="Date"], input[id*="date"], input[id*="txDate"]');
    const dateInputs = Array.from(inputs).filter(i => i.type === 'text' || i.type === '');
    if (dateInputs.length >= 2) {
      dateInputs[0].value = startD;
      dateInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
      dateInputs[1].value = endD;
      dateInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, startDate, endDate);
  
  // Click query button
  await mainFrame.evaluate(() => {
    for (const btn of document.querySelectorAll('button')) {
      if ((btn.textContent || '').trim() === '查詢') { btn.click(); return; }
    }
  });
  await new Promise(r => setTimeout(r, 3000));
  
  // Set 35 per page if possible
  await mainFrame.evaluate(() => {
    const sel = document.querySelector('select[id*="pageSize"], select[id*="perPage"]');
    if (sel) { sel.value = '35'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await new Promise(r => setTimeout(r, 2000));
  
  // Parse table rows — 抓所有案件的資料
  const records = await mainFrame.evaluate(() => {
    const rows = [];
    const table = document.querySelector('table[role="grid"], table.ui-datatable-data')
      || document.querySelector('tbody[id*="data"]')
      || document.querySelector('table tbody');
    if (!table) return rows;
    
    for (const tr of table.querySelectorAll('tr')) {
      const cells = tr.querySelectorAll('td');
      if (cells.length < 8) continue;
      const caseNo = (cells[1]?.textContent || '').trim();
      const fileName = (cells[2]?.textContent || '').trim();
      const txTime = (cells[4]?.textContent || '').trim();
      const txType = (cells[5]?.textContent || '').trim();
      const submitDate = (cells[7]?.textContent || '').trim();
      const totalCount = (cells[8]?.textContent || '').trim();
      
      // 狀態在最後幾個 cell
      let status = '';
      for (let i = cells.length - 1; i >= 0; i--) {
        const t = (cells[i]?.textContent || '').trim();
        if (t === '處理完成' || t === '交易失敗' || t === '銀行處理中' || t === '預約取消') {
          status = t;
          break;
        }
      }
      
      if (caseNo && caseNo.match(/^\d{15}/)) {
        rows.push({ caseNo, fileName, txTime, txType, submitDate, totalCount, status });
      }
    }
    return rows;
  });
  
  console.error(`[ach-reply-list] 找到 ${records.length} 筆案件`);
  
  // Store to DB
  let inserted = 0;
  for (const r of records) {
    const isSuccess = r.status === '處理完成';
    const status = isSuccess ? 'R' : 'N';
    const replyDate = r.submitDate ? r.submitDate.replace(/\//g, '') : '';
    
    try {
      await pool.query(
        `INSERT INTO ach_reply_cache (case_no, status, amount, pin, seq, reply_date, raw_line)
         VALUES ($1, $2, 0, '', 0, $3, $4)
         ON CONFLICT (case_no, seq, amount) DO UPDATE SET status = $2, raw_line = $4, fetched_at = NOW()`,
        [r.caseNo, status, replyDate, `${r.status}|${r.fileName}|${r.txTime}|count=${r.totalCount}`]
      );
      inserted++;
    } catch (e) {
      // Unique constraint — try with different seq
      try {
        const seq = inserted + 1;
        await pool.query(
          `INSERT INTO ach_reply_cache (case_no, status, amount, pin, seq, reply_date, raw_line)
           VALUES ($1, $2, 0, '', $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [r.caseNo, status, seq, replyDate, `${r.status}|${r.fileName}|${r.txTime}`]
        );
        inserted++;
      } catch (_) {}
    }
  }
  
  console.error(`[ach-reply-list] 存入 ${inserted} 筆`);
  console.log(JSON.stringify({ success: true, total: records.length, inserted, records }));
  
  await pool.end();
}

main().catch(e => {
  console.error('[ach-reply-list] Error:', e.message);
  console.log(JSON.stringify({ success: false, error: e.message }));
  process.exit(1);
});
