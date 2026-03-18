#!/usr/bin/env node
/**
 * LINE OA Manager 爬蟲 — 透過 browser evaluate 取得「加入管道」統計
 * 需要 LINE OA Manager 已在 openclaw browser 中登入
 * 
 * 用法: node scrape_line_oa.js [fromDate] [toDate]
 * 預設: 過去 30 天
 */

import { Pool } from 'pg';
const pgPool = new Pool({ database: 'paomao' });

const SOURCE_NAMES = {
  'externallink': '外部連結',
  'addfriendbutton': '加入好友圖示',
  'search': '搜尋',
  'other': '其他',
  '__CMS_POSTER__': '海報/宣傳',
  'inchatbutton': '聊天室按鈕',
  'oacoupon': '優惠券',
  'oalist': 'OA列表',
  'oashopcard': '集點卡',
  'sharedcontact': '分享聯絡人',
  'USER:Google Map': 'Google Map',
  'USER:LINE聯合推播': 'LINE聯合推播',
};

async function main() {
  const now = new Date();
  const from = process.argv[2] || new Date(now - 30 * 86400000).toISOString().slice(0,10).replace(/-/g, '');
  const to = process.argv[3] || new Date(now - 86400000).toISOString().slice(0,10).replace(/-/g, '');
  
  console.log(`📊 LINE OA 加入管道爬蟲 (${from} ~ ${to})`);
  
  // Use browser evaluate to call LINE OA Manager API
  const browserUrl = 'http://127.0.0.1:18800';
  
  // Find the LINE OA Manager tab
  const tabsResp = await fetch(`${browserUrl}/json`);
  const tabs = await tabsResp.json();
  const oaTab = tabs.find(t => t.url?.includes('manager.line.biz'));
  
  if (!oaTab) {
    console.error('❌ 找不到 LINE OA Manager 分頁，請先在 Chrome 開啟 manager.line.biz');
    process.exit(1);
  }
  
  // Use CDP to evaluate
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(oaTab.webSocketDebuggerUrl);
  
  await new Promise(resolve => ws.on('open', resolve));
  
  let msgId = 1;
  function cdpCall(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      ws.send(JSON.stringify({ id, method, params }));
      const handler = (data) => {
        const msg = JSON.parse(data);
        if (msg.id === id) {
          ws.off('message', handler);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      };
      ws.on('message', handler);
      setTimeout(() => reject(new Error('timeout')), 30000);
    });
  }
  
  // Get all bots
  const botsResult = await cdpCall('Runtime.evaluate', {
    expression: `(async () => {
      const r = await fetch('/api/bots?noCache=1');
      const d = await r.json();
      return JSON.stringify((d.list||[]).map(b => ({id: b.basicSearchId, name: b.name, reaches: b.targetedReaches})));
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  
  const bots = JSON.parse(botsResult.result.value);
  console.log(`找到 ${bots.length} 個 LINE OA`);
  
  let totalInserted = 0;
  
  for (const bot of bots) {
    try {
      // Get addFriend sources
      const srcResult = await cdpCall('Runtime.evaluate', {
        expression: `(async () => {
          const r = await fetch('/api/bots/${bot.id}/insight/addFriend?fromInclusive=${from}&toInclusive=${to}');
          return await r.text();
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      
      const srcData = JSON.parse(srcResult.result.value);
      const sources = srcData.summary || [];
      
      for (const s of sources) {
        const displaySource = SOURCE_NAMES[s.source] || s.source;
        await pgPool.query(`
          INSERT INTO line_friend_sources (store_name, line_channel_id, stat_date, source_type, count)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (store_name, stat_date, source_type) DO UPDATE SET count = $5, scraped_at = NOW()
        `, [bot.name, bot.id, to.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'), displaySource, s.added]);
        totalInserted++;
      }
      
      console.log(`  ✅ ${bot.name}: ${sources.length} 管道, ${srcData.total?.added || 0} 新好友`);
    } catch (e) {
      console.log(`  ❌ ${bot.name}: ${e.message}`);
    }
  }
  
  console.log(`\n✅ 完成! 寫入 ${totalInserted} 筆`);
  ws.close();
  await pgPool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
