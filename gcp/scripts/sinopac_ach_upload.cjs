#!/usr/bin/env node
/**
 * 永豐寰宇金融網 — ACH 檔案自動上傳
 * 假設 Chrome 已登入，連接到已有的 Chrome instance (SinopacProfile)
 * 
 * Usage:
 *   node sinopac_ach_upload.cjs --file /tmp/94256530_P01_1150313.txt
 * 
 * Environment:
 *   SINOPAC_CDP_PORT  - Chrome DevTools port (default: 18800)
 * 
 * 流程 (學自 Robby 2026/03/13 操作):
 *   1. 收款服務 → ACH收付款 → ACH檔案上傳
 *   2. 交易類別: 代收/代付
 *   3. 交易型態: ACH即時(eACH)
 *   4. 格式: 新格式
 *   5. 選擇檔案 → 上傳
 *   6. 檢核成功 → 送審
 *   7. 記錄案件編號
 */

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const delay = ms => new Promise(r => setTimeout(r, ms));

const DEBUG_PORT = parseInt(process.env.SINOPAC_CDP_PORT || '18800');

async function getWsUrl() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  const data = await res.json();
  return data.webSocketDebuggerUrl;
}

class SinopacAchUpload {
  constructor() {
    this.browser = null;
    this.page = null;
    this.mainFrame = null;
  }

  async connect() {
    console.log(`[ACH] 連接到 Chrome (port ${DEBUG_PORT})...`);
    this.browser = await puppeteer.connect({
      browserWSEndpoint: await getWsUrl(),
      defaultViewport: null,
    });

    const pages = await this.browser.pages();
    this.page = null;
    for (const p of pages) {
      const frames = p.frames();
      if (frames.some(f => f.name() === 'indexFrame' || f.name() === 'mainFrame')) {
        this.page = p;
        console.log('[ACH] 找到已登入的分頁');
        break;
      }
    }
    if (!this.page) {
      this.page = pages.find(p => p.url().includes('sinopac.com')) || pages[0];
      if (!this.page) throw new Error('找不到永豐頁面，請先開啟並登入');
    }

    await this.findMainFrame();
    console.log('[ACH] ✅ 連接成功');
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
    console.log(`[ACH] 使用 frame: ${this.mainFrame.name() || 'main'} url=${this.mainFrame.url().slice(0, 60)}`);
  }

  async navigateToMenu(menuPath) {
    console.log(`[ACH] 導航到: ${menuPath.join(' > ')}`);
    const indexFrame = this.page.frames().find(f => f.name() === 'indexFrame');
    if (!indexFrame) throw new Error('找不到 indexFrame，請確認已登入');

    for (const menuText of menuPath) {
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
      if (clicked) console.log(`[ACH] 點擊: ${clicked}`);
      else console.warn(`[ACH] 找不到選單: ${menuText}`);
      await delay(1500);
    }

    // Wait for mainFrame to load
    await delay(3000);
    let retries = 15;
    while (retries-- > 0) {
      const mf = this.page.frames().find(f => f.name() === 'mainFrame');
      if (mf && !mf.url().includes('blank.html')) {
        this.mainFrame = mf;
        console.log(`[ACH] mainFrame 已載入: ${mf.url().slice(0, 80)}`);
        await delay(2000);
        return;
      }
      await delay(1000);
    }
    console.warn('[ACH] mainFrame 載入超時');
    await this.findMainFrame();
  }

  /** Click a radio button by its ID */
  async selectRadioById(radioId) {
    console.log(`[ACH] 選擇 radio: ${radioId}`);
    const esc = radioId.replace(/:/g, '\\:');
    const result = await this.mainFrame.evaluate((id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      el.click();
      // PrimeFaces: also trigger change event
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { id: el.id, value: el.value, checked: el.checked };
    }, radioId);
    if (!result) throw new Error(`找不到 radio: ${radioId}`);
    console.log(`[ACH]   selected: ${JSON.stringify(result)}`);
    await delay(1500);
  }

  /** Click button/link in popup dialog frames (PrimeFaces dialogs live in separate iframes) */
  async clickInPopupFrame(text) {
    // 先檢查主框架中的對話框
    try {
      const mainFrameResult = await this.mainFrame.evaluate((targetText) => {
        // 查找對話框中的按鈕
        const dialogButtons = document.querySelectorAll('.ui-dialog button, .ui-confirm-dialog button, [role="dialog"] button');
        for (const btn of dialogButtons) {
          const t = (btn.textContent || btn.value || '').trim();
          if (t === targetText) {
            btn.click();
            return `MAIN_FRAME: ${btn.tagName}#${btn.id}: ${t}`;
          }
        }
        
        // 備用：所有按鈕
        const allButtons = document.querySelectorAll('a, button, input[type="submit"], input[type="button"]');
        for (const el of allButtons) {
          const t = (el.textContent || el.value || '').trim();
          if (t === targetText && el.offsetParent !== null) { // 只點擊可見的元素
            el.click();
            return `MAIN_FRAME: ${el.tagName}#${el.id}: ${t}`;
          }
        }
        return null;
      }, text);
      
      if (mainFrameResult) {
        console.log(`[ACH]   popup clicked in main: ${mainFrameResult}`);
        return mainFrameResult;
      }
    } catch (e) {
      console.log(`[ACH]   main frame click error: ${e.message}`);
    }
    
    // 再檢查其他框架
    for (const frame of this.page.frames()) {
      try {
        const clicked = await frame.evaluate((targetText) => {
          const els = document.querySelectorAll('a, button, input[type="submit"], input[type="button"]');
          for (const el of els) {
            const t = (el.textContent || el.value || '').trim();
            if (t === targetText && el.offsetParent !== null) {
              el.click();
              return `FRAME: ${el.tagName}#${el.id}: ${t} (${document.title || frame.url})`;
            }
          }
          return null;
        }, text);
        if (clicked) {
          console.log(`[ACH]   popup clicked in frame: ${clicked}`);
          return clicked;
        }
      } catch (e) {
        // 這個框架可能不可存取，繼續下一個
      }
    }
    return null;
  }

  /** Click button/link by text */
  async clickByText(text) {
    console.log(`[ACH] 點擊按鈕: ${text}`);
    const clicked = await this.mainFrame.evaluate((targetText) => {
      const candidates = document.querySelectorAll('button, a, input[type="submit"], input[type="button"], .btn, .ui-commandlink, .ui-button');
      for (const el of candidates) {
        const t = (el.textContent || el.value || '').trim();
        if (t === targetText || t.includes(targetText)) {
          el.click();
          return el.tagName + '#' + el.id + ': ' + t;
        }
      }
      return null;
    }, text);
    if (!clicked) throw new Error(`找不到按鈕: ${text}`);
    console.log(`[ACH]   clicked: ${clicked}`);
    return clicked;
  }

  /** Extract case number from result page */
  async extractCaseNumber() {
    return await this.mainFrame.evaluate(() => {
      const text = document.body.innerText;
      // Try various patterns
      const patterns = [
        /案件編號\s*[：:]*\s*(\d+)/,
        /案號\s*[：:]*\s*(\d+)/,
        /交易編號\s*[：:]*\s*(\d+)/,
      ];
      for (const p of patterns) {
        const m = text.match(p);
        if (m) return m[1];
      }
      return null;
    });
  }

  /** Get page text for debugging */
  async getPageText() {
    return await this.mainFrame.evaluate(() => document.body.innerText.substring(0, 1000));
  }
  
  /** 檢查是否有對話框出現 */
  async detectDialog() {
    try {
      const dialogInfo = await this.mainFrame.evaluate(() => {
        // 尋找各種對話框
        const dialogs = document.querySelectorAll('.ui-dialog, .ui-confirm-dialog, [role="dialog"], .modal');
        for (const dialog of dialogs) {
          if (dialog.offsetParent !== null) { // 可見的對話框
            const text = dialog.textContent.slice(0, 200);
            const buttons = Array.from(dialog.querySelectorAll('button, input[type="button"], input[type="submit"]'))
              .map(btn => btn.textContent || btn.value || '').filter(t => t.trim());
            return { visible: true, text, buttons };
          }
        }
        return { visible: false };
      });
      
      if (dialogInfo.visible) {
        console.log(`[ACH] 發現對話框: ${dialogInfo.text}`);
        console.log(`[ACH] 可用按鈕: ${dialogInfo.buttons.join(', ')}`);
      }
      
      return dialogInfo;
    } catch (e) {
      return { visible: false, error: e.message };
    }
  }

  // ══════════════════════════════════════════════════
  // ACH 檔案上傳主流程
  // ══════════════════════════════════════════════════
  async upload(filePath) {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) throw new Error(`檔案不存在: ${absPath}`);
    console.log(`[ACH] === ACH 檔案上傳 ===`);
    console.log(`[ACH] 檔案: ${absPath}`);

    // Step 1: Navigate to ACH檔案上傳
    await this.navigateToMenu(['收款服務', 'ACH收付款', 'ACH檔案上傳']);

    // Step 2: Select radio buttons (PrimeFaces radio, use IDs)
    // 交易類別: form:achUpKind:1 = 代收/代付 (ACHP01)
    await this.selectRadioById('form:achUpKind:1');

    // 交易型態: form:achTxKind:1 = ACH即時(eACH) (value=0)
    await this.selectRadioById('form:achTxKind:1');

    // Handle confirmation dialog: 「請確認是否發動即時或即時(預約)交易？」
    // Dialog is in a popup iframe, not mainFrame
    await delay(3000); // 增加等待時間
    console.log('[ACH] --- 處理即時交易確認彈窗 ---');
    
    // 多次嘗試處理對話框
    let dialogHandled = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      // 先檢查是否有對話框
      const dialogInfo = await this.detectDialog();
      if (dialogInfo.visible) {
        console.log(`[ACH] 第${attempt + 1}次嘗試處理對話框...`);
        
        const result = await this.clickInPopupFrame('確定');
        if (result) {
          dialogHandled = true;
          console.log(`[ACH] 彈窗處理成功 (第${attempt + 1}次嘗試): ${result}`);
          break;
        }
      } else {
        console.log(`[ACH] 第${attempt + 1}次嘗試找不到對話框`);
      }
      
      await delay(2000);
    }
    
    if (!dialogHandled) {
      console.log('[ACH] ⚠️ 無法處理確認彈窗，繼續執行...');
    }
    
    await delay(3000);

    // 格式: form:newFormatFlag:1 = 新格式 (value=1)
    await this.selectRadioById('form:newFormatFlag:1');

    // Step 3: Upload file via file input (id=form:file)
    console.log('[ACH] --- 上傳檔案 ---');
    const fileInput = await this.mainFrame.waitForSelector('input[type="file"]', { timeout: 5000 });
    if (!fileInput) throw new Error('找不到檔案上傳欄位');
    await fileInput.uploadFile(absPath);
    console.log(`[ACH] 檔案已選擇: ${path.basename(absPath)}`);
    await delay(2000);

    // Step 4: Click 上傳 submit button (form:j_idt67, NOT the tab link)
    console.log('[ACH] --- 點擊上傳按鈕 ---');
    await this.mainFrame.evaluate(() => {
      const btns = document.querySelectorAll('button[type="submit"]');
      for (const b of btns) {
        if (b.textContent.trim() === '上傳') { b.click(); return; }
      }
    });
    console.log('[ACH] 已點擊上傳按鈕');
    await delay(3000);

    // Step 4b: Handle 「請確認是否發動即時或即時(預約)交易？」dialog
    console.log('[ACH] --- 處理上傳確認彈窗 ---');
    
    // 多次嘗試處理上傳確認對話框
    let uploadConfirmed = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const dialogInfo = await this.detectDialog();
      if (dialogInfo.visible) {
        console.log(`[ACH] 上傳第${attempt + 1}次嘗試處理確認對話框...`);
        
        const result = await this.clickInPopupFrame('確定');
        if (result) {
          uploadConfirmed = true;
          console.log(`[ACH] 上傳確認成功 (第${attempt + 1}次嘗試): ${result}`);
          break;
        }
      }
      
      // 檢查是否已經轉到結果頁面
      const currentText = await this.getPageText();
      if (currentText.includes('檢核') || currentText.includes('成功') || currentText.includes('失敗')) {
        console.log(`[ACH] 偵測到已轉到結果頁面，停止等待確認對話框`);
        uploadConfirmed = true;
        break;
      }
      
      await delay(2000);
    }
    
    if (!uploadConfirmed) {
      console.log('[ACH] ⚠️ 上傳確認對話框處理超時，繼續執行...');
    }
    
    await delay(5000);

    // Step 5: Check result — look for 檢核成功/失敗
    await this.findMainFrame();
    const resultText = await this.getPageText();
    console.log(`[ACH] 上傳結果頁面:\n${resultText.substring(0, 500)}`);

    // Check for errors
    if (resultText.includes('失敗') && !resultText.includes('失敗總筆數')) {
      return { success: false, message: resultText.substring(0, 300) };
    }

    // Parse success/fail counts
    const successMatch = resultText.match(/成功總筆數\s*(\d+)/);
    const failMatch = resultText.match(/失敗總筆數\s*(\d+)/);
    const amountMatch = resultText.match(/成功總金額\s*([\d,]+)/);
    const successCount = successMatch ? parseInt(successMatch[1]) : 0;
    const failCount = failMatch ? parseInt(failMatch[1]) : 0;
    const successAmount = amountMatch ? amountMatch[1] : '0';

    console.log(`[ACH] 成功: ${successCount} 筆, 失敗: ${failCount} 筆, 金額: ${successAmount}`);

    if (failCount > 0 || successCount === 0) {
      return {
        success: false,
        message: `檢核失敗: 成功${successCount}筆, 失敗${failCount}筆`,
        successCount, failCount, successAmount,
        pageText: resultText.substring(0, 500),
      };
    }

    // Step 6: 送審 — look for submit button in 檢核成功清單
    console.log('[ACH] --- 送審 ---');
    // Scroll down to see the 檢核成功清單
    await this.mainFrame.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(1000);

    try {
      await this.clickByText('送審');
      await delay(5000);
    } catch (e) {
      console.log(`[ACH] 送審按鈕找不到，嘗試其他方式: ${e.message}`);
      // Maybe it's a checkbox + submit flow
      const pageText2 = await this.getPageText();
      return {
        success: false,
        message: '找不到送審按鈕',
        pageText: pageText2.substring(0, 500),
        successCount, failCount, successAmount,
      };
    }

    // Step 7: 確定送審
    await this.findMainFrame();
    const confirmText = await this.getPageText();
    console.log(`[ACH] 確認頁:\n${confirmText.substring(0, 300)}`);

    const caseNumber = await this.extractCaseNumber();
    console.log(`[ACH] 案件編號: ${caseNumber || '(未取得)'}`);

    try {
      await this.clickByText('確定送審');
      await delay(5000);
    } catch (e) {
      // Maybe already submitted or different button text
      console.log(`[ACH] 確定送審: ${e.message}, 嘗試「確定」`);
      try { await this.clickByText('確定'); await delay(5000); } catch (_) {}
    }

    // Final result
    await this.findMainFrame();
    const finalText = await this.getPageText();
    const finalCase = caseNumber || await this.extractCaseNumber();

    return {
      success: true,
      action: 'ach-upload',
      file: path.basename(absPath),
      caseNumber: finalCase,
      successCount,
      failCount,
      successAmount,
      message: finalText.includes('已送審') ? '已送審，請洽主管放行' : finalText.substring(0, 200),
    };
  }

  async disconnect() {
    if (this.browser) {
      this.browser.disconnect();
      console.log('[ACH] 已斷開');
    }
  }
}

// ══════════════════════════════════════════════════
// CLI
// ══════════════════════════════════════════════════
async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i].startsWith('--')) {
      options[args[i].substring(2)] = args[i + 1];
    }
  }

  if (!options.file) {
    console.log(`永豐寰宇金融網 ACH 檔案自動上傳

Usage:
  node sinopac_ach_upload.cjs --file /path/to/94256530_P01_xxx.txt

Env:
  SINOPAC_CDP_PORT  Chrome DevTools port (default: 18800)

流程: 收款服務 > ACH收付款 > ACH檔案上傳
設定: 代收/代付 + ACH即時(eACH) + 新格式`);
    process.exit(1);
  }

  const ach = new SinopacAchUpload();
  try {
    await ach.connect();
    const result = await ach.upload(options.file);
    console.log('\n' + JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    console.log(JSON.stringify({ success: false, error: e.message }));
    process.exit(1);
  } finally {
    await ach.disconnect();
  }
}

if (require.main === module) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}

module.exports = { SinopacAchUpload };
