#!/usr/bin/env node
/**
 * 檢查 GogoShop 中的天山雪蓮商品
 */

import fetch from 'node-fetch';
import fs from 'fs';

const GOGO_COOKIES = fs.readFileSync(process.env.HOME + '/.openclaw/secrets/gogoshop-cookies.txt', 'utf8').trim();

async function searchGogoProducts() {
  console.log('🔍 搜尋 GogoShop 中的天山雪蓮...');
  
  let allProducts = [];
  let page = 1;
  let hasMore = true;
  
  while (hasMore && page <= 10) {
    try {
      const response = await fetch(`https://my.gogoshop.io/backend/product?page=${page}`, {
        headers: { 'Cookie': GOGO_COOKIES }
      });
      
      if (!response.ok) break;
      
      const html = await response.text();
      
      // 找出商品資料
      const productRegex = /<tr[^>]*>[\s\S]*?<\/tr>/g;
      const matches = html.match(productRegex) || [];
      
      let pageProducts = [];
      for (const match of matches) {
        if (match.includes('天山雪蓮') || match.includes('唇膜')) {
          // 提取商品資訊
          const nameMatch = match.match(/<td[^>]*class="name"[^>]*>([\s\S]*?)<\/td>/);
          const imageMatch = match.match(/<img[^>]*src="([^"]+)"/);
          const idMatch = match.match(/href="[^"]*product\/(\d+)"/);
          
          if (nameMatch) {
            const name = nameMatch[1].replace(/<[^>]+>/g, '').trim();
            const imageUrl = imageMatch ? imageMatch[1] : null;
            const productId = idMatch ? idMatch[1] : null;
            
            pageProducts.push({
              id: productId,
              name: name,
              imageUrl: imageUrl,
              page: page
            });
          }
        }
      }
      
      allProducts.push(...pageProducts);
      
      // 檢查是否有下一頁
      hasMore = html.includes('下一頁') || html.includes('next');
      if (pageProducts.length === 0) hasMore = false;
      
      page++;
      
      if (pageProducts.length > 0) {
        console.log(`第${page-1}頁找到 ${pageProducts.length} 個相關商品`);
      }
      
    } catch (error) {
      console.error(`第${page}頁查詢失敗:`, error.message);
      break;
    }
  }
  
  console.log(`\n📋 GogoShop 搜尋結果 (共 ${allProducts.length} 個):`);
  allProducts.forEach(product => {
    console.log(`  ID: ${product.id}`);
    console.log(`  名稱: ${product.name}`);
    console.log(`  圖片: ${product.imageUrl}`);
    console.log('  ---');
  });
  
  return allProducts;
}

searchGogoProducts().catch(console.error);