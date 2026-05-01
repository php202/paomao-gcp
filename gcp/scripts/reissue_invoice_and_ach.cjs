#!/usr/bin/env node
/**
 * 重開發票並重跑 ACH 的一鍵工具
 * 處理發票錯誤需要重開的情況
 */

const { execSync } = require('child_process');
const { odooCall } = require('../lib/odoo.cjs');
const { getPool } = require('../lib/db-pool.cjs');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('使用方式:');
    console.log('  node reissue_invoice_and_ach.cjs <訂單編號>');
    console.log('  node reissue_invoice_and_ach.cjs S01922  # 重開發票並重跑ACH');
    console.log('');
    console.log('功能:');
    console.log('  1. 作廢舊發票');
    console.log('  2. 重新開立發票');
    console.log('  3. 更新 ACH 記錄');
    console.log('  4. 重新執行 ACH 流程');
    return;
  }
  
  const orderName = args[0];
  console.log(`=== 重開發票並重跑 ACH: ${orderName} ===\\n`);
  
  const pool = getPool();
  
  try {
    // 1. 查找訂單資訊
    console.log('📋 步驟 1: 查找訂單資訊...');
    const so = await odooCall('sale.order', 'search_read',
      [[['name', '=', orderName]]],
      { fields: ['id', 'name', 'partner_id', 'amount_total', 'invoice_ids', 'state'] }
    );
    
    if (so.length === 0) {
      throw new Error(`找不到訂單 ${orderName}`);
    }
    
    const order = so[0];
    console.log(`✅ 找到訂單: ${order.name}`);
    console.log(`   客戶: ${order.partner_id[1]}`);
    console.log(`   金額: $${order.amount_total}`);
    console.log(`   狀態: ${order.state}`);
    console.log('');
    
    // 2. 處理現有發票
    if (order.invoice_ids && order.invoice_ids.length > 0) {
      console.log('📄 步驟 2: 處理現有發票...');
      
      const invoices = await odooCall('account.move', 'read',
        [order.invoice_ids],
        { fields: ['id', 'name', 'state', 'amount_total'] }
      );
      
      for (const inv of invoices) {
        console.log(`   發票: ${inv.name} (${inv.state}) $${inv.amount_total}`);
        
        if (inv.state === 'posted') {
          console.log(`   🔄 作廢發票 ${inv.name}...`);
          await odooCall('account.move', 'button_cancel', [inv.id]);
          console.log(`   ✅ 已作廢`);
        } else if (inv.state === 'draft') {
          console.log(`   🗑️ 刪除草稿發票 ${inv.name}...`);
          await odooCall('account.move', 'unlink', [inv.id]);
          console.log(`   ✅ 已刪除`);
        }
      }
      console.log('');
    }
    
    // 3. 重新開立發票
    console.log('📄 步驟 3: 重新開立發票...');
    
    const wizardId = await odooCall('sale.advance.payment.inv', 'create', [{
      advance_payment_method: 'delivered'
    }], { context: { active_ids: [order.id], active_model: 'sale.order' } });
    
    await odooCall('sale.advance.payment.inv', 'create_invoices', [wizardId], {
      context: { active_ids: [order.id], active_model: 'sale.order' }
    });
    
    // 獲取新發票
    const soAfter = await odooCall('sale.order', 'read', [order.id], { fields: ['invoice_ids'] });
    const newInvoiceIds = soAfter[0].invoice_ids || [];
    
    if (newInvoiceIds.length === 0) {
      throw new Error('無法創建新發票');
    }
    
    const lastInvId = newInvoiceIds[newInvoiceIds.length - 1];
    
    // 過帳新發票
    await odooCall('account.move', 'action_post', [[lastInvId]]);
    
    // 獲取新發票名稱
    const newInv = await odooCall('account.move', 'read', [lastInvId], { 
      fields: ['name', 'amount_total'] 
    });
    const newInvoiceName = newInv[0].name;
    const newInvoiceAmount = newInv[0].amount_total;
    
    console.log(`✅ 新發票已開立: ${newInvoiceName}`);
    console.log(`   金額: $${newInvoiceAmount}`);
    console.log('');
    
    // 4. 更新 ACH 記錄
    console.log('💰 步驟 4: 更新 ACH 記錄...');
    
    const { rows: achRecords } = await pool.query(`
      SELECT id, store_name, amount, odoo_invoice_id
      FROM ach_records 
      WHERE odoo_quote_id = $1
    `, [orderName]);
    
    if (achRecords.length > 0) {
      const { rowCount } = await pool.query(`
        UPDATE ach_records 
        SET odoo_invoice_id = $1,
            amount = $2
        WHERE odoo_quote_id = $3
      `, [newInvoiceName, newInvoiceAmount, orderName]);
      
      console.log(`✅ ACH 記錄已更新 (${rowCount} 筆)`);
      achRecords.forEach(r => {
        console.log(`   - ${r.store_name}: ${r.odoo_invoice_id} → ${newInvoiceName}`);
      });
    } else {
      console.log('⚠️ 找不到對應的 ACH 記錄');
    }
    console.log('');
    
    // 5. 重新執行 ACH
    console.log('🏦 步驟 5: 重新執行 ACH 流程...');
    
    if (process.argv.includes('--with-ach')) {
      console.log(`🚀 執行 ACH: node sinopac_ach_full.cjs --invoice-name ${newInvoiceName}`);
      
      try {
        execSync(`node sinopac_ach_full.cjs --invoice-name ${newInvoiceName}`, {
          stdio: 'inherit',
          cwd: __dirname,
          timeout: 300000 // 5分鐘
        });
        console.log('✅ ACH 執行完成');
      } catch (achError) {
        console.error('⚠️ ACH 執行失敗:', achError.message);
        console.log('💡 你可以手動執行:');
        console.log(`   node sinopac_ach_full.cjs --invoice-name ${newInvoiceName}`);
      }
    } else {
      console.log('💡 使用 --with-ach 參數自動執行 ACH');
      console.log(`   或手動執行: node sinopac_ach_full.cjs --invoice-name ${newInvoiceName}`);
    }
    
    console.log('\\n🎉 重開發票流程完成!');
    console.log(`✅ 新發票: ${newInvoiceName}`);
    console.log(`✅ 金額: $${newInvoiceAmount}`);
    console.log(`✅ 客戶: ${order.partner_id[1]}`);
    
  } catch (error) {
    console.error('❌ 重開發票失敗:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}