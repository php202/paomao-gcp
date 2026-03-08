const { google } = require('googleapis');
const { Pool } = require('pg');
const key = require('/Users/paopaomao/.openclaw/secrets/gcp-service-account.json');

const auth = new google.auth.JWT(key.client_email, null, key.private_key, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
const sheets = google.sheets({ version: 'v4', auth });
const pool = new Pool({ database: 'paomao', host: 'localhost', port: 5432 });

const SHEET_ID = '17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE';

function parseAmount(val) {
  if (!val) return 0;
  return parseFloat(String(val).replace(/[＄$,\s()（）]/g, '').replace(/^-/, '-')) || 0;
}

async function main() {
  console.log('Fetching all ACH rows from Sheet...');
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: '2026/ACH紀錄!A2:V99999'
  });
  const rows = res.data.values || [];
  console.log(`Sheet rows: ${rows.length}`);

  // Headers mapping (A=0):
  // A: date, B: store, C: amount, D: payee_code, E: fee_type, F: description
  // G: customer_confirmed, H: ach_registered, I: ach_case_no, J: ach_released
  // K: ach_confirmed, L: transfer_666_686, M: transfer_case_no, N: invoice_confirmed
  // O: odoo_invoice_id, P: odoo_quote_id, Q: odoo_posted
  // R: ref_case_no, S: ref_amount, T: ref_store, U: ref_account, V: ref_extra

  // Find store IDs
  const { rows: storeRows } = await pool.query('SELECT id, store_name FROM stores');
  const storeMap = new Map();
  storeRows.forEach(s => {
    storeMap.set(s.store_name, s.id);
    storeMap.set(s.store_name.replace('泡泡貓｜', ''), s.id);
  });

  // Find payee IDs
  const { rows: payeeRows } = await pool.query('SELECT id, code FROM payees');
  const payeeMap = new Map();
  payeeRows.forEach(p => payeeMap.set(p.code, p.id));

  let inserted = 0, updated = 0, errors = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const sheetRow = i + 2; // 1-indexed, skip header
    const record_date = (r[0] || '').trim();
    const store_name = (r[1] || '').trim();
    const amount = parseAmount(r[2]);
    const payee_code = (r[3] || '').trim();
    const fee_type = (r[4] || '').trim();
    const description = (r[5] || '').trim();
    const customer_confirmed = (r[6] || '').trim() || null;
    const ach_registered = (r[7] || '').trim() || null;
    const ach_case_no = (r[8] || '').trim() || null;
    const ach_released = (r[9] || '').trim() || null;
    const ach_confirmed = (r[10] || '').trim() || null;
    const transfer_666_686 = (r[11] || '').trim() || null;
    const transfer_case_no = (r[12] || '').trim() || null;
    const invoice_confirmed = (r[13] || '').trim() || null;
    const odoo_invoice_id = (r[14] || '').trim() || null;
    const odoo_quote_id = (r[15] || '').trim() || null;
    const odoo_posted = (r[16] || '').trim() || null;
    const ref_case_no = (r[17] || '').trim() || null;
    const ref_amount = (r[18] || '').trim() || null;
    const ref_store = (r[19] || '').trim() || null;
    const ref_account = (r[20] || '').trim() || null;
    const ref_extra = (r[21] || '').trim() || null;

    // Skip empty rows
    if (!store_name && !amount && !fee_type) continue;

    const store_id = storeMap.get(store_name) || storeMap.get('泡泡貓｜' + store_name) || null;
    const payee_id = payeeMap.get(payee_code) || null;

    try {
      const result = await pool.query(`
        INSERT INTO ach_records (sheet_row, record_date, store_name, amount, payee_code, fee_type,
          description, customer_confirmed, ach_registered, ach_case_no, ach_released,
          ach_confirmed, transfer_666_686, transfer_case_no, invoice_confirmed,
          odoo_invoice_id, odoo_quote_id, odoo_posted,
          ref_case_no, ref_amount, ref_store, ref_account, ref_extra,
          payee_id, store_id, year)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,2026)
        ON CONFLICT (sheet_row, year) DO UPDATE SET
          record_date=EXCLUDED.record_date, store_name=EXCLUDED.store_name, amount=EXCLUDED.amount,
          payee_code=EXCLUDED.payee_code, fee_type=EXCLUDED.fee_type, description=EXCLUDED.description,
          customer_confirmed=EXCLUDED.customer_confirmed, ach_registered=EXCLUDED.ach_registered,
          ach_case_no=EXCLUDED.ach_case_no, ach_released=EXCLUDED.ach_released,
          ach_confirmed=EXCLUDED.ach_confirmed, transfer_666_686=EXCLUDED.transfer_666_686,
          transfer_case_no=EXCLUDED.transfer_case_no, invoice_confirmed=EXCLUDED.invoice_confirmed,
          odoo_invoice_id=EXCLUDED.odoo_invoice_id, odoo_quote_id=EXCLUDED.odoo_quote_id,
          odoo_posted=EXCLUDED.odoo_posted, ref_case_no=EXCLUDED.ref_case_no,
          ref_amount=EXCLUDED.ref_amount, ref_store=EXCLUDED.ref_store,
          ref_account=EXCLUDED.ref_account, ref_extra=EXCLUDED.ref_extra,
          payee_id=EXCLUDED.payee_id, store_id=EXCLUDED.store_id,
          updated_at=NOW()
        RETURNING id, (xmax = 0) as is_insert
      `, [sheetRow, record_date, store_name, amount, payee_code, fee_type,
          description, customer_confirmed, ach_registered, ach_case_no, ach_released,
          ach_confirmed, transfer_666_686, transfer_case_no, invoice_confirmed,
          odoo_invoice_id, odoo_quote_id, odoo_posted,
          ref_case_no, ref_amount, ref_store, ref_account, ref_extra,
          payee_id, store_id]);
      
      if (result.rows[0]?.is_insert) inserted++;
      else updated++;
    } catch (err) {
      errors++;
      if (errors <= 5) console.error(`Row ${sheetRow} error:`, err.message);
    }

    if ((i + 1) % 200 === 0) console.log(`Progress: ${i + 1}/${rows.length}`);
  }

  // Verify
  const { rows: [cnt] } = await pool.query('SELECT COUNT(*) as total FROM ach_records WHERE year=2026');
  
  console.log(`\n=== Sync Complete ===`);
  console.log(`Sheet rows: ${rows.length}`);
  console.log(`Inserted: ${inserted}`);
  console.log(`Updated: ${updated}`);
  console.log(`Errors: ${errors}`);
  console.log(`DB total (2026): ${cnt.total}`);

  pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
