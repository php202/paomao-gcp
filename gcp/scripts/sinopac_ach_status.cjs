#!/usr/bin/env node
/**
 * 永豐 ACH 結果查詢 — 從 ACH結果回覆檔案下載 頁面抓取案件狀態
 * 
 * Usage:
 *   node sinopac_ach_status.cjs                  # 今天
 *   node sinopac_ach_status.cjs --date 20260316  # 指定日期
 *
 * Output: JSON to stdout
 *   { success: true, cases: [
 *     { caseNo: "260316020819346", fileName: "...", status: "處理完成", amount: 8000 },
 *     ...
 *   ]}
 */

const puppeteer = require('puppeteer-core');
const delay = ms => new Promise(r => setTimeout(r, ms));
const CDP_PORT = parseInt(process.env.SINOPAC_CDP_PORT || '18800');

async function main() {
  const args = process.argv.slice(2);
  let targetDate = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) targetDate = args[++i];
  }
  if (!targetDate) {
    const now = new Date();
    targetDate = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).replace(/-/g, '');
  }

  const dateStr = `${targetDate.slice(0,4)}/${targetDate.slice(4,6)}/${targetDate.slice(6,8)}`;

  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const { webSocketDebuggerUrl } = await res.json();
  const browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl, defaultViewport: null });

  try {
    const pages = await browser.pages();
    const page = pages.find(p => p.url().includes('sinopac'));
    if (!page) throw new Error('找不到永豐頁面');

    const indexFrame = page.frames().find(f => f.name() === 'indexFrame');
    if (!indexFrame) throw new Error('找不到 indexFrame');

    // Verify logged in
    const pageCheck = await indexFrame.evaluate(() => document.body?.innerText?.substring(0, 200));
    if (pageCheck?.includes('登入資料') || pageCheck?.includes('圖形驗證碼') || pageCheck?.includes('瀏覽器使用中')) {
      throw new Error('永豐未登入，請先登入');
    }

    // Navigate to ACH結果回覆檔案下載
    console.error('[ach-status] 導航到 ACH 結果回覆...');
    await indexFrame.evaluate(() => {
      const menu = document.getElementById('MENU_CTWACTXQU');
      if (menu) menu.click();
    });
    await delay(5000);

    const mainFrame = page.frames().find(f => f.name() === 'mainFrame');
    if (!mainFrame) throw new Error('找不到 mainFrame');

    // Set date range
    await mainFrame.evaluate((d) => {
      const inputs = document.querySelectorAll('input[id*="Date"], input[id*="date"], input[id*="txDate"]');
      for (const input of inputs) {
        input.value = d;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, dateStr);
    await delay(1000);

    // Click 查詢
    await mainFrame.evaluate(() => {
      for (const btn of document.querySelectorAll('button')) {
        if (btn.textContent?.includes('查詢')) { btn.click(); return; }
      }
    });
    await delay(5000);

    // Parse table
    const cases = await mainFrame.evaluate(() => {
      const rows = document.querySelectorAll('tr');
      const results = [];
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 10) {
          const caseNo = cells[1]?.textContent?.trim();
          const origFile = cells[2]?.textContent?.trim();
          const sysFile = cells[3]?.textContent?.trim();
          const releaseTime = cells[4]?.textContent?.trim();
          const txType = cells[5]?.textContent?.trim();
          const submitDate = cells[7]?.textContent?.trim();
          const amountText = cells[8]?.textContent?.trim();
          const status = cells[9]?.textContent?.trim();
          
          if (caseNo && caseNo.match(/^\d{15,}/)) {
            // Parse amount: "18,000" → 8000 (divided by ? - check the actual value)
            const amount = parseInt((amountText || '').replace(/,/g, ''), 10) || 0;
            results.push({
              caseNo, origFile, sysFile, releaseTime, txType, submitDate,
              amountRaw: amountText, amount, status
            });
          }
        }
      });
      return results;
    });

    console.error(`[ach-status] ${dateStr}: ${cases.length} 筆`);

    // Close/navigate away to avoid page stacking
    try {
      await mainFrame.evaluate(() => {
        // Click X or 回功能首頁 to close
        for (const el of document.querySelectorAll('a, button')) {
          const text = (el.textContent || '').trim();
          if (text === '回功能首頁' || text === '✕' || text === '×') { el.click(); return; }
        }
        // Click close icon if exists
        for (const el of document.querySelectorAll('.ui-dialog-titlebar-close, [aria-label="Close"]')) {
          el.click(); return;
        }
      });
    } catch (_) {}
    
    console.log(JSON.stringify({ success: true, date: targetDate, cases }));

  } finally {
    browser.disconnect();
  }
}

main().catch(e => {
  console.log(JSON.stringify({ success: false, error: e.message }));
  process.exit(1);
});
