#!/usr/bin/env node
/**
 * 永豐寰宇金融網 — 查詢帳戶交易明細
 * 輸出 JSON 格式的存入交易列表
 *
 * Usage:
 *   node sinopac_query_666.cjs [--date 2026/03/13] [--account 666|686]
 *
 * 需要 Chrome 已登入（用 sinopac_ach_full.cjs --login-only 登入）
 */

const puppeteer = require('puppeteer-core');
const delay = ms => new Promise(r => setTimeout(r, ms));
const DEBUG_PORT = parseInt(process.env.SINOPAC_CDP_PORT || '18800');

const ACCOUNT_MAP = {
  '666': '234666',
  '686': '238686',
};

async function main() {
  const args = process.argv.slice(2);
  let queryDate = null;
  let accountKey = '666'; // default
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) queryDate = args[++i];
    if (args[i] === '--account' && args[i + 1]) accountKey = args[++i];
  }
  const accountNum = ACCOUNT_MAP[accountKey] || accountKey; // allow raw account number too

  // Default: today
  if (!queryDate) {
    const now = new Date();
    const tz = 'Asia/Taipei';
    queryDate = now.toLocaleDateString('en-CA', { timeZone: tz }).replace(/-/g, '/');
  }

  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  const { webSocketDebuggerUrl } = await res.json();
  const browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl, defaultViewport: null });

  try {
    const pages = await browser.pages();
    const page = pages.find(p => p.url().includes('sinopac'));
    if (!page) throw new Error('找不到永豐頁面');

    const indexFrame = page.frames().find(f => f.name() === 'indexFrame');
    if (!indexFrame) throw new Error('找不到 indexFrame，請先登入');

    // Navigate: 帳戶查詢 > 交易明細查詢
    await indexFrame.evaluate(() => document.getElementById('MENU_CTWDATXQU').click());
    console.error(`[${accountKey}] 導航到交易明細查詢`);
    await delay(5000);

    const mainFrame = page.frames().find(f => f.name() === 'mainFrame');
    if (!mainFrame) throw new Error('找不到 mainFrame');

    // Select account
    await mainFrame.evaluate(() => {
      const label = document.getElementById('form:accountCombo_label');
      if (label) label.click();
    });
    await delay(1000);

    await mainFrame.evaluate((acctNum) => {
      for (const li of document.querySelectorAll('li')) {
        if (li.textContent.includes(acctNum)) { li.click(); return; }
      }
    }, accountNum);
    await delay(1500);

    // Set date
    await mainFrame.evaluate((d) => {
      const s = document.getElementById('form:queryDateStart_input');
      const e = document.getElementById('form:queryDateEnd_input');
      if (s) { s.value = d; s.dispatchEvent(new Event('change', { bubbles: true })); }
      if (e) { e.value = d; e.dispatchEvent(new Event('change', { bubbles: true })); }
    }, queryDate);
    await delay(500);

    // Click 查詢
    await mainFrame.evaluate(() => {
      for (const btn of document.querySelectorAll('button')) {
        if (btn.textContent.trim() === '查詢') { btn.click(); return; }
      }
    });
    console.error(`[${accountKey}] 查詢中...`);
    await delay(8000);

    // Parse table results (with pagination — loop through all pages)
    let allTransactions = [];
    let pageNum = 1;

    while (true) {
      const transactions = await mainFrame.evaluate((targetAcct) => {
        const rows = [];
        const trs = document.querySelectorAll('table tbody tr, .ui-datatable-data tr');
        for (const tr of trs) {
          const tds = tr.querySelectorAll('td');
          if (tds.length < 8) continue;
          const texts = Array.from(tds).map(td => td.textContent.trim());
          const account = texts[0] || '';
          const txDate = texts[1] || '';
          const debit = texts[4] || '';
          const credit = texts[5] || '';
          const balance = texts[6] || '';
          const refNo = texts[8] || '';
          const memo = texts[9] || '';

          if (account.includes(targetAcct)) {
            rows.push({
              date: txDate,
              debit: debit.replace(/,/g, ''),
              credit: credit.replace(/,/g, ''),
              balance,
              ref: refNo,
              memo,
            });
          }
        }
        return rows;
      }, accountNum);

      allTransactions = allTransactions.concat(transactions);
      console.error(`[${accountKey}] 第 ${pageNum} 頁: ${transactions.length} 筆`);

      // Check for next page button
      const hasNext = await mainFrame.evaluate(() => {
        const nextBtn = document.querySelector('.ui-paginator-next:not(.ui-state-disabled)');
        if (nextBtn) { nextBtn.click(); return true; }
        return false;
      });

      if (!hasNext) break;
      pageNum++;
      await delay(3000);
      if (pageNum > 10) break; // safety limit
    }

    const transactions = allTransactions;

    // Filter to deposits only (credit > 0)
    const deposits = transactions.filter(t => t.credit && parseFloat(t.credit) > 0);

    // Output JSON to stdout
    console.log(JSON.stringify({
      success: true,
      date: queryDate,
      total: transactions.length,
      deposits: deposits.map(d => ({
        date: d.date,
        amount: parseFloat(d.credit),
        memo: d.memo,
        ref: d.ref,
      })),
      withdrawals: transactions.filter(t => t.debit && parseFloat(t.debit) > 0).map(w => ({
        date: w.date,
        amount: parseFloat(w.debit),
        memo: w.memo,
      })),
    }));
  } finally {
    browser.disconnect();
  }
}

main().catch(e => {
  console.log(JSON.stringify({ success: false, error: e.message }));
  process.exit(1);
});
