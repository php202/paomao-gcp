#!/usr/bin/env node
/**
 * 夜間自動優化系統
 * 在睡眠時間使用免費 AI 持續改善各項內容
 * 執行時間：23:00-07:00 (台北時間)
 */

const fs = require('fs');
const path = require('path');
const { callAI } = require('./ai_automation.cjs');

// 夜間優化任務清單
const NIGHTTIME_TASKS = [
  {
    name: 'content-optimization',
    description: '內容文案優化',
    priority: 1,
    estimatedMinutes: 30
  },
  {
    name: 'seo-improvement', 
    description: 'SEO 關鍵字優化',
    priority: 2,
    estimatedMinutes: 20
  },
  {
    name: 'user-experience-audit',
    description: '使用者體驗稽核',
    priority: 3,
    estimatedMinutes: 25
  },
  {
    name: 'social-media-content',
    description: '社群媒體內容生成',
    priority: 4,
    estimatedMinutes: 15
  },
  {
    name: 'customer-service-qa',
    description: '客服問答優化',
    priority: 5,
    estimatedMinutes: 20
  }
];

/**
 * 檢查是否為睡眠時間 (23:00-07:00 台北時間)
 */
function isSleepTime() {
  const now = new Date();
  const taipeiTime = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Taipei"}));
  const hour = taipeiTime.getHours();
  
  return hour >= 23 || hour <= 7;
}

/**
 * 記錄優化進度
 */
function logProgress(taskName, status, details = '') {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${taskName}: ${status}\n${details}\n---\n`;
  
  const logPath = path.join(__dirname, '../logs/nighttime-optimization.log');
  fs.appendFileSync(logPath, logEntry);
  
  console.log(`📝 [${timestamp}] ${taskName}: ${status}`);
}

/**
 * 1. 內容文案優化
 */
async function optimizeContent() {
  logProgress('content-optimization', 'STARTED', '開始分析網站文案');
  
  try {
    // 讀取預約網站內容
    const indexPath = path.join(process.env.HOME, '.openclaw/workspace/booking-site/public/index.html');
    const content = fs.readFileSync(indexPath, 'utf8');
    
    const prompt = `
請分析泡泡貓預約網站的文案內容，提供優化建議：

網站內容：
${content.substring(0, 5000)}

請針對以下方面優化：
1. **標題吸引力** - 更有吸引力的主標題和副標題
2. **服務描述** - 更清晰的服務項目說明
3. **信任建立** - 增強客戶信任的文案
4. **行動召喚** - 更有效的 CTA 按鈕文字
5. **情感連結** - 符合美容行業的情感訴求

格式：
## 現有問題分析
## 優化建議
## 建議文案範例

請實用、具體，符合泡泡貓韓式科技美容的品牌定位。
`;

    const analysis = await callAI(prompt, { temperature: 0.4 });
    
    // 儲存分析結果
    const outputPath = path.join(__dirname, '../reports/content-optimization-report.md');
    const report = `# 內容優化報告 (${new Date().toISOString()})\n\n${analysis}\n`;
    fs.writeFileSync(outputPath, report);
    
    logProgress('content-optimization', 'COMPLETED', `報告已儲存: ${outputPath}`);
    return true;
    
  } catch (e) {
    logProgress('content-optimization', 'FAILED', `錯誤: ${e.message}`);
    return false;
  }
}

/**
 * 2. SEO 關鍵字優化
 */
async function improveSEO() {
  logProgress('seo-improvement', 'STARTED', '開始 SEO 分析');
  
  try {
    const prompt = `
為泡泡貓連鎖美容分析並建議 SEO 關鍵字策略：

品牌資訊：
- 業務：韓式科技美容、潔顏護膚
- 服務：科技儀器洗臉、護膚療程
- 地區：台北、新竹、桃園、台中、高雄
- 目標客群：25-45歲女性，重視肌膚保養

請提供：
1. **主要關鍵字** (10個核心詞)
2. **長尾關鍵字** (20個組合詞)  
3. **地區性關鍵字** (結合各城市)
4. **競品分析** (同業常用關鍵字)
5. **內容主題建議** (部落格/社群文章主題)

請具體、可執行，並考慮台灣市場特性。
`;

    const analysis = await callAI(prompt, { temperature: 0.3 });
    
    const outputPath = path.join(__dirname, '../reports/seo-keywords-report.md');
    const report = `# SEO 關鍵字優化報告 (${new Date().toISOString()})\n\n${analysis}\n`;
    fs.writeFileSync(outputPath, report);
    
    logProgress('seo-improvement', 'COMPLETED', `SEO 報告已儲存: ${outputPath}`);
    return true;
    
  } catch (e) {
    logProgress('seo-improvement', 'FAILED', `錯誤: ${e.message}`);
    return false;
  }
}

/**
 * 3. 使用者體驗稽核
 */
async function auditUserExperience() {
  logProgress('user-experience-audit', 'STARTED', '開始 UX 稽核');
  
  try {
    const prompt = `
請針對泡泡貓預約網站進行全面的使用者體驗稽核：

分析角度：
1. **預約流程** - 從進入網站到完成預約的每個步驟
2. **資訊架構** - 資訊是否清晰易懂
3. **視覺設計** - 是否符合目標客群喜好
4. **互動設計** - 操作是否直觀
5. **錯誤處理** - 異常情況的處理方式
6. **載入速度** - 影響使用體驗的效能問題

美容行業特殊考量：
- 客戶通常重視隱私和專業感
- 需要展現服務品質和安全性
- 價格敏感度高，需要清楚說明價值
- 重視口碑和評價

請提供：
## UX 問題識別
## 改善建議
## 優先級排序
## 實作建議

要求具體、可執行。
`;

    const analysis = await callAI(prompt, { temperature: 0.5 });
    
    const outputPath = path.join(__dirname, '../reports/ux-audit-report.md');
    const report = `# UX 使用者體驗稽核報告 (${new Date().toISOString()})\n\n${analysis}\n`;
    fs.writeFileSync(outputPath, report);
    
    logProgress('user-experience-audit', 'COMPLETED', `UX 報告已儲存: ${outputPath}`);
    return true;
    
  } catch (e) {
    logProgress('user-experience-audit', 'FAILED', `錯誤: ${e.message}`);
    return false;
  }
}

/**
 * 4. 社群媒體內容生成
 */
async function generateSocialContent() {
  logProgress('social-media-content', 'STARTED', '生成社群內容');
  
  try {
    const prompt = `
為泡泡貓科技美容生成一週的社群媒體內容：

平台：Instagram、Facebook
目標：提升品牌知名度、客戶教育、預約轉換

內容類型要求：
1. **知識型貼文** (2則) - 護膚知識、保養技巧
2. **產品介紹** (2則) - 服務項目、儀器介紹  
3. **客戶見證** (1則) - 服務成果分享
4. **品牌故事** (1則) - 企業文化、專業團隊
5. **促銷活動** (1則) - 限時優惠、新客體驗

每則內容包含：
- 吸引人的標題
- 正文內容 (150-200字)
- 相關 hashtags
- 發布時間建議
- 配圖建議

語調：專業但親切，符合 25-45歲女性喜好。
`;

    const content = await callAI(prompt, { temperature: 0.6 });
    
    const outputPath = path.join(__dirname, '../content/weekly-social-media-plan.md');
    const plan = `# 社群媒體週計劃 (${new Date().toISOString()})\n\n${content}\n`;
    fs.writeFileSync(outputPath, plan);
    
    logProgress('social-media-content', 'COMPLETED', `社群內容已生成: ${outputPath}`);
    return true;
    
  } catch (e) {
    logProgress('social-media-content', 'FAILED', `錯誤: ${e.message}`);
    return false;
  }
}

/**
 * 5. 客服問答優化
 */
async function optimizeCustomerServiceQA() {
  logProgress('customer-service-qa', 'STARTED', '優化客服問答');
  
  try {
    const prompt = `
為泡泡貓美容優化客服常見問答集：

基於美容行業特性，建立完整的 FAQ：

核心問題類別：
1. **服務相關** - 項目內容、時間、效果
2. **價格相關** - 收費標準、優惠方案
3. **預約相關** - 預約方式、取消政策
4. **店面相關** - 地點、營業時間、停車
5. **衛生安全** - 清潔標準、儀器安全
6. **效果相關** - 適用膚質、注意事項

每個問答包含：
- 客戶可能的提問方式 (多種表達)
- 標準回覆內容 (專業且易懂)
- 相關追問的處理
- 轉介專人的時機

請生成 20 組完整的問答，涵蓋最常見的客戶疑慮。
語調：專業、耐心、有溫度。
`;

    const qaContent = await callAI(prompt, { temperature: 0.4 });
    
    const outputPath = path.join(__dirname, '../content/customer-service-faq.md');
    const faq = `# 客服 FAQ 優化版本 (${new Date().toISOString()})\n\n${qaContent}\n`;
    fs.writeFileSync(outputPath, faq);
    
    logProgress('customer-service-qa', 'COMPLETED', `FAQ 已優化: ${outputPath}`);
    return true;
    
  } catch (e) {
    logProgress('customer-service-qa', 'FAILED', `錯誤: ${e.message}`);
    return false;
  }
}

/**
 * 主要執行函數
 */
async function runNighttimeOptimization() {
  console.log('🌙 夜間優化系統啟動...');
  
  // 檢查是否為睡眠時間
  if (!isSleepTime()) {
    console.log('⏰ 非睡眠時間，跳過優化');
    return;
  }
  
  // 確保必要目錄存在
  const dirs = ['../reports', '../content', '../logs'];
  dirs.forEach(dir => {
    const fullPath = path.join(__dirname, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  });
  
  logProgress('system', 'STARTED', '夜間優化系統開始運行');
  
  const results = {
    total: NIGHTTIME_TASKS.length,
    completed: 0,
    failed: 0
  };
  
  // 依優先級執行任務
  for (const task of NIGHTTIME_TASKS.sort((a, b) => a.priority - b.priority)) {
    console.log(`🚀 執行任務: ${task.description} (預估 ${task.estimatedMinutes} 分鐘)`);
    
    let success = false;
    
    switch (task.name) {
      case 'content-optimization':
        success = await optimizeContent();
        break;
      case 'seo-improvement':
        success = await improveSEO();
        break;
      case 'user-experience-audit':
        success = await auditUserExperience();
        break;
      case 'social-media-content':
        success = await generateSocialContent();
        break;
      case 'customer-service-qa':
        success = await optimizeCustomerServiceQA();
        break;
      default:
        logProgress(task.name, 'SKIPPED', '未實作的任務');
    }
    
    if (success) {
      results.completed++;
    } else {
      results.failed++;
    }
    
    // 任務間暫停 30 秒，避免 API 限制
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
  
  // 生成夜間優化摘要報告
  const summary = `
# 夜間優化摘要報告

**執行時間:** ${new Date().toISOString()}
**總任務數:** ${results.total}
**完成任務:** ${results.completed}
**失敗任務:** ${results.failed}
**成功率:** ${((results.completed / results.total) * 100).toFixed(1)}%

## 生成的報告檔案

1. 內容優化報告: \`reports/content-optimization-report.md\`
2. SEO 關鍵字報告: \`reports/seo-keywords-report.md\`
3. UX 稽核報告: \`reports/ux-audit-report.md\`
4. 社群媒體計劃: \`content/weekly-social-media-plan.md\`
5. 客服 FAQ: \`content/customer-service-faq.md\`

## 建議後續行動

請在白天查看上述報告，並根據優先級實作改善建議。
`;

  const summaryPath = path.join(__dirname, '../reports/nighttime-summary.md');
  fs.writeFileSync(summaryPath, summary);
  
  logProgress('system', 'COMPLETED', `夜間優化完成，摘要報告: ${summaryPath}`);
  
  console.log(`✅ 夜間優化完成 (${results.completed}/${results.total} 成功)`);
}

// 命令列使用
if (require.main === module) {
  const forceRun = process.argv.includes('--force');
  
  if (forceRun) {
    console.log('🔧 強制執行模式 (忽略時間檢查)');
    // 暫時覆寫時間檢查
    global.isSleepTime = () => true;
  }
  
  runNighttimeOptimization()
    .then(() => {
      console.log('🌅 夜間優化系統結束');
      process.exit(0);
    })
    .catch(e => {
      console.error('❌ 夜間優化失敗:', e.message);
      process.exit(1);
    });
}

module.exports = { runNighttimeOptimization };