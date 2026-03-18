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
const SHOT_DIR = '/tmp/sinopac_shots2';

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

  // Download setup
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: path.join(process.env.HOME, 'Downloads'),
  });

  await page.goto(SINOPAC_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  // Get into the iframe!
  const frames = page.frames();
  console.log('Frames:', frames.map(f => f.url()));
  
  let loginFrame = frames.find(f => f.url().includes('CCMOTLGIN'));
  if (!loginFrame) {
    // Try by name
    const iframeEl = await page.$('#indexFrame');
    if (iframeEl) loginFrame = await iframeEl.contentFrame();
  }
  
  if (!loginFrame) {
    console.log('ERROR: Cannot find login iframe');
    await browser.close();
    return;
  }
  console.log('Found login iframe:', loginFrame.url());

  // Screenshot the iframe content
  await page.screenshot({ path: `${SHOT_DIR}/01_main.png`, fullPage: true });

  // Fill login form INSIDE iframe
  const companyInput = await loginFrame.$('input[name*="companyId"], input[id*="companyId"], input[placeholder*="用戶"]');
  console.log('companyInput found:', !!companyInput);
  if (companyInput) { await companyInput.click({ clickCount: 3 }); await companyInput.type(COMPANY_ID, { delay: 30 }); }

  const userInput = await loginFrame.$('input[name*="userId"], input[id*="userId"], input[placeholder*="使用者"]');
  console.log('userInput found:', !!userInput);
  if (userInput) { await userInput.click({ clickCount: 3 }); await userInput.type(USERNAME, { delay: 30 }); }

  const pwInput = await loginFrame.$('input[type="password"]');
  console.log('pwInput found:', !!pwInput);
  if (pwInput) { await pwInput.click({ clickCount: 3 }); await pwInput.type(password, { delay: 30 }); }

  // CAPTCHA
  const captchaImg = await loginFrame.$('img[id*="captcha"], img[src*="captcha"], img[alt*="驗證"]');
  console.log('captchaImg found:', !!captchaImg);
  if (captchaImg) {
    const imgBuffer = await captchaImg.screenshot();
    fs.writeFileSync(`${SHOT_DIR}/captcha.png`, imgBuffer);
    const captchaText = await solveCaptcha(imgBuffer);
    console.log('CAPTCHA solved:', captchaText);
    const captchaInput = await loginFrame.$('input[name*="captcha"], input[id*="captcha"], input[placeholder*="驗證"]');
    if (captchaInput) { await captchaInput.click({ clickCount: 3 }); await captchaInput.type(captchaText, { delay: 30 }); }
  }
  
  await page.screenshot({ path: `${SHOT_DIR}/02_filled.png`, fullPage: true });

  // Submit
  const loginBtn = await loginFrame.$('button[type="submit"], input[type="submit"], a[onclick*="login"], button[id*="login"], .btn-primary, button.btn');
  console.log('loginBtn found:', !!loginBtn);
  if (loginBtn) {
    const btnText = await loginFrame.evaluate(el => el.textContent, loginBtn);
    console.log('loginBtn text:', btnText);
    await loginBtn.click();
  }
  await delay(8000);
  await page.screenshot({ path: `${SHOT_DIR}/03_after_login.png`, fullPage: true });

  // Check all frames after login
  const frames2 = page.frames();
  console.log('Frames after login:', frames2.map(f => f.url()));

  // Find the main content frame (might be different after login)
  let mainFrame = frames2.find(f => f.url().includes('CCMOTMAIN') || f.url().includes('main'));
  if (!mainFrame) mainFrame = frames2.find(f => f !== page.mainFrame() && !f.url().includes('about:blank'));
  
  if (mainFrame) {
    console.log('Main frame found:', mainFrame.url());
    const bodyText = await mainFrame.evaluate(() => document.body?.innerText || '');
    fs.writeFileSync(`${SHOT_DIR}/03_text.txt`, bodyText);
    console.log('Page text (first 500):', bodyText.substring(0, 500));
    
    // Get page HTML structure
    const html = await mainFrame.content();
    fs.writeFileSync(`${SHOT_DIR}/03_page.html`, html);
  } else {
    // Try the indexFrame again
    const iframeEl = await page.$('#indexFrame');
    if (iframeEl) {
      const frame = await iframeEl.contentFrame();
      if (frame) {
        const bodyText = await frame.evaluate(() => document.body?.innerText || '');
        fs.writeFileSync(`${SHOT_DIR}/03_text.txt`, bodyText);
        console.log('indexFrame text (first 500):', bodyText.substring(0, 500));
      }
    }
  }

  await browser.close();
  console.log('Done. Screenshots in', SHOT_DIR);
})();
