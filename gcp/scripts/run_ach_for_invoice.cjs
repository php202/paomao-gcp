#!/usr/bin/env node
/**
 * 一鍵重跑 ACH 的快捷工具
 * 使用方式: node run_ach_for_invoice.cjs INV/2026/04/000085
 */

const { execSync } = require('child_process');
const path = require('path');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('🏦 一鍵重跑 ACH 工具');
    console.log('');
    console.log('使用方式:');
    console.log('  node run_ach_for_invoice.cjs <發票號碼>');
    console.log('  node run_ach_for_invoice.cjs INV/2026/04/000085');
    console.log('');
    console.log('功能:');
    console.log('  ✅ 自動登入永豐銀行');
    console.log('  ✅ 查詢 ACH 記錄');
    console.log('  ✅ 生成 ACH 檔案');
    console.log('  ✅ 上傳並送審');
    console.log('  ✅ 更新記錄狀態');
    console.log('');
    console.log('📋 最近可用的發票:');
    console.log('  INV/2026/04/000085 - 桃園南崁店 (剛修正)');
    return;
  }
  
  const invoiceName = args[0];
  console.log(`🚀 執行 ACH 處理: ${invoiceName}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  try {
    // 執行 ACH 完整流程
    const scriptPath = path.join(__dirname, 'sinopac_ach_full.cjs');
    
    console.log('📋 執行命令:');
    console.log(`   node ${path.basename(scriptPath)} --invoice-name ${invoiceName}`);
    console.log('');
    
    execSync(`node ${scriptPath} --invoice-name ${invoiceName}`, {
      stdio: 'inherit',
      cwd: __dirname,
      timeout: 600000 // 10分鐘超時
    });
    
    console.log('');
    console.log('🎉 ACH 處理完成！');
    
  } catch (error) {
    console.error('❌ ACH 處理失敗:', error.message);
    console.log('');
    console.log('🔧 可能的解決方案:');
    console.log('1. 檢查永豐銀行登入狀態');
    console.log('2. 確認發票號碼是否正確');
    console.log('3. 手動重新執行腳本');
    console.log('4. 檢查網路連線');
    
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}