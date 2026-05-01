#!/usr/bin/env node
/**
 * 維修報價單 Odoo SO 狀態輪詢
 * 
 * 偵測 Odoo SO 狀態從 sent → sale 時，自動更新 Dashboard 維修單為 payment_received
 * 並觸發後續流程（建發票、確認發票）
 * 
 * 建議 cron 每 10 分鐘執行
 */
// crontab: 0,10,20,30,40,50 * * * * cd ~/paomao-gcp/gcp && node scripts/repair_odoo_so_poll.cjs

'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { odooCall } = require('../lib/odoo.cjs');

const pool = new Pool({ database: 'paomao', host: 'localhost', port: 5432, max: 5 });

// === Telegram ===
function getBotToken() {
  const envPaths = [
    path.join(process.env.HOME, '泡泡貓', 'dashboard', '.env'),
  ];
  for (const p of envPaths) {
    try {
      const content = fs.readFileSync(p, 'utf8');
      const m = content.match(/TELEGRAM_BOT_TOKEN=(.+)/);
      if (m) return m[1].trim();
    } catch {}
  }
  return process.env.TELEGRAM_BOT_TOKEN || '';
}

async function sendTelegram(chatId, text) {
  const token = getBotToken();
  if (!token) { console.log('⚠️ No bot token'); return; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) console.error('TG error:', await res.text());
  } catch (e) { console.error('TG send failed:', e.message); }
}

const TG_REPAIR_GROUP = '-5007437010';   // 泡泡貓維修群
const TG_OFFICE_GROUP = '-5220564261';   // 泡泡貓辦公室群

// === 主流程 ===
async function main() {
  console.log(`[${new Date().toISOString()}] 開始輪詢維修報價單 Odoo SO 狀態...`);

  // 找出所有 status=quoted 且有 odoo_so_id 的維修單
  const { rows } = await pool.query(`
    SELECT id, order_number, store_name, odoo_so_id, odoo_so_name, estimated_cost
    FROM repair_orders
    WHERE status = 'quoted' AND odoo_so_id IS NOT NULL
  `);

  if (rows.length === 0) {
    console.log('ℹ️ 沒有待確認的報價單');
    return;
  }

  console.log(`📋 找到 ${rows.length} 筆待確認報價單`);

  for (const order of rows) {
    try {
      // 讀取 Odoo SO 狀態
      const soData = await odooCall('sale.order', 'read', [[order.odoo_so_id]], { fields: ['state', 'name'] });

      if (!soData || !Array.isArray(soData) || soData.length === 0) {
        console.log(`⚠️ ${order.order_number}: 找不到 Odoo SO ${order.odoo_so_id}`);
        continue;
      }

      const soState = soData[0]?.state;
      const soName = soData[0]?.name || order.odoo_so_name;
      console.log(`  ${order.order_number} (${soName}): SO state = ${soState}`);

      // SO 狀態為 sale → 觸發 payment_received
      if (soState === 'sale') {
        console.log(`🎯 ${order.order_number}: SO 已確認為銷售訂單，更新為 payment_received`);

        // 1. 更新 DB 狀態
        await pool.query(`
          UPDATE repair_orders
          SET status = 'payment_received', updated_at = NOW()
          WHERE id = $1
        `, [order.id]);

        // 2. 寫入進度紀錄
        await pool.query(`
          INSERT INTO repair_progress (repair_order_id, status, description, technician_name)
          VALUES ($1, 'payment_received', $2, 'System')
        `, [order.id, `Odoo SO ${soName} 已確認為銷售訂單，自動更新為可進行維修`]);

        // 3. 建立發票 + 確認發票
        let invoiceInfo = '';
        try {
          const invoiceIds = await odooCall('sale.order', '_create_invoices', [[order.odoo_so_id]], { final: false });
          const invoiceId = Array.isArray(invoiceIds) ? invoiceIds[0] : invoiceIds;
          if (invoiceId) {
            try {
              await odooCall('account.move', 'action_post', [[invoiceId]]);
              invoiceInfo = `\n🧾 發票已建立並確認 (id=${invoiceId})`;
              console.log(`  ✅ 發票已建立並確認: id=${invoiceId}`);
            } catch (postErr) {
              invoiceInfo = `\n🧾 發票已建立 (id=${invoiceId})，確認失敗: ${postErr.message}`;
              console.error(`  ⚠️ 發票確認失敗:`, postErr.message);
            }
          }
        } catch (invErr) {
          invoiceInfo = `\n⚠️ 建立發票失敗: ${invErr.message}`;
          console.error(`  ⚠️ 建立發票失敗:`, invErr.message);
        }

        // 4. TG 通知
        const tgMsg = `✅ 維修單狀態自動更新

📋 維修單：${order.order_number}
🏪 店家：${order.store_name}
💰 金額：NT$${(order.estimated_cost || 0).toLocaleString()}
🧾 Odoo SO：${soName}

📌 狀態：已報價 → <b>可進行維修</b>
（Odoo 銷售訂單已確認）${invoiceInfo}`;

        await sendTelegram(TG_REPAIR_GROUP, tgMsg);
        await sendTelegram(TG_OFFICE_GROUP, tgMsg);
      }
    } catch (err) {
      console.error(`❌ ${order.order_number} 輪詢失敗:`, err.message);
    }
  }

  console.log('✅ 輪詢完成');
}

main()
  .catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); })
  .finally(() => pool.end());
