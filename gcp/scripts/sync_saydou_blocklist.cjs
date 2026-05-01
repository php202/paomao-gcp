/**
 * SayDou 封鎖名單同步
 * 從 /api/management/crm/blockList 拉取全量名單 → upsert 到 saydou_blocklist
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ database: 'paomao', user: 'paopaomao' });

async function getSaydouToken() {
  const tokenFile = path.join(process.env.HOME, '.openclaw/workspace/booking-site/.saydou-token');
  return fs.readFileSync(tokenFile, 'utf8').trim();
}

async function fetchBlockList() {
  const token = await getSaydouToken();
  let allItems = [];
  let page = 0;
  const limit = 100;

  while (true) {
    const url = `https://saywebdatafeed.saydou.com/api/management/crm/blockList?page=${page}&limit=${limit}&sort=end_time&order=desc&keyword=`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000)
    });
    
    if (!resp.ok) throw new Error(`API ${resp.status}: ${resp.statusText}`);
    const json = await resp.json();
    
    const items = json.data?.items || [];
    allItems = allItems.concat(items);
    
    const total = json.data?.total || 0;
    console.log(`[blocklist] Page ${page}: ${items.length} items (total: ${total})`);
    
    if (allItems.length >= total || items.length < limit) break;
    page++;
  }

  return allItems;
}

async function syncToDb(items) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 先把所有 is_active 設為 false（之後 upsert 會更新回來）
    await client.query('UPDATE saydou_blocklist SET is_active = false, updated_at = NOW()');

    let inserted = 0, updated = 0;
    for (const item of items) {
      const result = await client.query(`
        INSERT INTO saydou_blocklist (membid, memnam, phone, start_time, end_time, remark, blocked_by_usrsid, blocked_by_name, is_active, synced_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW(), NOW())
        ON CONFLICT (membid) DO UPDATE SET
          memnam = EXCLUDED.memnam,
          phone = EXCLUDED.phone,
          start_time = EXCLUDED.start_time,
          end_time = EXCLUDED.end_time,
          remark = EXCLUDED.remark,
          blocked_by_usrsid = EXCLUDED.blocked_by_usrsid,
          blocked_by_name = EXCLUDED.blocked_by_name,
          is_active = true,
          synced_at = NOW(),
          updated_at = NOW()
        RETURNING (xmax = 0) AS is_insert
      `, [
        item.membid,
        item.memnam,
        item.phone_,
        item.start_time || null,
        item.end_time || null,
        item.remark || null,
        item.usrsid || null,
        item.usrs?.usrnam || null
      ]);

      if (result.rows[0]?.is_insert) inserted++;
      else updated++;
    }

    await client.query('COMMIT');
    return { inserted, updated, deactivated: 0 };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  console.log('[blocklist] 開始同步 SayDou 封鎖名單...');
  const startTime = Date.now();

  try {
    const items = await fetchBlockList();
    console.log(`[blocklist] 取得 ${items.length} 筆封鎖記錄`);

    const result = await syncToDb(items);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[blocklist] ✅ 同步完成 (${elapsed}s): 新增 ${result.inserted}, 更新 ${result.updated}`);

    // 統計
    const { rows } = await pool.query(`
      SELECT count(*) as total,
             count(*) FILTER (WHERE is_active AND end_time > NOW()) as active_blocked
      FROM saydou_blocklist
    `);
    console.log(`[blocklist] DB 統計: 總計 ${rows[0].total}, 目前有效封鎖 ${rows[0].active_blocked}`);
  } catch (e) {
    console.error(`[blocklist] ❌ 同步失敗:`, e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
