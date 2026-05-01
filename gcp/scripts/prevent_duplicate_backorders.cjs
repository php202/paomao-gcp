#!/usr/bin/env node
/**
 * 預防重複欠單的 Webhook 處理器
 * 在交貨單核實前檢查是否已存在相同產品的欠單
 */

'use strict';

const { odooCall } = require('../lib/odoo.cjs');

async function beforeDeliveryValidation(deliveryId) {
  console.log(`檢查交貨單 ${deliveryId} 是否會產生重複欠單...`);
  
  try {
    // 1. 獲取交貨單詳情
    const delivery = await odooCall('stock.picking', 'read', [deliveryId], {
      fields: ['name', 'origin', 'move_ids', 'state']
    });
    
    if (!delivery.length) {
      throw new Error('找不到交貨單');
    }
    
    const picking = delivery[0];
    if (!picking.origin) {
      console.log('交貨單沒有關聯訂單，跳過檢查');
      return true;
    }
    
    // 2. 查找同一訂單的其他庫存移動
    const relatedPickings = await odooCall('stock.picking', 'search_read', [
      [['origin', '=', picking.origin], ['id', '!=', deliveryId]]
    ], {
      fields: ['name', 'state', 'picking_type_id', 'move_ids']
    });
    
    // 3. 檢查是否已有欠單
    const existingBackorders = relatedPickings.filter(p => 
      p.state === 'assigned' && p.name.includes('BACK')
    );
    
    if (existingBackorders.length === 0) {
      console.log('沒有發現現有欠單，可以正常核實');
      return true;
    }
    
    // 4. 比對產品是否重複
    const deliveryMoves = await odooCall('stock.move', 'read', [picking.move_ids], {
      fields: ['product_id', 'product_uom_qty', 'reserved_availability']
    });
    
    for (const backorder of existingBackorders) {
      const backorderMoves = await odooCall('stock.move', 'read', [backorder.move_ids], {
        fields: ['product_id', 'product_uom_qty']
      });
      
      // 檢查產品重複
      for (const deliveryMove of deliveryMoves) {
        const shortfall = deliveryMove.product_uom_qty - deliveryMove.reserved_availability;
        if (shortfall <= 0) continue; // 沒有缺貨
        
        const duplicateBackorder = backorderMoves.find(bm => 
          bm.product_id[0] === deliveryMove.product_id[0]
        );
        
        if (duplicateBackorder) {
          console.log(`⚠️ 發現重複欠單:`);
          console.log(`  產品: ${deliveryMove.product_id[1]}`);
          console.log(`  現有欠單: ${backorder.name} (${duplicateBackorder.product_uom_qty} 件)`);
          console.log(`  交貨單缺貨: ${shortfall} 件`);
          
          // 解決方案：調整交貨單數量，避免重複欠單
          const adjustedQty = deliveryMove.reserved_availability;
          if (adjustedQty > 0) {
            console.log(`  調整交貨單數量為 ${adjustedQty} 件`);
            
            await odooCall('stock.move', 'write', [deliveryMove.id], {
              'product_uom_qty': adjustedQty
            });
          } else {
            console.log(`  取消這個產品的移動`);
            await odooCall('stock.move', 'write', [deliveryMove.id], {
              'state': 'cancel'
            });
          }
        }
      }
    }
    
    console.log('✅ 重複欠單檢查完成');
    return true;
    
  } catch (error) {
    console.error('檢查失敗:', error.message);
    return false;
  }
}

// Express.js 路由處理器（如果需要 webhook）
async function handleDeliveryWebhook(req, res) {
  try {
    const { delivery_id, action } = req.body;
    
    if (action === 'before_validate') {
      const canProceed = await beforeDeliveryValidation(delivery_id);
      res.json({ success: canProceed });
    } else {
      res.json({ success: true, message: 'No action needed' });
    }
    
  } catch (error) {
    console.error('Webhook 處理失敗:', error.message);
    res.status(500).json({ error: error.message });
  }
}

module.exports = {
  beforeDeliveryValidation,
  handleDeliveryWebhook
};