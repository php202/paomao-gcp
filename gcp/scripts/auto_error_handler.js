#!/usr/bin/env node
/**
 * 自動錯誤處理器 - 與 OpenClaw 集成
 * 當監控系統發現錯誤時，自動分析並提供修復建議
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);
const LOG_DIR = `${process.env.HOME}/.openclaw/workspace/logs/dashboard-monitor`;
const ERROR_LOG = `${LOG_DIR}/errors.log`;

class AutoErrorHandler {
  constructor() {
    this.lastCheckTime = 0;
  }

  // 檢查是否有新錯誤
  async checkForNewErrors() {
    if (!fs.existsSync(ERROR_LOG)) return false;

    const stats = fs.statSync(ERROR_LOG);
    const lastModified = stats.mtime.getTime();

    if (lastModified > this.lastCheckTime) {
      this.lastCheckTime = lastModified;
      return true;
    }

    return false;
  }

  // 讀取最近的錯誤
  getRecentErrors(minutes = 10) {
    if (!fs.existsSync(ERROR_LOG)) return [];

    const content = fs.readFileSync(ERROR_LOG, 'utf8');
    const lines = content.split('\\n').filter(line => line.trim());
    
    const cutoffTime = new Date(Date.now() - minutes * 60 * 1000);
    const recentErrors = [];

    for (const line of lines.reverse()) {
      const match = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] ERROR: (.+)$/);
      if (match) {
        const timestamp = new Date(match[1]);
        if (timestamp >= cutoffTime) {
          recentErrors.push({
            timestamp,
            message: match[2],
            raw: line
          });
        } else {
          break; // 因為是倒序的，遇到舊錯誤就停止
        }
      }
    }

    return recentErrors.reverse(); // 恢復時間順序
  }

  // 分析錯誤並生成修復建議
  analyzeAndSuggest(errors) {
    if (errors.length === 0) return null;

    const analysis = {
      errorCount: errors.length,
      timespan: this.getTimespan(errors),
      mainIssues: [],
      urgency: 'medium',
      suggestions: []
    };

    // 分析錯誤類型
    const errorTypes = {};
    errors.forEach(error => {
      const type = this.categorizeError(error.message);
      if (!errorTypes[type]) {
        errorTypes[type] = [];
      }
      errorTypes[type].push(error);
    });

    // 生成問題描述和建議
    Object.entries(errorTypes).forEach(([type, errorList]) => {
      const issue = this.getIssueInfo(type, errorList.length);
      analysis.mainIssues.push({
        type,
        count: errorList.length,
        description: issue.description,
        examples: errorList.slice(0, 2).map(e => e.message)
      });

      analysis.suggestions.push({
        priority: issue.priority,
        action: issue.solution,
        reason: `發現 ${errorList.length} 次 ${issue.description}錯誤`
      });
    });

    // 確定緊急程度
    if (errors.length >= 5 || errorTypes.port_conflict || errorTypes.database_error) {
      analysis.urgency = 'high';
    } else if (errors.length >= 3) {
      analysis.urgency = 'medium';
    } else {
      analysis.urgency = 'low';
    }

    return analysis;
  }

  // 分類錯誤類型
  categorizeError(message) {
    const msg = message.toLowerCase();
    
    if (msg.includes('eaddrinuse') || msg.includes('port') || msg.includes('address already in use')) {
      return 'port_conflict';
    } else if (msg.includes('postgresql') || msg.includes('database') || msg.includes('connection')) {
      return 'database_error';
    } else if (msg.includes('permission denied') || msg.includes('eacces')) {
      return 'permission_error';
    } else if (msg.includes('cannot find module') || msg.includes('module not found')) {
      return 'missing_dependency';
    } else if (msg.includes('memory') || msg.includes('heap')) {
      return 'memory_error';
    } else if (msg.includes('http') && (msg.includes('500') || msg.includes('503'))) {
      return 'service_error';
    } else {
      return 'unknown_error';
    }
  }

  // 獲取問題資訊
  getIssueInfo(type, count) {
    const issueMap = {
      port_conflict: {
        description: '端口衝突',
        priority: 1,
        solution: '執行 pkill -f "dashboard.*server.js" 並重啟服務'
      },
      database_error: {
        description: '資料庫連接',
        priority: 1,
        solution: '檢查 PostgreSQL 服務狀態：pg_isready -h localhost'
      },
      missing_dependency: {
        description: '依賴模組缺失',
        priority: 2,
        solution: '執行 cd ~/泡泡貓/dashboard && npm install'
      },
      memory_error: {
        description: '記憶體不足',
        priority: 1,
        solution: '重啟 Dashboard 服務釋放記憶體'
      },
      permission_error: {
        description: '權限',
        priority: 2,
        solution: '檢查文件權限：ls -la ~/泡泡貓/dashboard'
      },
      service_error: {
        description: 'HTTP 服務',
        priority: 2,
        solution: '檢查 Dashboard 服務健康度並考慮重啟'
      },
      unknown_error: {
        description: '未知',
        priority: 3,
        solution: '查看完整日誌以確定具體問題'
      }
    };

    return issueMap[type] || issueMap.unknown_error;
  }

  // 計算錯誤時間跨度
  getTimespan(errors) {
    if (errors.length < 2) return '單次錯誤';
    
    const first = errors[0].timestamp;
    const last = errors[errors.length - 1].timestamp;
    const diffMs = last - first;
    const diffMin = Math.round(diffMs / 60000);
    
    if (diffMin < 1) return '不到1分鐘內';
    if (diffMin < 60) return `${diffMin}分鐘內`;
    
    const diffHour = Math.round(diffMin / 60);
    return `${diffHour}小時內`;
  }

  // 生成 OpenClaw 格式的報告
  generateOpenClawReport(analysis) {
    if (!analysis) return null;

    const urgencyEmoji = {
      high: '🚨',
      medium: '⚠️',
      low: '💭'
    };

    const report = {
      title: `${urgencyEmoji[analysis.urgency]} Dashboard 錯誤檢測`,
      summary: `檢測到 ${analysis.errorCount} 個錯誤（${analysis.timespan}）`,
      details: [],
      actions: []
    };

    // 添加問題詳情
    analysis.mainIssues.forEach((issue, index) => {
      report.details.push(`${index + 1}. ${issue.description}錯誤：${issue.count} 次`);
      if (issue.examples.length > 0) {
        report.details.push(`   例如：${issue.examples[0]}`);
      }
    });

    // 添加建議動作
    analysis.suggestions
      .sort((a, b) => a.priority - b.priority)
      .forEach((suggestion, index) => {
        report.actions.push(`${index + 1}. ${suggestion.action}`);
        report.actions.push(`   原因：${suggestion.reason}`);
      });

    return report;
  }

  // 執行自動修復
  async attemptAutoFix(analysis) {
    const results = [];

    for (const issue of analysis.mainIssues) {
      if (issue.type === 'port_conflict' && issue.count >= 3) {
        console.log('🔧 嘗試自動修復端口衝突...');
        try {
          await execAsync('pkill -f "dashboard.*server.js"');
          await new Promise(resolve => setTimeout(resolve, 3000));
          await execAsync('cd ~/泡泡貓/dashboard && npm start > server.log 2>&1 &');
          results.push('✅ 已自動修復端口衝突問題');
        } catch (error) {
          results.push(`❌ 端口衝突自動修復失敗: ${error.message}`);
        }
      }

      if (issue.type === 'missing_dependency' && issue.count >= 2) {
        console.log('🔧 嘗試自動安裝依賴...');
        try {
          await execAsync('cd ~/泡泡貓/dashboard && npm install');
          results.push('✅ 已自動安裝缺失依賴');
        } catch (error) {
          results.push(`❌ 依賴安裝失敗: ${error.message}`);
        }
      }
    }

    return results;
  }
}

// OpenClaw 集成函數
async function checkAndReport() {
  const handler = new AutoErrorHandler();
  
  // 檢查最近10分鐘的錯誤
  const recentErrors = handler.getRecentErrors(10);
  
  if (recentErrors.length === 0) {
    console.log('✅ 沒有檢測到新錯誤');
    return;
  }

  console.log(`🔍 檢測到 ${recentErrors.length} 個最近錯誤`);
  
  // 分析錯誤
  const analysis = handler.analyzeAndSuggest(recentErrors);
  
  if (!analysis) {
    console.log('📊 錯誤分析無結果');
    return;
  }

  // 生成報告
  const report = handler.generateOpenClawReport(analysis);
  
  console.log('\\n📋 錯誤分析報告:');
  console.log(`${report.title}`);
  console.log(`${report.summary}\\n`);
  
  if (report.details.length > 0) {
    console.log('📝 問題詳情:');
    report.details.forEach(detail => console.log(`   ${detail}`));
    console.log('');
  }
  
  if (report.actions.length > 0) {
    console.log('💡 建議動作:');
    report.actions.forEach(action => console.log(`   ${action}`));
    console.log('');
  }

  // 如果錯誤嚴重，嘗試自動修復
  if (analysis.urgency === 'high') {
    console.log('🚨 錯誤程度：高，嘗試自動修復...');
    const fixResults = await handler.attemptAutoFix(analysis);
    
    if (fixResults.length > 0) {
      console.log('🔧 自動修復結果:');
      fixResults.forEach(result => console.log(`   ${result}`));
    }
  }

  return { analysis, report };
}

// 持續監控模式
async function continuousMonitor() {
  console.log('🔄 開始持續監控模式...');
  
  const handler = new AutoErrorHandler();
  
  setInterval(async () => {
    if (await handler.checkForNewErrors()) {
      console.log('\\n⚠️ 檢測到新錯誤，開始分析...');
      await checkAndReport();
    }
  }, 30000); // 每30秒檢查一次

  // 保持進程運行
  process.on('SIGINT', () => {
    console.log('\\n👋 停止持續監控');
    process.exit(0);
  });
}

// CLI 介面
async function main() {
  const command = process.argv[2];

  switch (command) {
    case 'check':
      await checkAndReport();
      break;
    
    case 'monitor':
      await continuousMonitor();
      break;
    
    case 'analyze':
      const { exec } = await import('child_process');
      const { spawn } = require('child_process');
      const analyzer = spawn('node', ['~/paomao-gcp/gcp/scripts/dashboard_log_analyzer.js', 'analyze']);
      analyzer.stdout.pipe(process.stdout);
      analyzer.stderr.pipe(process.stderr);
      break;
    
    default:
      console.log('🤖 Dashboard 自動錯誤處理器');
      console.log('\\n使用方式:');
      console.log('  node auto_error_handler.js check    - 檢查並報告最近錯誤');
      console.log('  node auto_error_handler.js monitor  - 持續監控模式');
      console.log('  node auto_error_handler.js analyze  - 完整日誌分析');
      console.log('\\n此腳本與 OpenClaw 智能監控系統集成');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}