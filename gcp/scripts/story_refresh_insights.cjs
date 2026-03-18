#!/usr/bin/env node
/**
 * Story Insights 自動刷新
 * 
 * 從 IG Graph API 拉取 Story 的 reach/navigation/replies 數據
 * 更新回 story_stats 表
 * 
 * IG Story 只存活 24 小時，media 過期後 insights 也查不到
 * 所以需要在 24 小時內抓取
 * Cron: 每天 09:00 / 15:00 / 21:00（三次確保不漏）
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: 'postgresql://localhost/paomao' });
const META_TOKEN = fs.readFileSync(
  path.join(process.env.HOME, '.openclaw/secrets/meta-token.txt'), 'utf8'
).trim();
const IG_ACCOUNT_ID = '17841463367279845'; // @paopaomao_
const API_VERSION = 'v22.0';

async function fetchInsights(mediaId) {
  const url = `https://graph.facebook.com/${API_VERSION}/${mediaId}/insights?metric=reach,navigation,replies&access_token=${META_TOKEN}`;
  const res = await fetch(url);
  const json = await res.json();
  
  if (json.error) {
    // Media expired or not found — expected for stories > 48h
    if (json.error.code === 100) return null;
    console.error(`  [API error] ${mediaId}: ${json.error.message}`);
    return null;
  }
  
  const metrics = {};
  (json.data || []).forEach(m => {
    metrics[m.name] = m.values?.[0]?.value || 0;
  });
  return metrics;
}

async function main() {
  console.log('[story-insights] Refreshing...');
  
  // Get stories from last 24 hours that have ig_media_id (Story media expires after 24h)
  const { rows } = await pool.query(`
    SELECT id, ig_media_id, store_name, reach, published_at
    FROM story_stats
    WHERE ig_media_id IS NOT NULL
      AND published_at >= NOW() - INTERVAL '24 hours'
    ORDER BY published_at DESC
  `);
  
  if (!rows.length) {
    console.log('[story-insights] No recent stories to refresh');
    await pool.end();
    return;
  }
  
  console.log(`[story-insights] Found ${rows.length} stories to refresh`);
  let updated = 0, failed = 0, skipped = 0;
  
  // Also fetch currently live stories from IG API to catch any we missed
  try {
    const liveRes = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${IG_ACCOUNT_ID}/stories?fields=id,timestamp,media_type&access_token=${META_TOKEN}`
    );
    const liveJson = await liveRes.json();
    const liveIds = new Set((liveJson.data || []).map(s => s.id));
    const dbIds = new Set(rows.map(r => r.ig_media_id));
    const missing = [...liveIds].filter(id => !dbIds.has(id));
    if (missing.length) {
      console.log(`[story-insights] ${missing.length} live stories not in DB (skipping — they were posted outside the system)`);
    }
  } catch (e) {
    console.error('[story-insights] Failed to fetch live stories:', e.message);
  }
  
  for (const row of rows) {
    const metrics = await fetchInsights(row.ig_media_id);
    if (!metrics) {
      skipped++;
      console.log(`  ✗ ${row.store_name} (${row.ig_media_id}) — expired or unavailable`);
      continue;
    }
    
    const reach = metrics.reach || 0;
    const navigation = metrics.navigation || 0;
    const replies = metrics.replies || 0;
    
    await pool.query(
      `UPDATE story_stats 
       SET reach = $1, navigation = $2, replies = $3, fetched_at = NOW()
       WHERE id = $4`,
      [reach, navigation, replies, row.id]
    );
    
    const changed = reach !== row.reach;
    console.log(`  ${changed ? '✓' : '·'} ${row.store_name}: reach ${row.reach} → ${reach}, nav ${navigation}, replies ${replies}`);
    updated++;
    
    // Rate limit: 200 calls/hour, be gentle
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log(`[story-insights] Done: ${updated} updated, ${skipped} expired/skipped, ${failed} failed`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
