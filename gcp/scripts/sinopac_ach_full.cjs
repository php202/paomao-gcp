#!/usr/bin/env node
/**
 * 永豐寰宇金融網 — ACH 完整自動化
 * 自動登入 + 產檔 + 上傳 + 建立案件 + 送審
 *
 * Usage:
 *   node sinopac_ach_full.cjs --invoiceId 12345 --invoiceName "INV/2026/03/000079"
 *   node sinopac_ach_full.cjs --file /tmp/ACH_xxx.txt          (skip generation, just upload+submit)
 *   node sinopac_ach_full.cjs --login-only                      (just login, don't upload)
 *
 * Env:
 *   SINOPAC_CDP_PORT    Chrome DevTools port (default: 18800)
 *   OPENAI_API_KEY      For captcha OCR (reads from secrets if not set)
 *   DATABASE_URL        PostgreSQL (default: postgresql://localhost/paomao)
 */

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const delay = ms => new Promise(r => setTimeout(r, ms));
const DEBUG_PORT = parseInt(process.env.SINOPAC_CDP_PORT || '18800');

/**
 * 通用彈窗處理：持續掃描所有 frame，找到 ConfirmDialog/popup 就點「確定」
 * 會連續處理多個彈窗（例如重複上傳 + 即時交易確認）
 * @param {Page} page - Puppeteer page
 * @param {number} maxAttempts - 最多嘗試幾輪（每輪 2 秒）
 * @param {string} label - 日誌標籤
 * @returns {number} 成功點擊次數
 */
async function dismissDialogs(page, maxAttempts = 8, label = '') {
  let totalClicked = 0;
  let consecutiveMisses = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await delay(2000);
    let clicked = false;
    for (const frame of page.frames()) {
      try {
        const url = frame.url();
        // Check ConfirmDialog, popup, or any frame with confirm buttons
        if (!url.includes('ConfirmDialog') && !url.includes('popup') && !url.includes('Dialog')) continue;
        const result = await frame.evaluate(() => {
          for (const el of document.querySelectorAll('a, button, input[type="button"]')) {
            const t = (el.textContent || el.value || '').trim();
            if (t === '確定' || t === '確認' || t === 'OK') { 
              el.click(); 
              return t; 
            }
          }
          return null;
        });
        if (result) {
          clicked = true;
          totalClicked++;
          console.log(`[ACH] ${label} 彈窗 #${totalClicked}: 點擊「${result}」(attempt ${attempt + 1})`);
          consecutiveMisses = 0;
          await delay(2000); // Wait for next potential dialog
        }
      } catch (_) {}
    }
    if (!clicked) {
      consecutiveMisses++;
      if (consecutiveMisses >= 2) break; // No dialogs for 2 consecutive checks → done
    }
  }
  return totalClicked;
}

// ══════════════════════════════════════════════════
// Config
// ══════════════════════════════════════════════════
const SINOPAC = {
  custId: '94256530',
  userId: 'openclew888',
  password: 'Happy888',
  ourBranch: '8070014',       // 永豐大園 (full 7-digit)
  ourAccount: '0019201800234666', // 666 with leading 00
  companyId: '94256530',
};

const DB_URL = process.env.DATABASE_URL || 'postgresql://localhost/paomao';
let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new Pool({ 
      connectionString: DB_URL, 
      max: 2,
      host: '/tmp', // Unix socket
      database: 'paomao',
      user: 'paopaomao'
    });
  }
  return _pool;
}

// ══════════════════════════════════════════════════
// Captcha OCR via OpenAI Vision
// ══════════════════════════════════════════════════
async function solveCaptcha(imageBase64) {
  let apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    try {
      const keyPath = path.join(process.env.HOME, '.openclaw/secrets/openai-api-key.txt');
      apiKey = fs.readFileSync(keyPath, 'utf8').trim();
    } catch (_) {}
  }
  if (!apiKey) {
    // Try ai-api-keys.json
    try {
      const keys = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.openclaw/secrets/ai-api-keys.json'), 'utf8'));
      apiKey = keys.openai?.api_key || keys.openai?.key;
    } catch (_) {}
  }
  if (!apiKey) throw new Error('需要 OPENAI_API_KEY 來識別驗證碼');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Read the captcha text in this image. Reply with ONLY the captcha characters, nothing else.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
        ],
      }],
      max_tokens: 20,
    }),
  });
  const data = await res.json();
  const captcha = data.choices?.[0]?.message?.content?.trim();
  if (!captcha) throw new Error('Vision API 無法識別驗證碼: ' + JSON.stringify(data));
  return captcha;
}

// ══════════════════════════════════════════════════
// Browser connection
// ══════════════════════════════════════════════════
async function connectBrowser() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  const { webSocketDebuggerUrl } = await res.json();
  const browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes('sinopac.com')) || pages[0];
  return { browser, page };
}

function getFrame(page, name) {
  return page.frames().find(f => f.name() === name);
}

// ══════════════════════════════════════════════════
// Login
// ══════════════════════════════════════════════════
async function ensureLoggedIn(page) {
  const frames = page.frames();
  const indexFrame = frames.find(f => f.name() === 'indexFrame');
  const mainFrame = frames.find(f => f.name() === 'mainFrame');

  // Already logged in?
  if (indexFrame && mainFrame && !mainFrame.url().includes('CCMOTLGIN')) {
    console.log('[LOGIN] ✅ 已登入');
    return true;
  }

  // Check if on logout page
  const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
  if (pageText.includes('已登出') || pageText.includes('回登入頁')) {
    console.log('[LOGIN] 偵測到登出頁，點擊回登入頁...');
    await page.evaluate(() => {
      for (const a of document.querySelectorAll('a, button')) {
        if (a.textContent.includes('回登入頁')) { a.click(); break; }
      }
    });
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => {});
    await delay(3000);
  }

  // Now on login page — find indexFrame
  const loginFrame = page.frames().find(f => f.name() === 'indexFrame') || page.mainFrame();
  const hasLoginForm = await loginFrame.evaluate(() => !!document.getElementById('form:txtCustId'));
  if (!hasLoginForm) {
    // Navigate to login page
    await page.goto('https://b2b.sinopac.com/B2B/index.xhtml?glocale=zh_TW', { waitUntil: 'networkidle0', timeout: 20000 });
    await delay(3000);
  }

  const lf = page.frames().find(f => f.name() === 'indexFrame') || page.mainFrame();

  // Attempt login (max 3 tries for captcha)
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[LOGIN] 登入嘗試 ${attempt}/3...`);

    // Refresh captcha
    await lf.evaluate(() => {
      const btn = document.getElementById('form:changCapthcabtnPrint');
      if (btn) btn.click();
    });
    await delay(2000);

    // Screenshot captcha image
    const captchaBase64 = await lf.evaluate(() => {
      const img = document.querySelector('img[id*="captcha"], img[src*="captcha"]');
      if (!img) {
        // Try canvas
        const canvas = document.querySelector('canvas');
        if (canvas) return canvas.toDataURL('image/png').split(',')[1];
        return null;
      }
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || img.width;
      c.height = img.naturalHeight || img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png').split(',')[1];
    });

    if (!captchaBase64) {
      // Fallback: screenshot the whole frame and crop
      console.log('[LOGIN] 找不到驗證碼圖片，截圖整頁辨識...');
      const screenshotPath = '/tmp/sinopac_captcha_temp.png';
      await page.screenshot({ path: screenshotPath, fullPage: true });
      // Use the full screenshot
      const screenshotB64 = fs.readFileSync(screenshotPath).toString('base64');
      var captchaText = await solveCaptchaFromScreenshot(screenshotB64);
    } else {
      var captchaText = await solveCaptcha(captchaBase64);
    }
    console.log(`[LOGIN] 驗證碼: ${captchaText}`);

    // Fill form
    await lf.evaluate((cfg, captcha) => {
      const fill = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      fill('form:txtCustId', cfg.custId);
      fill('form:txtUserId', cfg.userId);
      fill('form:txtUserPwd', cfg.password);
      fill('form:captchaInput', captcha);
    }, SINOPAC, captchaText);

    await delay(500);

    // Click login
    await lf.evaluate(() => {
      const btn = document.getElementById('form:submitLoginBtn');
      if (btn) btn.click();
    });
    console.log('[LOGIN] 送出登入...');
    await delay(5000);

    // Check result
    const frames2 = page.frames();
    const mf = frames2.find(f => f.name() === 'mainFrame');
    if (mf && !mf.url().includes('CCMOTLGIN')) {
      console.log('[LOGIN] ✅ 登入成功');
      return true;
    }

    // Check for error
    const lf2 = frames2.find(f => f.name() === 'indexFrame') || page.mainFrame();
    const errText = await lf2.evaluate(() => {
      const msgs = document.querySelectorAll('.ui-messages-error, .error-msg, [class*=error]');
      return Array.from(msgs).map(m => m.textContent.trim()).join('; ');
    });
    if (errText) console.log(`[LOGIN] ❌ 錯誤: ${errText}`);

    if (errText.includes('密碼') || errText.includes('locked') || errText.includes('鎖定')) {
      throw new Error(`登入失敗（密碼/鎖定）: ${errText}`);
    }

    // Handle "重複登入" — click "是，繼續本次登入"
    if (errText.includes('重複登入') || errText.includes('繼續本次登入')) {
      console.log('[LOGIN] 偵測到重複登入，點擊「是，繼續本次登入」...');
      const clicked = await lf2.evaluate(() => {
        for (const btn of document.querySelectorAll('button, input[type=button], a')) {
          const t = (btn.textContent || btn.value || '').trim();
          if (t.includes('是') && t.includes('繼續')) { btn.click(); return true; }
        }
        return false;
      });
      if (clicked) {
        await delay(5000);
        // Check if login succeeded after clicking
        const mf2 = page.frames().find(f => f.name() === 'mainFrame');
        if (mf2 && !mf2.url().includes('CCMOTLGIN')) {
          console.log('[LOGIN] ✅ 重複登入確認後登入成功');
          return true;
        }
      }
    }

    // Handle "瀏覽器使用中" — clear cookies and retry
    if (errText.includes('瀏覽器使用中')) {
      console.log('[LOGIN] 偵測到瀏覽器使用中，清除 cookies 重試...');
      try {
        await lf2.evaluate(() => {
          for (const btn of document.querySelectorAll('button, input[type=button], a')) {
            if ((btn.textContent || btn.value || '').includes('確定')) { btn.click(); return; }
          }
        });
        await delay(2000);
        const client = await page.createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await page.goto('https://b2b.sinopac.com/B2B/index.xhtml', { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(3000);
      } catch (e) { console.log('[LOGIN] 清除 cookies 失敗:', e.message); }
      // Will retry in next loop iteration
    }

    // Captcha wrong — retry
    console.log('[LOGIN] 驗證碼可能錯誤，重試...');
  }

  throw new Error('登入失敗：驗證碼連續 3 次錯誤');
}

async function solveCaptchaFromScreenshot(screenshotB64) {
  let apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    try { apiKey = fs.readFileSync(path.join(process.env.HOME, '.openclaw/secrets/openai-api-key.txt'), 'utf8').trim(); } catch (_) {}
  }
  if (!apiKey) {
    try {
      const keys = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.openclaw/secrets/ai-api-keys.json'), 'utf8'));
      apiKey = keys.openai?.api_key || keys.openai?.key;
    } catch (_) {}
  }
  if (!apiKey) throw new Error('需要 OPENAI_API_KEY');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'This is a bank login page screenshot. Find the CAPTCHA image and read its characters. Reply with ONLY the captcha text, nothing else.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotB64}` } },
        ],
      }],
      max_tokens: 20,
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ══════════════════════════════════════════════════
// ACH TXT Generation
// ══════════════════════════════════════════════════
function generateAchTxt(payeeCode, bankAccount, amount) {
  const now = new Date();
  const tz = 'Asia/Taipei';
  // 跨行匯款 22:00 後要用隔天日期，不然永豐會拒絕
  const hour = parseInt(now.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }));
  const txDate = hour >= 22
    ? new Date(now.getTime() + 24 * 60 * 60 * 1000)  // 明天
    : now;
  const todayROC = (txDate.getFullYear() - 1911) + txDate.toLocaleDateString('en-CA', { timeZone: tz }).replace(/-/g, '').slice(4);

  const header = ('BOFACHP010' + todayROC + '20180680700149990250V10').padEnd(250, ' ');

  const seq = '00000001';
  const feeStr = amount.toString().padStart(10, '0'); // 元，不乘100
  // 永豐 ACH 不接受中文，過濾掉非 ASCII 字元
  const pin = payeeCode.replace(/[^\x20-\x7E]/g, '').substring(0, 10).padEnd(10, ' ');
  const data = 'NSD904' + seq + SINOPAC.ourBranch + SINOPAC.ourAccount + SINOPAC.ourBranch + '00' +
    bankAccount.padEnd(14, '0') + feeStr + '00B' + SINOPAC.companyId + '  ' + pin +
    '      0000000000000000 ' + pin +
    '                                                            00000                                                           ';

  const footer = ('EOFACHP010' + todayROC + SINOPAC.ourBranch + '9990250000000' + '01' +
    amount.toString().padStart(16, '0')).padEnd(250, ' ');

  // Verify
  for (const [i, line] of [header, data, footer].entries()) {
    if (line.length !== 250) throw new Error(`Line ${i + 1} length=${line.length}, expected 250`);
  }

  return [header, data, footer].join('\r\n') + '\r\n';
}

// ══════════════════════════════════════════════════
// ACH Upload + Submit (建立案件→送審→確定送審)
// ══════════════════════════════════════════════════
async function uploadAndSubmit(page, filePath) {
  const indexFrame = getFrame(page, 'indexFrame');
  if (!indexFrame) throw new Error('找不到 indexFrame');

  // Navigate to ACH上傳
  console.log('[ACH] 導航到: 收款服務 > ACH收付款 > ACH檔案上傳');
  for (const text of ['收款服務', 'ACH收付款', 'ACH檔案上傳']) {
    await indexFrame.evaluate(t => {
      for (const a of document.querySelectorAll('a')) {
        if (a.textContent.trim().includes(t)) { a.click(); break; }
      }
    }, text);
    await delay(1500);
  }
  await delay(3000);

  const mainFrame = getFrame(page, 'mainFrame');
  if (!mainFrame) throw new Error('找不到 mainFrame');

  // Select radio buttons
  for (const radioId of ['form:achUpKind:1', 'form:achTxKind:1']) {
    await mainFrame.evaluate(id => {
      const el = document.getElementById(id);
      if (el) { el.click(); el.dispatchEvent(new Event('change', { bubbles: true })); }
    }, radioId);
    await delay(1500);
  }

  // Handle eACH confirmation popup
  await delay(2000);
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(() => {
        for (const el of document.querySelectorAll('a, button')) {
          if (el.textContent.trim() === '確定') { el.click(); return; }
        }
      });
    } catch (_) {}
  }
  await delay(2000);

  // New format radio
  await mainFrame.evaluate(() => {
    const el = document.getElementById('form:newFormatFlag:1');
    if (el) { el.click(); el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await delay(1500);

  // Upload file
  const fileInput = await mainFrame.waitForSelector('input[type="file"]', { timeout: 5000 });
  await fileInput.uploadFile(filePath);
  console.log(`[ACH] 檔案已選擇: ${path.basename(filePath)}`);
  await delay(2000);

  // Click 上傳
  await mainFrame.evaluate(() => {
    for (const b of document.querySelectorAll('button[type="submit"]')) {
      if (b.textContent.trim() === '上傳') { b.click(); return; }
    }
  });
  await delay(3000);

  // Handle ALL upload confirmation popups (重複上傳 + 即時交易確認 etc.)
  await dismissDialogs(page, 10, '上傳後');
  await delay(3000);

  // Check upload result
  const mf = getFrame(page, 'mainFrame');
  const resultText = await mf.evaluate(() => document.body.innerText);
  const successMatch = resultText.match(/檢核成功/);
  if (!successMatch) {
    console.log('[ACH] ❌ 檢核失敗');
    return { success: false, error: '檢核失敗', text: resultText.substring(0, 300) };
  }

  const amtMatch = resultText.match(/成功總金額\s*([\d,]+)/);
  console.log(`[ACH] ✅ 檢核成功，金額: ${amtMatch?.[1] || '?'}`);

  // Step 1: 點放大鏡 (功能按鈕, row 0)
  await mf.evaluate(() => {
    const btn = document.getElementById('form:CTWACTXUP_1_DataGrid:0:column10_content');
    if (btn) btn.click();
  });
  console.log('[ACH] 1. 點放大鏡');
  await delay(4000);

  // Step 2: 建立案件
  await mf.evaluate(() => {
    const btn = document.getElementById('form:btnCreateCase');
    if (btn) btn.click();
  });
  console.log('[ACH] 2. 建立案件');
  await delay(3000);

  // Handle all post-create dialogs (重複金額、同天同額 etc.)
  await dismissDialogs(page, 6, '建立案件後');

  // Get case number
  const caseText = await mf.evaluate(() => document.body.innerText);
  const caseMatch = caseText.match(/案件編號\s+(\d+)/);
  const caseNo = caseMatch?.[1];
  console.log(`[ACH] 案件編號: ${caseNo || '(未取得)'}`);

  // Step 3: 送審
  await mf.evaluate(() => {
    for (const el of document.querySelectorAll('button')) {
      if (el.textContent.trim() === '送審') { el.click(); return; }
    }
  });
  console.log('[ACH] 3. 送審');
  await delay(5000);

  // Handle any confirmation popup before 確定送審
  await dismissDialogs(page, 4, '送審前');

  // Step 4: 確定送審（重試最多 5 次，等按鈕出現）
  let submitClicked = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const clicked = await mf.evaluate(() => {
      for (const el of document.querySelectorAll('button')) {
        if (el.textContent.trim() === '確定送審') { el.click(); return true; }
      }
      return false;
    });
    if (clicked) { submitClicked = true; console.log(`[ACH] 4. 確定送審 (attempt ${attempt + 1})`); break; }
    await delay(3000);
    // 可能有彈窗擋住
    await dismissDialogs(page, 2, '等確定送審');
  }
  if (!submitClicked) console.log('[ACH] ⚠️ 找不到確定送審按鈕');
  
  // Handle post-submit dialogs
  await dismissDialogs(page, 4, '送審後');
  await delay(3000);

  // Verify — 已送審 OR 有案件編號就算成功
  const finalText = await mf.evaluate(() => document.body.innerText.substring(0, 500));
  const submitted = finalText.includes('已送審') || (caseNo && finalText.includes(caseNo));
  console.log(submitted ? `[ACH] ✅ 已送審 (${caseNo})` : `[ACH] ❌ 送審結果不明: ${finalText.substring(0, 100)}`);

  return { success: submitted || !!caseNo, caseNo, amount: amtMatch?.[1] || '0' };
}

// ══════════════════════════════════════════════════
// Full flow: DB lookup → generate → login → upload → submit → update DB
// ══════════════════════════════════════════════════
async function fullFlow(opts) {
  const { browser, page } = await connectBrowser();

  try {
    // Step 0: Login
    await ensureLoggedIn(page);
    if (opts.loginOnly) {
      console.log('[DONE] 登入完成');
      return { success: true, action: 'login' };
    }

    let filePath = opts.file;
    let achRecordId = null;
    let achFeeType = null;

    // Step 1: Generate ACH file if not provided
    if (!filePath && (opts.invoiceName || opts.invoiceId)) {
      console.log(`[FLOW] 查詢發票 ${opts.invoiceName || opts.invoiceId}...`);
      const pool = getPool();

      // Find ACH record — fallback to stores.payee_id (主要關聯代號) if payee_code empty
      const { rows } = await pool.query(
        `SELECT ar.id, ar.store_name, ar.amount, ar.payee_code, ar.store_id, ar.payee_id, ar.fee_type,
                COALESCE(pp.bank_account, p.bank_account, sp.bank_account) as bank_account,
                COALESCE(pp.branch_code, p.branch_code, sp.branch_code) as branch_code,
                COALESCE(ar.payee_code, sp.code) as effective_payee_code,
                COALESCE(pp.id_number, p.id_number, sp.id_number) as tax_id,
                COALESCE(pp.ach_code, p.ach_code, sp.ach_code) as ach_code
         FROM ach_records ar
         LEFT JOIN payees pp ON pp.id = ar.payee_id
         LEFT JOIN payees p ON p.code = ar.payee_code AND ar.payee_code IS NOT NULL AND ar.payee_code != ''
         LEFT JOIN stores s ON s.id = ar.store_id
         LEFT JOIN payees sp ON sp.id = s.payee_id
         WHERE (ar.odoo_quote_id = $1 OR ar.odoo_invoice_id = $1) AND ar.is_active = true
         ORDER BY ar.id DESC LIMIT 1`,
        [opts.invoiceName]
      );
      
      // ℹ️ 儲值金：允許 ACH 扣款，但不開電子發票
      if (rows[0] && rows[0].fee_type === '儲值金') {
        console.log(`[ACH] 💰 儲值金記錄: ${opts.invoiceName} (${rows[0].store_name} $${rows[0].amount})`);
        console.log(`[ACH]    → 允許 ACH 扣款，跳過電子發票`);
      }

      if (!rows[0]) throw new Error(`找不到 ACH 紀錄: ${opts.invoiceName}`);
      const rec = rows[0];
      achRecordId = rec.id;
      achFeeType = rec.fee_type;
      // If payee_code was empty, fill it from stores.payee_id
      if (!rec.payee_code && rec.effective_payee_code) {
        rec.payee_code = rec.effective_payee_code;
        await pool.query('UPDATE ach_records SET payee_code = $1 WHERE id = $2', [rec.payee_code, rec.id]);
        console.log(`[FLOW] ACH #${rec.id}: payee_code filled from store default: ${rec.payee_code}`);
      }
      console.log(`[FLOW] ACH #${rec.id}: ${rec.store_name} $${rec.amount} (${rec.payee_code})`);

      // ─── 自動校正金額：用 Odoo payment 金額（扣除貸記單/折讓後的實付金額）───
      if (rec.fee_type !== '儲值金') {
        try {
          const { odooCall } = require('../lib/odoo.cjs');
          const soName = rows[0].odoo_quote_id || opts.invoiceName;
          // 先找 invoice
          let invoiceIds = [];
          if (soName && soName.startsWith('S0')) {
            const sos = await odooCall('sale.order', 'search_read', [[['name', '=', soName]]], { fields: ['invoice_ids'], limit: 1 });
            invoiceIds = sos[0]?.invoice_ids || [];
          } else if (soName && soName.startsWith('INV/')) {
            const invs = await odooCall('account.move', 'search_read', [[['name', '=', soName], ['move_type', '=', 'out_invoice']]], { fields: ['id'], limit: 1 });
            invoiceIds = invs.map(i => i.id);
          }
          if (invoiceIds.length) {
            const invData = await odooCall('account.move', 'read', [invoiceIds], { fields: ['id', 'state', 'amount_total', 'payment_state'] });
            const posted = invData.find(i => i.state === 'posted');
            if (posted) {
              // 查 payment 實際付款金額
              const payments = await odooCall('account.payment', 'search_read',
                [[['ref', 'ilike', posted.id.toString()], ['state', '=', 'posted']]],
                { fields: ['amount'], limit: 5 }
              ).catch(() => []);
              // 也可直接用 reconciled_invoices → 但用 payment amount 更精準
              // fallback: 直接查 invoice 的 amount_total vs amount_residual
              let correctedAmount = null;
              if (payments.length) {
                const totalPaid = payments.reduce((s, p) => s + (p.amount || 0), 0);
                if (totalPaid > 0 && Math.abs(totalPaid - rec.amount) > 0.5) {
                  correctedAmount = Math.round(totalPaid);
                }
              }
              // fallback: 如果 payment_state=in_payment 且 amount_total 不同
              if (!correctedAmount && posted.amount_total && Math.abs(posted.amount_total - rec.amount) > 0.5) {
                // 有可能有貸記單，查一下
                const partner = await odooCall('account.move', 'read', [[posted.id]], { fields: ['partner_id'] });
                const pid = partner[0]?.partner_id?.[0];
                if (pid) {
                  const credits = await odooCall('account.move', 'search_read',
                    [[['partner_id', '=', pid], ['move_type', '=', 'out_refund'], ['state', '=', 'posted'], ['payment_state', '!=', 'paid']]],
                    { fields: ['amount_total'] });
                  if (credits.length) {
                    const creditTotal = credits.reduce((s, c) => s + c.amount_total, 0);
                    correctedAmount = Math.round(posted.amount_total - creditTotal);
                  }
                }
              }
              if (correctedAmount && correctedAmount !== Math.round(rec.amount) && correctedAmount > 0) {
                console.log(`[FLOW] ⚡ 金額校正: $${Math.round(rec.amount)} → $${correctedAmount} (Odoo payment/貸記單扣除)`);
                rec.amount = correctedAmount;
                await pool.query('UPDATE ach_records SET amount = $1 WHERE id = $2', [correctedAmount, rec.id]);
              }
            }
          }
        } catch (e) {
          console.warn(`[FLOW] ⚠️ 金額校正查詢失敗 (不影響上傳): ${e.message}`);
        }
      }

      if (!rec.bank_account) throw new Error(`${rec.payee_code || '無代號'} 缺少銀行帳號`);

      // Generate file
      // ACH PIN: 優先 ach_code（專用 ACH 代碼），fallback tax_id，最後 payee_code
      const rawPin = rec.ach_code || rec.tax_id || rec.payee_code || '';
      const achPin = rawPin.replace(/[^\x20-\x7E]/g, '').trim();
      console.log(`[FLOW] ACH PIN: ${achPin} (ach_code: ${rec.ach_code}, tax_id: ${rec.tax_id}, payee_code: ${rec.payee_code})`);
      const content = generateAchTxt(achPin, rec.bank_account, Math.round(rec.amount));
      filePath = `/tmp/ACH_${rec.store_name.replace(/[^\w\u4e00-\u9fff]/g, '')}_${Date.now()}.txt`;
      fs.writeFileSync(filePath, content);
      console.log(`[FLOW] 產檔: ${filePath}`);
    }

    if (!filePath) throw new Error('需要 --file 或 --invoiceName');

    // Step 2: Upload + submit
    const result = await uploadAndSubmit(page, filePath);

    // Step 3: Update DB
    if (result.success && result.caseNo && achRecordId) {
      try {
        const pool = getPool();
        const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace('T', ' ');
        // 儲值金：自動標記不需要 666→686 轉帳
        const isStoredValue = achFeeType === '儲值金';
        const extraFields = isStoredValue ? ", transfer_666_686 = 'x', transfer_case_no = 'x'" : '';
        
        await pool.query(
          `UPDATE ach_records SET ach_case_no = $1, ach_registered = 'success', ach_released = 'success'${extraFields}, updated_at = NOW() WHERE id = $2`,
          [result.caseNo, achRecordId]
        );
        console.log(`[DB] ach_records #${achRecordId} → case ${result.caseNo}${isStoredValue ? ' (儲值金，不轉686)' : ''}`);
      } catch (e) {
        console.error(`[DB] 更新失敗: ${e.message}`);
      }
    }

    return result;
  } finally {
    browser.disconnect();
    if (_pool) await _pool.end().catch(() => {});
  }
}

// ══════════════════════════════════════════════════
// CLI
// ══════════════════════════════════════════════════
async function main() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--login-only') { opts.loginOnly = true; continue; }
    if (args[i].startsWith('--') && args[i + 1]) {
      opts[args[i].substring(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = args[++i];
    }
  }

  if (!opts.file && !opts.invoiceName && !opts.loginOnly) {
    console.log(`永豐寰宇金融網 — ACH 完整自動化 (登入+產檔+上傳+送審)

Usage:
  node sinopac_ach_full.cjs --invoice-name "INV/2026/03/000079"    從 DB 查帳號→產檔→上傳→送審
  node sinopac_ach_full.cjs --file /tmp/ACH_xxx.txt                直接上傳檔案→送審
  node sinopac_ach_full.cjs --login-only                           只登入（session 過期時）

Options:
  --invoice-name   Odoo invoice name (查 ach_records → payees → 產檔)
  --file           直接指定 ACH TXT 檔案
  --login-only     只做登入

Env:
  SINOPAC_CDP_PORT    Chrome port (default: 18800)
  OPENAI_API_KEY      Captcha OCR

完整流程:
  1. 自動登入（Vision AI 讀驗證碼）
  2. 從 ach_records + payees 查帳號資訊
  3. 產生 ACH P01 TXT 檔案
  4. 上傳到永豐 ACH檔案上傳
  5. 放大鏡 → 建立案件 → 送審 → 確定送審
  6. 案件編號回寫 ach_records.ach_case_no`);
    process.exit(0);
  }

  try {
    const result = await fullFlow(opts);
    console.log(JSON.stringify(result));
    process.exit(result.success ? 0 : 1);
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    process.exit(1);
  }
}

main();
