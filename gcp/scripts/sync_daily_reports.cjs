#!/usr/bin/env node
/**
 * sync_daily_reports.cjs — 從 Google Sheet「營收報表」同步到 daily_reports DB
 * 可重複執行（UPSERT on store_name + report_date）
 * Usage: node sync_daily_reports.cjs [--from YYYY-MM-DD]
 */

const { google } = require('googleapis');
const { Pool } = require('pg');
const path = require('path');

const SHEET_ID = '1ZMutegYTLZ51XQHCbfFZ7-iAj1qTZGgSo5VTThXPQ5U';
const RANGE = '營收報表!B2:N10000';
const CREDS_PATH = '/Users/paopaomao/.openclaw/secrets/gcp-service-account.json';

const pool = new Pool({ database: 'paomao' });

function parseAmt(v) {
  if (!v) return 0;
  const s = String(v).replace(/[＄$,，\s]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

async function getStoreMap() {
  const { rows } = await pool.query("SELECT id, store_name FROM stores");
  const map = {};
  for (const r of rows) {
    const short = r.store_name.replace(/^泡泡貓[｜|]/, '').replace(/店.*$/, '');
    map[short] = r.id;
    map[r.store_name] = r.id;
  }
  return map;
}

function matchStore(name, storeMap) {
  if (storeMap[name]) return storeMap[name];
  // Try partial match
  for (const [key, id] of Object.entries(storeMap)) {
    if (key.includes(name) || name.includes(key)) return id;
  }
  return null;
}

async function main() {
  const fromArg = process.argv.find(a => a.startsWith('--from='));
  const fromDate = fromArg ? fromArg.split('=')[1] : null;

  // 1. Read Sheet
  const creds = require(CREDS_PATH);
  const auth = new google.auth.JWT(creds.client_email, null, creds.private_key, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE });
  let rows = (res.data.values || []).filter(r => r[0] && r[1]); // need date + store

  if (fromDate) {
    rows = rows.filter(r => r[0] >= fromDate);
    console.log(`Filtering from ${fromDate}: ${rows.length} rows`);
  }

  console.log(`Sheet rows to sync: ${rows.length}`);

  // 2. Store map
  const storeMap = await getStoreMap();

  // 3. UPSERT
  let inserted = 0, updated = 0, errors = 0;
  for (const r of rows) {
    const [date, store, cashTotal, cashConsume, cashStored, thirdParty, transferIn, lineIn, transferPending, linePending, revenue, errorNote, adjustTime] = r;
    const storeId = matchStore(store, storeMap);
    
    try {
      const result = await pool.query(`
        INSERT INTO daily_reports (store_name, store_id, report_date, cash_total, cash_consume, cash_stored,
          third_party_total, transfer_received, line_received, transfer_pending, line_pending,
          daily_revenue, error_note, adjust_time, data_source, synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'sheet',NOW())
        ON CONFLICT (store_name, report_date) DO UPDATE SET
          store_id = COALESCE(EXCLUDED.store_id, daily_reports.store_id),
          cash_total = EXCLUDED.cash_total,
          cash_consume = EXCLUDED.cash_consume,
          cash_stored = EXCLUDED.cash_stored,
          third_party_total = EXCLUDED.third_party_total,
          transfer_received = EXCLUDED.transfer_received,
          line_received = EXCLUDED.line_received,
          transfer_pending = EXCLUDED.transfer_pending,
          line_pending = EXCLUDED.line_pending,
          daily_revenue = EXCLUDED.daily_revenue,
          error_note = EXCLUDED.error_note,
          adjust_time = EXCLUDED.adjust_time,
          synced_at = NOW()
        RETURNING (xmax = 0) AS is_insert
      `, [
        store, storeId, date,
        parseAmt(cashTotal), parseAmt(cashConsume), parseAmt(cashStored),
        parseAmt(thirdParty), parseAmt(transferIn), parseAmt(lineIn),
        parseAmt(transferPending), parseAmt(linePending),
        parseAmt(revenue), errorNote || null, adjustTime || null
      ]);
      if (result.rows[0].is_insert) inserted++; else updated++;
    } catch (e) {
      errors++;
      if (errors <= 3) console.error(`Error: ${store} ${date}: ${e.message}`);
    }
  }

  console.log(`Done: ${inserted} inserted, ${updated} updated, ${errors} errors`);
  
  // 4. Fix any NULL store_id (台中廣三 mapping)
  const fixed = await pool.query(`
    UPDATE daily_reports SET store_id = 75 
    WHERE store_id IS NULL AND (store_name ILIKE '%台中廣三%')
    RETURNING id
  `);
  if (fixed.rowCount) console.log(`Fixed ${fixed.rowCount} 台中廣三 store_id`);

  // Summary
  const { rows: summary } = await pool.query("SELECT count(*), max(report_date) FROM daily_reports");
  console.log(`DB total: ${summary[0].count} rows, latest: ${summary[0].max}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
