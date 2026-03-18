#!/usr/bin/env node
/**
 * LINE OA Manager 爬蟲 — 取得「加入管道」統計
 * 
 * 使用方式：
 * 1. 先手動登入 LINE OA Manager，取得 cookie
 * 2. 或使用 Puppeteer 自動登入
 * 
 * 目前使用 LINE Messaging API 的 insight endpoint 取得基本數據，
 * 加入管道需要從 OA Manager 爬取。
 */

import { Pool } from 'pg';
const pgPool = new Pool({ database: 'paomao' });

// LINE OA Manager internal API endpoints (discovered)
// Base: https://manager.line.biz/api/
// 好友統計: /v1/bots/{botId}/insights/friends?period=daily&start={YYYYMMDD}&end={YYYYMMDD}
// 加入管道: /v1/bots/{botId}/insights/friends/add-path?start={YYYYMMDD}&end={YYYYMMDD}

// For now, use the official Messaging API insight endpoints per store
async function fetchStoreInsights() {
  const { rows: stores } = await pgPool.query(`
    SELECT store_name, line_channel_id, line_channel_secret 
    FROM stores 
    WHERE is_active = true AND line_channel_id IS NOT NULL AND line_channel_id != ''
  `);
  
  console.log(`Processing ${stores.length} stores...`);
  
  for (const store of stores) {
    try {
      // Get OAuth token
      const tokenResp = await fetch('https://api.line.me/v2/oauth/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: store.line_channel_id,
          client_secret: store.line_channel_secret,
        })
      });
      const tokenData = await tokenResp.json();
      if (!tokenData.access_token) {
        console.log(`  ⏭️ ${store.store_name}: no token`);
        continue;
      }
      
      // Get followers for last 7 days
      for (let d = 1; d <= 7; d++) {
        const date = new Date(Date.now() - d * 86400000);
        const dateStr = date.toISOString().slice(0,10).replace(/-/g, '');
        
        const resp = await fetch(`https://api.line.me/v2/bot/insight/followers?date=${dateStr}`, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const data = await resp.json();
        
        if (data.status === 'ready') {
          // Save to DB
          const statDate = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
          
          // followers = total, targetedReaches = reachable, blocks = blocked
          const sources = [
            { type: 'total_followers', count: data.followers || 0 },
            { type: 'targeted_reaches', count: data.targetedReaches || 0 },
            { type: 'blocks', count: data.blocks || 0 },
          ];
          
          for (const s of sources) {
            await pgPool.query(`
              INSERT INTO line_friend_sources (store_name, line_channel_id, stat_date, source_type, count)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (store_name, stat_date, source_type) DO UPDATE SET count = $5, scraped_at = NOW()
            `, [store.store_name, store.line_channel_id, statDate, s.type, s.count]);
          }
        }
      }
      
      console.log(`  ✅ ${store.store_name}`);
    } catch (e) {
      console.log(`  ❌ ${store.store_name}: ${e.message}`);
    }
  }
}

fetchStoreInsights().then(() => {
  console.log('Done');
  pgPool.end();
}).catch(e => {
  console.error(e);
  pgPool.end();
});
