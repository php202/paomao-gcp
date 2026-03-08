#!/usr/bin/env node
/**
 * 每月 5 號自動跑「上個月」儲值金
 * 1. 從儲值金請款 Sheet 讀取 GAS storeData() 產出的數據（可靠來源）
 * 2. 比對 DB stores + payees 建立 ACH 記錄
 * 3. 建 Odoo SO (正數) 或 PO (負數)
 * 4. 寫入 DB ach_records + ACH Sheet
 * 5. 漏掉或異常 → TG 通知
 *
 * Usage:
 *   node scripts/monthly_stored_value.cjs                  # 自動算上個月
 *   node scripts/monthly_stored_value.cjs --month 2026-02  # 指定月份
 *   node scripts/monthly_stored_value.cjs --dry-run        # 只檢查不寫入
 */

const { google } = require('googleapis');
const pg = require('pg');
const xmlrpc = require('xmlrpc');
const fs = require('fs');

// ─── Config ───
const ACH_SHEET_ID = '17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE';
const ACH_SHEET_TAB = '2026/ACH紀錄';
const STORED_VALUE_SHEET_ID = '1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE';
const STORED_VALUE_TAB = '儲值金請款';
const ODOO_PRODUCT_ID = 724; // "ACH 匯款項目"
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = '7956245081'; // Robby 私訊
const TG_OFFICE_GROUP = '-5220564261';

const odooConfig = JSON.parse(fs.readFileSync('/Users/paopaomao/.openclaw/secrets/odoo-config.json', 'utf8'));

// ─── Args ───
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const monthIdx = args.indexOf('--month');
let targetMonth; // YYYY-MM format

if (monthIdx >= 0 && args[monthIdx + 1]) {
  targetMonth = args[monthIdx + 1]; // e.g. "2026-02"
} else {
  // Default: last month
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  targetMonth = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}`;
}

const [targetYear, targetMonthNum] = targetMonth.split('-').map(Number);
const monthLabel = `${targetMonthNum}月`;
const dateLabel = `${new Date().getMonth() + 1}/${new Date().getDate()}`; // today M/D for record_date

console.log(`\n🔄 儲值金自動化 — ${targetMonth} (${dryRun ? 'DRY RUN' : 'LIVE'})`);
console.log(`   record_date: ${dateLabel}\n`);

// ─── Helpers ───
async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    keyFile: '/Users/paopaomao/.openclaw/secrets/gcp-service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getClient();
}

function odooCall(model, method, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    const client = xmlrpc.createSecureClient({ host: 'paomao.odoo.com', port: 443, path: '/xmlrpc/2/object' });
    client.methodCall('execute_kw', [odooConfig.db, 6, odooConfig.password, model, method, args, kwargs], (err, val) => {
      if (err) {
        // Odoo wizard methods return None → xmlrpc marshal error; treat as success
        if (err.message && err.message.includes('Cannot read response')) {
          resolve(null);
        } else {
          reject(err);
        }
      } else resolve(val);
    });
  });
}

async function sendTG(chatId, text) {
  if (!TG_BOT_TOKEN) { console.log('[TG skip]', text); return; }
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('[TG error]', e.message);
  }
}

function parseAmount(str) {
  if (!str) return 0;
  const cleaned = String(str).replace(/,/g, '').replace(/\s/g, '');
  return parseFloat(cleaned) || 0;
}

// ─── Main ───
async function main() {
  const pool = new pg.Pool({ host: '/tmp', database: 'paomao', user: 'paopaomao' });
  const authClient = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  // 1. Check if already run for this month
  const { rows: existingRows } = await pool.query(
    `SELECT count(*) as cnt FROM ach_records WHERE fee_type = '儲值金' AND description LIKE $1 AND year = $2`,
    [`${targetMonth}月儲值金%`, targetYear]
  );
  if (parseInt(existingRows[0].cnt) > 0) {
    const msg = `⚠️ ${targetMonth} 儲值金已有 ${existingRows[0].cnt} 筆記錄，跳過避免重複。如需重跑請先清除舊資料。`;
    console.log(msg);
    await sendTG(TG_CHAT_ID, msg);
    await pool.end();
    return;
  }

  // 2. Get SayDou token from Sheet
  const tokenRes = await sheets.spreadsheets.values.get({
    spreadsheetId: STORED_VALUE_SHEET_ID,
    range: `'預約表單'!C2`,
  });
  const saydouToken = tokenRes.data.values?.[0]?.[0];
  if (!saydouToken) {
    const errMsg = '🚨 SayDou token 不存在！無法拉儲值金資料。';
    console.error(errMsg);
    await sendTG(TG_CHAT_ID, errMsg);
    await pool.end();
    return;
  }

  // Calculate date range for target month
  const fd = `${targetYear}-${String(targetMonthNum).padStart(2,'0')}-01`;
  const lastDay = new Date(targetYear, targetMonthNum, 0).getDate();
  const ld = `${targetYear}-${String(targetMonthNum).padStart(2,'0')}-${lastDay}`;
  console.log(`📅 SayDou 查詢區間: ${fd} ~ ${ld}`);

  // Also read Sheet for cross-check
  const svRes = await sheets.spreadsheets.values.get({
    spreadsheetId: STORED_VALUE_SHEET_ID,
    range: `'${STORED_VALUE_TAB}'!A:H`,
  });
  const svRows = svRes.data.values || [];
  const sheetCrossCheck = new Map();
  for (let i = 1; i < svRows.length; i++) {
    const row = svRows[i];
    if (!row[0]) continue;
    sheetCrossCheck.set(String(row[0]).trim(), parseAmount(row[6]) || 0);
  }
  console.log(`📊 儲值金請款 Sheet (交叉比對用): ${sheetCrossCheck.size} 間店`);

  // 3. Load stores + payees from DB
  const { rows: storePayees } = await pool.query(`
    SELECT s.id as store_id, s.store_name, s.saydou_id, p.id as payee_id, p.code as payee_code
    FROM stores s
    JOIN payees p ON p.store_id = s.id
    WHERE s.is_active = true AND s.saydou_id IS NOT NULL AND p.is_active = true
    ORDER BY s.store_name
  `);
  console.log(`📋 DB stores with payees: ${storePayees.length}`);

  // Lookup Odoo partner_id for each store
  console.log(`🔍 Looking up Odoo partners...`);
  for (const sp of storePayees) {
    try {
      const partners = await odooCall('res.partner', 'search_read',
        [[['name', '=', sp.store_name]]], { fields: ['id', 'name'], limit: 1 });
      if (partners && partners.length > 0) {
        sp.odoo_partner_id = partners[0].id;
      } else {
        // Try partial match
        const shortName = sp.store_name.replace('泡泡貓｜', '').replace('店', '');
        const p2 = await odooCall('res.partner', 'search_read',
          [[['name', 'ilike', shortName]]], { fields: ['id', 'name'], limit: 1 });
        if (p2 && p2.length > 0) sp.odoo_partner_id = p2[0].id;
      }
    } catch (e) {
      console.warn(`  ⚠️ ${sp.store_name} Odoo partner lookup failed: ${e.message}`);
    }
  }

  // 4. Pull SayDou data for each store + match
  const results = [];
  const warnings = [];
  const apiFailures = [];
  const headers = { Authorization: 'Bearer ' + saydouToken };

  console.log(`\n🔄 拉取 SayDou 儲值金資料...`);
  for (const sp of storePayees) {
    const shortName = sp.store_name.replace('泡泡貓｜', '').replace('店', '');
    try {
      // 1. storecashAddRecord (實收)
      const r1 = await fetch(`https://saywebdatafeed.saydou.com/api/management/unearn/storecashAddRecord?page=0&limit=20&sort=rectim&order=desc&keyword=&start=${fd}&end=${ld}&membid=0&storid%5B%5D=${sp.saydou_id}&type=0&tabIndex=1`, { headers });
      if (r1.status === 401) {
        // Token expired — abort all remaining stores
        const errMsg = `🚨 SayDou token 已過期 (401)！所有店家資料無法取得。請更新 token。`;
        console.error(errMsg);
        apiFailures.push(errMsg);
        break; // No point trying other stores
      }
      const d1 = await r1.json();
      if (d1.error) { apiFailures.push(`${shortName}: API 錯誤: ${JSON.stringify(d1.error).substring(0,100)}`); continue; }
      const addTotal = d1.total_amount || 0;

      // 2. transactionStatistic (card/coupon/ticket)
      const r3 = await fetch(`https://saywebdatafeed.saydou.com/api/management/finance/transactionStatistic?page=0&limit=500&sort=ordrsn&order=desc&keyword=&start=${fd}&end=${ld}&store%5B%5D=${sp.saydou_id}&membid=0&godsid=0&usrsid=0&assign=all`, { headers });
      const d3 = await r3.json();
      const card = d3.card || 0;
      const coupon = d3.coupon || 0;
      const ticket = d3.ticket || 0;

      const balance = addTotal - card - coupon - ticket;

      // Cross-check with Sheet
      const sheetBalance = sheetCrossCheck.get(sp.store_name);
      if (sheetBalance !== undefined && Math.abs(sheetBalance - balance) > 100) {
        warnings.push(`${shortName}: API=$${balance.toLocaleString()} vs Sheet=$${sheetBalance.toLocaleString()} (差異 $${Math.abs(sheetBalance - balance).toLocaleString()})`);
      }

      // API 回 0 但 Sheet 有值 → 可能 token 問題
      if (balance === 0 && addTotal === 0 && sheetBalance && Math.abs(sheetBalance) > 100) {
        apiFailures.push(`${shortName}: API 全部回 0 但 Sheet 有 $${sheetBalance.toLocaleString()}，可能 token 失效或 storid 錯誤`);
        continue;
      }

      if (balance === 0) {
        console.log(`  ⏭️ ${shortName}: 餘額 $0, skip`);
        continue;
      }

      if (!sp.odoo_partner_id) {
        warnings.push(`${shortName}: 找不到 Odoo partner, 無法建單`);
        continue;
      }

      results.push({
        ...sp,
        amount: balance,
        addTotal, card, coupon, ticket,
        description: `${targetMonth}月儲值金`,
      });

      // Throttle to avoid 429
      await new Promise(r => setTimeout(r, 500));

    } catch (e) {
      apiFailures.push(`${shortName}: ${e.message}`);
    }
  }

  // Stores in Sheet but not in DB payees (unmatched)
  const matchedNames = new Set(storePayees.map(sp => sp.store_name));
  const unmatched = [];
  for (const [name, bal] of sheetCrossCheck) {
    if (!matchedNames.has(name) && bal !== 0) {
      unmatched.push(`${name}: $${bal.toLocaleString()}`);
    }
  }

  console.log(`\n✅ 要建立: ${results.length} 筆`);
  console.log(`⚠️ 警告: ${warnings.length}`);
  console.log(`🚨 API 失敗: ${apiFailures.length}`);
  console.log(`❓ 在 Sheet 但沒 payee: ${unmatched.length}\n`);

  if (dryRun) {
    console.log('--- DRY RUN 結果 ---');
    results.forEach(r => {
      const shortName = r.store_name.replace('泡泡貓｜', '').replace('店', '');
      console.log(`  ${shortName}: $${r.amount.toLocaleString()} → ${r.amount >= 0 ? 'SO' : 'PO'}`);
    });
    if (warnings.length) console.log('\n⚠️ Warnings:', warnings);
    if (apiFailures.length) console.log('\n🚨 API Failures:', apiFailures);
    if (unmatched.length) console.log('\n❓ Unmatched:', unmatched);
    await pool.end();
    return;
  }

  // 5. Create Odoo orders + DB + Sheet
  const created = [];
  const errors = [];

  // Get Sheet next row
  const colA = await sheets.spreadsheets.values.get({
    spreadsheetId: ACH_SHEET_ID,
    range: `'${ACH_SHEET_TAB}'!A:A`,
  });
  let nextSheetRow = (colA.data.values?.length || 0) + 1;

  for (const r of results) {
    const shortName = r.store_name.replace('泡泡貓｜', '').replace('店', '');
    try {
      let odooOrderName;

      if (r.amount >= 0) {
        // Create Sale Order
        const soId = await odooCall('sale.order', 'create', [{
          partner_id: r.odoo_partner_id,
          company_id: 1,
          order_line: [[0, 0, {
            product_id: ODOO_PRODUCT_ID,
            name: r.description,
            product_uom_qty: 1,
            price_unit: r.amount,
          }]],
        }]);
        const so = await odooCall('sale.order', 'read', [soId], { fields: ['name'] });
        odooOrderName = so[0].name;
        console.log(`  ✅ ${shortName}: SO ${odooOrderName} ($${r.amount.toLocaleString()})`);
      } else {
        // Create Purchase Order (negative amount)
        const poId = await odooCall('purchase.order', 'create', [{
          partner_id: r.odoo_partner_id,
          company_id: 1,
          order_line: [[0, 0, {
            product_id: ODOO_PRODUCT_ID,
            name: r.description,
            product_uom_qty: 1,
            price_unit: Math.abs(r.amount),
          }]],
        }]);
        const po = await odooCall('purchase.order', 'read', [poId], { fields: ['name'] });
        odooOrderName = po[0].name;
        // Confirm PO
        await odooCall('purchase.order', 'button_confirm', [[poId]]);
        console.log(`  ✅ ${shortName}: PO ${odooOrderName} ($${r.amount.toLocaleString()}) [confirmed]`);
      }

      // Insert DB
      const { rows: dbRows } = await pool.query(`
        INSERT INTO ach_records (
          record_date, store_name, amount, payee_code, fee_type, description,
          invoice_confirmed, odoo_invoice_id, odoo_quote_id, 
          store_id, payee_id, sheet_row, year
        ) VALUES ($1, $2, $3, $4, '儲值金', $5, 'x', 'x', $6, $7, $8, $9, $10)
        RETURNING id
      `, [dateLabel, shortName, r.amount, r.payee_code, r.description,
          odooOrderName, r.store_id, r.payee_id, nextSheetRow, targetYear]);

      // Write Sheet row
      await sheets.spreadsheets.values.update({
        spreadsheetId: ACH_SHEET_ID,
        range: `'${ACH_SHEET_TAB}'!A${nextSheetRow}:Q${nextSheetRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[
            dateLabel, shortName, r.amount, r.payee_code, '儲值金', r.description,
            '', '', '', '', '', '', '', 'x', 'x', odooOrderName, ''
          ]]
        },
      });

      created.push({ store: shortName, amount: r.amount, odoo: odooOrderName, dbId: dbRows[0].id, sheetRow: nextSheetRow });
      nextSheetRow++;

    } catch (err) {
      const errMsg = `${shortName}: ${err.message}`;
      console.error(`  ❌ ${errMsg}`);
      errors.push(errMsg);
    }
  }

  // 6. Send TG summary
  const soCount = created.filter(c => c.amount >= 0).length;
  const poCount = created.filter(c => c.amount < 0).length;
  const totalAmount = created.reduce((sum, c) => sum + c.amount, 0);

  let msg = `📊 <b>${targetMonth} 儲值金自動建立完成</b>\n\n`;
  msg += `✅ 成功: ${created.length} 筆 (SO:${soCount} / PO:${poCount})\n`;
  msg += `💰 總金額: $${totalAmount.toLocaleString()}\n`;
  
  if (errors.length) {
    msg += `\n❌ <b>Odoo 建單失敗 ${errors.length} 筆:</b>\n${errors.map(e => `  • ${e}`).join('\n')}\n`;
  }
  if (apiFailures.length) {
    msg += `\n🚨 <b>SayDou API 失敗 ${apiFailures.length} 筆 (未建立！):</b>\n${apiFailures.map(a => `  • ${a}`).join('\n')}\n`;
  }
  if (warnings.length) {
    msg += `\n⚠️ <b>金額差異警告:</b>\n${warnings.map(w => `  • ${w}`).join('\n')}\n`;
  }
  if (unmatched.length) {
    msg += `\n❓ <b>在 Sheet 但無 payee (未建立):</b>\n${unmatched.map(u => `  • ${u}`).join('\n')}\n`;
  }

  msg += `\nSheet rows: ${created.length > 0 ? created[0].sheetRow + '-' + created[created.length - 1].sheetRow : 'N/A'}`;

  console.log('\n' + msg.replace(/<[^>]+>/g, ''));
  await sendTG(TG_CHAT_ID, msg);

  // If any errors or API failures, also notify Robby urgently
  if (errors.length > 0 || apiFailures.length > 0) {
    const alertMsg = `🚨 ${targetMonth} 儲值金有問題！\n` +
      (errors.length ? `❌ Odoo建單失敗: ${errors.length} 筆\n` : '') +
      (apiFailures.length ? `🚨 SayDou API失敗: ${apiFailures.length} 筆（這些店沒有建立！）\n` : '') +
      `請盡速檢查！`;
    await sendTG(TG_CHAT_ID, alertMsg);
  }

  await pool.end();
  console.log('\n✅ Done');
}

main().catch(async (e) => {
  console.error('Fatal:', e);
  await sendTG(TG_CHAT_ID, `🚨 儲值金自動化腳本錯誤:\n${e.message}`);
  process.exit(1);
});
