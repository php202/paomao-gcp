#!/usr/bin/env node
/**
 * 永豐寰宇金融網 — 下載並解析 ACH 回覆檔
 * 使用已登入的 Chrome CDP 連線（port 18800）
 *
 * Usage:
 *   node sinopac_ach_reply.cjs                  # 今天
 *   node sinopac_ach_reply.cjs --date 20260316  # 指定日期
 *   node sinopac_ach_reply.cjs --parse-only     # 只解析已下載的檔案
 *
 * Output: JSON to stdout
 *   { success: true, date: "20260316", records: [
 *     { status: "R", amount: 8000, pin: "F126968049", payeeCode: "F126968049", seq: 1 },
 *     ...
 *   ], summary: { total: 5, success: 4, fail: 1 } }
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const delay = ms => new Promise(r => setTimeout(r, ms));
const DEBUG_PORT = parseInt(process.env.SINOPAC_CDP_PORT || '18800');
const DOWNLOAD_DIR = process.env.HOME + '/Downloads';

// ── Parse ACH reply line ──
function parseReplyLine(line) {
  if (!line || line.length < 80) return null;
  const status = line[0]; // R=success, N=fail
  if (status !== 'R' && status !== 'N') return null;

  const bIdx = line.indexOf('B94256530');
  if (bIdx < 0) return null;

  const amountStr = line.substring(bIdx - 10, bIdx);
  const amount = parseInt(amountStr, 10) / 100;

  // PIN (payee_code) is after B94256530 + 2 spaces
  const afterB = line.substring(bIdx + 9).trimStart();
  const pin = afterB.split(/\s+/)[0].trim();

  // Sequence number
  const seq = parseInt(line.substring(6, 14), 10);

  return { status, amount, pin, seq, raw: line.substring(0, 90) };
}

// ── Parse existing reply file ──
function parseReplyFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const records = [];

  for (const line of lines) {
    if (line.startsWith('BOF') || line.startsWith('EOF') || !line.trim()) continue;
    const parsed = parseReplyLine(line);
    if (parsed) records.push(parsed);
  }

  return records;
}

// ── Download reply file via CDP ──
async function downloadReply(targetDate) {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  const { webSocketDebuggerUrl } = await res.json();
  const browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl, defaultViewport: null });

  try {
    const pages = await browser.pages();
    const page = pages.find(p => p.url().includes('sinopac'));
    if (!page) throw new Error('找不到永豐頁面，請先登入');

    const indexFrame = page.frames().find(f => f.name() === 'indexFrame');
    if (!indexFrame) throw new Error('找不到 indexFrame，請先登入');

    // Navigate: 收款服務 → ACH收付款 → ACH結果回覆檔案下載
    console.error('[ach-reply] 導航到 ACH 結果回覆...');
    
    // Click menu by ID: MENU_CTWACTXQU
    await indexFrame.evaluate(() => {
      const menu = document.getElementById('MENU_CTWACTXQU');
      if (menu) { menu.click(); return true; }
      // Fallback by text
      for (const el of document.querySelectorAll('a')) {
        if (el.textContent?.includes('ACH結果回覆檔案下載')) { el.click(); return true; }
      }
      return false;
    });
    await delay(5000);

    const mainFrame = page.frames().find(f => f.name() === 'mainFrame');
    if (!mainFrame) throw new Error('找不到 mainFrame');

    // Debug: log page content
    const pageTitle = await mainFrame.evaluate(() => document.body?.innerText?.substring(0, 100));
    console.error(`[ach-reply] 頁面: ${pageTitle?.substring(0, 60)}`);

    // Set date range: startDate = targetDate, endDate = targetDate + 4 days (or today)
    const startDateStr = `${targetDate.slice(0,4)}/${targetDate.slice(4,6)}/${targetDate.slice(6,8)}`;
    const endD = new Date(targetDate.slice(0,4) + '-' + targetDate.slice(4,6) + '-' + targetDate.slice(6,8) + 'T00:00:00+08:00');
    endD.setDate(endD.getDate() + 4);
    const todayD = new Date();
    const finalEnd = endD > todayD ? todayD : endD;
    const endDateStr = `${finalEnd.getFullYear()}/${String(finalEnd.getMonth()+1).padStart(2,'0')}/${String(finalEnd.getDate()).padStart(2,'0')}`;
    console.error(`[ach-reply] 查詢區間: ${startDateStr} ~ ${endDateStr}`);

    await mainFrame.evaluate((startD, endD) => {
      // 永豐 ACH 回覆檔頁面有起始/結束日期欄位
      const inputs = document.querySelectorAll('input[id*="Date"], input[id*="date"], input[id*="txDate"]');
      const dateInputs = Array.from(inputs).filter(i => i.type === 'text' || i.type === '');
      if (dateInputs.length >= 2) {
        // 第一個 = 起始日期，第二個 = 結束日期
        dateInputs[0].value = startD;
        dateInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
        dateInputs[1].value = endD;
        dateInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // fallback: 全部設同一個日期
        for (const input of inputs) {
          input.value = startD;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }, startDateStr, endDateStr);
    await delay(1000);

    // Click 查詢
    await mainFrame.evaluate(() => {
      for (const btn of document.querySelectorAll('button, input[type="button"], input[type="submit"]')) {
        if ((btn.textContent || btn.value || '').includes('查詢')) { btn.click(); return; }
      }
    });
    await delay(5000);

    // Log results
    const resultText = await mainFrame.evaluate(() => document.body?.innerText?.substring(0, 500));
    console.error(`[ach-reply] 查詢結果: ${resultText?.substring(0, 200)}`);

    // Set download path via CDP
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOAD_DIR,
    });

    // Step 1: 找查詢結果 — 每行「功能」欄有「下載」按鈕（PrimeFaces button）
    const dlButtons = await mainFrame.evaluate(() => {
      const buttons = [];
      for (const btn of document.querySelectorAll('button')) {
        const text = (btn.textContent || '').trim();
        const onclick = btn.getAttribute('onclick') || '';
        if (text === '下載' && onclick.includes('PrimeFaces')) {
          // 取同行案件編號
          const row = btn.closest('tr');
          const cells = row ? row.querySelectorAll('td') : [];
          const caseNo = cells.length > 1 ? cells[1]?.textContent?.trim() : '';
          buttons.push({ id: btn.id, caseNo });
        }
      }
      return buttons;
    });
    console.error(`[ach-reply] 找到 ${dlButtons.length} 個下載按鈕`);

    if (dlButtons.length === 0) {
      console.error('[ach-reply] 查無結果或找不到下載按鈕');
      return false;
    }

    // 記錄下載前的檔案清單
    const beforeFiles = new Set(fs.readdirSync(DOWNLOAD_DIR));
    const downloadedFiles = [];

    // Step 2: 逐個點「下載」按鈕 → 彈出「檔案下載」彈窗 → 點媒體檔連結
    for (let i = 0; i < dlButtons.length; i++) {
      try {
        const { id: btnId, caseNo } = dlButtons[i];
        console.error(`[ach-reply] [${i+1}/${dlButtons.length}] 案件 ${caseNo}，點擊下載按鈕...`);

        // 點「下載」按鈕 — 用 Puppeteer 原生 click（確保 PrimeFaces AJAX 正確觸發）
        // PrimeFaces ID 含冒號，需轉義 CSS selector
        const btnSelector = '#' + btnId.replace(/:/g, '\\:');
        try {
          await mainFrame.click(btnSelector);
        } catch (_clickErr) {
          // Fallback: 直接呼叫 PrimeFaces.ab（不用 return false）
          await mainFrame.evaluate((bid) => {
            PrimeFaces.ab({s: bid});
          }, btnId);
        }
        await delay(5000);

        // Step 3: 找新出現的 iframe dialog
        let dialogFrame = null;
        for (let attempt = 0; attempt < 10; attempt++) {
          await delay(500);
          dialogFrame = page.frames().find(f => f.url().includes('CTWACTXQU_2.xhtml'));
          if (dialogFrame) break;
        }

        if (!dialogFrame) {
          console.error('[ach-reply] 錯誤：找不到下載彈窗 iframe');
          continue; // 繼續處理下一行
        }
        console.error('[ach-reply] 找到彈窗 iframe, URL:', dialogFrame.url().substring(0,100));

        // Step 4: 在彈窗 iframe 中點擊媒體檔連結
        const dlResult = await dialogFrame.evaluate(() => {
          for (const link of document.querySelectorAll('a')) {
            const text = (link.textContent || '').trim();
            // 媒體檔檔名格式: 94256530_NEP01_M_YYYYMMDD_N.TXT
            if (text.includes('_M_') && text.endsWith('.TXT') && !text.includes('_F')) {
              link.click();
              return { clicked: true, file: text };
            }
          }
          return { clicked: false, debug: document.body?.innerText?.substring(0, 300) };
        });

        console.error(`[ach-reply] 下載結果: ${JSON.stringify(dlResult)}`);
        if (dlResult.clicked) {
          await delay(6000); // 等待下載

          // 偵測新下載的檔案
          const afterFiles = fs.readdirSync(DOWNLOAD_DIR);
          for (const f of afterFiles) {
            if (!beforeFiles.has(f) && f.includes('_M_') && f.endsWith('.TXT') && !f.includes('_F')) {
              downloadedFiles.push(f);
              beforeFiles.add(f);
              console.error(`[ach-reply] 新檔案: ${f}`);
            }
          }
        }

        // Step 5: 關閉彈窗 (紅色圓形 ✕ 按鈕)
        // 這個按鈕在 mainFrame 的父層級，由 PrimeFaces 產生
        try {
          // PrimeFaces dialogs are created at the top level of the page's body
          const closed = await page.evaluate(() => {
            const closeButtons = document.querySelectorAll('.ui-dialog-titlebar-close');
            for (const btn of closeButtons) {
              // 找可見的
              if (btn.offsetParent !== null) {
                btn.click();
                return true;
              }
            }
            return false;
          });
          if (closed) console.error('[ach-reply] 已關閉彈窗');
          else await page.keyboard.press('Escape');
          await delay(2000);
        } catch (closeErr) {
          console.error(`[ach-reply] 關閉彈窗失敗: ${closeErr.message?.substring(0,80)}`);
        }

      } catch (rowErr) {
        console.error(`[ach-reply] 第 ${i+1} 行處理失敗: ${rowErr.message?.substring(0, 80)}`);
      }
    }

    console.error(`[ach-reply] 共下載 ${downloadedFiles.length} 個媒體檔: ${downloadedFiles.join(', ')}`);
    if (downloadedFiles.length > 0) {
      fs.writeFileSync(path.join(DOWNLOAD_DIR, '.ach_reply_latest'), downloadedFiles.join('\n'));
    }
    return downloadedFiles.length > 0;
  } finally {
    browser.disconnect();
  }
}

// ── Main ──
async function main() {
  const args = process.argv.slice(2);
  const parseOnly = args.includes('--parse-only');
  let targetDate = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) targetDate = args[++i];
  }

  if (!targetDate) {
    const now = new Date();
    targetDate = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).replace(/-/g, '');
  }

  // Try to download if not parse-only
  if (!parseOnly) {
    try {
      await downloadReply(targetDate);
    } catch (e) {
      console.error(`[ach-reply] Download failed: ${e.message}`);
    }
  }

  // Parse the reply file(s)
  // 1. 先找剛才下載的清單
  const latestListPath = path.join(DOWNLOAD_DIR, '.ach_reply_latest');
  let files = [];
  if (fs.existsSync(latestListPath)) {
    const latestFiles = fs.readFileSync(latestListPath, 'utf8').trim().split('\n').filter(Boolean);
    // 只用 1 小時內的
    const stat = fs.statSync(latestListPath);
    if (Date.now() - stat.mtime.getTime() < 3600000) {
      files = latestFiles.filter(f => fs.existsSync(path.join(DOWNLOAD_DIR, f)));
    }
  }

  // 2. Fallback: 找 targetDate 的檔案
  if (!files.length) {
    const pattern = `94256530_NEP01_M_${targetDate}`;
    files = fs.readdirSync(DOWNLOAD_DIR)
      .filter(f => f.startsWith(pattern) && f.endsWith('.TXT') && !f.includes('_F'))
      .sort();
  }

  // 3. Fallback: 找查詢區間內的檔案（targetDate ~ +4天）
  if (!files.length) {
    const endD2 = new Date(targetDate.slice(0,4) + '-' + targetDate.slice(4,6) + '-' + targetDate.slice(6,8) + 'T00:00:00+08:00');
    endD2.setDate(endD2.getDate() + 4);
    const allMediaFiles = fs.readdirSync(DOWNLOAD_DIR)
      .filter(f => f.startsWith('94256530_NEP01_M_') && f.endsWith('.TXT') && !f.includes('_F'));
    for (const f of allMediaFiles) {
      const match = f.match(/M_(\d{8})/);
      if (match) {
        const fDate = match[1];
        if (fDate >= targetDate && fDate <= endD2.toISOString().slice(0,10).replace(/-/g, '')) {
          files.push(f);
        }
      }
    }
    files.sort();
  }

  // 4. Last resort: 最近 1 小時下載的
  if (!files.length) {
    const altFiles = fs.readdirSync(DOWNLOAD_DIR)
      .filter(f => f.startsWith('94256530_NEP01_M_') && f.endsWith('.TXT') && !f.includes('_F'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtime }))
      .filter(f => Date.now() - f.mtime.getTime() < 3600000)
      .sort((a, b) => b.mtime - a.mtime);
    if (altFiles.length) files.push(altFiles[0].name);
  }

  if (!files.length) {
    console.log(JSON.stringify({
      success: false,
      date: targetDate,
      error: `找不到回覆檔 (${pattern}*.TXT)`,
      records: [],
    }));
    return;
  }

  const allRecords = [];
  for (const file of files) {
    const filePath = path.join(DOWNLOAD_DIR, file);
    console.error(`[ach-reply] 解析: ${file}`);
    const records = parseReplyFile(filePath);
    allRecords.push(...records);
  }

  const successCount = allRecords.filter(r => r.status === 'R').length;
  const failCount = allRecords.filter(r => r.status === 'N').length;

  console.log(JSON.stringify({
    success: true,
    date: targetDate,
    files: files,
    records: allRecords,
    summary: {
      total: allRecords.length,
      success: successCount,
      fail: failCount,
    },
  }));
}

main().catch(e => {
  console.log(JSON.stringify({ success: false, error: e.message }));
  process.exit(1);
});
