#!/usr/bin/env node
/**
 * AI 自動化任務中心
 * 使用免費 AI APIs 進行客服優化、營收分析、績效評估等
 */

const fs = require('fs');
const path = require('path');

// AI API 配置（使用免費額度）
const AI_CONFIG = {
  primary: 'google/gemini-2.5-flash',      // 主力：免費額度大
  fallback: 'openai/gpt-4o-mini',         // 備案：免費 tier
  backup: 'anthropic/claude-3-5-haiku',   // 備援：少量免費
  cost: 'free'                            // 完全免費
};

// 載入 AI API keys
function loadAIKeys() {
  try {
    const keysPath = path.join(process.env.HOME, '.openclaw/secrets/ai-api-keys.json');
    const data = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
    
    // 轉換為簡單的 provider -> key 格式
    const keys = {};
    if (data.keys) {
      data.keys.forEach(item => {
        keys[item.provider] = item.key;
      });
    }
    return keys;
  } catch (e) {
    console.error('❌ 無法載入 AI keys:', e.message);
    process.exit(1);
  }
}

// AI 調用函數（自動 fallback）
async function callAI(prompt, options = {}) {
  const keys = loadAIKeys();
  const models = [AI_CONFIG.primary, AI_CONFIG.fallback, AI_CONFIG.backup];
  
  for (const model of models) {
    try {
      console.log(`🤖 嘗試 ${model}...`);
      
      if (model.startsWith('google/')) {
        return await callGemini(prompt, keys.gemini, options);
      } else if (model.startsWith('openai/')) {
        return await callOpenAI(prompt, keys.openai, options);
      } else if (model.startsWith('anthropic/')) {
        return await callClaude(prompt, keys.claude, options);
      }
    } catch (e) {
      console.warn(`⚠️ ${model} 失敗:`, e.message);
      continue;
    }
  }
  
  throw new Error('所有 AI 模型都失敗了');
}

// Gemini API 調用
async function callGemini(prompt, apiKey, options) {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: options.temperature || 0.7,
        maxOutputTokens: options.maxTokens || 2048
      }
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${error}`);
  }
  
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// OpenAI API 調用
async function callOpenAI(prompt, apiKey, options) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 2048
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${error}`);
  }
  
  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

// Claude API 調用
async function callClaude(prompt, apiKey, options) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: options.maxTokens || 2048
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} ${error}`);
  }
  
  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// 任務調度器
async function runTask(taskName, ...args) {
  console.log(`🚀 執行任務: ${taskName}`);
  const startTime = Date.now();
  
  try {
    switch (taskName) {
      case 'faq-optimize':
        return await optimizeFAQ(...args);
      case 'revenue-insight':
        return await dailyRevenueInsight(...args);
      case 'performance-report':
        return await generatePerformanceReport(...args);
      case 'holiday-message':
        return await scheduleHolidayMessage(...args);
      default:
        throw new Error(`未知任務: ${taskName}`);
    }
  } finally {
    const duration = (Date.now() - startTime) / 1000;
    console.log(`✅ 任務完成，耗時 ${duration.toFixed(2)}s`);
  }
}

// ========================================
// 任務實作
// ========================================

// 1. 客服 FAQ 優化
async function optimizeFAQ(days = 7) {
  console.log(`📝 分析過去 ${days} 天的客服對話...`);
  
  // TODO: 從 LINE webhook 或資料庫取得對話記錄
  const conversations = await getLineConversations(days);
  
  const prompt = `
請分析這些泡泡貓美容客服對話，提供優化建議：

對話資料：
${JSON.stringify(conversations, null, 2)}

請分析：
1. **最常見問題TOP5** (列出問題類型和頻率)
2. **客戶困惑點** (哪些回覆讓客戶不滿意)
3. **建議回覆模板** (針對常見問題的標準回覆)
4. **改善建議** (如何提升客服效率)

格式：
## 常見問題分析
## 困惑點識別
## 建議回覆模板
## 改善建議

請務實、具體，針對美容行業特性。
`;

  const analysis = await callAI(prompt, { temperature: 0.3 });
  
  // 保存分析結果
  const outputPath = path.join(__dirname, '../logs/faq-analysis.md');
  fs.writeFileSync(outputPath, `# FAQ 分析報告 (${new Date().toISOString()})\n\n${analysis}`);
  
  console.log(`✅ FAQ 分析完成，報告已保存至 ${outputPath}`);
  return analysis;
}

// 2. 每日營收洞察
async function dailyRevenueInsight(targetDate = null) {
  const date = targetDate || new Date(Date.now() - 24*60*60*1000); // 昨日
  console.log(`💰 分析 ${date.toISOString().split('T')[0]} 營收...`);
  
  // TODO: 從資料庫取得營收數據
  const revenueData = await getRevenueData(date);
  
  const prompt = `
請分析泡泡貓連鎖美容的營收數據：

日期：${date.toISOString().split('T')[0]}
總營收：NT$ ${revenueData.total}
門市數據：
${revenueData.stores.map(s => `- ${s.name}: NT$ ${s.revenue} (${s.services}服務)`).join('\n')}

對比數據：
- 上週同日：NT$ ${revenueData.lastWeek}
- 月平均：NT$ ${revenueData.monthAvg}

請提供：
1. **整體表現評估** (好/普通/差，具體原因)
2. **門市排名分析** (前3名和後3名，分析原因)
3. **趨勢預測** (今日可能業績，基於歷史數據)
4. **行動建議** (3個具體可執行的建議)

語調：專業但易懂，給管理層的報告。
`;

  const insight = await callAI(prompt, { temperature: 0.4 });
  
  // 發送到管理群組（TODO: 整合 Telegram API）
  console.log(`📊 營收洞察:\n${insight}`);
  
  return insight;
}

// 3. 員工績效評估
async function generatePerformanceReport(employeeId, period = 30) {
  console.log(`👤 生成員工 ${employeeId} 的 ${period} 天績效報告...`);
  
  // TODO: 從資料庫取得員工數據
  const performance = await getEmployeeMetrics(employeeId, period);
  
  const prompt = `
請為泡泡貓員工生成個人化績效報告：

員工：${performance.name}
職位：${performance.title}
門市：${performance.store}

績效數據 (最近 ${period} 天)：
- 客戶評分：${performance.rating}/5 (${performance.reviewCount}則評價)
- 服務次數：${performance.services}次
- 營收貢獻：NT$ ${performance.revenue}
- 準時率：${performance.punctuality}%
- 出勤天數：${performance.attendance}天

請生成：
1. **表現亮點** (具體數據支撐，2-3點)
2. **待改善領域** (建設性建議，2-3點)
3. **下月目標** (具體、可測量的目標)
4. **成長建議** (培訓或技能提升建議)

語調：鼓勵、正面，但要具體有建設性。
`;

  const report = await callAI(prompt, { temperature: 0.5 });
  
  // TODO: 發送給員工
  console.log(`📋 績效報告 (${performance.name}):\n${report}`);
  
  return report;
}

// 4. 節日群發訊息
async function scheduleHolidayMessage(holiday, daysAhead = 3) {
  console.log(`🎉 為 ${holiday} 生成群發訊息 (${daysAhead}天前)...`);
  
  const prompt = `
請為泡泡貓連鎖美容生成 ${holiday} 的 LINE 群發訊息：

品牌特色：
- 韓式科技美容
- 專業潔顏師
- 高品質服務

要求：
1. **節日問候** (溫馨、專業)
2. **特別優惠** (限時、吸引人，但不要過度促銷)
3. **預約提醒** (方便客戶行動)
4. **適當 emoji** (不要過多，保持專業)

字數：150-200字
語調：親切但專業，體現品牌質感

直接輸出訊息內容，無需其他說明。
`;

  const message = await callAI(prompt, { temperature: 0.6 });
  
  // TODO: 排程到 LINE 群發系統
  console.log(`💌 ${holiday} 群發訊息:\n${message}`);
  
  return message;
}

// ========================================
// 資料取得函數 (待實作)
// ========================================

async function getLineConversations(days) {
  // TODO: 從 LINE webhook 記錄或資料庫取得對話
  return {
    totalMessages: 150,
    conversations: [
      { question: "幾點營業", answer: "11:00-21:00", count: 25 },
      { question: "價格多少", answer: "課程價格請洽詢門市", count: 20 },
      { question: "如何預約", answer: "可透過 LINE 或電話預約", count: 18 }
    ]
  };
}

async function getRevenueData(date) {
  // TODO: 從資料庫取得營收數據
  return {
    total: 125000,
    stores: [
      { name: "新竹公道店", revenue: 35000, services: 42 },
      { name: "台北信義店", revenue: 28000, services: 35 },
      { name: "高雄前鎮店", revenue: 22000, services: 28 }
    ],
    lastWeek: 118000,
    monthAvg: 121000
  };
}

async function getEmployeeMetrics(employeeId, period) {
  // TODO: 從資料庫取得員工數據
  return {
    name: "王小美",
    title: "潔顏師",
    store: "新竹公道店",
    rating: 4.8,
    reviewCount: 15,
    services: 45,
    revenue: 67500,
    punctuality: 98,
    attendance: 28
  };
}

// ========================================
// 命令列介面
// ========================================

async function main() {
  const [taskName, ...args] = process.argv.slice(2);
  
  if (!taskName) {
    console.log(`
🤖 AI 自動化任務中心

使用方法：
  node ai_automation.cjs <task> [args...]

可用任務：
  faq-optimize [days=7]           - 客服 FAQ 優化
  revenue-insight [date]          - 每日營收洞察  
  performance-report <empId>      - 員工績效報告
  holiday-message <holiday>       - 節日群發訊息

範例：
  node ai_automation.cjs faq-optimize 7
  node ai_automation.cjs revenue-insight
  node ai_automation.cjs performance-report 123
  node ai_automation.cjs holiday-message "母親節"
`);
    process.exit(0);
  }
  
  try {
    const result = await runTask(taskName, ...args);
    console.log('\n✅ 任務執行成功');
  } catch (e) {
    console.error('\n❌ 任務執行失敗:', e.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { runTask, callAI };