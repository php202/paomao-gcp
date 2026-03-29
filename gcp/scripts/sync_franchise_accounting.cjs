#!/usr/bin/env node
/**
 * 特許加盟店帳務報表同步腳本
 * 從 Google Sheet 同步帳務資料到 DB franchise_accounting 表
 *
 * Usage:
 *   node sync_franchise_accounting.cjs              # 同步所有店
 *   node sync_franchise_accounting.cjs --store=內湖東湖店  # 同步特定店
 */

'use strict';

const { Pool } = require('pg');
const path = require('path');
const { google } = require('googleapis');

// ========== Config ==========
const SA_KEY_PATH = path.join(process.env.HOME, '.openclaw/secrets/gcp-service-account.json');

const pool = new Pool({
  host: '/tmp',
  database: 'paomao',
  user: 'paopaomao',
});

const SHEET_CONFIG = [
  {
    storeId: 79,
    storeName: '泡泡貓｜內湖東湖店',
    sheetId: '1nCBgYQNiSeJNSj03bOCwTgzol46UyepiP6wzjZzdez0',
    tab: '2025內湖東湖店', // 主帳表
  },
  {
    storeId: 82,
    storeName: '泡泡貓｜楠梓大學店',
    sheetId: '1sAuvl8QpiLvjv6zZd4rvcrNy6KZEgputHtQccUCXiWA',
    tab: '泡泡貓楠梓店帳表',
  },
  // 平鎮文化店待補
];

const VALID_CATEGORIES = new Set([
  '房屋', '人事', '備品', '消耗品', '軟裝', '冷氣',
  '運費', '餐費', '行銷', '雜支', '稅務', '儲值金',
  '加盟相關', '收入',
]);

// ========== Google Sheets Auth ==========
let sheetsApi = null;
async function getSheets() {
  if (sheetsApi) return sheetsApi;
  const auth = new google.auth.GoogleAuth({
    keyFile: SA_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const client = await auth.getClient();
  sheetsApi = google.sheets({ version: 'v4', auth: client });
  return sheetsApi;
}

// ========== 工具函數 ==========

/**
 * 解析金額字串，處理全形符號、千分位逗號等
 * 例如: '＄8,000' → 8000
 */
function parseAmount(str) {
  if (!str && str !== 0) return null;
  if (typeof str === 'number') return str;
  const cleaned = String(str).replace(/[＄$,，\s]/g, '').trim();
  if (!cleaned) return null;
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

/**
 * 解析日期字串
 * 支援格式: '2025/8/7', '1/12'（補當年）, 'YYYYMMDD', '2025-08-07'
 */
function parseDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  if (!s) return null;

  const currentYear = new Date().getFullYear();

  // YYYYMMDD 格式
  if (/^\d{8}$/.test(s)) {
    const y = s.slice(0, 4);
    const m = s.slice(4, 6);
    const d = s.slice(6, 8);
    const dt = new Date(`${y}-${m}-${d}`);
    return isNaN(dt) ? null : dt.toISOString().slice(0, 10);
  }

  // YYYY/M/D 或 YYYY-M-D 格式
  const fullMatch = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (fullMatch) {
    const y = fullMatch[1];
    const m = fullMatch[2].padStart(2, '0');
    const d = fullMatch[3].padStart(2, '0');
    const dt = new Date(`${y}-${m}-${d}`);
    return isNaN(dt) ? null : dt.toISOString().slice(0, 10);
  }

  // M/D 格式（缺年份 → 補當年）
  const shortMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (shortMatch) {
    const m = shortMatch[1].padStart(2, '0');
    const d = shortMatch[2].padStart(2, '0');
    const dt = new Date(`${currentYear}-${m}-${d}`);
    return isNaN(dt) ? null : dt.toISOString().slice(0, 10);
  }

  return null;
}

/**
 * 解析 Boolean 欄位 (TRUE/FALSE/v/V/是/否 等)
 */
function parseBool(str) {
  if (!str) return false;
  const s = String(str).trim().toLowerCase();
  return s === 'true' || s === 'v' || s === '是' || s === '✓' || s === '1' || s === 'yes';
}

/**
 * 計算 review_status
 */
function calcReviewStatus(isConfirmed, dateStr) {
  if (isConfirmed) return 'approved';
  if (!dateStr) return 'pending';

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const rowDate = new Date(dateStr);

  if (rowDate < sevenDaysAgo) return 'auto';
  return 'pending';
}

// ========== 同步單間店 ==========
async function syncStore(config) {
  const { storeId, storeName, sheetId, tab } = config;

  if (!tab) {
    console.log(`⏭️  ${storeName}: tab 未設定，跳過`);
    return { skipped: true };
  }

  console.log(`\n📊 開始同步: ${storeName} (${tab})`);

  const sheets = await getSheets();

  let rows;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tab}!A:O`,
    });
    rows = res.data.values || [];
  } catch (err) {
    console.error(`❌ 讀取 Sheet 失敗: ${err.message}`);
    return { error: err.message };
  }

  console.log(`  讀到 ${rows.length} 行（含 header）`);

  const client = await pool.connect();
  const stats = { inserted: 0, updated: 0, skipped: 0, errors: 0 };

  try {
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const sheetRow = i + 1; // 1-indexed, row 1 是 header

      // A欄日期
      const rawDate = (row[0] || '').trim();
      if (!rawDate) {
        stats.skipped++;
        continue;
      }

      const dateStr = parseDate(rawDate);
      if (!dateStr) {
        console.log(`  ⚠️ 第 ${sheetRow} 行：無法解析日期 "${rawDate}"，跳過`);
        stats.skipped++;
        continue;
      }

      // D欄 category
      const category = (row[3] || '').trim();
      if (!category) {
        stats.skipped++;
        continue;
      }

      // 若 category 不在枚舉中，仍收錄（避免遺漏），但 log 警告
      if (!VALID_CATEGORIES.has(category)) {
        console.log(`  ⚠️ 第 ${sheetRow} 行：未知分類 "${category}"`);
      }

      const expenseCode = (row[1] || '').trim() || null;
      const itemName = (row[4] || '').trim() || null;
      const income = parseAmount(row[5]) || 0;
      const expense = parseAmount(row[6]) || 0;
      const currency = (row[7] || '').trim() || '新台幣';
      const exchangeRate = parseAmount(row[8]) || 1;
      const personnel = (row[9] || '').trim() || null;
      const amount = parseAmount(row[10]);
      const hasReceipt = parseBool(row[11]);
      const isConfirmed = parseBool(row[12]);
      const isClaimed = parseBool(row[13]);
      const note = (row[14] || '').trim() || null;

      const reviewStatus = calcReviewStatus(isConfirmed, dateStr);

      try {
        const res = await client.query(`
          INSERT INTO franchise_accounting (
            store_id, store_name, date, expense_code, category, item_name,
            income, expense, currency, exchange_rate, personnel, amount,
            has_receipt, is_confirmed, is_claimed, note,
            sheet_row, source_sheet_id, source_tab, review_status, synced_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16,
            $17, $18, $19, $20, NOW(), NOW()
          )
          ON CONFLICT (store_id, date, sheet_row, source_sheet_id)
          DO UPDATE SET
            store_name     = EXCLUDED.store_name,
            expense_code   = EXCLUDED.expense_code,
            category       = EXCLUDED.category,
            item_name      = EXCLUDED.item_name,
            income         = EXCLUDED.income,
            expense        = EXCLUDED.expense,
            currency       = EXCLUDED.currency,
            exchange_rate  = EXCLUDED.exchange_rate,
            personnel      = EXCLUDED.personnel,
            amount         = EXCLUDED.amount,
            has_receipt    = EXCLUDED.has_receipt,
            is_confirmed   = EXCLUDED.is_confirmed,
            is_claimed     = EXCLUDED.is_claimed,
            note           = EXCLUDED.note,
            source_tab     = EXCLUDED.source_tab,
            review_status  = EXCLUDED.review_status,
            synced_at      = NOW(),
            updated_at     = NOW()
          RETURNING (xmax = 0) AS inserted
        `, [
          storeId, storeName, dateStr, expenseCode, category, itemName,
          income, expense, currency, exchangeRate, personnel, amount,
          hasReceipt, isConfirmed, isClaimed, note,
          sheetRow, sheetId, tab, reviewStatus,
        ]);

        if (res.rows[0].inserted) {
          stats.inserted++;
        } else {
          stats.updated++;
        }
      } catch (err) {
        console.error(`  ❌ 第 ${sheetRow} 行寫入失敗: ${err.message}`);
        stats.errors++;
      }
    }
  } finally {
    client.release();
  }

  console.log(`  ✅ 同步完成：新增 ${stats.inserted}，更新 ${stats.updated}，跳過 ${stats.skipped}，錯誤 ${stats.errors}`);
  return stats;
}

// ========== Main ==========
async function main() {
  const args = process.argv.slice(2);
  const storeArg = args.find(a => a.startsWith('--store='))?.replace('--store=', '');

  console.log('🚀 開始同步特許加盟店帳務資料...');
  console.log(`   時間: ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);

  const configs = storeArg
    ? SHEET_CONFIG.filter(c => c.storeName.includes(storeArg))
    : SHEET_CONFIG;

  if (configs.length === 0) {
    console.error(`❌ 找不到符合的店: ${storeArg}`);
    process.exit(1);
  }

  const summary = [];
  for (const config of configs) {
    const result = await syncStore(config);
    summary.push({ store: config.storeName, ...result });
  }

  console.log('\n========== 同步摘要 ==========');
  for (const s of summary) {
    if (s.skipped === true) {
      console.log(`  ${s.store}: 跳過（tab 未設定）`);
    } else if (s.error) {
      console.log(`  ${s.store}: ❌ 錯誤 - ${s.error}`);
    } else {
      console.log(`  ${s.store}: 新增 ${s.inserted}, 更新 ${s.updated}, 跳過 ${s.skipped}, 錯誤 ${s.errors}`);
    }
  }
  console.log('================================\n');

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
