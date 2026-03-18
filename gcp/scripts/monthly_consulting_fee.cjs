#!/usr/bin/env node
/**
 * monthly_consulting_fee.cjs
 * 
 * 每月 1 號自動為有顧問費的店家建立：
 * 1. Odoo 銷售訂單 (SO)
 * 2. ACH DB 記錄
 * 3. ACH Sheet 記錄
 * 
 * Usage:
 *   NODE_PATH=~/泡泡貓/dashboard/node_modules node ~/paomao-gcp/gcp/scripts/monthly_consulting_fee.cjs
 *   --dry-run    只顯示不寫入
 *   --month YYYY-MM  指定月份（預設當月）
 */

const fs = require('fs');
const { Pool } = require('pg');
const { google } = require('googleapis');
const { odooCall } = require('../lib/odoo.cjs');

const DRY_RUN = process.argv.includes('--dry-run');
const MONTH_ARG = process.argv.find((_, i, a) => a[i - 1] === '--month');

const SHEET_ID = '17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE';
const SHEET_NAME = '2026/ACH紀錄';
const PRODUCT_ID = 500; // 顧問服務

const TG_BOT_TOKEN = (() => {
  try { return fs.readFileSync('/Users/paopaomao/.openclaw/secrets/telegram-bot-token.txt', 'utf8').trim(); } catch { return ''; }
})();
const TG_CHAT_ROBBY = '7956245081';

// ── TG ──
async function sendTG(chatId, text) {
  if (!TG_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('[TG]', e.message); }
}

async function main() {
  const now = new Date();
  const month = MONTH_ARG || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dateStr = `${now.getMonth() + 1}/1`;
  const description = `${month.replace('-', '-')}月顧問費`;

  console.log(`[consulting-fee] 🚀 開始 (month=${month}, dry_run=${DRY_RUN})`);

  const pool = new Pool({ database: 'paomao' });

  // 1. Get stores with consulting_fee (DISTINCT ON store to avoid duplicate payees)
  const { rows: stores } = await pool.query(`
    SELECT DISTINCT ON (s.id) s.id as store_id, s.store_name, s.consulting_fee, s.company, s.tax_id,
           p.code as payee_code, p.id as payee_id
    FROM stores s
    LEFT JOIN payee_stores ps ON ps.store_id = s.id
    LEFT JOIN payees p ON p.id = ps.payee_id
    WHERE s.consulting_fee > 0
    ORDER BY s.id, p.id
  `);

  console.log(`[consulting-fee] 找到 ${stores.length} 間有顧問費的店`);
  if (!stores.length) { await pool.end(); return; }

  // 2. Check duplicates in DB
  const { rows: existingRows } = await pool.query(
    `SELECT store_name FROM ach_records WHERE fee_type = '顧問費' AND description = $1`,
    [description]
  );
  const existingSet = new Set(existingRows.map(r => r.store_name));

  // Setup Sheets
  const auth = new google.auth.GoogleAuth({
    keyFile: '/Users/paopaomao/.openclaw/secrets/gcp-service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });

  let created = 0;
  const results = [];

  for (const store of stores) {
    const shortName = store.store_name.replace('泡泡貓｜', '').replace('店', '');
    const amount = parseFloat(store.consulting_fee);

    if (existingSet.has(shortName) || existingSet.has(store.store_name)) {
      console.log(`  ⏭️ ${shortName} $${amount} — 已存在，跳過`);
      continue;
    }

    console.log(`  ${shortName} | $${amount.toLocaleString()} | payee=${store.payee_code || '?'}`);

    if (DRY_RUN) {
      results.push({ store: shortName, amount });
      continue;
    }

    try {
      // A. Create Odoo sale.order
      let odooOrderName = null;
      try {
        // Find partner
        let partnerId = null;
        if (store.tax_id) {
          const partners = await odooCall('res.partner', 'search_read', [[['vat', '=', store.tax_id]]], { fields: ['id'], limit: 1 });
          if (partners.length) partnerId = partners[0].id;
        }
        if (!partnerId && store.company) {
          const partners = await odooCall('res.partner', 'search_read', [[['name', 'ilike', store.company]]], { fields: ['id'], limit: 1 });
          if (partners.length) partnerId = partners[0].id;
        }
        if (!partnerId) {
          const partners = await odooCall('res.partner', 'search_read', [[['name', 'ilike', shortName]]], { fields: ['id'], limit: 1 });
          if (partners.length) partnerId = partners[0].id;
        }

        if (partnerId) {
          const orderId = await odooCall('sale.order', 'create', [{
            partner_id: partnerId,
            note: description
          }]);
          await odooCall('sale.order.line', 'create', [{
            order_id: orderId,
            product_id: PRODUCT_ID,
            name: description,
            product_uom_qty: 1,
            price_unit: amount,
          }]);
          const order = await odooCall('sale.order', 'read', [[orderId]], { fields: ['name'] });
          odooOrderName = order[0]?.name;
          await odooCall('sale.order', 'write', [[orderId], { state: 'sent' }]);
          console.log(`    → Odoo: ${odooOrderName} → sent`);
        } else {
          console.warn(`    ⚠️ Odoo partner not found for ${shortName}`);
        }
      } catch (e) {
        console.error(`    ❌ Odoo error: ${e.message}`);
      }

      // B. Append to Sheet
      const newRow = [dateStr, shortName, amount, store.payee_code || '', '顧問費', description, '', '', '', '', '', '', '', '', '', odooOrderName || '', ''];
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

      // C. Insert into DB
      await pool.query(`
        INSERT INTO ach_records (sheet_row, record_date, store_name, amount, payee_code, fee_type, description,
          store_id, payee_id, odoo_quote_id, year)
        VALUES ($1, $2, $3, $4, $5, '顧問費', $6, $7, $8, $9, 2026)
        ON CONFLICT (sheet_row, year) DO UPDATE SET
          store_name=EXCLUDED.store_name, amount=EXCLUDED.amount, fee_type=EXCLUDED.fee_type,
          description=EXCLUDED.description, odoo_quote_id=EXCLUDED.odoo_quote_id, updated_at=NOW()
      `, [sheetRow, dateStr, shortName, amount, store.payee_code || '', description, store.store_id, store.payee_id, odooOrderName || '']);

      created++;
      results.push({ store: shortName, amount, odoo: odooOrderName, sheetRow });
    } catch (e) {
      console.error(`  ❌ ${shortName}: ${e.message}`);
    }
  }

  // TG notification
  if (results.length > 0 && !DRY_RUN) {
    const lines = results.map(r => `• ${r.store} $${r.amount.toLocaleString()}${r.odoo ? ' (' + r.odoo + ')' : ''}`);
    const msg = `💼 <b>${description} 自動建單完成</b>\n\n${lines.join('\n')}\n\n共 ${results.length} 筆`;
    await sendTG(TG_CHAT_ROBBY, msg);
  }

  console.log(`[consulting-fee] 🏁 完成：新增 ${created} 筆${DRY_RUN ? ' (dry-run)' : ''}`);
  await pool.end();
}

main().catch(e => { console.error('[consulting-fee] Fatal:', e); process.exit(1); });
