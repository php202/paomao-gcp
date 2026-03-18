#!/usr/bin/env node
/**
 * sync_sheets_cache.cjs — 把常用 Google Sheets 同步到本地 JSON 快取
 * 小龍讀本地 JSON 比打 API 快 100 倍，也不怕配額
 * 
 * 用法：node scripts/sync_sheets_cache.cjs [--sheet=xxx]
 * Cron：每天 06:00 自動跑
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(process.env.HOME, '.openclaw/workspace/data/cache');
const KEY_FILE = path.join(process.env.HOME, '.openclaw/secrets/gcp-service-account.json');

// Sheets to sync
const SHEETS_CONFIG = [
  {
    id: '1AmHy6-eaxSI-YY0l15lYFRDrgDoAczArmAlkPmNhrzE',
    name: 'hr-data',
    ranges: [
      { sheet: '基本資料', range: '基本資料!A:K' },
      { sheet: '基本資料問卷', range: '基本資料問卷!A:K' },
    ]
  },
  {
    id: '1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0',
    name: 'customer-status',
    ranges: [
      { sheet: '客人消費狀態', range: '客人消費狀態!A:Z' },
    ]
  },
  {
    id: '1bgumrtZS1FrP3t3bviZIbaPQjUIL0pGR9E2SJQESyuU',
    name: 'grading',
    ranges: [
      { sheet: '職責/升遷篇', range: "'職責/升遷篇'!A:Z" },
      { sheet: '薪資架構', range: "'薪資架構'!A:Z" },
      { sheet: '直營員工評分', range: "'直營員工評分'!A:Z" },
    ]
  },
  {
    id: '1GH2XbihFIY0AX8SMF9Tk6igrVKPpA_vMJVlkDkJjpe4',
    name: 'store-messages',
    ranges: [
      { sheet: '辦公室問卷', range: "'辦公室問卷'!A:Z" },
      { sheet: '員工清單', range: "'員工清單'!A:Z" },
      { sheet: '小費統整表', range: "'小費統整表'!A:Z" },
    ]
  },
];

async function main() {
  const specificSheet = process.argv.find(a => a.startsWith('--sheet='))?.split('=')[1];

  // Auth
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const configs = specificSheet
    ? SHEETS_CONFIG.filter(s => s.name === specificSheet)
    : SHEETS_CONFIG;

  for (const config of configs) {
    console.log(`\n📊 Syncing: ${config.name} (${config.id})`);
    const result = { _meta: { sheetId: config.id, syncedAt: new Date().toISOString() }, sheets: {} };

    for (const r of config.ranges) {
      try {
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: config.id,
          range: r.range,
        });
        const rows = res.data.values || [];
        if (rows.length === 0) {
          console.log(`  ⚠️ ${r.sheet}: empty`);
          continue;
        }
        // First row = headers
        const headers = rows[0];
        const data = rows.slice(1).map(row => {
          const obj = {};
          headers.forEach((h, i) => { obj[h] = row[i] || ''; });
          return obj;
        });
        result.sheets[r.sheet] = { headers, rowCount: data.length, data };
        console.log(`  ✅ ${r.sheet}: ${data.length} rows`);
      } catch (e) {
        console.log(`  ❌ ${r.sheet}: ${e.message}`);
        result.sheets[r.sheet] = { error: e.message };
      }
    }

    const outPath = path.join(CACHE_DIR, `${config.name}.json`);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(`  💾 Saved: ${outPath}`);
  }

  // Also dump a quick DB snapshot of employees + stores
  console.log('\n📋 Dumping DB snapshots...');
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ user: 'paopaomao', database: 'paomao' });

    // Employees
    const { rows: employees } = await pool.query(
      `SELECT id, name, nickname, title, department, store_name, phone, email, birth_date,
              is_active, managed_store_names, photo_url, employee_code, hire_date, bank_account
       FROM employees ORDER BY store_name, name`
    );
    fs.writeFileSync(
      path.join(CACHE_DIR, 'employees.json'),
      JSON.stringify({ _meta: { syncedAt: new Date().toISOString(), count: employees.length }, data: employees }, null, 2)
    );
    console.log(`  ✅ employees: ${employees.length} rows`);

    // Stores
    const { rows: stores } = await pool.query(
      `SELECT id, store_code, store_name, store_type, company, tax_id, phone, address, gmail, is_active
       FROM stores ORDER BY store_name`
    );
    fs.writeFileSync(
      path.join(CACHE_DIR, 'stores.json'),
      JSON.stringify({ _meta: { syncedAt: new Date().toISOString(), count: stores.length }, data: stores }, null, 2)
    );
    console.log(`  ✅ stores: ${stores.length} rows`);

    // Roles & permissions
    const { rows: roles } = await pool.query('SELECT role_name, display_name, permissions FROM roles ORDER BY role_name');
    fs.writeFileSync(
      path.join(CACHE_DIR, 'roles.json'),
      JSON.stringify({ _meta: { syncedAt: new Date().toISOString() }, data: roles }, null, 2)
    );
    console.log(`  ✅ roles: ${roles.length} rows`);

    await pool.end();
  } catch (e) {
    console.log(`  ❌ DB snapshot error: ${e.message}`);
  }

  console.log('\n🎉 Sync complete!');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
