#!/usr/bin/env node
/**
 * cron_daily_report_sync.cjs
 * 每天 09:30 跑，從 SayDou dailyIncome API 拉指定日期的營收資料，存進 daily_reports DB。
 *
 * Usage:
 *   node cron_daily_report_sync.cjs                    # 預設拉昨天
 *   node cron_daily_report_sync.cjs --date=2026-03-07  # 指定日期
 *   node cron_daily_report_sync.cjs --store=新竹公道    # 指定店家（模糊比對）
 *   node cron_daily_report_sync.cjs --date=2026-03-07 --store=新竹公道
 *   node cron_daily_report_sync.cjs --from=2026-03-01 --to=2026-03-07  # 日期區間
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ database: 'paomao' });

const SAYDOU_API = 'https://saywebdatafeed.saydou.com';
const TOKEN_PATH = '/Users/paopaomao/.openclaw/workspace/booking-site/.saydou-token';
const BATCH_SIZE = 10;
const BATCH_DELAY = 1500;

function getToken() {
  return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
}

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--(\w+)=(.+)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

function formatYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatYmd(d);
}

function today() {
  return formatYmd(new Date());
}

async function getStores(filter) {
  let q = "SELECT id, store_name, saydou_id FROM stores WHERE saydou_id IS NOT NULL AND saydou_id != '0001'";
  const params = [];
  if (filter) {
    q += ' AND store_name ILIKE $1';
    params.push(`%${filter}%`);
  }
  const { rows } = await pool.query(q, params);
  return rows;
}

async function fetchDailyIncome(token, storeId, dateStr) {
  const url = `${SAYDOU_API}/api/management/finance/dailyIncome?storid=${encodeURIComponent(storeId)}&date=${encodeURIComponent(dateStr)}&end_date=${encodeURIComponent(dateStr)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`SayDou Token 過期 (HTTP ${res.status})`);
  }
  const json = await res.json();
  return json;
}

function parseIncome(json) {
  const row = json?.data?.totalRow;
  if (!row) return null;

  const cashTotal = row.sum_paymentMethod?.[0]?.total || 0;
  const cashBusiness = row.cashpay?.business || 0;
  const cashUnearn = row.cashpay?.unearn || 0;
  const lineTotal = row.sum_paymentMethod?.[2]?.total || 0;
  const transferTotal = row.sum_paymentMethod?.[9]?.total || 0;
  const thirdPayTotal = lineTotal + transferTotal;
  const lineRecord = row.paymentMethod?.[2]?.total || 0;
  const transferRecord = row.paymentMethod?.[9]?.total || 0;
  const transferPending = transferTotal - transferRecord;
  const linePending = lineTotal - lineRecord;
  const revenue = row.businessIncome?.service ?? 0;

  return {
    cashTotal, cashConsume: cashBusiness, cashStored: cashUnearn,
    thirdPartyTotal: thirdPayTotal, transferReceived: transferRecord,
    lineReceived: lineRecord, transferPending, linePending, revenue,
  };
}

async function upsertReport(storeId, storeName, dateStr, data) {
  // Extract short name for store_name (matching Sheet convention)
  const shortName = storeName.replace(/^泡泡貓[｜|]/, '').replace(/店.*$/, '');

  await pool.query(`
    INSERT INTO daily_reports (store_id, store_name, report_date,
      cash_total, cash_consume, cash_stored, third_party_total,
      transfer_received, line_received, transfer_pending, line_pending,
      daily_revenue, data_source, synced_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'saydou',NOW())
    ON CONFLICT (store_name, report_date) DO UPDATE SET
      store_id = EXCLUDED.store_id,
      cash_total = EXCLUDED.cash_total,
      cash_consume = EXCLUDED.cash_consume,
      cash_stored = EXCLUDED.cash_stored,
      third_party_total = EXCLUDED.third_party_total,
      transfer_received = EXCLUDED.transfer_received,
      line_received = EXCLUDED.line_received,
      transfer_pending = EXCLUDED.transfer_pending,
      line_pending = EXCLUDED.line_pending,
      daily_revenue = EXCLUDED.daily_revenue,
      data_source = 'saydou',
      synced_at = NOW()
  `, [
    storeId, shortName, dateStr,
    data.cashTotal, data.cashConsume, data.cashStored, data.thirdPartyTotal,
    data.transferReceived, data.lineReceived, data.transferPending, data.linePending,
    data.revenue,
  ]);
}

async function main() {
  const args = parseArgs();

  // Date range
  const fromDate = args.from || args.date || yesterday();
  const toDate = args.to || args.date || yesterday();
  const storeFilter = args.store || null;

  // Generate date list
  const dates = [];
  const cur = new Date(fromDate + 'T00:00:00+08:00');
  const end = new Date(toDate + 'T00:00:00+08:00');
  while (cur <= end) {
    dates.push(formatYmd(cur));
    cur.setDate(cur.getDate() + 1);
  }

  const stores = await getStores(storeFilter);
  console.log(`[daily-report-sync] ${dates.length} 天 × ${stores.length} 店`);

  if (!stores.length) {
    console.error('No stores found');
    await pool.end();
    process.exit(1);
  }

  const token = getToken();
  let success = 0, failed = 0, skipped = 0;

  for (const dateStr of dates) {
    for (let i = 0; i < stores.length; i += BATCH_SIZE) {
      const batch = stores.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(s => fetchDailyIncome(token, s.saydou_id, dateStr))
      );

      for (let j = 0; j < results.length; j++) {
        const store = batch[j];
        const res = results[j];
        if (res.status !== 'fulfilled') {
          failed++;
          console.error(`  ✗ ${store.store_name} ${dateStr}: ${res.reason?.message}`);
          // Token expired = fatal
          if (res.reason?.message?.includes('Token 過期')) {
            console.error('Token expired, aborting');
            await pool.end();
            process.exit(1);
          }
          continue;
        }
        const data = parseIncome(res.value);
        if (!data) { skipped++; continue; }

        try {
          await upsertReport(store.id, store.store_name, dateStr, data);
          success++;
        } catch (e) {
          failed++;
          console.error(`  ✗ DB ${store.store_name} ${dateStr}: ${e.message}`);
        }
      }

      if (i + BATCH_SIZE < stores.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY));
      }
    }
    console.log(`[daily-report-sync] ${dateStr} done`);
  }

  console.log(`[daily-report-sync] 完成: ${success} ok, ${failed} failed, ${skipped} skipped`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
