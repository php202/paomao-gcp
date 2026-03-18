#!/usr/bin/env node
/**
 * LINE OA 每日數據收集器
 * 
 * 透過 Messaging API 收集各門市的：
 * - 好友數、目標好友數、封鎖數（每日快照）
 * - 每日好友增減（跟前一天比較）
 * - 訊息數：自動回應、歡迎訊息、手動聊天、API Push/Reply、群發
 * 
 * 用法：node line_oa_stats_collector.js [--date YYYYMMDD] [--backfill N]
 *   --date: 指定收集日期（預設昨天，因為 LINE 統計有 1 天延遲）
 *   --backfill N: 回填過去 N 天的資料
 */

const { Pool } = require('pg');

const pool = new Pool({ connectionString: 'postgresql://localhost/paomao' });

// LINE API rate limit: 注意不要太快
const DELAY_MS = 300;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getStoresWithLineCredentials() {
  const { rows } = await pool.query(`
    SELECT store_name, line_channel_id, line_channel_secret, line_oa_url
    FROM stores 
    WHERE line_channel_id IS NOT NULL 
      AND line_channel_secret IS NOT NULL
      AND line_channel_id != ''
    ORDER BY store_name
  `);
  return rows;
}

async function getLineToken(channelId, channelSecret) {
  const res = await fetch('https://api.line.me/v2/oauth/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${channelId}&client_secret=${channelSecret}`
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function getFollowerInsight(token, date) {
  const res = await fetch(`https://api.line.me/v2/bot/insight/followers?date=${date}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  if (data.status !== 'ready') return null;
  return data;
}

async function getMessageDelivery(token, date) {
  const res = await fetch(`https://api.line.me/v2/bot/insight/message/delivery?date=${date}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  if (data.status !== 'ready') return null;
  return data;
}

function formatDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function toDateStr(yyyymmdd) {
  return `${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`;
}

async function collectForDate(stores, dateStr) {
  const dateSql = toDateStr(dateStr);
  const prevDate = new Date(dateSql);
  prevDate.setDate(prevDate.getDate() - 1);
  const prevDateStr = formatDate(prevDate);
  
  console.log(`\n📊 收集 ${dateSql} 的數據...`);
  
  let success = 0, skip = 0, fail = 0;
  
  for (const store of stores) {
    try {
      const token = await getLineToken(store.line_channel_id, store.line_channel_secret);
      
      // Get follower data
      const followers = await getFollowerInsight(token, dateStr);
      await sleep(DELAY_MS);
      
      // Get message delivery data
      const messages = await getMessageDelivery(token, dateStr);
      await sleep(DELAY_MS);
      
      if (!followers) {
        console.log(`  ⏭️ ${store.store_name}: 數據未就緒`);
        skip++;
        continue;
      }
      
      // Get previous day to calculate daily change
      let followersAdded = null, followersBlocked = null;
      const prevFollowers = await getFollowerInsight(token, prevDateStr);
      await sleep(DELAY_MS);
      
      if (prevFollowers) {
        followersAdded = followers.followers - prevFollowers.followers;
        followersBlocked = followers.blocks - prevFollowers.blocks;
      }
      
      // Upsert into DB
      await pool.query(`
        INSERT INTO line_oa_daily_stats 
          (store_name, line_id, stat_date, followers, targeted_reaches, blocks,
           followers_added, followers_blocked,
           msg_auto_response, msg_welcome_response, msg_chat, 
           msg_api_push, msg_api_reply, msg_broadcast)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (store_name, stat_date) DO UPDATE SET
          followers = EXCLUDED.followers,
          targeted_reaches = EXCLUDED.targeted_reaches,
          blocks = EXCLUDED.blocks,
          followers_added = EXCLUDED.followers_added,
          followers_blocked = EXCLUDED.followers_blocked,
          msg_auto_response = EXCLUDED.msg_auto_response,
          msg_welcome_response = EXCLUDED.msg_welcome_response,
          msg_chat = EXCLUDED.msg_chat,
          msg_api_push = EXCLUDED.msg_api_push,
          msg_api_reply = EXCLUDED.msg_api_reply,
          msg_broadcast = EXCLUDED.msg_broadcast,
          collected_at = NOW()
      `, [
        store.store_name, store.line_oa_url || null, dateSql,
        followers.followers, followers.targetedReaches, followers.blocks,
        followersAdded, followersBlocked,
        messages?.autoResponse || 0, messages?.welcomeResponse || 0, 
        messages?.chat || 0, messages?.apiPush || 0, messages?.apiReply || 0,
        messages?.broadcasting || 0
      ]);
      
      const addStr = followersAdded !== null ? `+${followersAdded}` : '?';
      console.log(`  ✅ ${store.store_name}: 好友${followers.followers}(${addStr}) 封鎖${followers.blocks} 訊息:自動${messages?.autoResponse||0}/手動${messages?.chat||0}/推播${messages?.apiPush||0}`);
      success++;
      
    } catch (err) {
      console.error(`  ❌ ${store.store_name}: ${err.message}`);
      fail++;
    }
  }
  
  console.log(`\n📋 ${dateSql} 完成: ✅${success} ⏭️${skip} ❌${fail}`);
  return { success, skip, fail };
}

async function main() {
  const args = process.argv.slice(2);
  let backfill = 1;
  let startDate = null;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i+1]) {
      startDate = args[i+1];
      backfill = 1;
      i++;
    } else if (args[i] === '--backfill' && args[i+1]) {
      backfill = parseInt(args[i+1]);
      i++;
    }
  }
  
  const stores = await getStoresWithLineCredentials();
  console.log(`🏪 找到 ${stores.length} 間門市有 LINE 憑證`);
  
  if (startDate) {
    await collectForDate(stores, startDate);
  } else {
    // Collect for past N days (default: yesterday only)
    for (let i = backfill; i >= 1; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = formatDate(d);
      await collectForDate(stores, dateStr);
    }
  }
  
  await pool.end();
  console.log('\n✅ 全部完成');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
