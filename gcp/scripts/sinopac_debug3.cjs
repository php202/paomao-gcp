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
const SHOT_DIR = '/tmp/sinopac_shots3';
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
        { type: 'text', text: '請辨識這個驗證碼圖片中的文字。只回覆驗證碼本身，不要加任何說明。驗證碼通常是4-6個英數字。' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }
      ]
    }],
    max_tokens: 20,
  });
  return (response.choices[0]?.message?.content || '').trim().replace(/[^a-zA-Z0-9]/g, '');
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

  // Get login iframe
  const iframeEl = await page.$('#indexFrame');
  const frame = await iframeEl.contentFrame();
  if (!frame) { console.log('No iframe'); await browser.close(); return; }

  // Dump all inputs in iframe
  const inputs = await frame.evaluate(() => {
    return [...document.querySelectorAll('input, select, button, img')].map(el => ({
      tag: el.tagName, type: el.type, id: el.id, name: el.name, 
      class: el.className, src: el.src?.substring(0, 80), 
      placeholder: el.placeholder, value: el.value?.substring(0, 20),
      text: el.textContent?.substring(0, 30),
    }));
  });
  console.log('Inputs in iframe:', JSON.stringify(inputs, null, 2));

  // Fill using evaluate (bypass click issues)
  await frame.evaluate((cid, uid, pw) => {
    const inputs = document.querySelectorAll('input');
    for (const inp of inputs) {
      if (inp.name?.includes('companyId') || inp.id?.includes('companyId')) {
        inp.value = cid; inp.dispatchEvent(new Event('input', {bubbles:true})); inp.dispatchEvent(new Event('change', {bubbles:true}));
      }
      if (inp.name?.includes('userId') || inp.id?.includes('userId')) {
        inp.value = uid; inp.dispatchEvent(new Event('input', {bubbles:true})); inp.dispatchEvent(new Event('change', {bubbles:true}));
      }
      if (inp.type === 'password') {
        inp.value = pw; inp.dispatchEvent(new Event('input', {bubbles:true})); inp.dispatchEvent(new Event('change', {bubbles:true}));
      }
    }
  }, COMPANY_ID, USERNAME, password);

  // Get captcha image as base64 via canvas
  const captchaBase64 = await frame.evaluate(() => {
    const img = document.querySelector('img[id*="captcha"], img[src*="captcha"], img[alt*="驗證"]');
    if (!img) return null;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  
  if (captchaBase64) {
    fs.writeFileSync(`${SHOT_DIR}/captcha.png`, Buffer.from(captchaBase64, 'base64'));
    const captchaText = await solveCaptcha(captchaBase64);
    console.log('CAPTCHA:', captchaText);
    
    await frame.evaluate((val) => {
      const inp = document.querySelector('input[name*="captcha"], input[id*="captcha"], input[placeholder*="驗證"]');
      if (inp) { inp.value = val; inp.dispatchEvent(new Event('input', {bubbles:true})); inp.dispatchEvent(new Event('change', {bubbles:true})); }
    }, captchaText);
  }

  await page.screenshot({ path: `${SHOT_DIR}/01_filled.png` });

  // Click login button
  await frame.evaluate(() => {
    const btns = document.querySelectorAll('button, input[type="submit"], a');
    for (const b of btns) {
      if ((b.textContent || '').includes('登入') || (b.value || '').includes('登入')) {
        b.click(); return true;
      }
    }
    // Try form submit
    const form = document.querySelector('form');
    if (form) { form.submit(); return true; }
    return false;
  });
  
  await delay(8000);
  await page.screenshot({ path: `${SHOT_DIR}/02_after_login.png` });

  // Check frames
  const allFrames = page.frames();
  console.log('All frames after login:', allFrames.map(f => f.url()));

  // Check if we're still on login or moved to main
  for (const f of allFrames) {
    if (f === page.mainFrame()) continue;
    const url = f.url();
    if (url.includes('about:blank')) continue;
    console.log(`Frame: ${url}`);
    try {
      const text = await f.evaluate(() => document.body?.innerText?.substring(0, 300) || '');
      console.log(`  Text: ${text.substring(0, 200)}`);
    } catch(e) { console.log(`  Error: ${e.message}`); }
  }

  // If login succeeded, the iframe should have changed
  const frame2 = await (await page.$('#indexFrame'))?.contentFrame();
  if (frame2) {
    console.log('indexFrame URL:', frame2.url());
    
    // Check for frameset inside
    const innerFrames = await frame2.evaluate(() => {
      const frames = document.querySelectorAll('frame, iframe');
      return [...frames].map(f => ({ id: f.id, name: f.name, src: f.src }));
    });
    console.log('Inner frames:', JSON.stringify(innerFrames));
    
    // Get all links/menu items
    const menuItems = await frame2.evaluate(() => {
      return [...document.querySelectorAll('a, span, div, li, td')].filter(el => {
        const t = (el.textContent || '').trim();
        return t.length > 0 && t.length < 30 && (t.includes('收款') || t.includes('ACH') || t.includes('帳務') || t.includes('付款') || t.includes('查詢'));
      }).map(el => ({ tag: el.tagName, text: (el.textContent||'').trim().substring(0, 50), id: el.id, href: el.href?.substring(0, 80) }));
    });
    console.log('Menu items:', JSON.stringify(menuItems, null, 2));
    
    const html = await frame2.content();
    fs.writeFileSync(`${SHOT_DIR}/02_page.html`, html);
  }

  await browser.close();
  console.log('Done');
})();
