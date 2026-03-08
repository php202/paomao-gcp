#!/usr/bin/env node
/**
 * One-time fix: Write 29 儲值金 records (sheet_row IS NULL) to ACH Sheet + update DB sheet_row
 */
import { google } from 'googleapis';
import pg from 'pg';

const SHEET_ID = '17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE';
const SHEET_TAB = '2026/ACH紀錄';

async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    keyFile: '/Users/paopaomao/.openclaw/secrets/gcp-service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getClient();
}

async function main() {
  const pool = new pg.Pool({ host: '/tmp', database: 'paomao', user: 'paopaomao' });
  const authClient = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  // Get current last row in Sheet
  const colA = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_TAB}'!A:A`,
  });
  let nextRow = (colA.data.values?.length || 0) + 1;
  console.log(`Sheet last row: ${nextRow - 1}, next row: ${nextRow}`);

  // Get 29 records without sheet_row
  const { rows } = await pool.query(`
    SELECT id, record_date, store_name, amount, payee_code, fee_type, description,
           customer_confirmed, ach_registered, ach_case_no, ach_released, ach_confirmed,
           transfer_666_686, transfer_case_no, invoice_confirmed, odoo_invoice_id, odoo_quote_id, odoo_posted
    FROM ach_records
    WHERE fee_type = '儲值金' AND sheet_row IS NULL AND year = 2026
    ORDER BY id
  `);

  console.log(`Found ${rows.length} records to write`);

  // Build Sheet rows: A=date, B=store, C=amount, D=code, E=type, F=detail, G=confirmed,
  //   H=achLogged, I=achId, J=released, K=bankConfirm, L=transfer666, M=transferId,
  //   N=invoice, O=odooInvoice, P=odooQuote, Q=odooPosted
  const sheetRows = rows.map(r => [
    r.record_date || '',           // A
    r.store_name || '',            // B
    r.amount ? Number(r.amount) : '', // C
    r.payee_code || '',            // D
    r.fee_type || '',              // E
    r.description || '',           // F
    r.customer_confirmed || '',    // G
    r.ach_registered || '',        // H
    r.ach_case_no || '',           // I
    r.ach_released || '',          // J
    r.ach_confirmed || '',         // K
    r.transfer_666_686 || '',      // L
    r.transfer_case_no || '',      // M
    r.invoice_confirmed || 'x',    // N (儲值金不開發票)
    r.odoo_invoice_id || 'x',     // O
    r.odoo_quote_id || '',         // P
    r.odoo_posted || '',           // Q
  ]);

  // Append to Sheet
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_TAB}'!A${nextRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: sheetRows },
  });
  console.log(`✅ Wrote ${sheetRows.length} rows to Sheet starting at row ${nextRow}`);

  // Update DB sheet_row
  for (let i = 0; i < rows.length; i++) {
    const sheetRow = nextRow + i;
    await pool.query('UPDATE ach_records SET sheet_row = $1 WHERE id = $2', [sheetRow, rows[i].id]);
  }
  console.log(`✅ Updated ${rows.length} DB records with sheet_row ${nextRow}-${nextRow + rows.length - 1}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
