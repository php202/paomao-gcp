#!/usr/bin/env node
/**
 * ACH 全流程自動化模組
 * 
 * Phase 2: 
 *   - odoo-to-ach: Odoo 銷售訂單 → 自動建 ACH 紀錄 (貨款)
 *   - sync-g-column: LINE 確認回寫 DB (Sheet→DB G欄同步)
 *   - classify-666-686: 自動分類 666→686 轉帳
 * 
 * Phase 3:
 *   - bank-check: 永豐銀行自動查帳（下載 ACH 回覆檔 → 解析成功/失敗 → 更新 Sheet/DB）
 *   - issue-invoice: 開發票（已有 billing-issue-invoice.js）
 *   - odoo-post: Odoo 過帳（待小羅確認）
 * 
 * Phase 4:
 *   - 儲值金/服務費/顧問費/廣告費/票券（同框架，改 fee_type 篩選）
 * 
 * Usage: node ach_automation.cjs <command> [options]
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ========== Config ==========
const SHEET_ID = '17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE';
const ACH_SHEET_NAME = '2026/ACH紀錄';
const SA_KEY_PATH = path.join(process.env.HOME, '.openclaw/secrets/gcp-service-account.json');
const ODOO_CONFIG_PATH = path.join(process.env.HOME, '.openclaw/secrets/odoo-config.json');
const SINOPAC_PW_PATH = path.join(process.env.HOME, '.openclaw/secrets/sinopac-password.txt');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_ROBBY_CHAT = '7956245081';
const TG_OFFICE_GROUP = '-5220564261';

const pool = new Pool({
  host: '/tmp',
  database: 'paomao',
  user: 'paopaomao',
});

// ========== Google Sheets Auth ==========
let sheetsApi = null;
async function getSheets() {
  if (sheetsApi) return sheetsApi;
  const auth = new google.auth.GoogleAuth({
    keyFile: SA_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsApi = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return sheetsApi;
}

async function readSheet(range) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${ACH_SHEET_NAME}'!${range}`,
  });
  return res.data.values || [];
}

async function writeSheet(range, values) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${ACH_SHEET_NAME}'!${range}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

async function appendSheet(values) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${ACH_SHEET_NAME}'!A:Q`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

// ========== Odoo JSON-RPC ==========
let odooUid = null;
let odooConfig = null;
function getOdooConfig() {
  if (odooConfig) return odooConfig;
  odooConfig = JSON.parse(fs.readFileSync(ODOO_CONFIG_PATH, 'utf8'));
  return odooConfig;
}

async function odooAuth() {
  if (odooUid) return odooUid;
  const cfg = getOdooConfig();
  const res = await fetch(`${cfg.url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call',
      params: { service: 'common', method: 'authenticate', args: [cfg.db, cfg.username, cfg.password, {}] }
    }),
  });
  const json = await res.json();
  odooUid = json.result;
  if (!odooUid) throw new Error('Odoo auth failed');
  return odooUid;
}

async function odooCall(model, method, args, kwargs = {}) {
  const cfg = getOdooConfig();
  const uid = await odooAuth();
  const res = await fetch(`${cfg.url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call',
      params: { service: 'object', method: 'execute_kw', args: [cfg.db, uid, cfg.password, model, method, args, kwargs] }
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

// ========== Telegram ==========
async function sendTg(chatId, text) {
  if (!TG_BOT_TOKEN) { console.log(`[TG skip] ${chatId}: ${text}`); return; }
  await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(e => console.error('[TG error]', e.message));
}

// ========== Helpers ==========
function parseAmount(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[＄$,，\s]/g, '');
  return parseFloat(s) || 0;
}

function formatDate(d) {
  // Return M/D format
  const dt = new Date(d);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

// =============================================
// Phase 2A: Odoo 銷售訂單 → ACH 紀錄 (貨款)
// =============================================
async function odooToAch() {
  console.log('=== Phase 2A: Odoo → ACH (貨款) ===');
  
  // 1. 從 Odoo 抓取最近的已確認銷售訂單
  const orders = await odooCall('sale.order', 'search_read', [
    [['state', 'in', ['sale', 'done']], ['invoice_status', '=', 'invoiced']],
  ], {
    fields: ['name', 'partner_id', 'amount_total', 'date_order', 'invoice_ids'],
    order: 'date_order desc',
    limit: 50,
  });
  console.log(`  Odoo 查到 ${orders.length} 筆已開票銷售訂單`);

  // 2. 讀取現有 ACH Sheet P欄，避免重複
  const existingRows = await readSheet('P:P');
  const existingOdooIds = new Set(existingRows.flat().map(v => String(v).trim()).filter(Boolean));

  // 3. 取得 payees mapping (store name → code)
  const { rows: payees } = await pool.query(`SELECT code, store_label, account_name FROM payees WHERE is_active = TRUE`);
  const storeToCode = new Map();
  for (const p of payees) {
    if (p.store_label) storeToCode.set(p.store_label.trim(), p.code);
    if (p.account_name) storeToCode.set(p.account_name.trim(), p.code);
  }

  let added = 0;
  for (const order of orders) {
    const odooId = `S${String(order.id).padStart(5, '0')}`;
    if (existingOdooIds.has(odooId)) continue;

    const partnerName = order.partner_id?.[1] || '';
    const amount = order.amount_total || 0;
    if (amount <= 0) continue;

    // Map partner to store
    const storeCode = storeToCode.get(partnerName) || '';
    const dateStr = formatDate(order.date_order);

    // Get order lines for description
    const lines = await odooCall('sale.order.line', 'search_read', [
      [['order_id', '=', order.id], ['product_uom_qty', '>', 0]],
    ], { fields: ['name', 'product_uom_qty', 'price_subtotal'], limit: 10 });
    
    const desc = lines.map(l => `${l.name}x${l.product_uom_qty}`).join(', ').substring(0, 100);
    const fullDesc = `${odooId} ${desc}`;

    // ACH row: [A日期, B店名, C金額, D代碼, E類型, F說明, G確認, H~N空, O空, P odooId, Q空]
    const newRow = [dateStr, partnerName, `＄${amount}`, storeCode, '貨款', fullDesc, '', '', '', '', '', '', '', '', '', odooId, ''];
    
    await appendSheet([newRow]);
    existingOdooIds.add(odooId);
    added++;
    console.log(`  + ${odooId} ${partnerName} $${amount}`);
  }

  // Sync to DB
  if (added > 0) {
    console.log(`  新增 ${added} 筆，同步 DB...`);
    const { execSync } = require('child_process');
    execSync(`node ${path.join(__dirname, 'sync_ach_full.cjs')}`, { stdio: 'inherit' });
  }

  console.log(`  完成：新增 ${added} 筆 ACH 紀錄`);
  return { added };
}

// =============================================
// Phase 2B: Sheet G 欄同步到 DB
// =============================================
async function syncGColumn() {
  console.log('=== Phase 2B: Sync G column (Sheet → DB) ===');
  
  const rows = await readSheet('A:Q');
  let updated = 0;
  
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 7) continue;
    const gVal = (row[6] || '').trim();
    if (!gVal) continue;
    
    const sheetRow = i + 1;
    const result = await pool.query(
      `UPDATE ach_records SET customer_confirmed = $1 WHERE sheet_row = $2 AND year = 2026 
       AND (customer_confirmed IS NULL OR customer_confirmed != $1)`,
      [gVal, sheetRow]
    );
    if (result.rowCount > 0) updated++;
  }
  
  console.log(`  完成：更新 ${updated} 筆 G 欄到 DB`);
  return { updated };
}

// =============================================
// Phase 2C: 666→686 自動分類 + 產檔提示
// =============================================
async function classifyTransfers() {
  console.log('=== Phase 2C: 666→686 分類 ===');
  
  // 找已確認但未產檔的紀錄
  const { rows } = await pool.query(`
    SELECT id, fee_type, amount, store_name, customer_confirmed, ach_registered
    FROM ach_records
    WHERE customer_confirmed IS NOT NULL AND customer_confirmed != ''
      AND (ach_registered IS NULL OR ach_registered = '')
    ORDER BY sheet_row
  `);
  
  const p01 = []; // ACH 扣款 (666收)
  const transfer666to686 = []; // 666→686 轉帳
  const pay686 = []; // 686 直付
  
  for (const r of rows) {
    const type = (r.fee_type || '').trim();
    const amount = parseAmount(r.amount);
    switch (type) {
      case '貨款': case '服務費': case '廣告費': case '儀器運費': case '維修費': case '顧問':
        p01.push(r);
        transfer666to686.push(r);
        break;
      case '儲值金':
        if (amount > 0) p01.push(r);
        else if (amount < 0) transfer666to686.push(r); // 退儲值金
        break;
      case '票卷':
        pay686.push(r);
        break;
      case 'ACH餘額不足':
        p01.push(r);
        transfer666to686.push(r);
        break;
    }
  }
  
  const summary = {
    total: rows.length,
    p01Count: p01.length,
    transfer666to686Count: transfer666to686.length,
    pay686Count: pay686.length,
    p01Total: p01.reduce((s, r) => s + Math.abs(parseAmount(r.amount)), 0),
  };
  
  console.log(`  待處理: ${summary.total} 筆`);
  console.log(`  ACH P01 扣款: ${summary.p01Count} 筆 $${summary.p01Total}`);
  console.log(`  666→686 轉帳: ${summary.transfer666to686Count} 筆`);
  console.log(`  686 直付: ${summary.pay686Count} 筆`);
  
  return summary;
}

// =============================================
// Phase 3A: 永豐銀行自動查帳
// =============================================
async function bankCheck() {
  console.log('=== Phase 3A: 永豐銀行自動查帳 ===');
  
  // 解析已下載的 ACH 回覆媒體檔
  const downloadDir = path.join(process.env.HOME, 'Downloads');
  const achFiles = fs.readdirSync(downloadDir)
    .filter(f => f.match(/^94256530_NEP01_M_\d{8}\.TXT$/))
    .sort()
    .reverse();
  
  if (achFiles.length === 0) {
    console.log('  沒有找到 ACH 回覆媒體檔，需先從永豐下載');
    return { parsed: 0 };
  }
  
  const results = [];
  
  for (const file of achFiles.slice(0, 5)) { // 最近 5 個檔
    const content = fs.readFileSync(path.join(downloadDir, file), 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l.startsWith('RSD') || l.startsWith('NSD'));
    
    for (const line of lines) {
      // ACH NEP01 回覆檔格式 (固定寬度)
      // 位置大約：銀行代碼 pos 6-9, 帳號 pos ~30-44, 金額 pos ~46-55, 身分證 pos ~65-75
      const record = parseAchReplyLine(line);
      if (record) results.push({ ...record, sourceFile: file });
    }
  }
  
  console.log(`  解析到 ${results.length} 筆成功扣款`);
  
  // 比對 DB 的 ACH 紀錄，標記已入帳
  let matched = 0;
  for (const r of results) {
    // 用身分證/統編 + 金額比對
    const { rows } = await pool.query(`
      SELECT ar.id, ar.sheet_row, ar.amount, ar.ach_registered, p.id_number
      FROM ach_records ar
      LEFT JOIN payees p ON ar.payee_id = p.id
      WHERE p.id_number = $1 AND ar.amount IS NOT NULL
        AND (ar.ach_registered IS NULL OR ar.ach_registered = '')
    `, [r.pin]);
    
    for (const dbRow of rows) {
      const dbAmount = Math.abs(parseAmount(dbRow.amount));
      if (Math.abs(dbAmount - r.amount) < 1) { // 金額差 < $1
        const ts = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        const regValue = `${ts} 自動比對 (${r.sourceFile})`;
        
        // Update DB
        await pool.query(`UPDATE ach_records SET ach_registered = $1 WHERE id = $2`, [regValue, dbRow.id]);
        
        // Update Sheet K column (index 10, K = col 11)
        await writeSheet(`K${dbRow.sheet_row}`, [[regValue]]);
        
        matched++;
        break;
      }
    }
  }
  
  // 檢查失敗檔
  const failFiles = fs.readdirSync(downloadDir)
    .filter(f => f.match(/^94256530_NEP01_M_\d{8}_F\.TXT$/))
    .sort()
    .reverse();
  
  let failures = [];
  for (const file of failFiles.slice(0, 5)) {
    const content = fs.readFileSync(path.join(downloadDir, file), 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l.startsWith('RSD') || l.startsWith('NSD'));
    for (const line of lines) {
      const record = parseAchReplyLine(line);
      if (record) failures.push({ ...record, sourceFile: file });
    }
  }
  
  if (failures.length > 0) {
    const failText = failures.map(f => `  ⚠️ ${f.pin} $${f.amount} (${f.sourceFile})`).join('\n');
    console.log(`  ❌ ${failures.length} 筆扣款失敗:\n${failText}`);
    await sendTg(TG_ROBBY_CHAT, `❌ ACH 扣款失敗 ${failures.length} 筆:\n${failText}`);
  }
  
  console.log(`  完成：${matched} 筆已比對入帳，${failures.length} 筆失敗`);
  return { parsed: results.length, matched, failures: failures.length };
}

/**
 * 解析 ACH NEP01 回覆檔的一行資料
 * 格式：NSD/RSD + 9040 + seq(8) + bankCode(7) + branch(3~4) + account(14~16) + amount(10, cents) + B + taxId(8~10) + pin(10~12)...
 */
function parseAchReplyLine(line) {
  if (line.length < 100) return null;
  try {
    // 典型格式: [N/R]SD904[seq8][bank7+branch...][account area][amount10]B94256530  [pin]...
    // 先找 B94256530 的位置來定位
    const bIdx = line.indexOf('B94256530');
    if (bIdx < 0) return null;
    
    // 金額在 B94256530 前面 10 碼 (以分為單位)
    const amountStr = line.substring(bIdx - 10, bIdx);
    const amount = parseInt(amountStr, 10) / 100;
    
    // PIN/統編在 B94256530 後面
    const afterB = line.substring(bIdx + 11).trim(); // skip "B94256530  "
    const pin = afterB.split(/\s/)[0].trim();
    
    // 銀行帳號區域
    const accountArea = line.substring(14, bIdx - 10);
    
    return { amount, pin, accountArea };
  } catch (e) {
    return null;
  }
}

// =============================================
// Phase 3B: 開發票（呼叫現有 billing-issue-invoice.js）
// =============================================
async function issueInvoices() {
  console.log('=== Phase 3B: 開發票 ===');
  const { execSync } = require('child_process');
  try {
    const output = execSync(`node ${path.join(__dirname, 'billing-issue-invoice.js')}`, { 
      encoding: 'utf8', timeout: 60000 
    });
    console.log(output);
    return { status: 'ok' };
  } catch (e) {
    console.error('  開票失敗:', e.message);
    return { status: 'error', message: e.message };
  }
}

// =============================================
// Phase 3C: Odoo 過帳（待小羅確認流程）
// =============================================
async function odooPost() {
  console.log('=== Phase 3C: Odoo 過帳 (需小羅確認後實作) ===');
  
  // 找已開票但未過帳的紀錄
  const { rows } = await pool.query(`
    SELECT id, sheet_row, store_name, amount, fee_type, odoo_quote_id, odoo_invoice_id, odoo_posted
    FROM ach_records
    WHERE odoo_invoice_id IS NOT NULL AND odoo_invoice_id != ''
      AND (odoo_posted IS NULL OR odoo_posted = '')
  `);
  
  console.log(`  待過帳: ${rows.length} 筆`);
  
  // TODO: 等小羅確認 Odoo 過帳步驟後實作
  // 步驟大概是：
  // 1. 用 account.move 的 action_post 方法確認發票
  // 2. 用 account.payment.register 建立收款紀錄
  // 3. 回寫 Q 欄過帳編號
  
  return { pending: rows.length, status: 'waiting_for_confirmation' };
}

// =============================================
// Phase 4: 各類費用自動化（同框架）
// =============================================
async function processAllFeeTypes() {
  console.log('=== Phase 4: 全費用類型處理 ===');
  
  const { rows } = await pool.query(`
    SELECT fee_type, COUNT(*) as cnt, SUM(ABS(CAST(REPLACE(REPLACE(REPLACE(amount, '＄', ''), '$', ''), ',', '') AS NUMERIC))) as total
    FROM ach_records
    WHERE customer_confirmed IS NOT NULL AND customer_confirmed != ''
      AND (ach_registered IS NULL OR ach_registered = '')
    GROUP BY fee_type
    ORDER BY cnt DESC
  `);
  
  console.log('  待處理費用類型:');
  for (const r of rows) {
    console.log(`    ${r.fee_type}: ${r.cnt} 筆, $${Math.round(r.total || 0)}`);
  }
  
  return { feeTypes: rows };
}

// =============================================
// 全流程 Dashboard API（給 server.js 呼叫）
// =============================================
async function getAutomationStatus() {
  // 各階段狀態摘要
  const [pending, confirmed, registered, invoiced, posted] = await Promise.all([
    pool.query(`SELECT COUNT(*) as c FROM ach_records WHERE (customer_confirmed IS NULL OR customer_confirmed = '')`),
    pool.query(`SELECT COUNT(*) as c FROM ach_records WHERE customer_confirmed IS NOT NULL AND customer_confirmed != '' AND (ach_registered IS NULL OR ach_registered = '')`),
    pool.query(`SELECT COUNT(*) as c FROM ach_records WHERE ach_registered IS NOT NULL AND ach_registered != '' AND (odoo_invoice_id IS NULL OR odoo_invoice_id = '')`),
    pool.query(`SELECT COUNT(*) as c FROM ach_records WHERE odoo_invoice_id IS NOT NULL AND odoo_invoice_id != '' AND (odoo_posted IS NULL OR odoo_posted = '')`),
    pool.query(`SELECT COUNT(*) as c FROM ach_records WHERE odoo_posted IS NOT NULL AND odoo_posted != ''`),
  ]);
  
  return {
    pipeline: {
      待確認: parseInt(pending.rows[0].c),
      已確認待產檔: parseInt(confirmed.rows[0].c),
      已入帳待開票: parseInt(registered.rows[0].c),
      已開票待過帳: parseInt(invoiced.rows[0].c),
      已完成: parseInt(posted.rows[0].c),
    }
  };
}

// =============================================
// CLI Entry
// =============================================
const command = process.argv[2];

async function main() {
  try {
    switch (command) {
      case 'odoo-to-ach':
        await odooToAch();
        break;
      case 'sync-g':
        await syncGColumn();
        break;
      case 'classify':
        await classifyTransfers();
        break;
      case 'bank-check':
        await bankCheck();
        break;
      case 'invoice':
        await issueInvoices();
        break;
      case 'odoo-post':
        await odooPost();
        break;
      case 'all-fees':
        await processAllFeeTypes();
        break;
      case 'status':
        const status = await getAutomationStatus();
        console.log(JSON.stringify(status, null, 2));
        break;
      case 'full':
        // 全流程跑一輪
        console.log('\n🚀 ACH 全流程自動化開始\n');
        await odooToAch();
        console.log('');
        await syncGColumn();
        console.log('');
        await classifyTransfers();
        console.log('');
        await bankCheck();
        console.log('');
        await issueInvoices();
        console.log('');
        const st = await getAutomationStatus();
        console.log('\n📊 Pipeline 狀態:');
        for (const [k, v] of Object.entries(st.pipeline)) {
          console.log(`  ${k}: ${v}`);
        }
        break;
      default:
        console.log(`
ACH 全流程自動化

Usage: node ach_automation.cjs <command>

Commands:
  odoo-to-ach   Odoo 銷售訂單 → ACH 紀錄
  sync-g        Sheet G 欄確認 → DB 同步
  classify      666→686 轉帳分類
  bank-check    永豐銀行回覆檔比對入帳
  invoice       開發票（giveme）
  odoo-post     Odoo 過帳（待實作）
  all-fees      全費用類型統計
  status        Pipeline 狀態
  full          全流程跑一輪
        `);
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();

// Export for Dashboard API
module.exports = { getAutomationStatus, odooToAch, syncGColumn, classifyTransfers, bankCheck, issueInvoices, odooPost, processAllFeeTypes };
