#!/usr/bin/env node
/**
 * 比較 Odoo 和 GogoShop 的產品圖片和品名匹配情況
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const GOGO_COOKIES = fs.readFileSync(process.env.HOME + '/.openclaw/secrets/gogoshop-cookies.txt', 'utf8').trim();
const ODOO_CONFIG = JSON.parse(fs.readFileSync(process.env.HOME + '/.openclaw/secrets/odoo-config.json', 'utf8'));

// 辅助函数：清理产品名称用于比较
function cleanProductName(name) {
  return name
    .replace(/【.*?】/g, '') // 移除中文方括号内容
    .replace(/\[.*?\]/g, '') // 移除英文方括号内容
    .replace(/\(.*?\)/g, '') // 移除圆括号内容
    .replace(/（.*?）/g, '') // 移除中文圆括号内容
    .replace(/\d+ml/gi, '')  // 移除容量标识
    .replace(/\d+g/gi, '')   // 移除重量标识
    .replace(/\s+/g, ' ')    // 标准化空格
    .trim()
    .toLowerCase();
}

// 辅助函数：从URL提取图片文件名
function extractImageFilename(url) {
  if (!url) return null;
  const filename = url.split('/').pop().split('?')[0];
  return filename;
}

// 获取 GogoShop 产品数据
async function fetchGogoProducts() {
  console.log('🔍 获取 GogoShop 产品数据...');
  
  let allProducts = [];
  let page = 1;
  let hasMore = true;
  let totalChecked = 0;
  
  while (hasMore && page <= 20) { // 增加页数限制防止无限循环
    try {
      const response = await fetch(`https://my.gogoshop.io/backend/product?page=${page}`, {
        headers: { 
          'Cookie': GOGO_COOKIES,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
      });
      
      if (!response.ok) {
        console.log(`第${page}页请求失败: ${response.status}`);
        break;
      }
      
      const html = await response.text();
      
      // 检查是否包含产品数据
      if (!html.includes('<table') || !html.includes('product')) {
        console.log(`第${page}页没有产品数据`);
        break;
      }
      
      // 解析产品数据
      const productRegex = /<tr[^>]*>[\s\S]*?<\/tr>/g;
      const matches = html.match(productRegex) || [];
      
      let pageProducts = [];
      for (const match of matches) {
        totalChecked++;
        
        // 提取产品信息
        const nameMatch = match.match(/<td[^>]*class="name"[^>]*>([\s\S]*?)<\/td>/);
        const imageMatch = match.match(/<img[^>]*src="([^"]+)"/);
        const idMatch = match.match(/href="[^"]*product\/?(\d+)"/);
        const priceMatch = match.match(/<td[^>]*class="price"[^>]*>([\s\S]*?)<\/td>/);
        
        if (nameMatch) {
          const name = nameMatch[1].replace(/<[^>]+>/g, '').trim();
          const imageUrl = imageMatch ? imageMatch[1] : null;
          const productId = idMatch ? idMatch[1] : null;
          const price = priceMatch ? priceMatch[1].replace(/<[^>]+>/g, '').trim() : null;
          
          // 跳过空白或无效的产品
          if (name && name.length > 2) {
            pageProducts.push({
              id: productId,
              name: name,
              cleanName: cleanProductName(name),
              imageUrl: imageUrl ? (imageUrl.startsWith('http') ? imageUrl : `https://my.gogoshop.io${imageUrl}`) : null,
              imageFilename: extractImageFilename(imageUrl),
              price: price,
              source: 'GogoShop'
            });
          }
        }
      }
      
      allProducts.push(...pageProducts);
      
      // 检查是否有更多页面
      hasMore = html.includes('下一頁') || html.includes('next') || pageProducts.length > 0;
      
      console.log(`第${page}页: ${pageProducts.length} 个产品`);
      
      if (pageProducts.length === 0) {
        hasMore = false;
      }
      
      page++;
      
      // 防止请求过快
      await new Promise(resolve => setTimeout(resolve, 500));
      
    } catch (error) {
      console.error(`第${page}页查询失败:`, error.message);
      break;
    }
  }
  
  console.log(`✅ GogoShop 总计: ${allProducts.length} 个产品 (检查了 ${totalChecked} 行)`);
  return allProducts;
}

// 获取 Odoo 产品数据
async function fetchOdooProducts() {
  console.log('🔍 获取 Odoo 产品数据...');
  
  try {
    // Odoo JSON-RPC 认证
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
      throw new Error(`Odoo 认证失败: ${authResponse.status}`);
    }
    
    const authData = await authResponse.json();
    const cookies = authResponse.headers.get('set-cookie');
    
    if (!authData.result || authData.result.uid === false) {
      throw new Error('Odoo 登录失败');
    }
    
    console.log(`✅ Odoo 认证成功, UID: ${authData.result.uid}`);
    
    // 获取产品数据
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
            [['sale_ok', '=', true]], // 只获取可销售的产品
            ['id', 'name', 'image_1920', 'list_price', 'categ_id']
          ],
          kwargs: {
            limit: 1000
          }
        },
        id: 2
      })
    });
    
    if (!productResponse.ok) {
      throw new Error(`Odoo 产品查询失败: ${productResponse.status}`);
    }
    
    const productData = await productResponse.json();
    
    if (!productData.result) {
      throw new Error('Odoo 产品数据获取失败');
    }
    
    const products = productData.result.map(product => ({
      id: product.id,
      name: product.name,
      cleanName: cleanProductName(product.name),
      imageBase64: product.image_1920,
      hasImage: !!product.image_1920,
      price: product.list_price,
      category: product.categ_id ? product.categ_id[1] : null,
      source: 'Odoo'
    }));
    
    console.log(`✅ Odoo 总计: ${products.length} 个产品`);
    return products;
    
  } catch (error) {
    console.error('❌ Odoo 数据获取失败:', error.message);
    return [];
  }
}

// 比较产品匹配情况
function compareProducts(gogoProducts, odooProducts) {
  console.log('\\n🔍 开始比较产品匹配情况...');
  
  const matches = [];
  const gogoOnly = [];
  const odooOnly = [];
  const imageIssues = [];
  const nameIssues = [];
  
  // 创建 Odoo 产品的查找映射
  const odooMap = new Map();
  odooProducts.forEach(product => {
    odooMap.set(product.cleanName, product);
  });
  
  // 创建 GogoShop 产品的查找映射
  const gogoMap = new Map();
  gogoProducts.forEach(product => {
    gogoMap.set(product.cleanName, product);
  });
  
  // 检查 GogoShop 产品在 Odoo 中的匹配
  gogoProducts.forEach(gogoProduct => {
    const odooMatch = odooMap.get(gogoProduct.cleanName);
    
    if (odooMatch) {
      const match = {
        gogoProduct,
        odooProduct: odooMatch,
        nameMatch: true,
        imageIssue: false
      };
      
      // 检查图片问题
      if (gogoProduct.imageUrl && !odooMatch.hasImage) {
        match.imageIssue = true;
        match.issue = 'Odoo 缺少图片';
      } else if (!gogoProduct.imageUrl && odooMatch.hasImage) {
        match.imageIssue = true;
        match.issue = 'GogoShop 缺少图片';
      } else if (!gogoProduct.imageUrl && !odooMatch.hasImage) {
        match.imageIssue = true;
        match.issue = '两边都没有图片';
      }
      
      if (match.imageIssue) {
        imageIssues.push(match);
      }
      
      matches.push(match);
    } else {
      // 尝试模糊匹配
      let fuzzyMatch = null;
      for (const [odooCleanName, odooProduct] of odooMap) {
        if (odooCleanName.includes(gogoProduct.cleanName) || 
            gogoProduct.cleanName.includes(odooCleanName)) {
          fuzzyMatch = odooProduct;
          break;
        }
      }
      
      if (fuzzyMatch) {
        nameIssues.push({
          gogoProduct,
          odooProduct: fuzzyMatch,
          issue: '名称相似但不完全匹配'
        });
      } else {
        gogoOnly.push(gogoProduct);
      }
    }
  });
  
  // 检查 Odoo 中独有的产品
  odooProducts.forEach(odooProduct => {
    if (!gogoMap.has(odooProduct.cleanName)) {
      odooOnly.push(odooProduct);
    }
  });
  
  return {
    matches,
    gogoOnly,
    odooOnly,
    imageIssues,
    nameIssues,
    stats: {
      totalGogo: gogoProducts.length,
      totalOdoo: odooProducts.length,
      perfectMatches: matches.filter(m => !m.imageIssue).length,
      imageIssues: imageIssues.length,
      nameIssues: nameIssues.length,
      gogoOnly: gogoOnly.length,
      odooOnly: odooOnly.length
    }
  };
}

// 生成报告
function generateReport(comparison) {
  const { matches, gogoOnly, odooOnly, imageIssues, nameIssues, stats } = comparison;
  
  console.log('\\n📊 产品比较报告');
  console.log('='.repeat(50));
  
  console.log(`\\n📈 统计概览:`);
  console.log(`   GogoShop 产品总数: ${stats.totalGogo}`);
  console.log(`   Odoo 产品总数: ${stats.totalOdoo}`);
  console.log(`   完美匹配: ${stats.perfectMatches} 个`);
  console.log(`   图片问题: ${stats.imageIssues} 个`);
  console.log(`   名称问题: ${stats.nameIssues} 个`);
  console.log(`   GogoShop 独有: ${stats.gogoOnly} 个`);
  console.log(`   Odoo 独有: ${stats.odooOnly} 个`);
  
  // 图片问题详情
  if (imageIssues.length > 0) {
    console.log(`\\n🖼️ 图片问题详情 (${imageIssues.length} 个):`);
    imageIssues.slice(0, 10).forEach((issue, index) => {
      console.log(`\\n${index + 1}. ${issue.gogoProduct.name}`);
      console.log(`   问题: ${issue.issue}`);
      console.log(`   GogoShop 图片: ${issue.gogoProduct.imageUrl || '无'}`);
      console.log(`   Odoo 图片: ${issue.odooProduct.hasImage ? '有' : '无'}`);
    });
    
    if (imageIssues.length > 10) {
      console.log(`   ... 还有 ${imageIssues.length - 10} 个图片问题`);
    }
  }
  
  // 名称问题详情
  if (nameIssues.length > 0) {
    console.log(`\\n📝 名称问题详情 (${nameIssues.length} 个):`);
    nameIssues.slice(0, 5).forEach((issue, index) => {
      console.log(`\\n${index + 1}. 相似但不匹配:`);
      console.log(`   GogoShop: ${issue.gogoProduct.name}`);
      console.log(`   Odoo: ${issue.odooProduct.name}`);
    });
  }
  
  // GogoShop 独有产品
  if (gogoOnly.length > 0) {
    console.log(`\\n🏪 GogoShop 独有产品 (${gogoOnly.length} 个):`);
    gogoOnly.slice(0, 10).forEach((product, index) => {
      console.log(`   ${index + 1}. ${product.name}`);
    });
    
    if (gogoOnly.length > 10) {
      console.log(`   ... 还有 ${gogoOnly.length - 10} 个产品`);
    }
  }
  
  // Odoo 独有产品
  if (odooOnly.length > 0) {
    console.log(`\\n🏭 Odoo 独有产品 (${odooOnly.length} 个):`);
    odooOnly.slice(0, 10).forEach((product, index) => {
      console.log(`   ${index + 1}. ${product.name} (${product.category || '未分类'})`);
    });
    
    if (odooOnly.length > 10) {
      console.log(`   ... 还有 ${odooOnly.length - 10} 个产品`);
    }
  }
  
  // 重点关注的问题
  const criticalIssues = imageIssues.filter(issue => 
    issue.gogoProduct.name.includes('天山雪蓮') || 
    issue.gogoProduct.name.includes('重点') ||
    issue.gogoProduct.name.includes('热销')
  );
  
  if (criticalIssues.length > 0) {
    console.log(`\\n⚠️ 重点产品图片问题 (${criticalIssues.length} 个):`);
    criticalIssues.forEach((issue, index) => {
      console.log(`   ${index + 1}. ${issue.gogoProduct.name} - ${issue.issue}`);
    });
  }
  
  // 建议
  console.log(`\\n💡 改善建议:`);
  if (stats.imageIssues > 0) {
    console.log(`   1. 优先修复 ${stats.imageIssues} 个图片问题`);
  }
  if (stats.nameIssues > 0) {
    console.log(`   2. 检查 ${stats.nameIssues} 个名称相似的产品`);
  }
  if (stats.gogoOnly > 10) {
    console.log(`   3. 考虑将 GogoShop 独有的产品添加到 Odoo`);
  }
  if (stats.odooOnly > 10) {
    console.log(`   4. 检查 Odoo 独有产品是否需要在 GogoShop 上架`);
  }
  
  // 保存详细报告到文件
  const reportData = {
    timestamp: new Date().toISOString(),
    stats,
    imageIssues: imageIssues.map(issue => ({
      name: issue.gogoProduct.name,
      issue: issue.issue,
      gogoUrl: issue.gogoProduct.imageUrl,
      odooHasImage: issue.odooProduct.hasImage
    })),
    nameIssues: nameIssues.map(issue => ({
      gogoName: issue.gogoProduct.name,
      odooName: issue.odooProduct.name
    })),
    gogoOnly: gogoOnly.map(p => p.name),
    odooOnly: odooOnly.map(p => ({name: p.name, category: p.category}))
  };
  
  const reportFile = path.join(process.cwd(), 'odoo_gogo_comparison_report.json');
  fs.writeFileSync(reportFile, JSON.stringify(reportData, null, 2));
  console.log(`\\n💾 详细报告已保存到: ${reportFile}`);
}

// 主函数
async function main() {
  console.log('🚀 开始比较 Odoo vs GogoShop 产品数据...');
  console.log('=' .repeat(60));
  
  try {
    // 并发获取数据
    const [gogoProducts, odooProducts] = await Promise.all([
      fetchGogoProducts(),
      fetchOdooProducts()
    ]);
    
    if (gogoProducts.length === 0) {
      console.error('❌ 无法获取 GogoShop 数据');
      return;
    }
    
    if (odooProducts.length === 0) {
      console.error('❌ 无法获取 Odoo 数据');
      return;
    }
    
    // 比较数据
    const comparison = compareProducts(gogoProducts, odooProducts);
    
    // 生成报告
    generateReport(comparison);
    
    console.log('\\n✅ 比较完成！');
    
  } catch (error) {
    console.error('❌ 比较过程出错:', error);
  }
}

// 运行主函数
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { main as compareOdooGogoProducts };