#!/usr/bin/env node
/**
 * 產品檢查助手 - 協助檢查 Odoo vs GogoShop 產品一致性
 */

import fs from 'fs';
import path from 'path';

const REPORT_FILE = './product_check_report.json';
const TODAY = new Date().toISOString().split('T')[0];

// 重點檢查產品清單
const PRIORITY_PRODUCTS = {
  high: [
    '天山雪蓮面膜',
    '天山雪蓮精華液', 
    '天山雪蓮乳液',
    '天山雪蓮化妝水',
    '各種唇膜產品'
  ],
  medium: [
    '洗面乳系列',
    '化妝水系列', 
    '精華液系列',
    '面膜系列',
    '乳液面霜系列'
  ],
  low: [
    '配件類產品',
    '測試商品',
    '停產品項'
  ]
};

class ProductCheckAssistant {
  constructor() {
    this.report = this.loadReport();
  }

  loadReport() {
    if (fs.existsSync(REPORT_FILE)) {
      return JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
    }
    return {
      created: TODAY,
      lastUpdated: TODAY,
      products: {},
      issues: [],
      summary: {
        totalChecked: 0,
        issuesFound: 0,
        completionRate: 0
      }
    };
  }

  saveReport() {
    this.updateSummary();
    this.report.lastUpdated = new Date().toISOString();
    fs.writeFileSync(REPORT_FILE, JSON.stringify(this.report, null, 2));
  }

  updateSummary() {
    const products = Object.values(this.report.products);
    this.report.summary.totalChecked = products.length;
    this.report.summary.issuesFound = this.report.issues.length;
    this.report.summary.completionRate = this.calculateCompletionRate();
  }

  calculateCompletionRate() {
    const totalPriority = PRIORITY_PRODUCTS.high.length + PRIORITY_PRODUCTS.medium.length;
    const checkedPriority = Object.keys(this.report.products).filter(name => 
      PRIORITY_PRODUCTS.high.includes(name) || PRIORITY_PRODUCTS.medium.includes(name)
    ).length;
    return Math.round((checkedPriority / totalPriority) * 100);
  }

  addProductCheck(productName, gogoHasImage, odooHasImage, imagesMatch, namesMatch, notes = '') {
    this.report.products[productName] = {
      name: productName,
      checkedAt: new Date().toISOString(),
      gogo: { hasImage: gogoHasImage },
      odoo: { hasImage: odooHasImage },
      imagesMatch,
      namesMatch,
      notes,
      priority: this.getProductPriority(productName)
    };

    // 如果發現問題，加入問題清單
    if (!imagesMatch || !namesMatch || !gogoHasImage || !odooHasImage) {
      this.addIssue(productName, {
        gogoHasImage, odooHasImage, imagesMatch, namesMatch, notes
      });
    }

    this.saveReport();
    console.log(`✅ ${productName} 檢查完成`);
  }

  addIssue(productName, details) {
    const issueDescription = [];
    if (!details.gogoHasImage) issueDescription.push('GogoShop缺少圖片');
    if (!details.odooHasImage) issueDescription.push('Odoo缺少圖片');
    if (!details.imagesMatch) issueDescription.push('圖片內容不匹配');
    if (!details.namesMatch) issueDescription.push('產品名稱不一致');

    this.report.issues.push({
      product: productName,
      issues: issueDescription,
      notes: details.notes,
      priority: this.getProductPriority(productName),
      reportedAt: new Date().toISOString()
    });
  }

  getProductPriority(productName) {
    if (PRIORITY_PRODUCTS.high.some(p => productName.includes(p) || p.includes(productName))) {
      return 'high';
    }
    if (PRIORITY_PRODUCTS.medium.some(p => productName.includes(p) || p.includes(productName))) {
      return 'medium'; 
    }
    return 'low';
  }

  generateInteractiveReport() {
    console.log('\\n🔍 泡泡貓產品檢查報告');
    console.log('=' .repeat(50));
    console.log(`檢查日期: ${this.report.created}`);
    console.log(`最後更新: ${new Date(this.report.lastUpdated).toLocaleString('zh-TW')}`);
    console.log(`完成度: ${this.report.summary.completionRate}%`);
    
    console.log('\\n📊 檢查統計:');
    console.log(`   已檢查產品: ${this.report.summary.totalChecked}`);
    console.log(`   發現問題: ${this.report.summary.issuesFound}`);
    
    if (this.report.issues.length > 0) {
      console.log('\\n🚨 發現的問題:');
      this.report.issues.forEach((issue, index) => {
        console.log(`\\n${index + 1}. ${issue.product} [${issue.priority}優先級]`);
        issue.issues.forEach(prob => console.log(`   ❌ ${prob}`));
        if (issue.notes) console.log(`   📝 備註: ${issue.notes}`);
      });
    }

    console.log('\\n📋 待檢查的重點產品:');
    const uncheckedHigh = PRIORITY_PRODUCTS.high.filter(p => 
      !Object.keys(this.report.products).some(checked => checked.includes(p) || p.includes(checked))
    );
    
    if (uncheckedHigh.length > 0) {
      console.log('   🔥 高優先級:');
      uncheckedHigh.forEach(product => console.log(`     • ${product}`));
    }

    console.log('\\n💡 建議行動:');
    if (this.report.summary.completionRate < 50) {
      console.log('   1. 先完成天山雪蓮系列檢查');
      console.log('   2. 接著檢查唇膜產品');
      console.log('   3. 記錄發現的所有問題');
    } else if (this.report.summary.issuesFound > 0) {
      console.log('   1. 優先修復高優先級產品問題');
      console.log('   2. 上傳正確的產品圖片');
      console.log('   3. 統一產品名稱格式');
    } else {
      console.log('   1. 繼續檢查中優先級產品');
      console.log('   2. 建立定期檢查機制');
      console.log('   3. 制定產品資料標準');
    }
  }

  startInteractiveCheck() {
    console.log('🚀 開始互動式產品檢查');
    console.log('建議使用專用檢查工具：file://' + path.resolve('./manual_product_comparison.html'));
    console.log('\\n📖 檢查步驟:');
    console.log('1. 同時開啟 GogoShop 和 Odoo 後台');
    console.log('2. 使用檢查工具記錄每個產品的狀況');
    console.log('3. 發現問題時立即截圖記錄');
    console.log('4. 完成檢查後生成修復計劃');
    
    this.generateInteractiveReport();
  }

  exportIssues() {
    const csvContent = [
      '產品名稱,問題類型,優先級,備註,發現時間',
      ...this.report.issues.map(issue => 
        `"${issue.product}","${issue.issues.join('; ')}","${issue.priority}","${issue.notes}","${issue.reportedAt}"`
      )
    ].join('\\n');

    const csvFile = `product_issues_${TODAY}.csv`;
    fs.writeFileSync(csvFile, csvContent);
    console.log(`\\n📄 問題清單已匯出: ${csvFile}`);
  }
}

// CLI 介面
function main() {
  const assistant = new ProductCheckAssistant();
  const command = process.argv[2];

  switch (command) {
    case 'start':
      assistant.startInteractiveCheck();
      break;
    case 'report':
      assistant.generateInteractiveReport();
      break;
    case 'export':
      assistant.exportIssues();
      break;
    case 'add':
      const [name, gogo, odoo, match, nameMatch, ...notes] = process.argv.slice(3);
      assistant.addProductCheck(
        name, 
        gogo === 'true',
        odoo === 'true', 
        match === 'true',
        nameMatch === 'true',
        notes.join(' ')
      );
      break;
    default:
      console.log('🔍 產品檢查助手');
      console.log('\\n使用方式:');
      console.log('  node product_check_assistant.js start   - 開始互動式檢查');
      console.log('  node product_check_assistant.js report  - 查看檢查報告'); 
      console.log('  node product_check_assistant.js export  - 匯出問題清單');
      console.log('  node product_check_assistant.js add <產品名> <gogo有圖> <odoo有圖> <圖片匹配> <名稱匹配> [備註]');
      console.log('\\n範例:');
      console.log('  node product_check_assistant.js add "天山雪蓮面膜" true false false true "Odoo缺少圖片"');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export default ProductCheckAssistant;