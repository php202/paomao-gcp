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
function buildBubble(order, storeName, amt, themeColor, itemContents, orderType) {
  const isPO = orderType === 'PO';
  if (!itemContents) {
    itemContents = [{ type: 'text', text: `$${amt.toLocaleString()}`, size: 'sm', color: '#333333' }];
  }
  const confirmAction = isPO ? 'po_confirm' : 'so_confirm';
  const cancelAction = isPO ? 'po_dispute' : 'so_cancel';
  const confirmLabel = '正確';
  const cancelLabel = isPO ? '有問題' : '取消';
  const title = isPO ? '🐱 儲值金對帳' : '🐱 請款提醒';
  const footerText = isPO
    ? `總公司將匯款：$${Math.abs(amt).toLocaleString()} 元`
    : `ACH 將自動扣款：$${amt.toLocaleString()} 元`;
  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical',
      contents: [
        { type: 'text', text: title, weight: 'bold', color: themeColor, size: 'sm' },
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
          { type: 'text', text: footerText, size: 'sm', weight: 'bold', margin: 'xs', color: '#333333' }
        ]}
      ]
    },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        { type: 'button', style: 'primary', color: themeColor, height: 'sm',
          action: { type: 'postback', label: confirmLabel, data: `action=${confirmAction}&orderId=${order.id}&orderName=${order.name}` } },
        { type: 'button', style: 'link', color: '#e53935', height: 'sm',
          action: { type: 'postback', label: cancelLabel, data: `action=${cancelAction}&orderId=${order.id}&orderName=${order.name}` } }
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

const TG_ROBBY_CHAT = '7956245081';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || (() => { try { return require('fs').readFileSync('/Users/paopaomao/.openclaw/secrets/telegram-bot-token.txt','utf8').trim(); } catch(e) { return ''; } })();
async function tgNotify(msg) {
  if (!TG_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_ROBBY_CHAT, text: msg, parse_mode: 'HTML' })
    });
  } catch(e) { console.log('[tg] notify error:', e.message); }
}

async function main() {
  const isForce = process.argv.includes('--force');
  // 判斷是否為 cron 排程時間（09:00 或 17:00 ±15分）
  const nowH = new Date(new Date().toLocaleString('en-US', {timeZone:'Asia/Taipei'})).getHours();
  const nowM = new Date(new Date().toLocaleString('en-US', {timeZone:'Asia/Taipei'})).getMinutes();
  const isCron = process.env.OPENCLAW_CRON === '1' || process.env.CRON === '1' || ((nowH === 9 || nowH === 17) && nowM <= 15);
  console.log('[notify-sent] 🚀 開始查詢 Odoo sent 訂單...' + (isForce ? ' (強制重發)' : '') + (isCron ? ' (cron)' : ' (手動)'));

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

  // 1b. 過濾今天已通知過的訂單（除非 --force）
  if (!isForce) {
    const orderNames = orders.map(o => o.name);
    const { rows: notified } = await pool.query(
      "SELECT DISTINCT order_name FROM so_notification_log WHERE order_name = ANY($1) AND notified_at::date = CURRENT_DATE",
      [orderNames]
    );
    const notifiedSet = new Set(notified.map(r => r.order_name));
    const before = orders.length;
    const filtered = orders.filter(o => !notifiedSet.has(o.name));
    if (notifiedSet.size > 0) {
      console.log(`[notify-sent] ⏭ 跳過 ${notifiedSet.size} 筆今天已通知: ${[...notifiedSet].join(', ')}`);
    }
    orders.length = 0;
    orders.push(...filtered);
    if (orders.length === 0) {
      console.log('[notify-sent] ✅ 所有訂單今天已通知過');
      await pool.end();
      return;
    }
  }

  // 1c. 手動執行時通知 Robby
  if (!isCron) {
    const summary = orders.map(o => `${o.name} ${(o.partner_id?.[1]||'').replace('泡泡貓｜','')} $${Math.round(o.amount_total).toLocaleString()}`).join('\n');
    await tgNotify(`⚠️ <b>手動執行 LINE 通知</b> (${isForce ? '強制重發' : '新單'})\n\n即將發送 ${orders.length} 筆：\n<code>${summary}</code>\n\nℹ️ 已執行，如有問題請聯繫小龍`);
    console.log('[notify-sent] 📩 已通知 Robby (TG)');
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
    groupBubbles[mapping.groupId].push({ bubble, storeName, orderName: order.name, orderId: order.id });
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
          // 記錄到 DB
          for (const item of chunk) {
            try {
              await pool.query(
                'INSERT INTO so_notification_log (order_name, order_id, notified_by, line_group_id, store_name) VALUES ($1, $2, $3, $4, $5)',
                [item.orderName, item.orderId || null, isForce ? 'manual' : 'cron', groupId, item.storeName]
              );
            } catch (e2) { /* ignore dup */ }
          }
          // 記錄到 Odoo chatter
          for (const item of chunk) {
            try {
              const oid = orders.find(o => o.name === item.orderName)?.id;
              if (oid) {
                await odooCall('sale.order', 'message_post', [[oid]], {
                  body: `📨 LINE 通知已發送 (${new Date().toLocaleString('zh-TW', {timeZone:'Asia/Taipei'})})`,
                  message_type: 'comment', subtype_xmlid: 'mail.mt_note'
                });
              }
            } catch (e3) { console.log('  ⚠️ Odoo chatter 寫入失敗: ' + (e3.message || '').substring(0, 60)); }
          }
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

  console.log(`[notify-sent] 📦 SO 完成：發送 ${sent} 筆，跳過 ${skipped} 筆`);

  // ═══ PO (Purchase Orders) 處理 ═══
  let poSent = 0, poSkipped = 0;
  try {
    const poOrders = await odooCall('purchase.order', 'search_read',
      [[['state', '=', 'sent']]],
      { fields: ['id', 'name', 'partner_id', 'amount_total', 'order_line'], limit: 200 }
    );
    console.log(`[notify-sent] 📊 PO: 找到 ${poOrders.length} 筆 sent 採購單`);

    if (poOrders.length > 0) {
      // 過濾今天已通知
      if (!isForce) {
        const poNames = poOrders.map(o => o.name);
        const { rows: notifiedPO } = await pool.query(
          "SELECT DISTINCT order_name FROM so_notification_log WHERE order_name = ANY($1) AND notified_at::date = CURRENT_DATE",
          [poNames]
        );
        const notifiedPOSet = new Set(notifiedPO.map(r => r.order_name));
        if (notifiedPOSet.size > 0) {
          console.log(`[notify-sent] ⏭ PO 跳過 ${notifiedPOSet.size} 筆今天已通知`);
        }
        const filtered = poOrders.filter(o => !notifiedPOSet.has(o.name));
        poOrders.length = 0;
        poOrders.push(...filtered);
      }

      if (poOrders.length > 0) {
        // 非 cron 時通知 Robby
        if (!isCron) {
          const summary = poOrders.map(o => `${o.name} ${(o.partner_id?.[1]||'').replace('泡泡貓｜','')} $${Math.round(o.amount_total).toLocaleString()}`).join('\n');
          await tgNotify(`⚠️ <b>手動執行 PO LINE 通知</b>\n\n即將發送 ${poOrders.length} 筆：\n<code>${summary}</code>`);
        }

        const poGroupBubbles = {};
        for (const po of poOrders) {
          const partnerId = po.partner_id?.[0];
          const partnerName = po.partner_id?.[1] || '';
          const mapping = groupMap.get(partnerId);
          if (!mapping) {
            console.log(`  ⏭️ ${po.name} (${partnerName}): 找不到 LINE 群組`);
            poSkipped++;
            continue;
          }

          // 取 PO 明細
          let poItemContents = null;
          try {
            const lines = await odooCall('purchase.order.line', 'read', [po.order_line],
              { fields: ['name', 'product_uom_qty', 'price_subtotal'] });
            const validLines = (lines || []).filter(l => l.price_subtotal !== 0);
            if (validLines.length > 0) {
              poItemContents = validLines.map(line => ({
                type: 'box', layout: 'horizontal', margin: 'sm',
                contents: [
                  { type: 'text', text: (line.name || '品項').replace(/\n/g, ' '), size: 'xs', color: '#555555', wrap: true, flex: 5 },
                  { type: 'text', text: `x${line.product_uom_qty}`, size: 'xs', color: '#888888', flex: 1, align: 'center' },
                  { type: 'text', text: `$${Math.round(line.price_subtotal).toLocaleString()}`, size: 'xs', color: '#333333', flex: 2, align: 'end' }
                ]
              }));
            }
          } catch(e) { /* ignore */ }

          const storeName = (mapping.storeName || partnerName).replace('泡泡貓｜', '');
          const amt = Math.round(po.amount_total);
          const bubble = buildBubble(po, storeName, amt, '#E74C3C', poItemContents, 'PO');

          if (!poGroupBubbles[mapping.groupId]) poGroupBubbles[mapping.groupId] = [];
          poGroupBubbles[mapping.groupId].push({ bubble, storeName, orderName: po.name, orderId: po.id });
        }

        // 發送 PO
        for (const [groupId, items] of Object.entries(poGroupBubbles)) {
          const storeNames = [...new Set(items.map(i => i.storeName))].join('/');
          const orderNames = items.map(i => i.orderName).join(', ');
          let flexContent = items.length === 1 ? items[0].bubble : { type: 'carousel', contents: items.map(i => i.bubble) };

          try {
            const lineRes = await fetch('https://api.line.me/v2/bot/message/push', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${PAOPAO_LINE_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to: groupId,
                messages: [{ type: 'flex', altText: `🐱 泡泡貓儲值金對帳 (PO) - ${storeNames}`, contents: flexContent }]
              })
            });

            if (lineRes.ok) {
              poSent += items.length;
              console.log(`  ✅ PO ${orderNames} → ${storeNames}`);
              for (const item of items) {
                try {
                  await pool.query('INSERT INTO so_notification_log (order_name, order_id, notified_by, line_group_id, store_name) VALUES ($1, $2, $3, $4, $5)',
                    [item.orderName, item.orderId, isForce ? 'manual' : 'cron', groupId, item.storeName]);
                } catch(e2) { /* dup */ }
              }
            } else {
              console.error(`  ❌ PO ${orderNames} LINE 發送失敗: ${await lineRes.text()}`);
            }
          } catch(e) {
            console.error(`  ❌ PO ${orderNames} 發送錯誤: ${e.message}`);
          }
          await new Promise(r => setTimeout(r, 300));
        }
      }
    }
  } catch(poErr) {
    console.error('[notify-sent] PO 處理錯誤:', poErr.message);
  }

  console.log(`[notify-sent] 🏁 完成：SO ${sent} 筆 + PO ${poSent} 筆，跳過 SO ${skipped} + PO ${poSkipped}`);
  await pool.end();
}

main().catch(e => {
  console.error('[notify-sent] ❌ 致命錯誤:', e);
  pool.end();
  process.exit(1);
});
