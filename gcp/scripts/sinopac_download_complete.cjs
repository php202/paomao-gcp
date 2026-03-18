#!/usr/bin/env node
/**
 * 永豐寰宇金融網 — ACH 回覆檔完整自動化流程
 * 登入 → 導航 → 下載 → 解析 → 更新DB
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

const pool = new Pool({ host: '/tmp', database: 'paomao', user: 'paopaomao' });

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

    await frame.click('#form\\:txtCustId', { clickCount: 3 });
    await frame.type('#form\\:txtCustId', COMPANY_ID, { delay: 30 });
    await frame.click('#form\\:txtUserId', { clickCount: 3 });
    await frame.type('#form\\:txtUserId', USERNAME, { delay: 30 });
    await frame.click('#form\\:txtUserPwd', { clickCount: 3 });
    await frame.type('#form\\:txtUserPwd', password, { delay: 30 });

    // CAPTCHA
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

    // 點擊登入按鈕
    await frame.evaluate(() => {
      const loginLink = document.getElementById('form:submitLoginBtn');
      if (loginLink) loginLink.click();
    });

    await delay(10000);
    
    // 檢查是否登入成功
    const newFrame = await (await page.$('#indexFrame'))?.contentFrame();
    if (newFrame && !newFrame.url().includes('CCMOTLGIN')) {
      console.log('[login] ✅ 登入成功！');
      return true;
    }
    
    console.log('[login] ⚠️ 登入失敗，重試...');
  }
  
  throw new Error(`登入失敗（重試 ${maxRetries} 次）`);
}

async function navigateToACHDownload(page) {
  console.log('[nav] 導航到 ACH 回覆檔下載...');
  
  const allFrames = page.frames();
  let menuFrame = null;
  let contentFrame = null;
  
  // 找到選單 frame
  for (const f of allFrames) {
    const url = f.url();
    if (url.includes('CCMHMANNO_Main')) {
      menuFrame = f;
      console.log('[nav] 找到選單 frame');
      break;
    }
  }
  
  if (!menuFrame) throw new Error('找不到選單 frame');
  
  // 點擊「收款服務」
  await menuFrame.evaluate(() => {
    const links = document.querySelectorAll('a, span, td, div');
    for (const el of links) {
      const text = (el.textContent || '').trim();
      if (text === '收款服務') {
        el.click();
        return true;
      }
    }
    return false;
  });
  
  await delay(3000);
  
  // 尋找 ACH 相關選項
  let achFound = false;
  for (let retry = 0; retry < 5; retry++) {
    const currentFrames = page.frames();
    
    for (const f of currentFrames) {
      if (f === page.mainFrame()) continue;
      
      try {
        const text = await f.evaluate(() => document.body?.innerText || '');
        
        // 尋找 ACH 收付款選項
        if (text.includes('ACH') && (text.includes('收付款') || text.includes('代收'))) {
          console.log('[nav] 找到 ACH 選單');
          
          const clicked = await f.evaluate(() => {
            const links = document.querySelectorAll('a, span, td, div');
            for (const el of links) {
              const t = (el.textContent || '').trim();
              if (t.includes('ACH') && (t.includes('收付款') || t.includes('代收'))) {
                el.click();
                return t;
              }
            }
            return null;
          });
          
          if (clicked) {
            console.log(`[nav] 點擊: ${clicked}`);
            await delay(3000);
            achFound = true;
            break;
          }
        }
      } catch(e) { /* frame 錯誤忽略 */ }
    }
    
    if (achFound) break;
    await delay(1000);
  }
  
  if (!achFound) {
    console.log('[nav] ⚠️ 未找到 ACH 選項，嘗試通用方式...');
  }
  
  // 尋找回覆檔下載
  await delay(2000);
  const finalFrames = page.frames();
  
  for (const f of finalFrames) {
    if (f === page.mainFrame()) continue;
    
    try {
      const text = await f.evaluate(() => document.body?.innerText || '');
      
      if (text.includes('回覆') || text.includes('下載') || text.includes('檔案')) {
        console.log('[nav] 找到可能的下載頁面');
        
        // 尋找下載相關按鈕
        const downloadInfo = await f.evaluate(() => {
          const buttons = document.querySelectorAll('button, input[type="button"], input[type="submit"], a');
          const found = [];
          
          for (const btn of buttons) {
            const text = (btn.textContent || btn.value || '').trim();
            if (text.includes('下載') || text.includes('媒體') || text.includes('查詢')) {
              found.push({
                text: text.substring(0, 50),
                id: btn.id,
                tag: btn.tagName,
                onclick: btn.onclick?.toString().substring(0, 100)
              });
            }
          }
          return found;
        });
        
        console.log('[nav] 找到下載按鈕:', JSON.stringify(downloadInfo));
        
        // 點擊下載按鈕
        const downloadSuccess = await f.evaluate(() => {
          const buttons = document.querySelectorAll('button, input, a');
          for (const btn of buttons) {
            const text = (btn.textContent || btn.value || '').trim();
            if (text.includes('下載') || (text.includes('查詢') && !text.includes('餘額'))) {
              btn.click();
              return text;
            }
          }
          return null;
        });
        
        if (downloadSuccess) {
          console.log(`[nav] ✅ 觸發下載: ${downloadSuccess}`);
          await delay(5000);
          return true;
        }
      }
    } catch(e) { /* 忽略 frame 錯誤 */ }
  }
  
  return false;
}

async function checkDownloadedFiles(targetDate = null) {
  console.log('[check] 檢查下載的檔案...');
  
  // 取得檔案清單（最近 10 分鐘內的）
  const files = fs.readdirSync(DOWNLOAD_DIR)
    .filter(f => f.startsWith('94256530_NEP01_') && f.endsWith('.TXT'))
    .map(f => ({
      name: f,
      path: path.join(DOWNLOAD_DIR, f),
      mtime: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtime,
    }))
    .filter(f => Date.now() - f.mtime.getTime() < 600000) // 10分鐘內
    .sort((a, b) => b.mtime - a.mtime);
  
  if (files.length === 0) {
    console.log('[check] 沒有新下載的檔案');
    return { newFiles: 0, processed: 0 };
  }
  
  console.log(`[check] 找到 ${files.length} 個新檔案:`, files.map(f => f.name));
  
  // 執行 bankCheck 處理
  try {
    const { bankCheck } = require('./ach_automation.cjs');
    const result = await bankCheck();
    console.log('[check] bankCheck 結果:', result);
    
    return { newFiles: files.length, ...result };
  } catch(e) {
    console.error('[check] bankCheck 錯誤:', e.message);
    return { newFiles: files.length, error: e.message };
  }
}

async function main() {
  const arg = process.argv[2] || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  
  let targetDates = [];
  if (arg === 'pending') {
    // 取得所有有 pending ACH 的日期
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
    await sendTg('ℹ️ 永豐 ACH：沒有 pending 的日期需要處理');
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

  let results = { success: 0, error: 0, totalFiles: 0, totalMatched: 0 };

  try {
    // 登入
    await login(page);
    
    // 導航到下載頁面
    const navSuccess = await navigateToACHDownload(page);
    
    if (navSuccess) {
      // 檢查下載結果
      const checkResult = await checkDownloadedFiles();
      results.totalFiles = checkResult.newFiles || 0;
      results.totalMatched = checkResult.matched || 0;
      
      if (checkResult.error) {
        results.error++;
        console.error('[main] 處理錯誤:', checkResult.error);
      } else {
        results.success++;
      }
      
      // 發送通知
      if (results.totalFiles > 0) {
        await sendTg(
          `✅ 永豐 ACH 自動處理完成\n` +
          `📁 新檔案: ${results.totalFiles} 個\n` +
          `✔️ 比對成功: ${results.totalMatched} 筆\n` +
          `📅 處理日期: ${targetDates.join(', ')}`
        );
      } else {
        await sendTg(`ℹ️ 永豐 ACH：${targetDates.join(', ')} 無新回覆檔`);
      }
    } else {
      await sendTg(`⚠️ 永豐 ACH：無法找到下載頁面，請手動確認`);
    }
    
  } catch(e) {
    console.error('[main] 錯誤:', e.message);
    results.error++;
    await sendTg(`❌ 永豐 ACH 自動下載失敗: ${e.message}`);
  } finally {
    await browser.close();
    await pool.end();
  }
  
  console.log('[main] 最終結果:', results);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { main };