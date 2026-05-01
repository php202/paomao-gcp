#!/usr/bin/env node
/**
 * 修正 Odoo 重複欠單問題
 * 檢查揀貨單和交貨單中的重複欠單，並合併處理
 */

'use strict';

const { Pool } = require('pg');
const { odooCall } = require('../lib/odoo.cjs');

const pool = new Pool({
  host: '/tmp',
  database: 'paomao',
  user: 'paopaomao',
});

async function checkDuplicateBackorders() {
  console.log('=== 檢查重複欠單問題 ===\n');
  
  try {
    // 1. 查詢所有待處理的欠單 (Backorder)
    const backorders = await odooCall('stock.picking', 'search_read', [], {
      fields: ['name', 'origin', 'state', 'picking_type_id', 'backorder_id', 'move_ids'],
      domain: [['state', 'in', ['assigned', 'partially_available', 'waiting']]]
    });
    
    console.log(`找到 ${backorders.length} 個待處理的庫存移動單`);
    
    // 2. 按原始訂單分組，找出重複欠單
    const orderGroups = {};
    
    for (const picking of backorders) {
      const origin = picking.origin;
      if (!origin) continue;
      
      if (!orderGroups[origin]) {
        orderGroups[origin] = [];
      }
      orderGroups[origin].push(picking);
    }
    
    // 3. 找出有多個欠單的訂單
    const duplicates = [];
    for (const [origin, pickings] of Object.entries(orderGroups)) {
      if (pickings.length > 1) {
        duplicates.push({ origin, pickings });
      }
    }
    
    console.log(`發現 ${duplicates.length} 個訂單有重複欠單：`);
    
    for (const dup of duplicates) {
      console.log(`\n📋 訂單 ${dup.origin}:`);
      
      for (const picking of dup.pickings) {
        const pickingType = await odooCall('stock.picking.type', 'read', [picking.picking_type_id[0]], 
          { fields: ['name'] });
        
        console.log(`  - ${picking.name} (${pickingType[0].name}) - 狀態: ${picking.state}`);
        
        // 檢查欠單的產品明細
        if (picking.move_ids && picking.move_ids.length > 0) {
          const moves = await odooCall('stock.move', 'read', [picking.move_ids], {
            fields: ['product_id', 'product_uom_qty', 'reserved_availability', 'state']
          });
          
          for (const move of moves) {
            const shortfall = move.product_uom_qty - move.reserved_availability;
            if (shortfall > 0) {
              console.log(`    缺貨: ${move.product_id[1]} - 缺 ${shortfall} 件`);
            }
          }
        }
      }
    }
    
    return duplicates;
    
  } catch (error) {
    console.error('檢查欠單失敗:', error.message);
    throw error;
  }
}

async function fixDuplicateBackorders(duplicates) {
  console.log('\n=== 修正重複欠單 ===\n');
  
  for (const dup of duplicates) {
    console.log(`處理訂單 ${dup.origin}...`);
    
    // 找出揀貨單和交貨單
    const pickingList = dup.pickings.filter(p => p.name.includes('PICK'));
    const deliveryList = dup.pickings.filter(p => p.name.includes('OUT'));
    
    if (pickingList.length > 0 && deliveryList.length > 0) {
      console.log('  發現揀貨單和交貨單重複欠單');
      
      // 策略：保留揀貨單的欠單，取消交貨單的重複部分
      for (const delivery of deliveryList) {
        try {
          // 檢查交貨單是否可以取消
          if (delivery.state === 'assigned') {
            console.log(`  取消重複交貨單: ${delivery.name}`);
            await odooCall('stock.picking', 'action_cancel', [[delivery.id]]);
          }
        } catch (cancelError) {
          console.warn(`  無法取消 ${delivery.name}: ${cancelError.message}`);
        }
      }
    }
  }
}

async function main() {
  try {
    const duplicates = await checkDuplicateBackorders();
    
    if (duplicates.length === 0) {
      console.log('✅ 沒有發現重複欠單問題');
      return;
    }
    
    // 詢問是否要修正
    console.log('\n是否要自動修正這些重複欠單？');
    console.log('⚠️  這將會取消部分重複的庫存移動單');
    
    if (process.argv.includes('--fix')) {
      await fixDuplicateBackorders(duplicates);
      console.log('\n✅ 重複欠單修正完成');
    } else {
      console.log('\n💡 如要修正，請加上 --fix 參數');
    }
    
  } catch (error) {
    console.error('執行失敗:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  checkDuplicateBackorders,
  fixDuplicateBackorders
};