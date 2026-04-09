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
const { odooCall } = require('../lib/odoo.cjs');

// ========== Config ==========
const SHEET_ID = '17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE';
const ACH_SHEET_NAME = '2026/ACH紀錄';
const SA_KEY_PATH = path.join(process.env.HOME, '.openclaw/secrets/gcp-service-account.json');
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

// ========== Odoo: see ../lib/odoo.cjs ==========

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
  console.log('=== Phase 2A: Odoo → ACH (直接寫 DB，不經 Sheet) ===');
  
  // 1. 從 Odoo 抓取最近的已確認銷售訂單
  const orders = await odooCall('sale.order', 'search_read', [
    [['state', 'in', ['sale', 'done']], ['invoice_status', '=', 'invoiced']],
  ], {
    fields: ['name', 'partner_id', 'amount_total', 'date_order', 'invoice_ids'],
    order: 'date_order desc',
    limit: 50,
  });
  console.log(`  Odoo 查到 ${orders.length} 筆已開票銷售訂單`);

  // 2. 從 DB 查已存在的 Odoo ID，避免重複
  const { rows: existingRows } = await pool.query(
    "SELECT odoo_quote_id FROM ach_records WHERE year = 2026 AND odoo_quote_id IS NOT NULL AND odoo_quote_id != ''"
  );
  const existingOdooIds = new Set(existingRows.map(r => r.odoo_quote_id));

  // 3. 取得 payees mapping (store name → code)
  const { rows: payees } = await pool.query(`SELECT code, store_label, account_name FROM payees WHERE is_active = TRUE`);
  const storeToCode = new Map();
  for (const p of payees) {
    if (p.store_label) storeToCode.set(p.store_label.trim(), p.code);
    if (p.account_name) storeToCode.set(p.account_name.trim(), p.code);
  }

  // 4. 取得下一個 sheet_row（保持相容性）
  const { rows: maxRow } = await pool.query("SELECT COALESCE(MAX(sheet_row), 1) as max_row FROM ach_records WHERE year = 2026");
  let nextRow = maxRow[0].max_row + 1;

  let added = 0;
  for (const order of orders) {
    const odooId = `S${String(order.id).padStart(5, '0')}`;
    if (existingOdooIds.has(odooId) || existingOdooIds.has(order.name)) continue;

    const partnerName = order.partner_id?.[1] || '';
    // 優先用 Invoice 的 amount_residual（已扣貸記單沖抵後的實際應收）
    let amount = order.amount_total || 0;
    if (order.invoice_ids && order.invoice_ids.length > 0) {
      try {
        const lastInvId = order.invoice_ids[order.invoice_ids.length - 1];
        const inv = await odooCall('account.move', 'read', [lastInvId], { fields: ['amount_residual', 'state'] });
        if (inv[0]?.state === 'posted' && inv[0].amount_residual != null) {
          amount = inv[0].amount_residual;
          if (amount !== order.amount_total) {
            console.log(`  📝 ${order.name}: 原價 $${order.amount_total} → 沖抵後 $${amount}`);
          }
        }
      } catch (invErr) {
        console.warn(`  ⚠️ ${order.name}: 讀取 Invoice residual 失敗，用 SO amount_total: ${invErr.message?.slice(0, 100)}`);
      }
    }
    if (amount <= 0) continue;

    const storeCode = storeToCode.get(partnerName) || '';
    const dateStr = formatDate(order.date_order);

    // Get order lines for description
    const lines = await odooCall('sale.order.line', 'search_read', [
      [['order_id', '=', order.id], ['product_uom_qty', '>', 0]],
    ], { fields: ['name', 'product_uom_qty', 'price_subtotal'], limit: 10 });
    
    const desc = lines.map(l => `${l.name}x${l.product_uom_qty}`).join(', ').substring(0, 100);
    const fullDesc = `${odooId} ${desc}`;

    // 查 payee_id 和 store_id
    const payeeRow = storeCode ? await pool.query('SELECT id FROM payees WHERE code=$1 LIMIT 1', [storeCode]) : { rows: [] };
    const storeRow = partnerName ? await pool.query('SELECT id FROM stores WHERE store_name=$1 LIMIT 1', [partnerName]) : { rows: [] };
    const payeeId = payeeRow.rows[0]?.id || null;
    const storeId = storeRow.rows[0]?.id || null;

    // 直接寫入 DB
    await pool.query(`
      INSERT INTO ach_records (sheet_row, year, record_date, store_name, amount, payee_code, fee_type, description, odoo_quote_id, payee_id, store_id)
      VALUES ($1, 2026, $2, $3, $4, $5, '貨款', $6, $7, $8, $9)
      ON CONFLICT (sheet_row, year) DO NOTHING
    `, [nextRow, dateStr || null, partnerName, amount, storeCode, fullDesc, odooId, payeeId, storeId]);

    existingOdooIds.add(odooId);
    nextRow++;
    added++;
    console.log(`  + ${odooId} ${partnerName} $${amount}`);
  }

  console.log(`  完成：新增 ${added} 筆 ACH 紀錄（直接寫 DB）`);
  return { added };
}

// =============================================
// Phase 2B: Sheet G 欄同步到 DB
// =============================================
async function syncGColumn() {
  // 2026 起停用 Sheet 同步，G 欄直接在 Dashboard DB 操作
  console.log('=== Phase 2B: syncGColumn — SKIPPED (Sheet 已停用，改用 DB 直接操作) ===');
  return { updated: 0, skipped: true };
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
  console.log('=== Phase 3A: 永豐銀行自動查帳 (修正版：包含失敗檔) ===');
  
  // 解析已下載的 ACH 回覆檔 - 包括成功檔和失敗檔
  const downloadDir = path.join(process.env.HOME, 'Downloads');
  
  // 成功 M 檔 — 支援整批 (_M_YYYYMMDD.TXT) 和單筆 (_M_YYYYMMDD_N.TXT / _M_YYYYMMDD_N (1).TXT)
  const achFiles = fs.readdirSync(downloadDir)
    .filter(f => f.match(/^94256530_NEP01_M_\d{8}(_\d+)?( \(\d+\))?\.TXT$/))
    .filter(f => !f.includes('_F.TXT'))  // 排除失敗檔
    .sort()
    .reverse();
  
  // 失敗 M 檔 — 同樣支援單筆格式
  const failFiles = fs.readdirSync(downloadDir)
    .filter(f => f.match(/^94256530_NEP01_M_\d{8}(_\d+)?(_F| \(\d+\))*_?F\.TXT$/))
    .sort()
    .reverse();
  
  // R 檔（報表檔）— 純文字格式，包含 PIN + 金額 + 退件理由
  const reportFiles = fs.readdirSync(downloadDir)
    .filter(f => f.match(/^94256530_NEP01_R_\d{8}(_\d+)?( \(\d+\))?\.TXT$/))
    .filter(f => !f.includes('_F.TXT'))
    .sort()
    .reverse();
  
  // R 檔失敗檔
  const reportFailFiles = fs.readdirSync(downloadDir)
    .filter(f => f.match(/^94256530_NEP01_R_\d{8}.*_F\.TXT$/))
    .sort()
    .reverse();
  
  const allFiles = [...achFiles, ...failFiles, ...reportFiles, ...reportFailFiles];
  
  if (allFiles.length === 0) {
    console.log('  沒有找到 ACH 回覆檔，需先從永豐下載');
    return { parsed: 0 };
  }
  
  console.log(`  找到 ${achFiles.length} 個成功M檔 + ${failFiles.length} 個失敗M檔 + ${reportFiles.length} 個報表R檔 + ${reportFailFiles.length} 個失敗R檔`);
  
  // 去重：同 payee+amount 只取一筆（避免重複下載的檔案重複比對）
  const results = [];
  const seen = new Set();
  
  for (const file of allFiles) { // 掃全部檔案
    const filePath = path.join(downloadDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const isRFile = file.includes('_NEP01_R_');
    const isFailure = file.includes('_F.TXT');
    
    if (isRFile) {
      // R 檔：純文字報表格式，解析「代收」行
      const lines = content.split(/\r?\n/).filter(l => l.includes('代收'));
      for (const line of lines) {
        const record = parseAchReportLine(line);
        if (record) {
          // R 檔的退件理由欄非空 = 失敗
          const isFail = isFailure || !!record.rejectReason;
          const dedupeKey = `${record.pin}|${record.amount}|${isFail}`;
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            results.push({ ...record, sourceFile: file, isFailure: isFail });
          }
        }
      }
    } else {
      // M 檔：固定寬度格式，狀態碼在金額尾 2 碼
      const lines = content.split(/\r?\n/).filter(l => l.startsWith('RSD') || l.startsWith('NSD'));
      for (const line of lines) {
        const record = parseAchReplyLine(line);
        if (record) {
          // M 檔的失敗判定：_F 檔名 或 狀態碼非 00
          const isFail = isFailure || record.isReject;
          const dedupeKey = `${record.pin}|${record.amount}|${isFail}`;
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            results.push({ ...record, sourceFile: file, isFailure: isFail });
          }
        }
      }
    }
  }
  
  console.log(`  解析到 ${results.length} 筆扣款記錄`);
  
  // 比對 DB 的 ACH 紀錄，標記已入帳
  let matched = 0;
  let failureMatched = 0;
  
  for (const r of results) {
    // 比對策略：優先 ach_code，再 id_number，最後 payee_code
    const { rows } = await pool.query(`
      SELECT ar.id, ar.sheet_row, ar.amount, ar.ach_released, ar.ach_confirmed, 
             COALESCE(p.id_number, '') as id_number, COALESCE(p.ach_code, '') as ach_code, ar.payee_code, ar.created_at
      FROM ach_records ar
      LEFT JOIN payees p ON ar.payee_id = p.id
      WHERE (p.ach_code = $1 OR p.id_number = $1 OR ar.payee_code = $1 OR ar.payee_code LIKE $1 || '-%')
        AND ar.amount IS NOT NULL
        AND ar.ach_released IS NOT NULL AND ar.ach_released != ''
        AND (ar.ach_confirmed IS NULL OR ar.ach_confirmed = '' OR ar.ach_confirmed = 'FALSE')
    `, [r.pin]);
    
    for (const dbRow of rows) {
      const dbAmount = Math.abs(parseAmount(dbRow.amount));
      if (Math.abs(dbAmount - r.amount) < 1) { // 金額差 < $1
        
        if (r.isFailure) {
          // 失敗檔：標記為失敗
          const failValue = `FAIL ${new Date().toISOString().slice(5, 16)}`;
          await pool.query(`UPDATE ach_records SET ach_confirmed = $1 WHERE id = $2`, [failValue, dbRow.id]);
          failureMatched++;
          console.log(`    ❌ 失敗: PIN=${r.pin} $${r.amount} → DB ID=${dbRow.id}`);
        } else {
          // 成功檔：標記為成功
          const successValue = `OK ${new Date().toISOString().slice(5, 16)}`;
          await pool.query(`UPDATE ach_records SET ach_confirmed = $1 WHERE id = $2`, [successValue, dbRow.id]);
          matched++;
          console.log(`    ✅ 成功: PIN=${r.pin} $${r.amount} → DB ID=${dbRow.id}`);
        }
        break;
      }
    }
  }
  
  console.log(`  完成：${matched} 筆已比對入帳，${failureMatched} 筆失敗`);
  
  // 發送失敗通知
  if (failureMatched > 0) {
    const failList = results.filter(r => r.isFailure).map(f => `  ⚠️ ${f.pin} $${f.amount}`).join('\n');
    await sendTg(TG_ROBBY_CHAT, `❌ ACH 扣款失敗 ${failureMatched} 筆:\n${failList}`);
  }
  
  return { parsed: results.length, matched, failures: failureMatched };
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
    
    // 金額在 B94256530 前面 12 碼：10碼金額(分) + 2碼狀態碼
    // 狀態碼：00=成功, 01=退件(餘額不足等), 02=其他失敗
    const fullAmountArea = line.substring(bIdx - 12, bIdx);
    const statusCode = fullAmountArea.substring(10, 12);
    const amountStr = fullAmountArea.substring(0, 10);
    const amount = parseInt(amountStr, 10) / 100;
    const isReject = statusCode !== '00'; // 01, 02 = 失敗
    
    // PIN/統編在 B94256530 後面
    const afterB = line.substring(bIdx + 11).trim(); // skip "B94256530  "
    const pin = afterB.split(/\s/)[0].trim();
    
    // 銀行帳號區域
    const accountArea = line.substring(14, bIdx - 12);
    
    return { amount, pin, accountArea, isReject, statusCode };
  } catch (e) {
    return null;
  }
}

/**
 * 解析 ACH 報表檔 (R 檔) 的一行
 * 格式：代收  貨款  8070014  8070014  94256530  [統編]  [帳號]  [用戶號碼]  [金額]  [退件理由]
 */
function parseAchReportLine(line) {
  if (!line.includes('代收')) return null;
  try {
    // 用正則擷取：94256530 後面的統編、金額、退件理由
    const match = line.match(/94256530\s+(\S+)\s+(\S+)\s+(\S+)\s+([\d,]+\.\d+)\s*(.*)?$/);
    if (!match) return null;
    
    const pin = match[3].trim(); // 用戶號碼
    const amount = parseFloat(match[4].replace(/,/g, ''));
    const rejectReason = (match[5] || '').trim();
    
    if (!pin || isNaN(amount)) return null;
    return { pin, amount, rejectReason, accountArea: match[2] };
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

if (require.main === module) {
  main();
}

// Export for Dashboard API
module.exports = { getAutomationStatus, odooToAch, syncGColumn, classifyTransfers, bankCheck, issueInvoices, odooPost, processAllFeeTypes };
