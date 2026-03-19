#!/usr/bin/env node
/**
 * Notify Sent Orders — 推送 Odoo 狀態為 sent 的報價單到 LINE 群組
 * 每天 09:00 / 17:00 執行
 *
 * 流程：
 * 1. 查 Odoo sale.order state=sent
 * 2. 用 StoreGroupResolver 找 LINE 群組（odoo_id → parent_id → 名稱比對）
 * 3. 發送 Flex Message（帶 so_confirm / so_cancel 按鈕）
 * 4. 客人按「正確」→ paopao-webhook handleSOConfirmPostback
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const pool = new Pool({ database: 'paomao' });
const { odooCall } = require('../lib/odoo.cjs');
const { StoreGroupResolver } = require('../lib/store-group.cjs');

const PAOPAO_LINE_TOKEN = (process.env.LINE_TOKEN_PAOPAO || '').trim();

/** 建立 Flex Bubble */
function buildBubble(order, storeName, amt, themeColor, itemContents) {
  if (!itemContents) {
    itemContents = [{ type: 'text', text: `$${amt.toLocaleString()}`, size: 'sm', color: '#333333' }];
  }
  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical',
      contents: [
        { type: 'text', text: '🐱 請款提醒', weight: 'bold', color: themeColor, size: 'sm' },
        { type: 'text', text: `單號: ${order.name}`, size: 'xs', color: '#aaaaaa', margin: 'xs' }
      ]
    },
    body: {
      type: 'box', layout: 'vertical',
      contents: [
        { type: 'text', text: storeName || '店家', weight: 'bold', size: 'md' },
        { type: 'separator', margin: 'md' },
        { type: 'box', layout: 'vertical', margin: 'md', spacing: 'sm', contents: itemContents },
        { type: 'separator', margin: 'md' },
        { type: 'box', layout: 'vertical', margin: 'md', contents: [
          { type: 'text', text: '如果以上內容正確，請點擊下方按鈕確認。', size: 'xs', color: '#888888', wrap: true },
          { type: 'text', text: `ACH 將自動扣款：$${amt.toLocaleString()} 元`, size: 'sm', weight: 'bold', margin: 'xs', color: '#333333' }
        ]}
      ]
    },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        { type: 'button', style: 'primary', color: themeColor, height: 'sm',
          action: { type: 'postback', label: '正確', data: `action=so_confirm&orderId=${order.id}&orderName=${order.name}` } },
        { type: 'button', style: 'link', color: '#e53935', height: 'sm',
          action: { type: 'postback', label: '取消', data: `action=so_cancel&orderId=${order.id}&orderName=${order.name}` } }
      ]
    }
  };
}

/** 取訂單明細，組 itemContents */
async function getOrderItemContents(order) {
  try {
    const lines = await odooCall('sale.order.line', 'read', [order.order_line],
      { fields: ['name', 'product_uom_qty', 'price_subtotal'] }
    );
    const validLines = (lines || []).filter(l => l.price_subtotal !== 0);
    if (validLines.length > 0) {
      return validLines.map(line => ({
        type: 'box', layout: 'horizontal', margin: 'sm',
        contents: [
          { type: 'text', text: (line.name || '品項').replace(/\n/g, ' '), size: 'xs', color: '#555555', wrap: true, flex: 5 },
          { type: 'text', text: `x${line.product_uom_qty}`, size: 'xs', color: '#888888', flex: 1, align: 'center' },
          { type: 'text', text: `$${Math.round(line.price_subtotal).toLocaleString()}`, size: 'xs', color: '#333333', flex: 2, align: 'end' }
        ]
      }));
    }
  } catch (e) {
    console.warn(`  ⚠️ ${order.name}: 取明細失敗: ${e.message}`);
  }
  return null;
}

async function main() {
  console.log('[notify-sent] 🚀 開始查詢 Odoo sent 訂單...');

  // 1. 查 Odoo sent 狀態的 SO
  const orders = await odooCall('sale.order', 'search_read',
    [[['state', '=', 'sent']]],
    { fields: ['id', 'name', 'partner_id', 'amount_total', 'order_line', 'date_order'], limit: 200 }
  );

  console.log(`[notify-sent] 📊 找到 ${orders.length} 筆 sent 訂單`);
  if (orders.length === 0) {
    console.log('[notify-sent] ✅ 沒有待通知的訂單');
    await pool.end();
    return;
  }

  // 2. 初始化 StoreGroupResolver
  const resolver = new StoreGroupResolver(pool);
  await resolver.init();

  // 3. 批量解析所有訂單的 LINE 群組
  const items = orders.map(o => ({
    partnerId: o.partner_id?.[0],
    partnerName: o.partner_id?.[1] || ''
  }));
  const groupMap = await resolver.resolveBatch(items);

  let sent = 0, skipped = 0;
  const groupBubbles = {}; // groupId → [{ bubble, storeName, orderName }]

  for (const order of orders) {
    const partnerId = order.partner_id?.[0];
    const partnerName = order.partner_id?.[1] || '';
    const mapping = groupMap.get(partnerId);

    if (!mapping) {
      console.log(`  ⏭️ ${order.name} (${partnerName}): 找不到 LINE 群組，跳過`);
      skipped++;
      continue;
    }

    if (mapping.method !== 'odoo_id') {
      console.log(`  🔗 ${order.name}: partner "${partnerName}" → ${mapping.method} 比對到 ${mapping.storeName}`);
    }

    const itemContents = await getOrderItemContents(order);
    const storeName = (mapping.storeName || partnerName).replace('泡泡貓｜', '');
    const amt = Math.round(order.amount_total);
    const bubble = buildBubble(order, storeName, amt, '#1DB446', itemContents);

    if (!groupBubbles[mapping.groupId]) groupBubbles[mapping.groupId] = [];
    groupBubbles[mapping.groupId].push({ bubble, storeName, orderName: order.name });
  }

  // 4. 按群組發送：多筆 → carousel（可滑動），單筆 → 單 bubble
  for (const [groupId, items] of Object.entries(groupBubbles)) {
    // LINE carousel 最多 12 個 bubble
    const chunks = [];
    for (let i = 0; i < items.length; i += 12) {
      chunks.push(items.slice(i, i + 12));
    }

    for (const chunk of chunks) {
      const storeNames = [...new Set(chunk.map(i => i.storeName))].join('/');
      const orderNames = chunk.map(i => i.orderName).join(', ');

      let flexContent;
      if (chunk.length === 1) {
        flexContent = chunk[0].bubble;
      } else {
        flexContent = {
          type: 'carousel',
          contents: chunk.map(i => i.bubble)
        };
      }

      try {
        const lineRes = await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${PAOPAO_LINE_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: groupId,
            messages: [{ type: 'flex', altText: `🐱 泡泡貓請款提醒 (${chunk.length}筆) - ${storeNames}`, contents: flexContent }]
          })
        });

        if (lineRes.ok) {
          sent += chunk.length;
          console.log(`  ✅ ${orderNames} → ${storeNames} (${groupId.slice(0, 8)}...) [${chunk.length}筆 carousel]`);
        } else {
          const errText = await lineRes.text();
          console.error(`  ❌ ${orderNames} LINE 發送失敗: ${errText}`);
        }
      } catch (e) {
        console.error(`  ❌ ${orderNames} 發送錯誤: ${e.message}`);
      }

      // 避免 LINE rate limit
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`[notify-sent] 🏁 完成：發送 ${sent} 筆，跳過 ${skipped} 筆`);
  await pool.end();
}

main().catch(e => {
  console.error('[notify-sent] ❌ 致命錯誤:', e);
  pool.end();
  process.exit(1);
});
