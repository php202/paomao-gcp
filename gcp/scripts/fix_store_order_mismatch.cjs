#!/usr/bin/env node
/**
 * 修正訂單門市錯誤的腳本
 * 處理高雄前鎮店 vs 陽明店的訂單歸屬問題
 */

'use strict';

const { odooCall } = require('../lib/odoo.cjs');
const { Pool } = require('pg');

const pool = new Pool({
  host: '/tmp',
  database: 'paomao',
  user: 'paopaomao',
});

async function findOrderByAmount(amount) {
  console.log(`🔍 尋找金額 ${amount} 的訂單...`);
  
  try {
    // 1. 在 Odoo 中搜尋金額相符的訂單
    const orders = await odooCall('sale.order', 'search_read', [], {
      fields: ['name', 'partner_id', 'amount_total', 'state', 'date_order'],
      domain: [
        ['amount_total', '=', amount],
        ['state', 'in', ['sale', 'done']]
      ]
    });
    
    console.log(`找到 ${orders.length} 個相符金額的訂單:`);
    
    for (const order of orders) {
      console.log(`- ${order.name} | ${order.partner_id[1]} | $${order.amount_total}`);
      console.log(`  狀態: ${order.state} | 日期: ${order.date_order}`);
      
      // 檢查客戶是否包含高雄
      if (order.partner_id[1].includes('高雄')) {
        console.log(`  🎯 可能的目標訂單: ${order.name}`);
        
        // 取得詳細資訊
        const [orderDetail] = await odooCall('sale.order', 'read', [order.id], {
          fields: ['partner_id', 'team_id', 'user_id', 'order_line']
        });
        
        return {
          id: order.id,
          name: order.name,
          partner: orderDetail.partner_id,
          team: orderDetail.team_id,
          salesperson: orderDetail.user_id
        };
      }
    }
    
    return null;
    
  } catch (error) {
    console.error('搜尋訂單失敗:', error.message);
    return null;
  }
}

async function getStorePartners() {
  try {
    // 取得高雄兩店的 partner_id
    const partners = await odooCall('res.partner', 'search_read', [
      [['name', 'ilike', '高雄']]
    ], {
      fields: ['name', 'id']
    });
    
    const result = {};
    for (const partner of partners) {
      if (partner.name.includes('前鎮')) {
        result.qianzhen = partner;
      } else if (partner.name.includes('陽明')) {
        result.yangming = partner;
      }
    }
    
    return result;
    
  } catch (error) {
    console.error('取得門市資料失敗:', error.message);
    return {};
  }
}

async function updateOrderStore(orderId, newPartnerId) {
  console.log(`📝 更新訂單 ${orderId} 的門市為 ${newPartnerId}...`);
  
  try {
    await odooCall('sale.order', 'write', [orderId], {
      'partner_id': newPartnerId
    });
    
    console.log('✅ 訂單門市更新成功');
    return true;
    
  } catch (error) {
    console.error('更新失敗:', error.message);
    return false;
  }
}

async function main() {
  try {
    const amount = 23263; // 目標金額
    
    console.log('=== 修正高雄門市訂單歸屬 ===\n');
    
    // 1. 尋找訂單
    const order = await findOrderByAmount(amount);
    if (!order) {
      console.log('❌ 找不到相符的訂單');
      return;
    }
    
    // 2. 取得門市資訊
    const stores = await getStorePartners();
    if (!stores.yangming) {
      console.log('❌ 找不到陽明店資訊');
      return;
    }
    
    // 3. 確認修正
    console.log(`\n🎯 找到訂單: ${order.name}`);
    console.log(`目前客戶: ${order.partner[1]}`);
    console.log(`建議改為: ${stores.yangming.name} (ID: ${stores.yangming.id})`);
    
    if (process.argv.includes('--fix')) {
      const success = await updateOrderStore(order.id, stores.yangming.id);
      
      if (success) {
        console.log('\n✅ 修正完成！請重新發送 ACH 確認通知');
      }
    } else {
      console.log('\n💡 如要執行修正，請加上 --fix 參數');
    }
    
  } catch (error) {
    console.error('執行失敗:', error.message);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  findOrderByAmount,
  updateOrderStore
};