#!/usr/bin/env node
/**
 * 測試 GogoShop 連接並獲取基本產品信息（無需cookies）
 */

import fetch from 'node-fetch';

async function testGogoShopPublicAccess() {
  console.log('🔍 測試 GogoShop 公開頁面訪問...');
  
  try {
    const response = await fetch('https://my.gogoshop.io/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    console.log(`狀態碼: ${response.status}`);
    console.log(`狀態文字: ${response.statusText}`);
    
    if (response.ok) {
      const html = await response.text();
      console.log(`頁面大小: ${html.length} 字元`);
      console.log('✅ GogoShop 網站可以正常訪問');
      
      // 檢查是否包含登入相關內容
      if (html.includes('login') || html.includes('登入')) {
        console.log('🔑 發現登入頁面，需要認證才能訪問後台');
      }
      
      return true;
    } else {
      console.log('❌ GogoShop 網站無法訪問');
      return false;
    }
    
  } catch (error) {
    console.error('❌ 連接 GogoShop 失敗:', error.message);
    return false;
  }
}

async function testOdooPublicAccess() {
  console.log('\\n🔍 測試 Odoo 公開頁面訪問...');
  
  try {
    const response = await fetch('https://paomao.odoo.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    console.log(`狀態碼: ${response.status}`);
    console.log(`狀態文字: ${response.statusText}`);
    
    if (response.ok) {
      const html = await response.text();
      console.log(`頁面大小: ${html.length} 字元`);
      console.log('✅ Odoo 網站可以正常訪問');
      
      // 檢查頁面內容
      if (html.includes('odoo')) {
        console.log('🏭 確認這是 Odoo 系統');
      }
      
      return true;
    } else {
      console.log('❌ Odoo 網站無法訪問');
      return false;
    }
    
  } catch (error) {
    console.error('❌ 連接 Odoo 失敗:', error.message);
    return false;
  }
}

async function checkCookiesFile() {
  console.log('\\n🔍 檢查認證文件...');
  
  const fs = await import('fs');
  const path = process.env.HOME + '/.openclaw/secrets/';
  
  try {
    const files = fs.readdirSync(path);
    console.log('找到的認證文件:');
    files.forEach(file => {
      if (file.includes('gogo') || file.includes('odoo')) {
        console.log(`  📄 ${file}`);
        try {
          const content = fs.readFileSync(path + file, 'utf8');
          console.log(`     大小: ${content.length} 字元`);
          if (content.length < 50) {
            console.log(`     內容: ${content.substring(0, 50)}...`);
          }
        } catch (e) {
          console.log(`     ❌ 無法讀取: ${e.message}`);
        }
      }
    });
  } catch (error) {
    console.log(`❌ 無法訪問認證文件夾: ${error.message}`);
  }
}

async function generateSuggestions() {
  console.log('\\n💡 檢查建議:');
  console.log('='.repeat(40));
  
  console.log('\\n🔧 立即可行的方案:');
  console.log('1. 手動登入兩個系統進行對比檢查');
  console.log('   - GogoShop: https://my.gogoshop.io/backend/product');
  console.log('   - Odoo: https://paomao.odoo.com');
  console.log('\\n2. 重點檢查以下產品:');
  console.log('   ✅ 天山雪蓮面膜');
  console.log('   ✅ 天山雪蓮精華');
  console.log('   ✅ 各種唇膜產品');
  console.log('   ✅ 基礎護膚品');
  
  console.log('\\n🔑 認證問題解決:');
  console.log('1. GogoShop: 需要登入後獲取 session cookies');
  console.log('2. Odoo: 需要更新 API 密鑰或密碼');
  console.log('3. 可以先用瀏覽器開發者工具獲取認證資訊');
  
  console.log('\\n📋 檢查重點:');
  console.log('- 產品名稱是否一致');
  console.log('- 產品圖片是否存在');
  console.log('- 圖片內容是否匹配');
  console.log('- 產品規格是否正確');
}

async function main() {
  console.log('🚀 Odoo vs GogoShop 連接測試');
  console.log('='.repeat(50));
  
  const gogoOk = await testGogoShopPublicAccess();
  const odooOk = await testOdooPublicAccess();
  
  await checkCookiesFile();
  await generateSuggestions();
  
  console.log('\\n📊 測試結果總結:');
  console.log(`GogoShop 連接: ${gogoOk ? '✅ 正常' : '❌ 失敗'}`);
  console.log(`Odoo 連接: ${odooOk ? '✅ 正常' : '❌ 失敗'}`);
  
  if (gogoOk && odooOk) {
    console.log('\\n🎯 兩個系統都可以訪問，建議進行手動檢查');
  } else {
    console.log('\\n⚠️ 部分系統無法訪問，請檢查網路連接');
  }
}

main().catch(console.error);