#!/usr/bin/env node
/**
 * backfill_daily_reports_2026.cjs
 * 2026 年全部從 SayDou dailyIncome 重新拉一次，慢慢來不要搞爆 API。
 * 每批 5 店，每批間隔 3 秒，每天完成後暫停 2 秒。
 */

const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({ database: 'paomao' });
const SAYDOU_API = 'https://saywebdatafeed.saydou.com';
const TOKEN_PATH = '/Users/paopaomao/.openclaw/workspace/booking-site/.saydou-token';
const BATCH_SIZE = 5;        // 每批只拉 5 店（原本 10）
const BATCH_DELAY = 3000;    // 每批間隔 3 秒（原本 1.5）
const DAY_DELAY = 2000;      // 每天結束暫停 2 秒
const REQUEST_TIMEOUT = 30000;

function getToken() {
  return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
}

function formatYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function getStores() {
  const { rows } = await pool.query(
    "SELECT id, store_name, saydou_id FROM stores WHERE saydou_id IS NOT NULL AND saydou_id != '0001' AND is_active = true ORDER BY store_name"
  );
  return rows;
}

async function fetchDailyIncome(token, storeId, dateStr) {
  const url = `${SAYDOU_API}/api/management/finance/dailyIncome?storid=${encodeURIComponent(storeId)}&date=${encodeURIComponent(dateStr)}&end_date=${encodeURIComponent(dateStr)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Token 過期 (HTTP ${res.status})`);
  }
  return await res.json();
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
  const shortName = storeName.replace(/^泡泡貓[｜|]/, '').replace(/店$/, '');
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
  const stores = await getStores();
  
  // Date range: 2026-01-01 to yesterday
  const startDate = new Date('2026-01-01T00:00:00+08:00');
  const now = new Date();
  // Yesterday in Taipei timezone
  const endDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  endDate.setDate(endDate.getDate() - 1);
  
  const dates = [];
  const cur = new Date(startDate);
  while (cur <= endDate) {
    dates.push(formatYmd(cur));
    cur.setDate(cur.getDate() + 1);
  }
  
  console.log(`[backfill] ${dates.length} 天 × ${stores.length} 店 = ${dates.length * stores.length} 次 API call`);
  console.log(`[backfill] 預估時間: ~${Math.ceil(dates.length * (stores.length / BATCH_SIZE) * (BATCH_DELAY/1000) / 60)} 分鐘`);
  console.log(`[backfill] 日期範圍: ${dates[0]} ~ ${dates[dates.length-1]}`);
  console.log(`[backfill] 每批 ${BATCH_SIZE} 店, 間隔 ${BATCH_DELAY/1000} 秒`);
  console.log('');

  const token = getToken();
  let success = 0, failed = 0, skipped = 0;
  const startTime = Date.now();

  for (let di = 0; di < dates.length; di++) {
    const dateStr = dates[di];
    let daySuccess = 0, dayFail = 0;
    
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
          dayFail++;
          console.error(`  ✗ ${store.store_name} ${dateStr}: ${res.reason?.message}`);
          if (res.reason?.message?.includes('Token 過期')) {
            console.error('\n⛔ Token 過期，中止。請更新 token 後重跑。');
            console.log(`進度: ${di}/${dates.length} 天, 已完成到 ${dateStr}`);
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
          daySuccess++;
        } catch (e) {
          failed++;
          dayFail++;
          console.error(`  ✗ DB ${store.store_name} ${dateStr}: ${e.message}`);
        }
      }

      // Delay between batches
      if (i + BATCH_SIZE < stores.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY));
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const pct = ((di + 1) / dates.length * 100).toFixed(0);
    console.log(`[${pct}%] ${dateStr} ✓ ${daySuccess} ok ${dayFail ? `/ ${dayFail} fail` : ''} (${elapsed}min)`);

    // Delay between days
    await new Promise(r => setTimeout(r, DAY_DELAY));
  }

  const totalMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n[backfill] 完成！ ${success} ok, ${failed} failed, ${skipped} skipped — 耗時 ${totalMin} 分鐘`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
