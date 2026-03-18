#!/usr/bin/env node
/**
 * 永豐寰宇金融網 — 自動下載 ACH 回覆檔 v2
 * 修正：iframe 操作 + RSA 密碼加密 + 正確 JSF 提交
 * 
 * Usage:
 *   node sinopac_download_v2.cjs                    # 下載今天
 *   node sinopac_download_v2.cjs 20260317           # 下載指定日期
 *   node sinopac_download_v2.cjs pending             # 自動抓所有 pending 日期
 */

const puppeteer = require('puppeteer');
const delay = ms => new Promise(r => setTimeout(r, ms));
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { Pool } = require('pg');

const SINOPAC_URL = 'https://b2b.sinopac.com/B2B/index.xhtml';
const COMPANY_ID = '94256530';
const USERNAME = 'openclew888';
const PASSWORD_FILE = path.join(process.env.HOME, '.openclaw/secrets/sinopac-password.txt');
const AI_KEYS_FILE = path.join(process.env.HOME, '.openclaw/secrets/ai-api-keys.json');
const DOWNLOAD_DIR = path.join(process.env.HOME, 'Downloads');
const SHOT_DIR = '/tmp/sinopac_dl';

const pool = new Pool({ host: '/tmp', database: 'paomao', user: 'paopaomao' });

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

// Telegram
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = '7956245081';
async function sendTg(text) {
  if (!TG_BOT_TOKEN) { console.log(`[TG] ${text}`); return; }
  await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' }),
  }).catch(e => console.error('[TG error]', e.message));
}

async function solveCaptcha(base64) {
  const keysData = JSON.parse(fs.readFileSync(AI_KEYS_FILE, 'utf8'));
  const openaiKey = keysData.keys.find(k => k.provider === 'openai');
  const openai = new OpenAI({ apiKey: openaiKey.key });
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '請辨識這個驗證碼圖片中的文字。只回覆驗證碼本身，不要加任何說明。驗證碼通常是5個英數字。' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }
      ]
    }],
    max_tokens: 20,
  });
  return (response.choices[0]?.message?.content || '').trim().replace(/[^a-zA-Z0-9]/g, '');
}

async function login(page, maxRetries = 3) {
  const password = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[login] 嘗試 ${attempt}/${maxRetries}...`);
    
    await page.goto(SINOPAC_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(3000);

    const iframeEl = await page.$('#indexFrame');
    if (!iframeEl) throw new Error('找不到 indexFrame');
    const frame = await iframeEl.contentFrame();
    if (!frame) throw new Error('無法取得 iframe 內容');

    // Fill form fields with keyboard events (PrimeFaces needs this)
    await frame.click('#form\\:txtCustId', { clickCount: 3 });
    await frame.type('#form\\:txtCustId', COMPANY_ID, { delay: 30 });

    await frame.click('#form\\:txtUserId', { clickCount: 3 });
    await frame.type('#form\\:txtUserId', USERNAME, { delay: 30 });

    await frame.click('#form\\:txtUserPwd', { clickCount: 3 });
    await frame.type('#form\\:txtUserPwd', password, { delay: 30 });

    // Solve CAPTCHA
    const captchaBase64 = await frame.evaluate(() => {
      const img = document.getElementById('form:captchaImg');
      if (!img) return null;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || img.width;
      c.height = img.naturalHeight || img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png').split(',')[1];
    });

    if (!captchaBase64) throw new Error('找不到 CAPTCHA 圖片');
    
    const captchaText = await solveCaptcha(captchaBase64);
    console.log(`[login] CAPTCHA: ${captchaText}`);
    
    await frame.click('#form\\:captchaInput', { clickCount: 3 });
    await frame.type('#form\\:captchaInput', captchaText, { delay: 30 });

    // Click the actual login link which triggers the full chain:
    // jsf.util.chain → doSubmit() → doPwdCertEncrypt() → mojarra.jsfcljs()
    const loginResult = await frame.evaluate(() => {
      const loginLink = document.getElementById('form:submitLoginBtn');
      if (loginLink) {
        loginLink.click();
        return 'submitLoginBtn clicked';
      }
      return 'login link not found';
    });
    console.log(`[login] Submit: ${loginResult}`);

    // Wait for navigation/page change
    await delay(10000);
    
    // Check if we're still on login page or moved on
    const allFrames = page.frames();
    const urls = allFrames.map(f => f.url());
    console.log(`[login] Frames after login:`, urls.map(u => u.substring(0, 80)));
    
    // If we're past login, the iframe should no longer be the login page
    const newFrame = await (await page.$('#indexFrame'))?.contentFrame();
    if (newFrame) {
      const newUrl = newFrame.url();
      const stillLogin = newUrl.includes('CCMOTLGIN');
      
      if (!stillLogin) {
        console.log('[login] ✅ 登入成功！');
        return true;
      }
      
      // Check for error message
      const errorText = await newFrame.evaluate(() => {
        const msgs = document.querySelectorAll('.ui-messages-error, .ui-message-error, .error, [class*="error"]');
        return [...msgs].map(m => m.textContent.trim()).join('; ');
      });
      
      if (errorText) {
        console.log(`[login] ❌ 錯誤: ${errorText}`);
      } else {
        // Maybe the page changed structure - check for frameset
        const hasFrameset = await newFrame.evaluate(() => !!document.querySelector('frameset, frame'));
        if (hasFrameset) {
          console.log('[login] ✅ 登入成功！(frameset detected)');
          return true;
        }
        console.log('[login] ⚠️ 還在登入頁，可能 CAPTCHA 錯誤');
      }
    }
    
    // Take debug screenshot
    await page.screenshot({ path: `${SHOT_DIR}/login_fail_${attempt}.png` });
  }
  
  throw new Error(`登入失敗（重試 ${maxRetries} 次）`);
}

async function navigateToACHReply(page) {
  // After login, find the menu frame and navigate
  const allFrames = page.frames();
  
  // Look for the menu/navigation frame
  for (const f of allFrames) {
    const url = f.url();
    if (url.includes('about:blank') || url === page.mainFrame().url()) continue;
    
    try {
      const text = await f.evaluate(() => document.body?.innerText || '');
      
      // Find "收款服務" menu
      if (text.includes('收款') || text.includes('帳務查詢')) {
        console.log(`[nav] Found menu frame: ${url.substring(0, 80)}`);
        
        // Click 收款服務
        const clicked = await f.evaluate(() => {
          const links = document.querySelectorAll('a, span, td, div');
          for (const el of links) {
            const t = (el.textContent || '').trim();
            if (t === '收款服務' || t === 'ACH收付款') {
              el.click();
              return t;
            }
          }
          return null;
        });
        if (clicked) {
          console.log(`[nav] Clicked: ${clicked}`);
          await delay(3000);
        }
      }
    } catch(e) { /* frame access error */ }
  }
}

async function main() {
  const arg = process.argv[2] || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  
  let targetDates = [];
  if (arg === 'pending') {
    // Get all dates with pending ACH records
    const { rows } = await pool.query(`
      SELECT DISTINCT TO_CHAR(created_at, 'YYYYMMDD') AS dt
      FROM ach_records 
      WHERE is_active = true AND status = 'pending'
        AND ach_released IS NOT NULL AND ach_released != ''
        AND (ach_confirmed IS NULL OR ach_confirmed = '' OR ach_confirmed = 'FALSE')
      ORDER BY dt
    `);
    targetDates = rows.map(r => r.dt);
    console.log(`[main] Pending 日期: ${targetDates.join(', ')}`);
  } else {
    targetDates = [arg];
  }
  
  if (targetDates.length === 0) {
    console.log('[main] 沒有需要處理的日期');
    return;
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow', downloadPath: DOWNLOAD_DIR,
  });

  try {
    // Login once
    await login(page);
    
    // Take post-login screenshot for debugging
    await page.screenshot({ path: `${SHOT_DIR}/post_login.png` });
    
    // Dump all frames info
    const allFrames = page.frames();
    for (const f of allFrames) {
      const url = f.url();
      if (url.includes('about:blank')) continue;
      console.log(`[frame] ${url.substring(0, 100)}`);
      try {
        const text = await f.evaluate(() => document.body?.innerText?.substring(0, 200) || '');
        if (text.trim()) console.log(`  text: ${text.substring(0, 150)}`);
        
        const links = await f.evaluate(() => {
          return [...document.querySelectorAll('a')].slice(0, 20).map(a => ({
            text: (a.textContent || '').trim().substring(0, 30),
            href: a.href?.substring(0, 80),
          })).filter(l => l.text);
        });
        if (links.length > 0) console.log(`  links: ${JSON.stringify(links)}`);
      } catch(e) {}
    }

    // Navigate to ACH reply download
    await navigateToACHReply(page);

    console.log('[main] 完成偵查');
    
  } catch(e) {
    console.error('[main] 錯誤:', e.message);
    await sendTg(`❌ 永豐自動下載失敗: ${e.message}`);
  } finally {
    await browser.close();
    await pool.end();
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
