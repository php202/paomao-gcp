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
const SHOT_DIR = '/tmp/sinopac_shots';

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

async function solveCaptcha(imageBuffer) {
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

(async () => {
  const password = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox'],
    defaultViewport: { width: 1280, height: 900 },
  });
  const page = await browser.newPage();

  // Login
  await page.goto(SINOPAC_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);
  await page.screenshot({ path: `${SHOT_DIR}/01_login.png`, fullPage: true });

  const companyInput = await page.$('input[name*="companyId"], input[id*="companyId"], input[placeholder*="用戶"]');
  if (companyInput) { await companyInput.click({ clickCount: 3 }); await companyInput.type(COMPANY_ID, { delay: 30 }); }
  const userInput = await page.$('input[name*="userId"], input[id*="userId"], input[placeholder*="使用者"]');
  if (userInput) { await userInput.click({ clickCount: 3 }); await userInput.type(USERNAME, { delay: 30 }); }
  const pwInput = await page.$('input[type="password"]');
  if (pwInput) { await pwInput.click({ clickCount: 3 }); await pwInput.type(password, { delay: 30 }); }

  const captchaImg = await page.$('img[id*="captcha"], img[src*="captcha"], img[alt*="驗證"]');
  if (captchaImg) {
    const imgBuffer = await captchaImg.screenshot();
    const captchaText = await solveCaptcha(imgBuffer);
    console.log('CAPTCHA:', captchaText);
    const captchaInput = await page.$('input[name*="captcha"], input[id*="captcha"], input[placeholder*="驗證"]');
    if (captchaInput) { await captchaInput.click({ clickCount: 3 }); await captchaInput.type(captchaText, { delay: 30 }); }
  }

  const loginBtn = await page.$('button[type="submit"], input[type="submit"], a[onclick*="login"], button[id*="login"]');
  if (loginBtn) await loginBtn.click();
  await delay(5000);
  await page.screenshot({ path: `${SHOT_DIR}/02_after_login.png`, fullPage: true });

  const content = await page.content();
  if (content.includes('密碼錯誤') || content.includes('驗證碼錯誤') || content.includes('登入失敗')) {
    console.log('LOGIN FAILED');
    await browser.close();
    return;
  }
  console.log('LOGIN OK');

  // Navigate menus - screenshot each step
  const allLinks1 = await page.$$('a, span, li');
  for (const el of allLinks1) {
    const text = await page.evaluate(e => (e.textContent || '').trim(), el);
    if (text === '收款服務' || text.includes('收款服務')) {
      console.log('Found: 收款服務');
      await el.click();
      await delay(3000);
      break;
    }
  }
  await page.screenshot({ path: `${SHOT_DIR}/03_after_collection.png`, fullPage: true });

  const allLinks2 = await page.$$('a, span, li');
  for (const el of allLinks2) {
    const text = await page.evaluate(e => (e.textContent || '').trim(), el);
    if (text.includes('ACH') && text.includes('收付款')) {
      console.log('Found:', text);
      await el.click();
      await delay(3000);
      break;
    }
  }
  await page.screenshot({ path: `${SHOT_DIR}/04_after_ach.png`, fullPage: true });

  const allLinks3 = await page.$$('a, span, li');
  let foundReply = false;
  for (const el of allLinks3) {
    const text = await page.evaluate(e => (e.textContent || '').trim(), el);
    if (text.includes('結果回覆') || text.includes('回覆檔')) {
      console.log('Found:', text);
      await el.click();
      await delay(3000);
      foundReply = true;
      break;
    }
  }
  await page.screenshot({ path: `${SHOT_DIR}/05_reply_page.png`, fullPage: true });

  // Dump the full page HTML to file for analysis
  const html = await page.content();
  fs.writeFileSync(`${SHOT_DIR}/05_page.html`, html);
  
  // Get all visible text
  const bodyText = await page.evaluate(() => document.body.innerText);
  fs.writeFileSync(`${SHOT_DIR}/05_text.txt`, bodyText);

  // Look for any tables, forms, buttons
  const formInfo = await page.evaluate(() => {
    const forms = [...document.querySelectorAll('form')].map(f => ({ action: f.action, id: f.id, class: f.className }));
    const tables = [...document.querySelectorAll('table')].map(t => ({ id: t.id, rows: t.rows.length, class: t.className }));
    const buttons = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a.btn')].map(b => ({ tag: b.tagName, text: b.textContent?.trim() || b.value, id: b.id, onclick: b.getAttribute('onclick')?.substring(0, 100) }));
    const selects = [...document.querySelectorAll('select')].map(s => ({ id: s.id, name: s.name, options: [...s.options].map(o => o.text) }));
    return { forms, tables, buttons, selects };
  });
  fs.writeFileSync(`${SHOT_DIR}/05_elements.json`, JSON.stringify(formInfo, null, 2));
  console.log('Elements:', JSON.stringify(formInfo, null, 2).substring(0, 2000));

  await browser.close();
  console.log('Done. Screenshots in', SHOT_DIR);
})();
