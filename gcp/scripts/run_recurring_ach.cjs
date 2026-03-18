#!/usr/bin/env node
/**
 * 每月定期扣款自動產生
 * Cron: 每月5號 08:00 執行
 * 讀取 ach_recurring 表，為啟用項目產生 ACH 紀錄 (DB + Sheet)
 */

const { Pool } = require('pg');
const { google } = require('googleapis');

const pool = new Pool({ database: 'paomao' });
const SHEET_ID = '17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE';
const SHEET_NAME = '2026/ACH紀錄';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '8520607475:AAHKn1oBOmTGloSzvM_Y0ps41tigRG3torc';
const TG_CHAT_ID = '-5220564261'; // 辦公室群組

async function sendTG(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' })
    });
  } catch(e) { console.error('TG send failed:', e.message); }
}

async function main() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const currentMonth = `${yyyy}-${mm}`;
  const dateStr = `${now.getMonth()+1}/${now.getDate()}`;

  console.log(`[recurring] Running for ${currentMonth}, date=${dateStr}`);

  const { rows: items } = await pool.query(
    `SELECT * FROM ach_recurring WHERE is_active=true`
  );
  console.log(`[recurring] Found ${items.length} active recurring items`);

  if (!items.length) { await pool.end(); return; }

  // Only process items whose day_of_month <= today (so 5號 items run on or after the 5th)
  const today = now.getDate();
  const eligible = items.filter(i => i.day_of_month <= today && i.last_generated_month !== currentMonth);

  if (!eligible.length) {
    console.log('[recurring] All items already generated or not yet due');
    await pool.end();
    return;
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: '/Users/paopaomao/.openclaw/secrets/gcp-service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });

  let created = 0;
  const details = [];

  for (const item of eligible) {
    const desc = `${mm}月${item.description}`;

    // Dedup check
    const existing = await pool.query(
      `SELECT id FROM ach_records WHERE store_name=$1 AND fee_type=$2 AND description=$3 AND year=$4`,
      [item.store_name, item.fee_type, desc, yyyy]
    );
    if (existing.rows.length > 0) {
      await pool.query(`UPDATE ach_recurring SET last_generated_month=$1 WHERE id=$2`, [currentMonth, item.id]);
      continue;
    }

    // Sheet
    const newRow = [dateStr, item.store_name, item.amount, item.payee_code || '', item.fee_type, desc];
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

    // DB
    const dbRes = await pool.query(
      `INSERT INTO ach_records (record_date, store_name, amount, payee_code, fee_type, description,
       store_id, payee_id, sheet_row, year)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [dateStr, item.store_name, item.amount, item.payee_code, item.fee_type, desc,
       item.store_id, item.payee_id, sheetRow, yyyy]
    );

    await pool.query(`UPDATE ach_recurring SET last_generated_month=$1, updated_at=now() WHERE id=$2`, [currentMonth, item.id]);

    await pool.query(
      `INSERT INTO ach_audit_log (ach_record_id, action, changed_by, details) VALUES ($1, 'create', 'cron-recurring', $2)`,
      [dbRes.rows[0].id, JSON.stringify({ source: 'recurring', recurring_id: item.id })]
    );

    details.push(`${item.store_name} $${Number(item.amount).toLocaleString()} ${item.fee_type} ${desc}`);
    created++;
  }

  if (created > 0) {
    const msg = `🔄 <b>定期扣款自動產生</b>\n\n本月新增 ${created} 筆：\n${details.map(d => `• ${d}`).join('\n')}`;
    await sendTG(msg);
    console.log(`[recurring] Created ${created} records`);
  } else {
    console.log('[recurring] No new records needed');
  }

  await pool.end();
}

main().catch(e => { console.error('[recurring] FATAL:', e); process.exit(1); });
