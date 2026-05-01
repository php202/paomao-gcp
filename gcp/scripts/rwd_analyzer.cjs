#!/usr/bin/env node
/**
 * RWD 響應式設計分析器 - 使用免費 AI 掃描並優化手機版體驗
 */

const fs = require('fs');
const path = require('path');

// 載入 AI 模組
const { callAI } = require('./ai_automation.cjs');

async function analyzeRWD(sitePath) {
  console.log(`📱 分析 ${sitePath} 的 RWD...`);
  
  // 掃描 HTML/CSS 檔案
  const files = await scanFiles(sitePath, ['.html', '.css', '.js']);
  
  for (const file of files) {
    console.log(`🔍 掃描 ${file.name}...`);
    
    const analysis = await callAI(`
請分析這個網頁檔案的手機版 RWD 問題：

檔案：${file.name}
內容：
${file.content}

請檢查：
1. **CSS 媒體查詢** - 是否有適當的 @media 斷點
2. **按鈕尺寸** - 手機上是否太小（建議 44px+）
3. **字體大小** - 是否適合手機閱讀（建議 16px+）
4. **觸控友善** - 連結/按鈕間距是否足夠
5. **表格問題** - 是否會橫向溢出
6. **輸入框** - 是否適合手機輸入

格式：
## 發現問題
## 建議修正
## CSS 程式碼

請具體、可執行。
`, { temperature: 0.3 });

    // 儲存分析結果
    const outputPath = path.join(__dirname, '../logs', `rwd-analysis-${file.name.replace(/[^a-zA-Z0-9]/g, '-')}.md`);
    fs.writeFileSync(outputPath, `# RWD 分析報告 - ${file.name}\n\n${analysis}\n`);
    
    console.log(`✅ ${file.name} 分析完成`);
  }
}

async function scanFiles(dirPath, extensions) {
  const files = [];
  
  function walkDir(currentPath) {
    if (!fs.existsSync(currentPath)) return;
    
    const items = fs.readdirSync(currentPath);
    
    for (const item of items) {
      const itemPath = path.join(currentPath, item);
      const stat = fs.statSync(itemPath);
      
      if (stat.isDirectory() && !item.startsWith('.') && !item.includes('node_modules')) {
        walkDir(itemPath);
      } else if (stat.isFile()) {
        const ext = path.extname(item);
        if (extensions.includes(ext)) {
          try {
            const content = fs.readFileSync(itemPath, 'utf8');
            files.push({
              name: path.relative(dirPath, itemPath),
              path: itemPath,
              content: content.length > 10000 ? content.substring(0, 10000) + '...' : content
            });
          } catch (e) {
            console.warn(`⚠️ 無法讀取 ${itemPath}:`, e.message);
          }
        }
      }
    }
  }
  
  walkDir(dirPath);
  return files;
}

// 命令列使用
if (require.main === module) {
  const sitePath = process.argv[2];
  if (!sitePath) {
    console.log(`
🔍 RWD 分析器

使用方法：
  node rwd_analyzer.cjs <網站目錄>

範例：
  node rwd_analyzer.cjs ~/paomao-gcp/booking-site/public
  node rwd_analyzer.cjs ~/paomao-gcp/dashboard/views
`);
    process.exit(0);
  }
  
  analyzeRWD(sitePath).catch(e => {
    console.error('❌ 分析失敗:', e.message);
    process.exit(1);
  });
}

module.exports = { analyzeRWD };
