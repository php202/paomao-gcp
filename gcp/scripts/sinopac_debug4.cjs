const puppeteer = require('puppeteer');
const delay = ms => new Promise(r => setTimeout(r, ms));
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');

const SINOPAC_URL = 'https://b2b.sinopac.com/B2B/index.xhtml';
const COMPANY_ID = '94256530';
const USERNAME = 'openclew888';
const PASSWORD_FILE = path.join(process.env.HOME, '.openclaw/secrets/sinopac-password.txt');
const AI_KEYS_FILE = path.join(process.env.HOME, '.openclaw/secrets/ai-api-keys.json');
const SHOT_DIR = '/tmp/sinopac_shots4';
const DOWNLOAD_DIR = path.join(process.env.HOME, 'Downloads');

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

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

async function getLoginFrame(page) {
  const el = await page.$('#indexFrame');
  if (el) return el.contentFrame();
  return null;
}

(async () => {
  const password = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox'],
    defaultViewport: { width: 1280, height: 900 },
  });
  const page = await browser.newPage();

  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow', downloadPath: DOWNLOAD_DIR,
  });

  await page.goto(SINOPAC_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  let frame = await getLoginFrame(page);
  if (!frame) { console.log('No iframe'); await browser.close(); return; }

  // Use frame.type() with proper selectors (PrimeFaces needs real keyboard events)
  await frame.click('#form\\:txtCustId', { clickCount: 3 });
  await frame.type('#form\\:txtCustId', COMPANY_ID, { delay: 40 });

  await frame.click('#form\\:txtUserId', { clickCount: 3 });
  await frame.type('#form\\:txtUserId', USERNAME, { delay: 40 });

  await frame.click('#form\\:txtUserPwd', { clickCount: 3 });
  await frame.type('#form\\:txtUserPwd', password, { delay: 40 });

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

  if (captchaBase64) {
    fs.writeFileSync(`${SHOT_DIR}/captcha.png`, Buffer.from(captchaBase64, 'base64'));
    const captchaText = await solveCaptcha(captchaBase64);
    console.log('CAPTCHA:', captchaText);
    await frame.click('#form\\:captchaInput', { clickCount: 3 });
    await frame.type('#form\\:captchaInput', captchaText, { delay: 40 });
  }

  await page.screenshot({ path: `${SHOT_DIR}/01_filled.png` });

  // Click login - use the actual login button (find by text "登入")
  await frame.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      const text = (b.textContent || '').trim();
      if (text === '登入' || text.includes('登入')) { b.click(); return; }
    }
  });

  // Wait for navigation
  console.log('Waiting for login...');
  await delay(10000);
  
  await page.screenshot({ path: `${SHOT_DIR}/02_after_login.png` });

  // After login, the iframe URL should change. Re-grab frames.
  const allFrames = page.frames();
  console.log('All frames:', allFrames.map(f => f.url().substring(0, 100)));

  // Find the main content frame (after login it becomes a frameset)
  let mainFrame = null;
  for (const f of allFrames) {
    const url = f.url();
    if (url.includes('about:blank') || url === page.mainFrame().url()) continue;
    try {
      const text = await f.evaluate(() => document.body?.innerText?.substring(0, 200) || '');
      console.log(`Frame ${url.substring(0, 80)}: "${text.substring(0, 100)}"`);
      if (text.includes('收款') || text.includes('付款') || text.includes('帳務') || text.includes('ACH')) {
        mainFrame = f;
      }
    } catch(e) {
      console.log(`Frame ${url.substring(0, 80)}: error - ${e.message.substring(0, 50)}`);
    }
  }

  // Also check if there are nested iframes inside the indexFrame
  frame = await getLoginFrame(page);
  if (frame) {
    const frameUrl = frame.url();
    console.log('indexFrame URL after login:', frameUrl);
    
    try {
      const innerHtml = await frame.content();
      fs.writeFileSync(`${SHOT_DIR}/02_indexframe.html`, innerHtml);
      
      // Check for nested frames/iframes
      const nested = await frame.evaluate(() => {
        const els = document.querySelectorAll('frame, iframe');
        return [...els].map(e => ({ tag: e.tagName, id: e.id, name: e.name, src: e.src?.substring(0, 120) }));
      });
      console.log('Nested frames in indexFrame:', JSON.stringify(nested, null, 2));
      
      // Get body text
      const bodyText = await frame.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
      console.log('indexFrame body:', bodyText.substring(0, 300));
    } catch(e) {
      console.log('indexFrame access error:', e.message.substring(0, 100));
    }
  }

  // Try to find menu frame and content frame
  for (const f of allFrames) {
    const url = f.url();
    if (url.includes('MENU') || url.includes('menu') || url.includes('MAIN') || url.includes('main') || url.includes('left') || url.includes('top') || url.includes('header')) {
      console.log(`\n=== Interesting frame: ${url} ===`);
      try {
        const text = await f.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
        console.log(text.substring(0, 400));
      } catch(e) {}
    }
  }

  await browser.close();
  console.log('\nDone. Screenshots in', SHOT_DIR);
})();
