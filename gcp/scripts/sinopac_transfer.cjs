#!/usr/bin/env node
/**
 * 永豐寰宇金融網 — 自動轉帳操作
 * 假設 Chrome 已登入，連接到已有的 Chrome instance
 * 
 * Usage:
 *   node sinopac_transfer.cjs pay --from 666 --to "19201800238686" --bank "807" --branch "1929" --name "泡泡貓股份有限公司" --amount 5971 --memo "台南安南店-INV000061"
 *   node sinopac_transfer.cjs query --account 666 --date 2026-03-13
 * 
 * Environment:
 *   SINOPAC_CDP_PORT  - Chrome DevTools port (default: 18800)
 */

const puppeteer = require('puppeteer-core');
const delay = ms => new Promise(r => setTimeout(r, ms));

const DEBUG_PORT = parseInt(process.env.SINOPAC_CDP_PORT || '18800');

async function getWsUrl() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  const data = await res.json();
  return data.webSocketDebuggerUrl;
}

const ACCOUNTS = {
  '666': '19201800234666',
  '686': '19201800238686',
};

class SinopacTransfer {
  constructor() {
    this.browser = null;
    this.page = null;
    this.mainFrame = null;
  }

  async connect() {
    console.log(`[Sinopac] 連接到 Chrome (port ${DEBUG_PORT})...`);
    try {
      this.browser = await puppeteer.connect({
        browserWSEndpoint: await getWsUrl(),
        defaultViewport: null,
      });
      
      const pages = await this.browser.pages();
      
      // Find the logged-in page (has indexFrame/mainFrame)
      this.page = null;
      for (const p of pages) {
        const frames = p.frames();
        if (frames.some(f => f.name() === 'indexFrame' || f.name() === 'mainFrame')) {
          this.page = p;
          console.log('[Sinopac] 找到已登入的分頁');
          break;
        }
      }
      if (!this.page) {
        this.page = pages.find(p => p.url().includes('sinopac.com')) || pages[0];
        if (!this.page) throw new Error('找不到永豐頁面，請先開啟並登入');
      }
      
      await this.findMainFrame();
      
      // Ensure logged in — if session expired, run ach_full --login-only
      const loggedIn = await this.checkLoggedIn();
      if (!loggedIn) {
        console.log('[Sinopac] Session 過期，執行登入...');
        const { execSync } = require('child_process');
        try {
          execSync('/opt/homebrew/bin/node /Users/paopaomao/paomao-gcp/gcp/scripts/sinopac_ach_full.cjs --login-only',
            { timeout: 90000, encoding: 'utf8', cwd: '/Users/paopaomao/paomao-gcp/gcp/scripts' });
          console.log('[Sinopac] 登入完成，重新連接...');
          // Re-find frames after login
          await delay(3000);
          await this.findMainFrame();
        } catch (loginErr) {
          console.error('[Sinopac] 自動登入失敗:', loginErr.message?.substring(0, 200));
          throw new Error('永豐未登入且自動登入失敗: ' + loginErr.message?.substring(0, 100));
        }
      }
      
      console.log('[Sinopac] ✅ 連接成功');
      
    } catch (e) {
      console.error('[Sinopac] 連接失敗:', e.message);
      throw e;
    }
  }
  
  async checkLoggedIn() {
    try {
      const frames = this.page.frames();
      const indexFrame = frames.find(f => f.name() === 'indexFrame');
      const mainFrame = frames.find(f => f.name() === 'mainFrame');
      if (indexFrame && mainFrame && !mainFrame.url().includes('CCMOTLGIN')) {
        console.log('[Sinopac] ✅ Session 有效');
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  async findMainFrame() {
    await delay(1000);
    const frames = this.page.frames();
    
    let indexFrame = frames.find(f => f.name() === 'indexFrame');
    if (indexFrame) {
      await delay(1000);
      const childFrames = indexFrame.childFrames();
      this.mainFrame = childFrames.find(f => f.name() === 'mainFrame') || childFrames[0];
    }
    
    if (!this.mainFrame) {
      this.mainFrame = frames.find(f => f.name() === 'mainFrame') || this.page.mainFrame();
    }
    
    console.log(`[Sinopac] 使用 frame: ${this.mainFrame.name() || 'main'} url=${this.mainFrame.url().slice(0, 60)}`);
  }

  async navigateToMenu(menuPath) {
    console.log(`[Sinopac] 導航到: ${menuPath.join(' > ')}`);
    
    const indexFrame = this.page.frames().find(f => f.name() === 'indexFrame');
    if (!indexFrame) throw new Error('找不到 indexFrame，請確認已登入');
    
    for (let i = 0; i < menuPath.length; i++) {
      const menuText = menuPath[i];
      await delay(800);
      
      const clicked = await indexFrame.evaluate((text) => {
        const links = document.querySelectorAll('a');
        for (const a of links) {
          if (a.textContent.trim() === text) { a.click(); return a.textContent.trim(); }
        }
        for (const a of links) {
          if (a.textContent.trim().includes(text)) { a.click(); return a.textContent.trim(); }
        }
        return null;
      }, menuText);
      
      if (clicked) {
        console.log(`[Sinopac] 點擊: ${clicked}`);
      } else {
        console.warn(`[Sinopac] 找不到選單項目: ${menuText}`);
      }
      await delay(1500);
    }
    
    // Wait for mainFrame to load new content
    await delay(3000);
    let retries = 15;
    while (retries-- > 0) {
      const mf = this.page.frames().find(f => f.name() === 'mainFrame');
      if (mf && !mf.url().includes('blank.html')) {
        this.mainFrame = mf;
        console.log(`[Sinopac] mainFrame 已載入: ${mf.url().slice(0, 80)}`);
        await delay(2000);
        return;
      }
      await delay(1000);
    }
    console.warn('[Sinopac] mainFrame 載入超時');
    await this.findMainFrame();
  }

  /** PrimeFaces dropdown: click label → find panel items → click matching (with retry) */
  async selectDropdown(formField, optionText, maxRetries = 3) {
    console.log(`[Sinopac] 選擇: ${formField} → ${optionText}`);
    const esc = formField.replace(/:/g, '\\:');
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Wait for element to be available
        await this.mainFrame.waitForSelector(`#${esc}_label`, { visible: true, timeout: 10000 });
        await delay(500);
        await this.mainFrame.click(`#${esc}_label`);
        await delay(1000);
        break; // success
      } catch (e) {
        if (attempt < maxRetries) {
          console.log(`[Sinopac]   dropdown click retry (${attempt}/${maxRetries}): ${e.message.substring(0, 60)}`);
          await delay(2000);
        } else throw new Error(`❌ No element found for selector: #${esc}_label (${maxRetries} retries)`);
      }
    }
    
    // Find matching item in the panel
    const items = await this.mainFrame.$$(`#${esc}_panel .ui-selectonemenu-item`);
    console.log(`[Sinopac]   panel items: ${items.length}`);
    
    let found = false;
    for (const item of items) {
      const text = await item.evaluate(el => el.textContent.trim());
      if (text.includes(optionText)) {
        await item.click();
        console.log(`[Sinopac]   選中: ${text}`);
        found = true;
        await delay(1500);
        break;
      }
    }
    
    if (!found) {
      // Fallback: try broader search (all visible selectonemenu items)
      const allItems = await this.mainFrame.$$('.ui-selectonemenu-item');
      for (const item of allItems) {
        const text = await item.evaluate(el => el.textContent.trim());
        if (text.includes(optionText)) {
          await item.click();
          console.log(`[Sinopac]   選中(fallback): ${text}`);
          found = true;
          await delay(1500);
          break;
        }
      }
    }
    
    if (!found) throw new Error(`找不到下拉選項: ${optionText} (field: ${formField})`);
  }

  async fillInput(formField, value) {
    console.log(`[Sinopac] 填入: ${formField} = ${value}`);
    const esc = formField.replace(/:/g, '\\:');
    const input = await this.mainFrame.$(`#${esc}`);
    if (!input) throw new Error(`找不到輸入框: ${formField}`);
    
    await input.click({ clickCount: 3 });
    await delay(200);
    await input.type(value.toString(), { delay: 50 });
    await delay(500);
  }

  /** Click button/link by text content — with retry + waitForVisible */
  async clickByText(text, maxRetries = 5) {
    console.log(`[Sinopac] 點擊: ${text}`);
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Wait for any PrimeFaces ajax to complete
        await this.mainFrame.evaluate(() => {
          return new Promise(r => {
            if (typeof PrimeFaces !== 'undefined' && PrimeFaces.ajax?.Queue?.isEmpty?.() === false) {
              const t = setInterval(() => { if (PrimeFaces.ajax.Queue.isEmpty()) { clearInterval(t); r(); } }, 200);
              setTimeout(() => { clearInterval(t); r(); }, 5000);
            } else r();
          });
        }).catch(() => {});

        const clicked = await this.mainFrame.evaluate((targetText) => {
          const candidates = document.querySelectorAll('button, a, input[type="submit"], input[type="button"], .btn, .ui-commandlink');
          for (const el of candidates) {
            const t = (el.textContent || el.value || '').trim();
            if (t === targetText || t.includes(targetText)) {
              // Check visible + enabled
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              if (el.disabled) continue;
              el.click();
              return el.tagName + '#' + el.id + ': ' + t;
            }
          }
          return null;
        }, text);
        
        if (clicked) {
          console.log(`[Sinopac]   clicked: ${clicked}${attempt > 1 ? ' (attempt ' + attempt + ')' : ''}`);
          return clicked;
        }
        
        if (attempt < maxRetries) {
          console.log(`[Sinopac]   找不到「${text}」，等 2 秒重試 (${attempt}/${maxRetries})`);
          await delay(2000);
        }
      } catch (e) {
        if (attempt < maxRetries) {
          console.log(`[Sinopac]   clickByText error: ${e.message.substring(0, 80)}，重試 (${attempt}/${maxRetries})`);
          await delay(2000);
        } else throw e;
      }
    }
    throw new Error(`找不到按鈕: ${text} (重試 ${maxRetries} 次)`);
  }

  /** Extract case number from confirmation/result page */
  async extractCaseNumber() {
    return await this.mainFrame.evaluate(() => {
      const text = document.body.innerText;
      const match = text.match(/案件編號\s*[\n\t]*(\d+)/);
      return match ? match[1] : null;
    });
  }

  /** Extract result message from page */
  async extractResult() {
    return await this.mainFrame.evaluate(() => {
      const text = document.body.innerText;
      if (text.includes('已送審')) return { success: true, message: '已送審，請洽主管審核/放行' };
      if (text.includes('成功')) return { success: true, message: '操作成功' };
      if (text.includes('錯誤') || text.includes('失敗')) {
        const m = text.match(/錯誤[：:]\s*([^\n]+)/) || text.match(/失敗[：:]\s*([^\n]+)/);
        return { success: false, message: m ? m[1] : '操作失敗' };
      }
      return { success: null, message: text.substring(0, 200) };
    });
  }

  // ══════════════════════════════════════════════════
  // 臺幣單筆付款 (666→686 or 686→外部)
  // 自動判斷：同行(807)走轉帳，他行走通匯
  // ══════════════════════════════════════════════════
  async pay(fromAccount, toAccount, bankCode, branchCode, accountName, amount, memo) {
    const isSameBank = bankCode === '807';
    const payMethod = isSameBank ? '臺幣單筆付款' : '臺幣單筆付款'; // 同一頁面，通匯靠下拉選
    console.log(`[Sinopac] === ${isSameBank ? '同行轉帳' : '跨行通匯'} ===`);
    console.log(`[Sinopac] ${fromAccount} → ${toAccount}, bank=${bankCode}, $${amount}, memo=${memo}`);
    
    // 防呆：先確保 mainFrame 在乾淨狀態（回到首頁或待命頁）
    try {
      const currentUrl = this.mainFrame?.url() || '';
      if (currentUrl.includes('PayTransfer') || currentUrl.includes('confirm') || currentUrl.includes('result')) {
        console.log('[Sinopac] mainFrame 還在上一筆頁面，重新導航');
      }
    } catch (_) {}
    
    // Step 1: Navigate to 臺幣單筆付款
    await this.navigateToMenu(['付款轉帳', '轉帳付款', '臺幣單筆付款']);
    
    // Step 2: Fill form
    // 付款帳號
    await this.selectDropdown('form:payerAccountCombo', ACCOUNTS[fromAccount] || fromAccount);
    
    // 跨行(非807)：指定付款通路 → FXML (radio button)
    if (!isSameBank) {
      console.log('[Sinopac] 跨行匯款 → 選擇 FXML radio button');
      try {
        const clicked = await this.mainFrame.evaluate(() => {
          // 方法1：找 label 文字包含「FXML」的 radio
          const labels = document.querySelectorAll('label');
          for (const label of labels) {
            if (label.textContent.trim().includes('FXML')) {
              label.click();
              return 'label-click: ' + label.textContent.trim();
            }
          }
          // 方法2：找 radio input value 含 FXML
          const radios = document.querySelectorAll('input[type="radio"]');
          for (const radio of radios) {
            const parent = radio.closest('td, div, span');
            if (parent && parent.textContent.includes('FXML')) {
              radio.click();
              return 'radio-click';
            }
          }
          // 方法3：PrimeFaces selectOneRadio
          const items = document.querySelectorAll('.ui-radiobutton, .ui-selectoneradio td');
          for (const item of items) {
            if (item.textContent.includes('FXML')) {
              const box = item.querySelector('.ui-radiobutton-box, .ui-radiobutton-icon, input');
              if (box) { box.click(); return 'pf-radio-click'; }
              item.click();
              return 'item-click';
            }
          }
          return null;
        });
        console.log(`[Sinopac] FXML 選擇結果: ${clicked || '未找到'}`);
        await delay(2000);
      } catch (e) {
        console.warn(`[Sinopac] ⚠️ FXML radio 選擇失敗: ${e.message}`);
      }
    }
    
    // 交易金額
    await this.fillInput('form:txAmt_input', String(Math.round(amount)));
    
    // 收款帳號
    await this.fillInput('form:payeeAccountNo', ACCOUNTS[toAccount] || toAccount);
    
    // 銀行
    if (bankCode) {
      await this.selectDropdown('form:payeeBankCombo', `(${bankCode})`);
      await delay(2000); // Wait for branch list to load
    }
    
    // 分行
    if (branchCode) {
      try {
        await this.selectDropdown('form:payeeBranchCombo', branchCode);
      } catch (e) {
        console.log(`[Sinopac] 分行跳過(可能已自動帶入): ${e.message}`);
      }
    }
    
    // 收款人戶名
    if (accountName) {
      await this.fillInput('form:payeeName', accountName);
    }
    
    // 付款備註/匯款附言
    if (memo) {
      await this.fillInput('form:payeeMemo', memo);
    }
    
    // Step 3: 送審 (first submit → confirmation page)
    console.log('[Sinopac] --- Step 3: 送審 ---');
    await this.clickByText('送審');
    await delay(5000);
    
    // Step 4: 確認頁 → extract case number → 確定送審
    console.log('[Sinopac] --- Step 4: 確定送審 ---');
    const caseNumber = await this.extractCaseNumber();
    console.log(`[Sinopac] 案件編號: ${caseNumber || '(未取得)'}`);
    
    await this.clickByText('確定送審');
    await delay(5000);
    
    // Step 5: Extract final result
    const result = await this.extractResult();
    console.log(`[Sinopac] 結果: ${JSON.stringify(result)}`);
    
    return {
      action: 'pay',
      from: fromAccount,
      to: toAccount,
      bank: bankCode,
      branch: branchCode,
      name: accountName,
      amount: amount,
      memo: memo,
      caseNumber: caseNumber,
      ...result,
    };
  }

  // ══════════════════════════════════════════════════
  // 查詢交易明細
  // ══════════════════════════════════════════════════
  async query(account, date) {
    console.log(`[Sinopac] === 帳戶查詢 === ${account}, ${date}`);
    
    await this.navigateToMenu(['帳戶查詢', '帳戶交易明細查詢']);
    
    await this.selectDropdown('form:queryAcctCombo', ACCOUNTS[account] || account);
    
    if (date) {
      const dateStr = date.replace(/-/g, '/');
      await this.fillInput('form:startDate', dateStr);
      await this.fillInput('form:endDate', dateStr);
    }
    
    await this.clickByText('查詢');
    await delay(5000);
    
    const transactions = await this.mainFrame.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      return Array.from(rows).map(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length > 3) {
          return {
            date: cells[0]?.textContent?.trim(),
            description: cells[1]?.textContent?.trim(),
            amount: cells[2]?.textContent?.trim(),
            balance: cells[3]?.textContent?.trim(),
          };
        }
        return null;
      }).filter(Boolean);
    });
    
    return { action: 'query', account, date, transactions, count: transactions.length };
  }

  async disconnect() {
    if (this.browser) {
      this.browser.disconnect();
      console.log('[Sinopac] 已斷開');
    }
  }
}

// ══════════════════════════════════════════════════
// CLI
// ══════════════════════════════════════════════════
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`永豐寰宇金融網 自動轉帳工具
    
Usage:
  node sinopac_transfer.cjs pay --from 666 --to 19201800238686 --bank 807 --branch 1929 --name "泡泡貓股份有限公司" --amount 5971 --memo "台南安南-INV061"
  node sinopac_transfer.cjs query --account 666 --date 2026-03-13

Env:
  SINOPAC_CDP_PORT  Chrome DevTools port (default: 18800)`);
    process.exit(1);
  }
  
  const action = args[0];
  const options = {};
  for (let i = 1; i < args.length; i += 2) {
    if (args[i].startsWith('--')) {
      options[args[i].substring(2)] = args[i + 1];
    }
  }
  
  const sinopac = new SinopacTransfer();
  
  try {
    await sinopac.connect();
    
    let result;
    switch (action) {
      case 'pay':
        if (!options.from || !options.to || !options.amount) throw new Error('缺少: --from, --to, --amount');
        result = await sinopac.pay(options.from, options.to, options.bank, options.branch, options.name, Number(options.amount), options.memo);
        break;
      case 'query':
        if (!options.account) throw new Error('缺少: --account');
        result = await sinopac.query(options.account, options.date);
        break;
      default:
        throw new Error(`未知操作: ${action}`);
    }
    
    console.log('\n' + JSON.stringify(result));
    
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    console.log(JSON.stringify({ success: false, error: e.message }));
    process.exit(1);
  } finally {
    await sinopac.disconnect();
  }
}

if (require.main === module) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}

module.exports = { SinopacTransfer };
