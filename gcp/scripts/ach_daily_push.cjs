#!/usr/bin/env node
/**
 * ACH Daily Push — 定時推送未確認的 ACH 請款提醒到 LINE 群組
 * 替代 GAS dailyCheckAndPush，改用 DB 為 source of truth
 * 
 * 流程：
 * 1. 從 DB 查未確認 (customer_confirmed IS NULL/empty) 且有 odoo_quote_id 的紀錄
 * 2. 用 payees.line_group_id 找目標群組
 * 3. 發送 Flex Message（每筆一張卡片，帶 dbId + sheetRow）
 * 4. 客人按「正確」→ webhook 寫 DB
 */

const { Pool } = require('pg');
const pool = new Pool({ database: 'paomao' });

const PAOPAO_LINE_TOKEN = 'cpJinkc6qjthP9/685wxeI114mz/TPYieKdtabf0KIkuzpf1mGLFIRKSbVoCD7QAtIf7pBSJrI8I3x7Pk2Z5khTFbCgsaos749+4MjrIFoW5+90ppxSguaWlvYGGoLHGgMHzmJejEHWIlggnfMBqKQdB04t89/1O/w1cDnyilFU=';

async function main() {
  console.log('[ach-daily-push] 🚀 開始執行...');

  const { rows } = await pool.query(`
    SELECT ar.id, ar.sheet_row, ar.store_name, ar.amount, ar.fee_type, ar.description, ar.payee_code,
           ar.odoo_quote_id,
           s.store_name as full_store_name,
           p.line_group_id as payee_group_id, p.account_name as payee_name
    FROM ach_records ar
    LEFT JOIN stores s ON ar.store_id = s.id
    LEFT JOIN payees p ON ar.payee_id = p.id
    WHERE ar.year = 2026
      AND (ar.customer_confirmed IS NULL OR ar.customer_confirmed = '')
      AND ar.amount IS NOT NULL AND ar.amount != 0
      AND p.line_group_id IS NOT NULL AND p.line_group_id != ''
      AND ar.odoo_quote_id IS NOT NULL AND ar.odoo_quote_id != ''
    ORDER BY ar.sheet_row
  `);

  console.log(`[ach-daily-push] 📊 找到 ${rows.length} 筆未確認紀錄`);
  if (rows.length === 0) {
    console.log('[ach-daily-push] ✅ 全部已確認，無需推送');
    await pool.end();
    return;
  }

  // Group by payee_group_id
  const byGroup = {};
  for (const r of rows) {
    const key = r.payee_group_id;
    if (!byGroup[key]) byGroup[key] = {
      store: r.full_store_name || r.store_name,
      groupId: r.payee_group_id,
      items: []
    };
    byGroup[key].items.push(r);
  }

  let sent = 0, failed = 0;

  for (const [key, group] of Object.entries(byGroup)) {
    try {
      const storeName = (group.store || '').replace('泡泡貓｜', '');

      const bubbles = group.items.map(item => {
        const amt = Math.abs(item.amount);
        const dbId = item.id;
        const desc = item.description || item.fee_type || '代收款';
        const isPayment = item.amount < 0;
        const themeColor = isPayment ? '#FF5733' : '#1DB446';
        const titleText = isPayment ? '💰 付款通知' : '🐱 請款提醒';
        const footerText = isPayment ? `泡泡貓將付款給您：$${amt.toLocaleString()} 元` : `ACH 將自動扣款：$${amt.toLocaleString()} 元`;
        const sheetStoreName = item.store_name || storeName;
        const itemsText = `📋 ${desc} x1：$${amt.toLocaleString()}`;

        return {
          type: 'bubble',
          header: {
            type: 'box', layout: 'vertical',
            contents: [
              { type: 'text', text: titleText, weight: 'bold', color: themeColor, size: 'sm' },
              { type: 'text', text: `單號 ID: ${dbId}`, size: 'xs', color: '#aaaaaa', margin: 'xs' }
            ]
          },
          body: {
            type: 'box', layout: 'vertical',
            contents: [
              { type: 'text', text: sheetStoreName || '店家', weight: 'bold', size: 'md' },
              { type: 'separator', margin: 'md' },
              { type: 'text', text: itemsText, wrap: true, size: 'xs', margin: 'md', color: '#555555', lineSpacing: '4px' },
              { type: 'separator', margin: 'md' },
              { type: 'box', layout: 'vertical', margin: 'md', contents: [
                { type: 'text', text: '如果以上內容正確，請點擊下方按鈕確認。', size: 'xs', color: '#888888', wrap: true },
                { type: 'text', text: footerText, size: 'sm', weight: 'bold', margin: 'xs', color: '#333333' }
              ]}
            ]
          },
          footer: {
            type: 'box', layout: 'vertical',
            contents: [{
              type: 'button', style: 'primary', color: themeColor, height: 'sm',
              action: { type: 'postback', label: '正確', data: `action=confirm&dbId=${dbId}&sheetRow=${item.sheet_row}` }
            }]
          }
        };
      });

      // LINE max 12 bubbles per carousel
      const chunks = [];
      for (let i = 0; i < bubbles.length; i += 12) {
        chunks.push(bubbles.slice(i, i + 12));
      }

      for (const chunk of chunks) {
        const messages = chunk.length === 1
          ? [{ type: 'flex', altText: `🐱 泡泡貓請款提醒 - ${storeName}`, contents: chunk[0] }]
          : [{ type: 'flex', altText: `🐱 泡泡貓請款提醒 - ${storeName} (${chunk.length}筆)`, contents: { type: 'carousel', contents: chunk } }];

        const pushRes = await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: { Authorization: `Bearer ${PAOPAO_LINE_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: group.groupId, messages }),
          signal: AbortSignal.timeout(15000),
        });
        if (!pushRes.ok) {
          const errText = await pushRes.text();
          throw new Error(`Push failed: ${pushRes.status} ${errText.slice(0, 200)}`);
        }
      }
      sent += group.items.length;
      console.log(`[ach-daily-push] ✅ ${group.store} → ${group.items.length} 筆`);
    } catch (e) {
      console.error(`[ach-daily-push] ❌ ${group.store}: ${e.message}`);
      failed += group.items.length;
    }
  }

  console.log(`[ach-daily-push] 🏁 完成：發送 ${sent} 筆，失敗 ${failed} 筆，共 ${Object.keys(byGroup).length} 個群組`);
  await pool.end();
}

main().catch(e => { console.error('[ach-daily-push] Fatal:', e); process.exit(1); });
