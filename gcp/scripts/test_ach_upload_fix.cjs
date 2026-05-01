#!/usr/bin/env node
/**
 * 測試優化後的 ACH 上傳腳本
 * 模擬處理彰化中興店 S01919 的 ACH 上傳
 */

const path = require('path');

async function main() {
  console.log('=== 測試優化後的 ACH 上傳腳本 ===\n');
  
  // 先檢查是否有現成的 ACH 檔案
  const achDir = '/tmp';
  const fs = require('fs');
  
  console.log('1. 檢查是否有待處理的 ACH 檔案...');
  const files = fs.readdirSync(achDir).filter(f => 
    f.includes('ACH_') && f.endsWith('.txt') && f.includes('彰化')
  );
  
  if (files.length > 0) {
    console.log(`找到 ACH 檔案: ${files[0]}`);
    const filePath = path.join(achDir, files[0]);
    
    console.log('\n2. 執行優化後的 ACH 上傳...');
    console.log('優化項目:');
    console.log('- ✅ 增強對話框檢測 (detectDialog)');
    console.log('- ✅ 多次重試機制 (5次重試)');
    console.log('- ✅ 增加等待時間 (3秒 → 更長等待)');
    console.log('- ✅ 檢測頁面狀態變化');
    console.log('- ✅ 改進按鈕點擊邏輯');
    
    console.log(`\n3. 執行命令:`);
    console.log(`node sinopac_ach_upload.cjs --file ${filePath}`);
    
    // 可以選擇實際執行或只顯示建議
    if (process.argv.includes('--dry-run')) {
      console.log('\n📝 Dry run 模式，不實際執行');
    } else {
      console.log('\n🚀 準備執行實際上傳...');
      const { execSync } = require('child_process');
      
      try {
        execSync(`node ${__dirname}/sinopac_ach_upload.cjs --file ${filePath}`, {
          stdio: 'inherit',
          cwd: __dirname,
          timeout: 300000 // 5 分鐘超時
        });
        console.log('\n✅ ACH 上傳完成');
      } catch (error) {
        console.error(`\n❌ ACH 上傳失敗: ${error.message}`);
      }
    }
    
  } else {
    console.log('沒有找到待處理的 ACH 檔案');
    console.log('你可以先執行:');
    console.log('node sinopac_ach_full.cjs --invoice-name S01919');
    console.log('生成 ACH 檔案後再測試上傳');
  }
}

if (require.main === module) {
  main().catch(console.error);
}