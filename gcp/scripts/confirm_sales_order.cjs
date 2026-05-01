#!/usr/bin/env node
/**
 * 銷售單確認腳本
 * 處理客戶確認後的銷售單：貸記單連結、金額重算、ACH更新
 */

'use strict';

const { Pool } = require('pg');
const { odooCall } = require('../lib/odoo.cjs');

const pool = new Pool({
  host: '/tmp',
  database: 'paomao',
  user: 'paopaomao',
});

async function confirmSalesOrder(saleOrderId) {
  console.log(`=== 確認銷售單 ${saleOrderId} ===\n`);
  
  try {
    // 1. 查找對應的 ACH 記錄
    const { rows: achRecords } = await pool.query(`
      SELECT id, store_name, amount, description, odoo_quote_id, status
      FROM ach_records 
      WHERE odoo_quote_id = $1
      ORDER BY record_date DESC
      LIMIT 1
    `, [saleOrderId]);
    
    if (achRecords.length === 0) {
      throw new Error(`找不到銷售單 ${saleOrderId} 對應的 ACH 記錄`);
    }
    
    const achRecord = achRecords[0];
    console.log(`找到 ACH 記錄: ${achRecord.store_name} - $${achRecord.amount}`);
    console.log(`狀態: ${achRecord.status}\n`);
    
    // 2. 在 Odoo 中找到銷售單 ID
    console.log('步驟 1: 查找銷售單...');
    const soIds = await odooCall('sale.order', 'search', [[['name', '=', saleOrderId]]]);
    if (!soIds || soIds.length === 0) {
      throw new Error(`找不到銷售單 ${saleOrderId}`);
    }
    const soId = soIds[0];
    console.log(`找到銷售單 ID: ${soId}`);
    
    // 3. 確認銷售單
    console.log('步驟 2: 確認銷售單...');
    const confirmResult = await odooCall('sale.order', 'action_confirm', [[soId]]);
    if (!confirmResult) {
      throw new Error('銷售單確認失敗');
    }
    console.log('✅ 銷售單已確認\n');
    
    // 4. 獲取確認後的銷售單詳情（包含貸記單折抵）
    console.log('步驟 3: 取得確認後金額...');
    const [orderDetail] = await odooCall('sale.order', 'read', [soId], {
      fields: ['name', 'partner_id', 'amount_total', 'amount_untaxed', 'state', 'invoice_ids']
    });
    
    if (!orderDetail) {
      throw new Error('無法取得銷售單詳情');
    }
    
    console.log(`確認後狀態: ${orderDetail.state}`);
    console.log(`未稅金額: $${orderDetail.amount_untaxed}`);
    console.log(`總金額: $${orderDetail.amount_total}\n`);
    
    // 5. 檢查是否有貸記單連結
    if (orderDetail.invoice_ids && orderDetail.invoice_ids.length > 0) {
      console.log('步驟 4: 檢查貸記單折抵...');
      
      // 查詢相關發票和貸記單
      const invoiceIds = Array.isArray(orderDetail.invoice_ids) ? orderDetail.invoice_ids : [orderDetail.invoice_ids];
      const invoices = await odooCall('account.move', 'read', [invoiceIds], {
        fields: ['name', 'amount_total', 'move_type', 'date']
      });
      
      let totalCreditNotes = 0;
      for (const invoice of invoices) {
        console.log(`- 發票: ${invoice.name} (${invoice.move_type}) $${invoice.amount_total}`);
        if (invoice.move_type === 'out_refund') {
          totalCreditNotes += Math.abs(invoice.amount_total);
        }
      }
      
      if (totalCreditNotes > 0) {
        console.log(`貸記單總折抵: $${totalCreditNotes}`);
        const finalAmount = orderDetail.amount_total - totalCreditNotes;
        console.log(`實付金額: $${finalAmount}\n`);
        
        // 5. 更新 ACH 記錄金額
        if (Math.abs(achRecord.amount - finalAmount) > 0.01) {
          console.log('步驟 4: 更新 ACH 金額...');
          const { rowCount } = await pool.query(`
            UPDATE ach_records 
            SET amount = $1, 
                description = $2
            WHERE id = $3
          `, [
            finalAmount, 
            `${achRecord.description} (貸記單折抵後)`,
            achRecord.id
          ]);
          
          if (rowCount > 0) {
            console.log(`✅ ACH 金額已更新: $${achRecord.amount} → $${finalAmount}`);
          }
        } else {
          console.log('金額無變動，無需更新 ACH');
        }
      } else {
        console.log('沒有貸記單折抵');
      }
    } else {
      console.log('尚未產生發票');
    }
    
    // 6. 最終狀態更新
    await pool.query(`
      UPDATE ach_records 
      SET status = 'confirmed'
      WHERE id = $1
    `, [achRecord.id]);
    
    console.log('\n🎉 銷售單確認完成！');
    return {
      success: true,
      saleOrder: saleOrderId,
      finalAmount: orderDetail.amount_total,
      achRecordId: achRecord.id
    };
    
  } catch (error) {
    console.error(`❌ 確認失敗: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

async function main() {
  const saleOrderId = process.argv[2];
  
  if (!saleOrderId) {
    console.log('用法: node confirm_sales_order.cjs <銷售單ID>');
    console.log('例如: node confirm_sales_order.cjs S01919');
    process.exit(1);
  }
  
  try {
    const result = await confirmSalesOrder(saleOrderId);
    
    if (result.success) {
      console.log(`\n✅ ${saleOrderId} 確認成功`);
    } else {
      console.log(`\n❌ ${saleOrderId} 確認失敗: ${result.error}`);
      process.exit(1);
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
  confirmSalesOrder
};