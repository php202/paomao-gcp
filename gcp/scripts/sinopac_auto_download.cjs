#!/usr/bin/env node
/**
 * 永豐寰宇金融網 — 自動下載 ACH 回覆檔
 * 用 Puppeteer + Vision AI 解 CAPTCHA 自動登入
 * 
 * Usage:
 *   node sinopac_auto_download.cjs          # 下載今天的 ACH 回覆檔
 *   node sinopac_auto_download.cjs 20260307 # 下載指定日期
 * 
 * Cron: 每日 10:00 + 15:00 執行
 */

const puppeteer = require('puppeteer');
const delay = ms => new Promise(r => setTimeout(r, ms));
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');

const SINOPAC_URL = 'https://b2b.sinopac.com/B2B/index.xhtml';
const COMPANY_ID = '94256530';
const USERNAME = 'openclew888';
const PASSWORD_FILE = path.join(process.env.HOME, '.openclaw/secrets/sinopac-password.txt');
const DOWNLOAD_DIR = path.join(process.env.HOME, 'Downloads');
const AI_KEYS_FILE = path.join(process.env.HOME, '.openclaw/secrets/ai-api-keys.json');

// Telegram notification
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = '7956245081'; // Robby 私訊

async function sendTg(text) {
  if (!TG_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('[TG] send failed:', e.message); }
}

async function solveCaptcha(imageBuffer) {
  // Try OpenAI Vision first
  const keys = JSON.parse(fs.readFileSync(AI_KEYS_FILE, 'utf8'));
  const openai = new OpenAI({ apiKey: keys.openai });
  
  const base64 = imageBuffer.toString('base64');
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '請辨識這個驗證碼圖片中的文字。只回覆驗證碼本身，不要加任何說明。驗證碼通常是 4-6 個英數字。' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }
      ]
    }],
    max_tokens: 20,
  });
  
  return (response.choices[0]?.message?.content || '').trim().replace(/[^a-zA-Z0-9]/g, '');
}

async function main() {
  const targetDate = process.argv[2] || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  console.log(`[sinopac] 開始自動下載 ACH 回覆檔 (${targetDate})`);
  
  const password = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 800 },
  });
  
  let downloadedFiles = [];
  
  try {
    const page = await browser.newPage();
    
    // Set download behavior
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOAD_DIR,
    });
    
    // 1. Navigate to login page
    console.log('[sinopac] 開啟登入頁...');
    await page.goto(SINOPAC_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);
    
    // 2. Fill login form
    // Company ID (用戶代號)
    const companyInput = await page.$('input[name*="companyId"], input[id*="companyId"], input[placeholder*="用戶"]');
    if (companyInput) {
      await companyInput.click({ clickCount: 3 });
      await companyInput.type(COMPANY_ID, { delay: 50 });
    }
    
    // Username (使用者代號)
    const userInput = await page.$('input[name*="userId"], input[id*="userId"], input[placeholder*="使用者"]');
    if (userInput) {
      await userInput.click({ clickCount: 3 });
      await userInput.type(USERNAME, { delay: 50 });
    }
    
    // Password
    const pwInput = await page.$('input[type="password"]');
    if (pwInput) {
      await pwInput.click({ clickCount: 3 });
      await pwInput.type(password, { delay: 50 });
    }
    
    // 3. Solve CAPTCHA
    console.log('[sinopac] 辨識 CAPTCHA...');
    const captchaImg = await page.$('img[id*="captcha"], img[src*="captcha"], img[alt*="驗證"]');
    if (captchaImg) {
      const imgBuffer = await captchaImg.screenshot();
      const captchaText = await solveCaptcha(imgBuffer);
      console.log(`[sinopac] CAPTCHA 辨識結果: ${captchaText}`);
      
      const captchaInput = await page.$('input[name*="captcha"], input[id*="captcha"], input[placeholder*="驗證"]');
      if (captchaInput) {
        await captchaInput.click({ clickCount: 3 });
        await captchaInput.type(captchaText, { delay: 50 });
      }
    }
    
    // 4. Submit login
    console.log('[sinopac] 登入...');
    const loginBtn = await page.$('button[type="submit"], input[type="submit"], a[onclick*="login"], button[id*="login"]');
    if (loginBtn) await loginBtn.click();
    await delay(5000);
    
    // Check login success (look for menu or error)
    const pageContent = await page.content();
    if (pageContent.includes('密碼錯誤') || pageContent.includes('驗證碼錯誤') || pageContent.includes('登入失敗')) {
      throw new Error('登入失敗 — 可能是 CAPTCHA 辨識錯誤');
    }
    console.log('[sinopac] ✅ 登入成功');
    
    // 5. Navigate to ACH 結果回覆檔案下載
    console.log('[sinopac] 導航到 ACH 結果回覆...');
    // 收款服務 → ACH收付款 → ACH結果回覆檔案下載
    // Try clicking menu items
    const menuLinks = await page.$$('a, span');
    for (const link of menuLinks) {
      const text = await page.evaluate(el => el.textContent, link);
      if (text && text.includes('收款服務')) {
        await link.click();
        await delay(2000);
        break;
      }
    }
    
    const subLinks = await page.$$('a, span');
    for (const link of subLinks) {
      const text = await page.evaluate(el => el.textContent, link);
      if (text && text.includes('ACH收付款')) {
        await link.click();
        await delay(2000);
        break;
      }
    }
    
    const subSubLinks = await page.$$('a, span');
    for (const link of subSubLinks) {
      const text = await page.evaluate(el => el.textContent, link);
      if (text && (text.includes('結果回覆') || text.includes('檔案下載'))) {
        await link.click();
        await delay(3000);
        break;
      }
    }
    
    // 6. Look for download links/buttons for today's files
    console.log('[sinopac] 尋找可下載的回覆檔...');
    await delay(3000);
    
    // Find and click download buttons for media files (_M_)
    const downloadLinks = await page.$$('a[href*="download"], button[onclick*="download"], a[onclick*="download"]');
    for (const link of downloadLinks) {
      const text = await page.evaluate(el => el.textContent || el.getAttribute('title') || '', link);
      if (text.includes('媒體檔') || text.includes('_M_')) {
        console.log(`[sinopac] 下載: ${text}`);
        await link.click();
        await delay(3000);
      }
    }
    
    // Also try clicking any visible download buttons in the table
    const allButtons = await page.$$('button, a.btn, input[type="button"]');
    for (const btn of allButtons) {
      const text = await page.evaluate(el => el.textContent || el.value || '', btn);
      if (text.includes('下載') || text.includes('媒體')) {
        console.log(`[sinopac] 點擊下載按鈕: ${text}`);
        await btn.click();
        await delay(3000);
      }
    }
    
    // 7. Check what was downloaded
    await delay(5000);
    const files = fs.readdirSync(DOWNLOAD_DIR)
      .filter(f => f.startsWith('94256530_NEP01_') && f.endsWith('.TXT'))
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtime,
      }))
      .filter(f => Date.now() - f.mtime.getTime() < 600000) // 10分鐘內的
      .sort((a, b) => b.mtime - a.mtime);
    
    downloadedFiles = files.map(f => f.name);
    console.log(`[sinopac] 新下載 ${downloadedFiles.length} 個檔案:`, downloadedFiles);
    
  } catch (e) {
    console.error('[sinopac] 錯誤:', e.message);
    await sendTg(`❌ 永豐自動下載失敗\n${e.message}`);
    throw e;
  } finally {
    await browser.close();
  }
  
  // 8. Parse downloaded files and reconcile
  if (downloadedFiles.length > 0) {
    console.log('[sinopac] 開始解析並比對...');
    try {
      const achAuto = require('./ach_automation.cjs');
      const result = await achAuto.bankCheck();
      console.log('[sinopac] 銀行比對結果:', result);
      
      await sendTg(
        `✅ 永豐 ACH 自動下載完成\n` +
        `📁 下載 ${downloadedFiles.length} 個檔案\n` +
        `🏦 比對: ${result.matched || 0} 筆匹配, ${result.parsed || 0} 筆解析`
      );
    } catch (e) {
      console.error('[sinopac] 比對錯誤:', e.message);
    }
  } else {
    console.log('[sinopac] 沒有新檔案可下載');
    await sendTg(`ℹ️ 永豐 ACH：今日無新回覆檔`);
  }
  
  return { downloadedFiles };
}

main().then(r => {
  console.log('[sinopac] 完成:', r);
  process.exit(0);
}).catch(e => {
  console.error('[sinopac] 致命錯誤:', e);
  process.exit(1);
});
