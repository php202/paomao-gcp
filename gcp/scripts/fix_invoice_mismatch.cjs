#!/usr/bin/env node
/**
 * 修正發票開錯客戶的問題
 * 處理 INV/2026/04/000073 桃園南崁店 vs 小檜溪店的錯誤
 */

const { odooCall } = require('../lib/odoo.cjs');
const { getPool } = require('../lib/db-pool.cjs');

async function main() {
  console.log('=== 修正發票客戶錯誤 ===\n');

  const pool = getPool();
  
  try {
    // 1. 查看當前狀況
    console.log('📋 當前狀況:');
    console.log('- S01922: 桃園南崁店 $19,572');
    console.log('- INV/2026/04/000073: 錯誤開給小檜溪店');
    console.log('- 正確應該：南崁店收到發票');
    console.log('');

    // 2. 檢查發票狀態
    const invoice = await odooCall('account.move', 'search_read',
      [[['name', '=', 'INV/2026/04/000073']]],
      { fields: ['name', 'partner_id', 'amount_total', 'state', 'move_type'] }
    );
    
    if (invoice.length === 0) {
      throw new Error('找不到發票 INV/2026/04/000073');
    }
    
    const inv = invoice[0];
    console.log(`📄 發票狀態: ${inv.name}`);
    console.log(`   客戶: ${inv.partner_id[1]}`);
    console.log(`   金額: $${inv.amount_total}`);
    console.log(`   狀態: ${inv.state}`);
    console.log('');

    if (inv.state === 'posted') {
      console.log('⚠️ 發票已過帳，需要作廢重開');
      console.log('');
      console.log('🔧 修正步驟:');
      console.log('1. 作廢當前發票 INV/2026/04/000073');
      console.log('2. 為 S01922 (桃園南崁店) 重新開立發票');
      console.log('3. 更新 ach_records 發票記錄');
      console.log('');
      
      if (process.argv.includes('--execute')) {
        console.log('🚀 開始執行修正...');
        
        // Step 1: 作廢發票
        console.log('步驟 1: 作廢錯誤發票...');
        await odooCall('account.move', 'button_cancel', [inv.id]);
        console.log('✅ 發票已作廢');
        
        // Step 2: 為 S01922 重新開發票
        console.log('步驟 2: 重新開立發票...');
        
        // 找到 S01922 的 SO
        const so = await odooCall('sale.order', 'search_read',
          [[['name', '=', 'S01922']]],
          { fields: ['id', 'name', 'partner_id', 'amount_total'] }
        );
        
        if (so.length === 0) {
          throw new Error('找不到銷售單 S01922');
        }
        
        console.log(`✅ 找到 SO: ${so[0].name} - ${so[0].partner_id[1]}`);
        
        // 創建新發票
        const wizardId = await odooCall('sale.advance.payment.inv', 'create', [{
          advance_payment_method: 'delivered'
        }], { context: { active_ids: [so[0].id], active_model: 'sale.order' } });
        
        await odooCall('sale.advance.payment.inv', 'create_invoices', [wizardId], {
          context: { active_ids: [so[0].id], active_model: 'sale.order' }
        });
        
        // 獲取新發票
        const soAfter = await odooCall('sale.order', 'read', [so[0].id], { fields: ['invoice_ids'] });
        const newInvoiceIds = soAfter[0].invoice_ids || [];
        
        if (newInvoiceIds.length > 0) {
          const lastInvId = newInvoiceIds[newInvoiceIds.length - 1];
          
          // 過帳新發票
          await odooCall('account.move', 'action_post', [[lastInvId]]);
          
          // 獲取新發票名稱
          const newInv = await odooCall('account.move', 'read', [lastInvId], { fields: ['name'] });
          const newInvoiceName = newInv[0].name;
          
          console.log(`✅ 新發票已創建: ${newInvoiceName}`);
          
          // Step 3: 更新 ACH 記錄
          console.log('步驟 3: 更新 ACH 記錄...');
          const { rowCount } = await pool.query(`
            UPDATE ach_records 
            SET odoo_invoice_id = $1
            WHERE odoo_quote_id = 'S01922'
          `, [newInvoiceName]);
          
          if (rowCount > 0) {
            console.log('✅ ACH 記錄已更新');
          }
          
          console.log('\\n🎉 修正完成!');
          console.log(`✅ 舊發票 INV/2026/04/000073 已作廢`);
          console.log(`✅ 新發票 ${newInvoiceName} 已開立給正確客戶`);
          console.log(`✅ ACH 記錄已更新`);
          
        } else {
          throw new Error('無法創建新發票');
        }
        
      } else {
        console.log('💡 使用 --execute 參數執行實際修正');
        console.log('   node fix_invoice_mismatch.cjs --execute');
      }
      
    } else {
      console.log('💡 發票尚未過帳，可直接修改客戶');
    }
    
  } catch (error) {
    console.error('❌ 修正失敗:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}