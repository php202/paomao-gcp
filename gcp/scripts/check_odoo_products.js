#!/usr/bin/env node
/**
 * 檢查 Odoo 產品數據，特別關注圖片和品名
 */

import fetch from 'node-fetch';
import fs from 'fs';

const ODOO_CONFIG = JSON.parse(fs.readFileSync(process.env.HOME + '/.openclaw/secrets/odoo-config.json', 'utf8'));

// 獲取 Odoo 產品數據
async function fetchOdooProducts() {
  console.log('🔍 連接 Odoo 並獲取產品數據...');
  console.log(`URL: ${ODOO_CONFIG.url}`);
  console.log(`DB: ${ODOO_CONFIG.db}`);
  console.log(`User: ${ODOO_CONFIG.username}`);
  
  try {
    // Odoo JSON-RPC 認證
    console.log('🔑 正在進行 Odoo 認證...');
    const authResponse = await fetch(`${ODOO_CONFIG.url}/web/session/authenticate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          db: ODOO_CONFIG.db,
          login: ODOO_CONFIG.username,
          password: ODOO_CONFIG.password
        },
        id: 1
      })
    });
    
    if (!authResponse.ok) {
      throw new Error(`Odoo 認證請求失敗: ${authResponse.status} ${authResponse.statusText}`);
    }
    
    const authData = await authResponse.json();
    console.log('認證回應:', JSON.stringify(authData, null, 2));
    
    if (!authData.result || authData.result.uid === false) {
      throw new Error('Odoo 登入失敗: ' + JSON.stringify(authData));
    }
    
    const cookies = authResponse.headers.get('set-cookie');
    console.log(`✅ Odoo 認證成功, UID: ${authData.result.uid}`);
    
    // 獲取產品數據
    console.log('📦 正在獲取產品數據...');
    const productResponse = await fetch(`${ODOO_CONFIG.url}/web/dataset/call_kw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookies
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'product.template',
          method: 'search_read',
          args: [
            [['sale_ok', '=', true]], // 只獲取可銷售的產品
            ['id', 'name', 'image_1920', 'list_price', 'categ_id', 'default_code']
          ],
          kwargs: {
            limit: 500
          }
        },
        id: 2
      })
    });
    
    if (!productResponse.ok) {
      throw new Error(`Odoo 產品查詢失敗: ${productResponse.status} ${productResponse.statusText}`);
    }
    
    const productData = await productResponse.json();
    console.log('產品數據回應:', JSON.stringify(productData, null, 2).substring(0, 500) + '...');
    
    if (!productData.result) {
      throw new Error('Odoo 產品數據獲取失敗: ' + JSON.stringify(productData));
    }
    
    const products = productData.result.map(product => ({
      id: product.id,
      name: product.name,
      code: product.default_code,
      hasImage: !!product.image_1920,
      imageSize: product.image_1920 ? product.image_1920.length : 0,
      price: product.list_price,
      category: product.categ_id ? product.categ_id[1] : null,
    }));
    
    console.log(`\\n✅ Odoo 總計: ${products.length} 個產品`);
    return products;
    
  } catch (error) {
    console.error('❌ Odoo 數據獲取失敗:', error.message);
    if (error.response) {
      console.error('錯誤詳情:', await error.response.text());
    }
    return [];
  }
}

// 分析產品數據
function analyzeProducts(products) {
  console.log('\\n📊 產品數據分析');
  console.log('='.repeat(50));
  
  const withImages = products.filter(p => p.hasImage);
  const withoutImages = products.filter(p => !p.hasImage);
  const withCode = products.filter(p => p.code);
  
  console.log(`\\n📈 基本統計:`);
  console.log(`   總產品數: ${products.length}`);
  console.log(`   有圖片: ${withImages.length} (${Math.round(withImages.length/products.length*100)}%)`);
  console.log(`   無圖片: ${withoutImages.length} (${Math.round(withoutImages.length/products.length*100)}%)`);
  console.log(`   有產品代碼: ${withCode.length} (${Math.round(withCode.length/products.length*100)}%)`);
  
  // 按類別分析
  const categories = {};
  products.forEach(p => {
    const cat = p.category || '未分類';
    if (!categories[cat]) categories[cat] = { total: 0, withImages: 0 };
    categories[cat].total++;
    if (p.hasImage) categories[cat].withImages++;
  });
  
  console.log(`\\n📂 按類別分析:`);
  Object.entries(categories)
    .sort(([,a], [,b]) => b.total - a.total)
    .slice(0, 10)
    .forEach(([cat, data]) => {
      const imagePercent = Math.round(data.withImages/data.total*100);
      console.log(`   ${cat}: ${data.total} 個 (${data.withImages} 個有圖片, ${imagePercent}%)`);
    });
  
  // 重點產品檢查
  const keyProducts = products.filter(p => 
    p.name.includes('天山雪蓮') || 
    p.name.includes('面膜') ||
    p.name.includes('精華') ||
    p.name.includes('乳液') ||
    p.name.includes('洗面') ||
    p.name.includes('化妝水')
  );
  
  console.log(`\\n🌟 重點產品 (${keyProducts.length} 個):`);
  keyProducts.slice(0, 20).forEach(product => {
    const imageStatus = product.hasImage ? '✅' : '❌';
    const imageInfo = product.hasImage ? `(${Math.round(product.imageSize/1024)}KB)` : '';
    console.log(`   ${imageStatus} [${product.id}] ${product.name} ${imageInfo}`);
    if (product.code) console.log(`      代碼: ${product.code}`);
    if (product.price) console.log(`      價格: $${product.price}`);
  });
  
  // 沒有圖片的重點產品
  const keyProductsNoImages = keyProducts.filter(p => !p.hasImage);
  if (keyProductsNoImages.length > 0) {
    console.log(`\\n⚠️ 重點產品缺少圖片 (${keyProductsNoImages.length} 個):`);
    keyProductsNoImages.forEach(product => {
      console.log(`   ❌ [${product.id}] ${product.name}`);
    });
  }
  
  // 特殊檢查：天山雪蓮相關產品
  const tianshanProducts = products.filter(p => p.name.includes('天山雪蓮'));
  if (tianshanProducts.length > 0) {
    console.log(`\\n🏔️ 天山雪蓮相關產品 (${tianshanProducts.length} 個):`);
    tianshanProducts.forEach(product => {
      const imageStatus = product.hasImage ? '✅ 有圖片' : '❌ 無圖片';
      console.log(`   ${imageStatus} [${product.id}] ${product.name}`);
      if (product.code) console.log(`      代碼: ${product.code}`);
      if (product.category) console.log(`      類別: ${product.category}`);
    });
  }
  
  // 保存詳細報告
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      total: products.length,
      withImages: withImages.length,
      withoutImages: withoutImages.length,
      imagePercent: Math.round(withImages.length/products.length*100)
    },
    categories,
    keyProducts: keyProducts.map(p => ({
      id: p.id,
      name: p.name,
      hasImage: p.hasImage,
      code: p.code,
      price: p.price
    })),
    missingImages: withoutImages.map(p => ({
      id: p.id,
      name: p.name,
      category: p.category
    }))
  };
  
  fs.writeFileSync('odoo_products_analysis.json', JSON.stringify(report, null, 2));
  console.log(`\\n💾 詳細報告已保存到: odoo_products_analysis.json`);
}

// 主函數
async function main() {
  console.log('🚀 開始檢查 Odoo 產品數據...');
  console.log('=' .repeat(50));
  
  try {
    const products = await fetchOdooProducts();
    
    if (products.length === 0) {
      console.error('❌ 無法獲取 Odoo 產品數據');
      return;
    }
    
    analyzeProducts(products);
    
    console.log('\\n✅ 檢查完成！');
    
  } catch (error) {
    console.error('❌ 檢查過程出錯:', error);
  }
}

// 運行主函數
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}