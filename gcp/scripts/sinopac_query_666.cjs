#!/usr/bin/env node
/**
 * 永豐寰宇金融網 — 查詢帳戶交易明細
 * 輸出 JSON 格式的交易列表（存入/支出）
 *
 * Usage:
 *   node sinopac_query_666.cjs [options]
 *
 * Options:
 *   --date <YYYY/MM/DD>        查單日（起訖同天）
 *   --start-date <YYYY/MM/DD>  區間起始日
 *   --end-date <YYYY/MM/DD>    區間結束日（預設今天）
 *   --days <N>                 查最近 N 天（預設 7，與 --date 互斥）
 *   --account <666|686>        帳戶（預設 666）
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

function formatDate(d) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

function todayStr() {
  const now = new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now).replace(/-/g, '/');
}

function dateOffset(baseStr, offsetDays) {
  // baseStr = "YYYY/MM/DD"
  const parts = baseStr.split('/');
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  d.setDate(d.getDate() + offsetDays);
  return formatDate(d);
}

async function main() {
  const args = process.argv.slice(2);
  let singleDate = null;
  let startDate = null;
  let endDate = null;
  let days = null;
  let accountKey = '666';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) singleDate = args[++i];
    else if (args[i] === '--start-date' && args[i + 1]) startDate = args[++i];
    else if (args[i] === '--end-date' && args[i + 1]) endDate = args[++i];
    else if (args[i] === '--days' && args[i + 1]) days = parseInt(args[++i]);
    else if (args[i] === '--account' && args[i + 1]) accountKey = args[++i];
  }

  const accountNum = ACCOUNT_MAP[accountKey] || accountKey;

  // 決定查詢區間
  if (singleDate) {
    // 向下相容：--date 查單日
    startDate = singleDate;
    endDate = singleDate;
  } else if (startDate) {
    endDate = endDate || todayStr();
  } else {
    // 預設查最近 N 天
    const n = days || 7;
    endDate = todayStr();
    startDate = dateOffset(endDate, -(n - 1));
  }

  console.error(`[${accountKey}] 查詢區間: ${startDate} ~ ${endDate}`);

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

    // Set date range（起始日 + 結束日）
    await mainFrame.evaluate((sd, ed) => {
      const s = document.getElementById('form:queryDateStart_input');
      const e = document.getElementById('form:queryDateEnd_input');
      if (s) { s.value = sd; s.dispatchEvent(new Event('change', { bubbles: true })); }
      if (e) { e.value = ed; e.dispatchEvent(new Event('change', { bubbles: true })); }
    }, startDate, endDate);
    await delay(500);

    // Click 查詢
    await mainFrame.evaluate(() => {
      for (const btn of document.querySelectorAll('button')) {
        if (btn.textContent.trim() === '查詢') { btn.click(); return; }
      }
    });
    console.error(`[${accountKey}] 查詢中...`);
    await delay(8000);

    // ─── 分頁抓取所有交易 ───
    let allTransactions = [];
    let pageNum = 1;
    const MAX_PAGES = 50;

    // 抓取當前頁面資料的函式
    const scrapeCurrentPage = async () => {
      return await mainFrame.evaluate((targetAcct) => {
        const rows = [];
        // PrimeFaces DataGrid / DataTable — 嘗試多種 selector
        const selectors = [
          '[id$="DetailDataGrid_data"] tr',
          '.ui-datatable-data tr',
          'table tbody tr',
        ];
        let trs = [];
        for (const sel of selectors) {
          trs = document.querySelectorAll(sel);
          if (trs.length > 0) break;
        }
        for (const tr of trs) {
          const tds = tr.querySelectorAll('td');
          if (tds.length < 8) continue;
          // 跳過「無資料」提示行
          if (tds.length === 1 && tds[0].colSpan > 1) continue;
          const texts = Array.from(tds).map(td => td.textContent.trim());
          const account = texts[0] || '';
          const txDate = texts[1] || '';
          const debit = texts[4] || '';
          const credit = texts[5] || '';
          const balance = texts[6] || '';
          const refNo = texts[8] || '';
          const memo = texts[9] || '';

          if (account.includes(targetAcct)) {
            rows.push({ date: txDate, debit: debit.replace(/,/g, ''), credit: credit.replace(/,/g, ''), balance, ref: refNo, memo });
          }
        }
        return rows;
      }, accountNum);
    };

    // 等待頁面資料載入完成
    const waitForTableReady = async (expectedChange = false) => {
      // 策略 1: 等 PrimeFaces AJAX 完成（blockUI 消失）
      try {
        await mainFrame.waitForFunction(() => {
          // PrimeFaces blockUI overlay
          const blocks = document.querySelectorAll('.ui-blockui, .ui-blockui-content');
          for (const b of blocks) {
            if (b.offsetParent !== null && b.style.display !== 'none') return false;
          }
          // PrimeFaces AJAX status
          const ajaxStatus = document.querySelector('.ui-ajax-loader, [id$="ajaxStatusPanel"]');
          if (ajaxStatus && ajaxStatus.offsetParent !== null) return false;
          return true;
        }, { timeout: 15000 });
      } catch (_) {}
      // 策略 2: 額外等一下讓 DOM 穩定
      await delay(2000);
    };

    while (pageNum <= MAX_PAGES) {
      await waitForTableReady();
      const transactions = await scrapeCurrentPage();

      if (transactions.length === 0 && pageNum === 1) {
        console.error(`[${accountKey}] 查無交易紀錄`);
        break;
      }

      // 防重複：用 date+debit+credit+memo 作為 key 去重
      const existingKeys = new Set(allTransactions.map(t => `${t.date}|${t.debit}|${t.credit}|${t.memo}`));
      let newCount = 0;
      for (const t of transactions) {
        const key = `${t.date}|${t.debit}|${t.credit}|${t.memo}`;
        if (!existingKeys.has(key)) {
          allTransactions.push(t);
          existingKeys.add(key);
          newCount++;
        }
      }
      console.error(`[${accountKey}] 第 ${pageNum} 頁: ${transactions.length} 筆 (新增 ${newCount})`);

      // 如果翻頁但抓到的全是重複資料 → 可能是翻頁失敗
      if (pageNum > 1 && newCount === 0) {
        console.error(`[${accountKey}] 第 ${pageNum} 頁全重複，停止`);
        break;
      }

      // 檢查下一頁按鈕（PrimeFaces paginator）
      const paginatorInfo = await mainFrame.evaluate(() => {
        // 找到 paginator 的頁碼資訊
        const pageReport = document.querySelector('.ui-paginator-current, [class*="paginator-current"]');
        const nextBtn = document.querySelector('.ui-paginator-next:not(.ui-state-disabled)');
        return {
          hasNext: !!nextBtn,
          pageReport: pageReport?.textContent?.trim() || '',
        };
      });

      if (!paginatorInfo.hasNext) {
        if (paginatorInfo.pageReport) {
          console.error(`[${accountKey}] 分頁: ${paginatorInfo.pageReport}`);
        }
        break;
      }

      // 記住翻頁前的第一筆資料，用來偵測頁面是否真的換了
      const firstRowBefore = transactions[0]?.date + '|' + transactions[0]?.memo;

      // 點擊下一頁
      await mainFrame.evaluate(() => {
        const nextBtn = document.querySelector('.ui-paginator-next:not(.ui-state-disabled)');
        if (nextBtn) nextBtn.click();
      });
      pageNum++;

      // 等待頁面切換：偵測第一筆資料有變化
      await delay(1500);
      let retries = 0;
      while (retries < 5) {
        await waitForTableReady(true);
        const newFirstRow = await mainFrame.evaluate((targetAcct) => {
          const trs = document.querySelectorAll('[id$="DetailDataGrid_data"] tr, .ui-datatable-data tr, table tbody tr');
          for (const tr of trs) {
            const tds = tr.querySelectorAll('td');
            if (tds.length < 8) continue;
            const texts = Array.from(tds).map(td => td.textContent.trim());
            if (texts[0]?.includes(targetAcct)) return texts[1] + '|' + (texts[9] || '');
          }
          return '';
        }, accountNum);

        if (newFirstRow && newFirstRow !== firstRowBefore) break; // 頁面已切換
        retries++;
        await delay(2000);
        console.error(`[${accountKey}] 等待第 ${pageNum} 頁載入... (retry ${retries})`);
      }
    }

    if (pageNum >= MAX_PAGES) {
      console.error(`[${accountKey}] ⚠️ 達到分頁上限 ${MAX_PAGES}，可能有遺漏`);
    }

    // 分類：存入 vs 支出
    const deposits = allTransactions
      .filter(t => t.credit && parseFloat(t.credit) > 0)
      .map(d => ({ date: d.date, amount: parseFloat(d.credit), memo: d.memo, ref: d.ref }));

    const withdrawals = allTransactions
      .filter(t => t.debit && parseFloat(t.debit) > 0)
      .map(w => ({ date: w.date, amount: parseFloat(w.debit), memo: w.memo }));

    // 輸出 JSON
    console.log(JSON.stringify({
      success: true,
      startDate,
      endDate,
      pages: pageNum,
      total: allTransactions.length,
      deposits,
      withdrawals,
    }));
  } finally {
    browser.disconnect();
  }
}

main().catch(e => {
  console.log(JSON.stringify({ success: false, error: e.message }));
  process.exit(1);
});
