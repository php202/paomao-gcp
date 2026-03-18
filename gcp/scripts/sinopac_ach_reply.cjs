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

    // Set date range
    const dateStr = `${targetDate.slice(0,4)}/${targetDate.slice(4,6)}/${targetDate.slice(6,8)}`;
    await mainFrame.evaluate((d) => {
      // Try various date input patterns
      const inputs = document.querySelectorAll('input[id*="Date"], input[id*="date"], input[id*="txDate"]');
      for (const input of inputs) {
        input.value = d;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, dateStr);
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

    // Set download path
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOAD_DIR,
    });

    // Find download buttons - look for 媒體檔 download links
    const downloaded = await mainFrame.evaluate(() => {
      const clicked = [];
      // Look for links with download-related onclick or text
      for (const el of document.querySelectorAll('a, button, input[type="button"]')) {
        const text = (el.textContent || el.value || '').trim();
        const onclick = el.getAttribute('onclick') || '';
        const id = el.id || '';
        // Match: 下載, 媒體, download, or specific form button IDs
        if (text.includes('媒體') || text.includes('下載') || 
            onclick.includes('download') || onclick.includes('Download') ||
            id.includes('Download') || id.includes('download') || id.includes('btnDown')) {
          el.click();
          clicked.push({ text, id, onclick: onclick.substring(0, 60) });
        }
      }
      return clicked;
    });
    
    console.error(`[ach-reply] 點擊下載: ${JSON.stringify(downloaded)}`);
    await delay(8000);

    return true;
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

  // Parse the reply file
  const pattern = `94256530_NEP01_M_${targetDate}`;
  const files = fs.readdirSync(DOWNLOAD_DIR)
    .filter(f => f.startsWith(pattern) && f.endsWith('.TXT') && !f.includes('_F'))
    .sort();

  if (!files.length) {
    // Also check for files without date suffix
    const altFiles = fs.readdirSync(DOWNLOAD_DIR)
      .filter(f => f.startsWith('94256530_NEP01_M_') && f.endsWith('.TXT') && !f.includes('_F'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtime }))
      .filter(f => Date.now() - f.mtime.getTime() < 3600000) // Last hour
      .sort((a, b) => b.mtime - a.mtime);

    if (altFiles.length) {
      files.push(altFiles[0].name);
    }
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
