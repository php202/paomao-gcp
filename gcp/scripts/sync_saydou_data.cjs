#!/usr/bin/env node
/**
 * sync_saydou_data.cjs — 從 SayDou 同步交易/儲值資料到本地 DB
 * 
 * v2.0 — Semaphore 池 + KPI 埋點 + Circuit Breaker
 * 
 * 用法：
 *   node scripts/sync_saydou_data.cjs                    # 同步當月
 *   node scripts/sync_saydou_data.cjs --month=2026-02    # 同步指定月份
 *   node scripts/sync_saydou_data.cjs --full             # 同步近3個月
 *   node scripts/sync_saydou_data.cjs --dry-run          # 只檢查不寫入
 *   node scripts/sync_saydou_data.cjs --test=5           # 只跑前 N 店（冒煙測試）
 * 
 * Cron：每小時跑一次
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ user: 'paopaomao', database: 'paomao' });

const TOKEN_PATH = path.join(process.env.HOME, '.openclaw/workspace/booking-site/.saydou-token');
const SAYDOU_API = 'https://saywebdatafeed.saydou.com';

// ─── Config ───
const CONCURRENCY = 5;            // Worker 池大小（SayDou API 甜蜜點）
const API_TIMEOUT_MS = 30000;     // 單次 API request timeout
const RATE_LIMIT_MS = 200;        // 分頁間隔
const CIRCUIT_BREAKER = {
  checkWindow: '12 hours',        // 檢查時間窗口
  warnAfter: 3,                   // 連續失敗 3 次 → 警告
  backoffAfter: 5,                // 連續失敗 5 次 → 降頻（等 5 分鐘）
  haltAfter: 10,                  // 連續失敗 10 次 → 停機
};

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const TEST_LIMIT = parseInt(args.find(a => a.startsWith('--test='))?.split('=')[1] || '0');
const RESYNC_MODE = args.includes('--resync');  // 處理 resync_requests
const BACKFILL = args.find(a => a.startsWith('--backfill='))?.split('=')[1]; // e.g. --backfill=2025-01
const RESYNC_STORE = args.find(a => a.startsWith('--store='))?.split('=')[1]; // e.g. --store=1437
const RESYNC_DATE = args.find(a => a.startsWith('--date='))?.split('=')[1];   // e.g. --date=2026-03-22

function getToken() {
  return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
}

// ─── Semaphore Pool ───
// 固定 N 個 worker 搶任務，跑完的立刻接下一個，不被最慢的店卡住
function createSemaphore(limit) {
  let active = 0;
  const queue = [];

  return async function run(fn) {
    if (active >= limit) {
      await new Promise(resolve => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      if (queue.length > 0) queue.shift()();
    }
  };
}

// ─── Instrumented API fetch ───
// 回傳 { data, latencyMs, status }
async function fetchJSON(url, token) {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { data, latencyMs, status: res.status };
  } finally {
    clearTimeout(timeout);
  }
}

// Get all stores with SayDou IDs
async function getStores() {
  const { rows } = await pool.query(
    "SELECT store_name, saydou_store_id FROM employees WHERE saydou_store_id IS NOT NULL AND saydou_store_id != '' AND is_active = true GROUP BY store_name, saydou_store_id"
  );
  const storeMap = new Map();
  for (const r of rows) {
    if (r.saydou_store_id) storeMap.set(r.saydou_store_id, r.store_name);
  }
  return storeMap;
}

// ─── Fetch with KPI tracking ───
async function fetchTransactions(token, storeId, startDate, endDate, kpi) {
  const allItems = [];
  let page = 0;
  const limit = 50;

  while (true) {
    const url = `${SAYDOU_API}/api/management/finance/transaction?page=${page}&limit=${limit}&sort=ordrsn&order=desc&keyword=&start=${startDate}&end=${endDate}&searchMemberCtrl=null&searchProductCtrl=null&searchStaffCtrl=null&membid=0&godsid=0&usrsid=0&memnam=&godnam=&usrnam=&assign=all&goctString=&store%5B%5D=${storeId}`;

    const { data, latencyMs } = await fetchJSON(url, token);
    kpi.apiCalls++;
    kpi.apiLatencies.push(latencyMs);

    const items = data?.data?.items || [];
    allItems.push(...items);

    const total = data?.data?.total || 0;
    if (allItems.length >= total || items.length < limit || items.length === 0) break;
    page++;
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  return allItems;
}

async function fetchStorecash(token, storeId, startDate, endDate, kpi) {
  const allItems = [];
  let page = 0;
  const limit = 50;

  while (true) {
    const url = `${SAYDOU_API}/api/management/unearn/storecashAddRecord?page=${page}&limit=${limit}&sort=rectim&order=desc&keyword=&start=${startDate}&end=${endDate}&membid=0&type=0&tabIndex=1&storid%5B%5D=${storeId}`;

    const { data, latencyMs } = await fetchJSON(url, token);
    kpi.apiCalls++;
    kpi.apiLatencies.push(latencyMs);

    const items = data?.data?.items || [];
    allItems.push(...items);

    const total = data?.data?.total || 0;
    if (allItems.length >= total || items.length < limit || items.length === 0) break;
    page++;
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  return allItems;
}

// ─── DB Write with timing ───
async function upsertTransactions(transactions, storeName, yearMonth, kpi) {
  if (DRY_RUN) return transactions.length;
  let count = 0;
  const writeStart = Date.now();

  for (const tx of transactions) {
    const ordcid = tx.ordcid;
    if (!ordcid) { kpi.nullRecords++; continue; }

    // Check for null member name
    const memnam = tx.memnam || tx.memb?.memnam;
    if (!memnam) kpi.nullRecords++;

    const items = (tx.ordds || []).map(d => ({
      godnam: d.godnam, godsid: d.godsid,
      price: d.rprice || d.price_, gocnam: d.gocnam,
      workers: (d.work || []).map(w => ({
        usrsid: w.usrsid, usrnam: w.usrnam,
        usrcod: (w.usrcod_usrnam || '').split('-')[0],
        achn: w.achn__, bonus: w.bonus_,
        pclnam: w.pcls?.pclnam,
      })),
      payment: {
        cash: d.gbmd?.cash || 0, card: d.gbmd?.card || 0,
        ticket: d.gbmd?.ticket || 0, rpcash: d.gbmd?.rpcash || 0,
        give: d.gbmd?.give || 0, free: d.gbmd?.free || 0,
      },
    }));

    try {
      await pool.query(`
        INSERT INTO saydou_transactions 
          (ordcid, ordrsn, membid, memnam, storid, store_name, rectim, rprice,
           cash, card, ticket, rpcash, give, free, remark, items, raw_data, year_month,
           order_date, order_time, updated_at, is_deleted)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW(),FALSE)
        ON CONFLICT (ordcid) DO UPDATE SET
          rprice=EXCLUDED.rprice, cash=EXCLUDED.cash, card=EXCLUDED.card,
          ticket=EXCLUDED.ticket, rpcash=EXCLUDED.rpcash, give=EXCLUDED.give, free=EXCLUDED.free,
          memnam=EXCLUDED.memnam, remark=EXCLUDED.remark,
          items=EXCLUDED.items, raw_data=EXCLUDED.raw_data,
          order_date=EXCLUDED.order_date, order_time=EXCLUDED.order_time,
          synced_at=NOW(), updated_at=NOW(), is_deleted=FALSE
      `, [
        ordcid, tx.ordrsn, tx.membid || tx.memb?.membid, memnam,
        tx.storid, storeName || tx.stor?.stonam,
        tx.rectim, tx.rprice || 0,
        tx.cash || 0, tx.card || 0, tx.ticket || 0, tx.rpcash || 0, tx.give || 0, tx.free || 0,
        tx.remark || '', JSON.stringify(items), JSON.stringify(tx), yearMonth,
        tx.rectim ? tx.rectim.substring(0, 10) : null,
        tx.rectim ? tx.rectim.substring(11, 16) : null,
      ]);
      count++;
    } catch (e) {
      console.error(`  ⚠️ tx ${ordcid}: ${e.message}`);
    }
  }

  kpi.dbWriteMs += Date.now() - writeStart;
  return count;
}

async function upsertStorecash(records, storeName, yearMonth, kpi) {
  if (DRY_RUN) return records.length;
  let count = 0;
  const writeStart = Date.now();

  for (const sc of records) {
    const scitid = sc.scitid;
    if (!scitid) { kpi.nullRecords++; continue; }
    if (!sc.memnam) kpi.nullRecords++;

    const staffCode = sc.usrs?.usrcod || (sc.usrcod_usrnam || '').split('-')[0] || '';

    try {
      await pool.query(`
        INSERT INTO saydou_storecash 
          (scitid, membid, memnam, storid, store_name, rectim, amount, type, remark, staff_code, raw_data, year_month)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (scitid) DO UPDATE SET
          amount=EXCLUDED.amount, raw_data=EXCLUDED.raw_data, synced_at=NOW()
      `, [
        scitid, sc.membid, sc.memnam,
        sc.storid, storeName || sc.stor?.stonam,
        sc.rectim, sc.amount || sc.cash || 0,
        sc.type || 0, sc.remark || '', staffCode,
        JSON.stringify(sc), yearMonth,
      ]);
      count++;
    } catch (e) {
      console.error(`  ⚠️ sc ${scitid}: ${e.message}`);
    }
  }

  kpi.dbWriteMs += Date.now() - writeStart;
  return count;
}

// ─── Single store sync with full KPI ───
async function syncStore(token, storeId, storeName, startDate, endDate, yearMonth) {
  const label = storeName.replace('泡泡貓｜', '');
  const storeStart = Date.now();

  // Per-store KPI
  const kpi = {
    apiCalls: 0,
    apiLatencies: [],  // ms per call
    dbWriteMs: 0,
    nullRecords: 0,
    retryCount: 0,
  };

  const { rows: [logRow] } = await pool.query(
    "INSERT INTO saydou_sync_log (sync_type, store_id, year_month) VALUES ('all', $1, $2) RETURNING id",
    [parseInt(storeId), yearMonth]
  );

  try {
    // Transactions
    const txItems = await fetchTransactions(token, storeId, startDate, endDate, kpi);
    const txCount = await upsertTransactions(txItems, storeName, yearMonth, kpi);

    // 刪單偵測：SayDou 回來的 ordcid 集合 vs DB 中該門市該期間的 ordcid
    // 如果 DB 有但 SayDou 沒有 → 標記 is_deleted（店長改單/刪單）
    if (txItems.length > 0) {
      const apiOrdcids = txItems.map(t => t.ordcid).filter(Boolean);
      const { rows: dbRows } = await pool.query(
        `SELECT ordcid FROM saydou_transactions WHERE storid = $1 AND year_month = $2 AND is_deleted = FALSE`,
        [parseInt(storeId), yearMonth]
      );
      const dbOrdcids = dbRows.map(r => r.ordcid);
      const apiSet = new Set(apiOrdcids.map(String));
      const deletedOrdcids = dbOrdcids.filter(id => !apiSet.has(String(id)));
      
      if (deletedOrdcids.length > 0) {
        await pool.query(
          `UPDATE saydou_transactions SET is_deleted = TRUE, updated_at = NOW() WHERE ordcid = ANY($1::bigint[])`,
          [deletedOrdcids]
        );
        kpi.deletedCount = deletedOrdcids.length;
        console.log(`  🗑️ ${storeName.replace('泡泡貓｜', '')}: ${deletedOrdcids.length} 筆已刪單標記`);
      }
    }

    // Storecash
    const scItems = await fetchStorecash(token, storeId, startDate, endDate, kpi);
    const scCount = await upsertStorecash(scItems, storeName, yearMonth, kpi);

    const elapsed = ((Date.now() - storeStart) / 1000).toFixed(1);
    const avgApi = kpi.apiLatencies.length > 0
      ? (kpi.apiLatencies.reduce((a, b) => a + b, 0) / kpi.apiLatencies.length).toFixed(0)
      : 0;
    const maxApi = kpi.apiLatencies.length > 0 ? Math.max(...kpi.apiLatencies) : 0;

    console.log(`  🏪 ${label} (${storeId}) ${elapsed}s | tx:${txCount} sc:${scCount} | api:${avgApi}ms(max ${maxApi}ms) db:${kpi.dbWriteMs}ms${kpi.nullRecords > 0 ? ` ⚠️null:${kpi.nullRecords}` : ''}`);

    // Write KPI to sync_log
    await pool.query(`
      UPDATE saydou_sync_log SET 
        status='success', records_synced=$1, finished_at=NOW(),
        api_calls=$2, api_avg_ms=$3, api_max_ms=$4, db_write_ms=$5,
        tx_count=$6, sc_count=$7, null_records=$8, retry_count=$9
      WHERE id=$10
    `, [
      txCount + scCount, kpi.apiCalls,
      parseFloat(avgApi), maxApi, kpi.dbWriteMs,
      txCount, scCount, kpi.nullRecords, kpi.retryCount,
      logRow.id,
    ]);

    return { tx: txCount, sc: scCount, kpi };
  } catch (e) {
    const elapsed = ((Date.now() - storeStart) / 1000).toFixed(1);
    console.log(`  🏪 ${label} (${storeId}) ${elapsed}s | ❌ ${e.message}`);
    await pool.query(
      "UPDATE saydou_sync_log SET status='error', error_message=$1, finished_at=NOW() WHERE id=$2",
      [e.message, logRow.id]
    );
    return { tx: 0, sc: 0, kpi, error: e.message };
  }
}

// ─── Circuit Breaker ───
async function checkCircuitBreaker() {
  const { rows: [{ cnt }] } = await pool.query(
    `SELECT COUNT(*) as cnt FROM saydou_sync_log 
     WHERE status = 'error' AND started_at > NOW() - INTERVAL '${CIRCUIT_BREAKER.checkWindow}'
     AND sync_type = 'all'`
  );
  const errorCount = parseInt(cnt);

  // Count unique failed runs (group by started_at minute)
  const { rows: [{ run_errors }] } = await pool.query(
    `SELECT COUNT(DISTINCT DATE_TRUNC('minute', started_at)) as run_errors 
     FROM saydou_sync_log 
     WHERE status = 'error' AND started_at > NOW() - INTERVAL '${CIRCUIT_BREAKER.checkWindow}'`
  );
  const consecutiveRuns = parseInt(run_errors);

  if (consecutiveRuns >= CIRCUIT_BREAKER.haltAfter) {
    console.log(`🛑 CIRCUIT BREAKER OPEN: ${consecutiveRuns} 次連續失敗 (>${CIRCUIT_BREAKER.haltAfter})，暫停同步`);
    console.log(`   請檢查 SayDou token/API 狀態後手動重啟`);
    process.exit(2);
  }

  if (consecutiveRuns >= CIRCUIT_BREAKER.backoffAfter) {
    console.log(`⚠️ 降頻模式: ${consecutiveRuns} 次連續失敗，等待 5 分鐘...`);
    await new Promise(r => setTimeout(r, 300000));
  }

  if (consecutiveRuns >= CIRCUIT_BREAKER.warnAfter) {
    console.log(`⚠️ 警告: 過去 ${CIRCUIT_BREAKER.checkWindow} 內 ${consecutiveRuns} 次失敗`);
  }

  return { consecutiveRuns, totalErrors: errorCount };
}

// ─── Month sync with Semaphore Pool ───
async function syncMonth(token, storeMap, yearMonth) {
  const [year, month] = yearMonth.split('-');
  const startDate = `${yearMonth}-01`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const endDate = `${yearMonth}-${lastDay}`;

  console.log(`\n📅 Syncing ${yearMonth} (${startDate} ~ ${endDate})`);

  let entries = Array.from(storeMap.entries());
  if (TEST_LIMIT > 0) {
    entries = entries.slice(0, TEST_LIMIT);
    console.log(`🧪 Test mode: only ${TEST_LIMIT} stores`);
  }
  if (DRY_RUN) console.log('🏜️ Dry-run mode: no DB writes');

  // Semaphore pool: 5 workers 搶任務
  const sem = createSemaphore(CONCURRENCY);

  const results = await Promise.all(
    entries.map(([storeId, storeName]) =>
      sem(() => syncStore(token, storeId, storeName, startDate, endDate, yearMonth))
    )
  );

  // Aggregate
  let totalTx = 0, totalSc = 0;
  const allKpis = { apiCalls: 0, apiLatencies: [], dbWriteMs: 0, nullRecords: 0, errors: 0 };

  for (const r of results) {
    totalTx += r.tx;
    totalSc += r.sc;
    allKpis.apiCalls += r.kpi.apiCalls;
    allKpis.apiLatencies.push(...r.kpi.apiLatencies);
    allKpis.dbWriteMs += r.kpi.dbWriteMs;
    allKpis.nullRecords += r.kpi.nullRecords;
    if (r.error) allKpis.errors++;
  }

  return { totalTx, totalSc, kpis: allKpis, storeCount: entries.length };
}

// ─── Main ───
async function main() {
  const specificMonth = args.find(a => a.startsWith('--month='))?.split('=')[1];
  const fullSync = args.includes('--full');

  console.log('🔄 SayDou Data Sync v2.1 (resync + backfill)');
  console.log(`   Concurrency: ${CONCURRENCY} workers | API timeout: ${API_TIMEOUT_MS}ms`);
  console.log('='.repeat(60));

  // Circuit breaker check
  const cb = await checkCircuitBreaker();

  const token = getToken();
  const storeMap = await getStores();
  console.log(`Found ${storeMap.size} stores with SayDou IDs`);

  // Dynamic timeout warning
  const estimatedSec = Math.ceil(storeMap.size / CONCURRENCY) * 30;
  if (estimatedSec > 240) {
    console.log(`⚠️ 預估耗時 ~${estimatedSec}s，接近 timeout 門檻`);
  }

  if (storeMap.size === 0) {
    console.log('⚠️ No stores with saydou_store_id found. Trying fallback...');
    const { rows } = await pool.query("SELECT DISTINCT storid, store_name FROM saydou_transactions LIMIT 50");
    for (const r of rows) storeMap.set(String(r.storid), r.store_name);
    if (storeMap.size === 0) {
      console.log('❌ No store IDs available.');
      process.exit(1);
    }
  }

  // ─── Resync 模式：處理 pending 的重跑請求 ───
  if (RESYNC_MODE) {
    const { rows: reqs } = await pool.query(
      "SELECT * FROM saydou_resync_requests WHERE status = 'pending' ORDER BY requested_at LIMIT 20"
    );
    if (reqs.length === 0) {
      console.log('✅ No pending resync requests');
      await pool.end();
      return;
    }
    console.log(`🔄 Processing ${reqs.length} resync requests`);
    for (const req of reqs) {
      await pool.query("UPDATE saydou_resync_requests SET status='processing' WHERE id=$1", [req.id]);
      const ym = req.resync_date.toISOString().substring(0, 7);
      const dateStr = req.resync_date.toISOString().substring(0, 10);
      // Resync 只跑指定日期（不是整月），更精準
      try {
        const result = await syncStore(token, String(req.store_id), req.store_name, dateStr, dateStr, ym);
        await pool.query("UPDATE saydou_resync_requests SET status='done', processed_at=NOW(), note=$1 WHERE id=$2",
          [`tx:${result.tx} sc:${result.sc}`, req.id]);
        console.log(`  ✅ Resync ${req.store_name} ${dateStr}: tx:${result.tx}`);
      } catch (e) {
        await pool.query("UPDATE saydou_resync_requests SET status='error', processed_at=NOW(), note=$1 WHERE id=$2",
          [e.message, req.id]);
        console.log(`  ❌ Resync ${req.store_name} ${dateStr}: ${e.message}`);
      }
    }
    await pool.end();
    return;
  }

  // ─── 單店單日 resync（CLI 直接指定）───
  if (RESYNC_STORE && RESYNC_DATE) {
    const storeName = storeMap.get(RESYNC_STORE) || `store_${RESYNC_STORE}`;
    const ym = RESYNC_DATE.substring(0, 7);
    console.log(`🔄 Resync: ${storeName} (${RESYNC_STORE}) @ ${RESYNC_DATE}`);
    const result = await syncStore(token, RESYNC_STORE, storeName, RESYNC_DATE, RESYNC_DATE, ym);
    console.log(`✅ Done: tx:${result.tx} sc:${result.sc}`);
    await pool.end();
    return;
  }

  // ─── Backfill 模式：歷史回填（指定起始月到今天）───
  if (BACKFILL) {
    const [startYear, startMonth] = BACKFILL.split('-').map(Number);
    const endDate = new Date();
    const months = [];
    let cur = new Date(startYear, startMonth - 1, 1);
    while (cur <= endDate) {
      months.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
      cur.setMonth(cur.getMonth() + 1);
    }
    console.log(`📦 Backfill: ${months[0]} → ${months[months.length - 1]} (${months.length} months)`);
    let grandTx = 0, grandSc = 0;
    for (const ym of months) {
      const { totalTx, totalSc } = await syncMonth(token, storeMap, ym);
      grandTx += totalTx;
      grandSc += totalSc;
    }
    console.log(`\n✅ Backfill complete: tx:${grandTx} sc:${grandSc}`);
    await pool.end();
    return;
  }

  const now = new Date();
  let months = [];

  if (specificMonth) {
    months = [specificMonth];
  } else if (fullSync) {
    for (let i = 0; i < 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
  } else {
    months = [`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`];
  }

  let grandTx = 0, grandSc = 0;
  const startTime = Date.now();
  let lastKpis = null;

  for (const ym of months) {
    const { totalTx, totalSc, kpis } = await syncMonth(token, storeMap, ym);
    grandTx += totalTx;
    grandSc += totalSc;
    lastKpis = kpis;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Summary with KPI
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ Done in ${elapsed}s (concurrency: ${CONCURRENCY})`);
  console.log(`   交易: ${grandTx} 筆 | 儲值: ${grandSc} 筆`);

  if (lastKpis) {
    const avgApi = lastKpis.apiLatencies.length > 0
      ? (lastKpis.apiLatencies.reduce((a, b) => a + b, 0) / lastKpis.apiLatencies.length).toFixed(0)
      : 0;
    const maxApi = lastKpis.apiLatencies.length > 0 ? Math.max(...lastKpis.apiLatencies) : 0;
    const nullRate = (grandTx + grandSc) > 0
      ? (lastKpis.nullRecords / (grandTx + grandSc) * 100).toFixed(1)
      : 0;

    console.log(`\n📊 KPI Summary`);
    console.log(`   API calls: ${lastKpis.apiCalls} | avg: ${avgApi}ms | max: ${maxApi}ms`);
    console.log(`   DB write: ${(lastKpis.dbWriteMs / 1000).toFixed(1)}s`);
    console.log(`   Null records: ${lastKpis.nullRecords} (${nullRate}%)`);
    console.log(`   Errors: ${lastKpis.errors} stores failed`);
    console.log(`   Timeout usage: ${(parseFloat(elapsed) / 300 * 100).toFixed(0)}% of 300s`);

    // Trend warning
    if (parseFloat(elapsed) / 300 > 0.85) {
      console.log(`\n🔴 WARNING: 耗時 ${elapsed}s 超過 timeout 85% 水位！考慮增加 timeout 或優化`);
    } else if (parseFloat(elapsed) / 300 > 0.70) {
      console.log(`\n🟡 NOTICE: 耗時 ${elapsed}s 接近 timeout 70% 水位`);
    }
  }

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
