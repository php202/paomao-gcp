#!/usr/bin/env node
/**
 * sync_odoo_orders_to_ach.cjs
 * 
 * 從 Odoo 電商拉取已確認的銷售訂單 (state='sale', website_id!=false)
 * 自動寫入 ach_records DB + ACH Sheet
 * 
 * 觸發：cron 每小時跑一次（或手動）
 * 邏輯：
 *   1. 查 Odoo 最近 30 天 confirmed website SO
 *   2. 比對 DB ach_records.odoo_quote_id，跳過已存在的
 *   3. 用 partner_id → stores.company 反查店家 + payee_code
 *   4. 寫入 Sheet + DB
 *   5. TG 通知（有新訂單時）
 * 
 * Usage:
 *   NODE_PATH=~/泡泡貓/dashboard/node_modules node ~/paomao-gcp/gcp/scripts/sync_odoo_orders_to_ach.cjs
 *   --dry-run    只顯示不寫入
 *   --days N     查最近 N 天（預設 30）
 */

const fs = require('fs');
const { Pool } = require('pg');
const xmlrpc = require('xmlrpc');
const { google } = require('googleapis');

const DRY_RUN = process.argv.includes('--dry-run');
const DAYS = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--days') || '30');

const SHEET_ID = '17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE';
const SHEET_NAME = '2026/ACH紀錄';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || (() => {
  try { return fs.readFileSync('/Users/paopaomao/.openclaw/secrets/telegram-bot-token.txt', 'utf8').trim(); } catch { return ''; }
})();
const TG_CHAT_ROBBY = '7956245081';
const TG_CHAT_OFFICE = '-5220564261';

// ── Odoo XML-RPC ──
const odooConfig = JSON.parse(fs.readFileSync('/Users/paopaomao/.openclaw/secrets/odoo-config.json', 'utf8'));

function odooCall(model, method, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    const client = xmlrpc.createSecureClient({ host: 'paomao.odoo.com', port: 443, path: '/xmlrpc/2/object' });
    client.methodCall('execute_kw', [
      odooConfig.db || 'paomao', odooConfig.uid || 6, odooConfig.password,
      model, method, args, kwargs
    ], (err, val) => err ? reject(err) : resolve(val));
  });
}

// ── TG notification ──
async function sendTG(chatId, text) {
  if (!TG_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('[TG] send failed:', e.message); }
}

// ── Main ──
async function main() {
  console.log(`[sync-odoo-ach] 🚀 開始 (dry_run=${DRY_RUN}, days=${DAYS})`);

  const pool = new Pool({ database: 'paomao' });

  // 1. Query Odoo for confirmed website sale orders
  const sinceDate = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  console.log(`[sync-odoo-ach] 查詢 Odoo SO: state=sale, website, since ${sinceDate}`);

  const orders = await odooCall('sale.order', 'search_read', [[
    ['state', 'in', ['sale', 'done']],
    ['create_date', '>', sinceDate],
    ['website_id', '!=', false]
  ]], { fields: ['name', 'partner_id', 'amount_total', 'date_order', 'create_date', 'state'], limit: 500, order: 'create_date asc' });

  console.log(`[sync-odoo-ach] Odoo 找到 ${orders.length} 筆已確認電商訂單`);
  if (!orders.length) { await pool.end(); return; }

  // 2. Check which ones are already in DB
  const soNames = orders.map(o => o.name);
  const { rows: existingRows } = await pool.query(
    `SELECT odoo_quote_id FROM ach_records WHERE odoo_quote_id = ANY($1)`,
    [soNames]
  );
  const existingSet = new Set(existingRows.map(r => r.odoo_quote_id));
  const newOrders = orders.filter(o => !existingSet.has(o.name));

  console.log(`[sync-odoo-ach] 已存在 ${existingSet.size} 筆，新增 ${newOrders.length} 筆`);
  if (!newOrders.length) { console.log('[sync-odoo-ach] ✅ 無新訂單'); await pool.end(); return; }

  // 3. Load store mapping (company → store)
  const { rows: storeRows } = await pool.query(`
    SELECT s.id as store_id, s.store_name, s.company, p.code as payee_code, p.id as payee_id
    FROM stores s
    LEFT JOIN payee_stores ps ON ps.store_id = s.id
    LEFT JOIN payees p ON p.id = ps.payee_id
    WHERE s.company IS NOT NULL AND s.company != ''
  `);
  // Map by company name (exact) and also partial match
  const companyMap = {};
  for (const s of storeRows) {
    companyMap[s.company] = s;
    // Also index by short name (e.g., "竹北光明")
    const short = (s.store_name || '').replace('泡泡貓｜', '').replace('店', '');
    if (short) companyMap[short] = s;
  }

  // 4. Setup Google Sheets
  const auth = new google.auth.GoogleAuth({
    keyFile: '/Users/paopaomao/.openclaw/secrets/gcp-service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // 5. Process each new order
  let inserted = 0;
  const results = [];

  for (const order of newOrders) {
    const partnerName = order.partner_id?.[1] || '';
    const soName = order.name;
    const amount = order.amount_total || 0;

    // Match store
    let storeInfo = companyMap[partnerName];
    if (!storeInfo) {
      // Try partial match
      for (const key of Object.keys(companyMap)) {
        if (partnerName.includes(key) || key.includes(partnerName)) {
          storeInfo = companyMap[key];
          break;
        }
      }
    }

    const storeName = storeInfo ? storeInfo.store_name.replace('泡泡貓｜', '') : partnerName;
    const payeeCode = storeInfo?.payee_code || '';
    const storeId = storeInfo?.store_id || null;
    const payeeId = storeInfo?.payee_id || null;

    // Format date: M/D from date_order (UTC+8)
    const orderDate = new Date(order.date_order);
    orderDate.setHours(orderDate.getHours() + 8); // UTC → Taipei
    const dateStr = `${orderDate.getMonth() + 1}/${orderDate.getDate()}`;

    // Build detail from order lines
    let detail = '貨款';
    try {
      const lines = await odooCall('sale.order.line', 'search_read', [[
        ['order_id', '=', order.id],
        ['product_uom_qty', '>', 0],
        ['price_unit', '>', 0]
      ]], { fields: ['name', 'product_uom_qty', 'price_subtotal'], limit: 20 });
      if (lines.length) {
        const items = lines.map(l => l.name.split('\n')[0]).filter(Boolean);
        if (items.length <= 3) {
          detail = '貨款：' + items.join('、');
        } else {
          detail = `貨款：${items.slice(0, 2).join('、')}等${items.length}項`;
        }
      }
    } catch (e) {
      console.warn(`[sync-odoo-ach] 讀取 ${soName} 明細失敗:`, e.message);
    }

    console.log(`  ${soName} | ${storeName} | $${amount} | ${dateStr} | ${detail}`);

    if (DRY_RUN) {
      results.push({ soName, storeName, amount, dateStr });
      continue;
    }

    try {
      // A. Append to Sheet
      const newRow = [dateStr, storeName, amount, payeeCode, '貨款', detail, '', '', '', '', '', '', '', '', '', soName, ''];
      const appendRes = await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `'${SHEET_NAME}'!A:Q`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [newRow] }
      });

      const updatedRange = appendRes.data.updates?.updatedRange || '';
      const rowMatch = updatedRange.match(/!A(\d+)/);
      const sheetRow = rowMatch ? parseInt(rowMatch[1]) : null;

      // B. Insert into DB
      const dbRes = await pool.query(`
        INSERT INTO ach_records (sheet_row, record_date, store_name, amount, payee_code, fee_type, description, 
          store_id, payee_id, odoo_quote_id, year)
        VALUES ($1, $2, $3, $4, $5, '貨款', $6, $7, $8, $9, 2026)
        ON CONFLICT (sheet_row, year) DO UPDATE SET
          store_name=EXCLUDED.store_name, amount=EXCLUDED.amount, payee_code=EXCLUDED.payee_code,
          fee_type=EXCLUDED.fee_type, description=EXCLUDED.description, odoo_quote_id=EXCLUDED.odoo_quote_id, updated_at=NOW()
        RETURNING id
      `, [sheetRow, dateStr, storeName, amount, payeeCode, detail, storeId, payeeId, soName]);

      inserted++;
      results.push({ soName, storeName, amount, dateStr, sheetRow, dbId: dbRes.rows[0]?.id });
    } catch (e) {
      console.error(`  ❌ ${soName} 寫入失敗:`, e.message);
    }
  }

  // 6. TG notification
  if (results.length > 0 && !DRY_RUN) {
    const lines = results.map(r => `• ${r.storeName} $${r.amount.toLocaleString()} (${r.soName})`);
    const msg = `📦 <b>新貨款訂單自動寫入 ACH</b>\n\n${lines.join('\n')}\n\n共 ${results.length} 筆`;
    await sendTG(TG_CHAT_ROBBY, msg);
  }

  console.log(`[sync-odoo-ach] 🏁 完成：新增 ${inserted} 筆${DRY_RUN ? ' (dry-run)' : ''}`);
  await pool.end();
}

main().catch(e => { console.error('[sync-odoo-ach] Fatal:', e); process.exit(1); });
