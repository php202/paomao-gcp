#!/usr/bin/env node
/**
 * Dashboard 日誌分析器 - 智能錯誤分析和修復建議
 */

import fs from 'fs';
import path from 'path';

const LOG_DIR = `${process.env.HOME}/.openclaw/workspace/logs/dashboard-monitor`;
const ERROR_LOG = `${LOG_DIR}/errors.log`;
const MONITOR_LOG = `${LOG_DIR}/monitor.log`;

class DashboardLogAnalyzer {
  constructor() {
    this.errorPatterns = {
      'EADDRINUSE': {
        type: 'port_conflict',
        severity: 'high',
        description: '端口衝突',
        solution: '殺死占用端口的進程並重啟服務'
      },
      'ECONNREFUSED': {
        type: 'connection_refused',
        severity: 'medium',
        description: '連接被拒絕',
        solution: '檢查服務是否正常啟動，確認端口配置'
      },
      'PostgreSQL': {
        type: 'database_error',
        severity: 'high',
        description: '資料庫連接問題',
        solution: '檢查 PostgreSQL 服務狀態，確認連接配置'
      },
      'permission denied': {
        type: 'permission_error',
        severity: 'medium',
        description: '權限錯誤',
        solution: '檢查文件權限，確保用戶有足夠的訪問權限'
      },
      'Cannot find module': {
        type: 'missing_dependency',
        severity: 'high',
        description: '缺少依賴模組',
        solution: '執行 npm install 安裝缺失的依賴'
      },
      'out of memory': {
        type: 'memory_error',
        severity: 'critical',
        description: '記憶體不足',
        solution: '重啟服務釋放記憶體，考慮增加系統記憶體'
      }
    };
  }

  // 讀取日誌文件
  readLogFile(filePath, lines = 50) {
    try {
      if (!fs.existsSync(filePath)) return [];
      
      const content = fs.readFileSync(filePath, 'utf8');
      return content.split('\\n')
        .filter(line => line.trim())
        .slice(-lines)
        .map(line => this.parseLogLine(line))
        .filter(parsed => parsed !== null);
    } catch (error) {
      console.error(`讀取日誌失敗: ${error.message}`);
      return [];
    }
  }

  // 解析日誌行
  parseLogLine(line) {
    const logPattern = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] (INFO|ERROR|SUCCESS): (.+)$/;
    const match = line.match(logPattern);
    
    if (match) {
      return {
        timestamp: new Date(match[1]),
        level: match[2],
        message: match[3],
        raw: line
      };
    }
    
    // 如果不符合標準格式，可能是系統診斷資訊
    return {
      timestamp: null,
      level: 'SYSTEM',
      message: line,
      raw: line
    };
  }

  // 分析錯誤模式
  analyzeErrors(logs) {
    const errors = logs.filter(log => log.level === 'ERROR');
    const analysis = {
      totalErrors: errors.length,
      recentErrors: errors.filter(err => {
        if (!err.timestamp) return false;
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
        return err.timestamp > hourAgo;
      }),
      errorTypes: {},
      suggestions: []
    };

    errors.forEach(error => {
      for (const [pattern, config] of Object.entries(this.errorPatterns)) {
        if (error.message.toLowerCase().includes(pattern.toLowerCase())) {
          if (!analysis.errorTypes[config.type]) {
            analysis.errorTypes[config.type] = {
              count: 0,
              config: config,
              examples: []
            };
          }
          analysis.errorTypes[config.type].count++;
          analysis.errorTypes[config.type].examples.push({
            timestamp: error.timestamp,
            message: error.message
          });
          break;
        }
      }
    });

    // 生成修復建議
    this.generateSuggestions(analysis);
    
    return analysis;
  }

  // 生成修復建議
  generateSuggestions(analysis) {
    const suggestions = analysis.suggestions;

    // 根據錯誤類型生成建議
    Object.entries(analysis.errorTypes).forEach(([type, data]) => {
      if (data.count > 0) {
        suggestions.push({
          priority: this.getPriority(data.config.severity),
          title: `修復 ${data.config.description}`,
          description: `發現 ${data.count} 次 ${data.config.description} 錯誤`,
          action: data.config.solution,
          count: data.count
        });
      }
    });

    // 如果最近錯誤很多，建議立即處理
    if (analysis.recentErrors.length > 5) {
      suggestions.unshift({
        priority: 1,
        title: '大量近期錯誤',
        description: `過去1小時內發生了 ${analysis.recentErrors.length} 個錯誤`,
        action: '立即檢查服務狀態，可能需要重啟或修復配置',
        count: analysis.recentErrors.length
      });
    }

    // 按優先級排序
    suggestions.sort((a, b) => a.priority - b.priority);
  }

  // 獲取優先級數字
  getPriority(severity) {
    const priorities = { 'critical': 1, 'high': 2, 'medium': 3, 'low': 4 };
    return priorities[severity] || 5;
  }

  // 檢查服務狀態
  async checkServiceStatus() {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const status = {
      dashboard: false,
      database: false,
      ports: {}
    };

    try {
      // 檢查 Dashboard 進程
      const { stdout: psOutput } = await execAsync("ps aux | grep 'dashboard.*server.js' | grep -v grep");
      status.dashboard = psOutput.trim().length > 0;
    } catch {}

    try {
      // 檢查端口 3000
      const { stdout: portOutput } = await execAsync("lsof -ti:3000");
      status.ports['3000'] = portOutput.trim().length > 0;
    } catch {}

    try {
      // 檢查 PostgreSQL
      const { stdout: pgOutput } = await execAsync("pg_isready -h localhost");
      status.database = pgOutput.includes('accepting connections');
    } catch {}

    return status;
  }

  // 生成完整報告
  async generateReport() {
    console.log('🔍 Dashboard 日誌分析報告');
    console.log('=' .repeat(50));
    console.log(`分析時間: ${new Date().toLocaleString('zh-TW')}`);
    
    // 讀取日誌
    const errorLogs = this.readLogFile(ERROR_LOG, 100);
    const monitorLogs = this.readLogFile(MONITOR_LOG, 50);
    
    console.log(`\\n📊 日誌統計:`);
    console.log(`   錯誤日誌: ${errorLogs.length} 條記錄`);
    console.log(`   監控日誌: ${monitorLogs.length} 條記錄`);

    // 分析錯誤
    const errorAnalysis = this.analyzeErrors([...errorLogs, ...monitorLogs]);
    
    console.log(`\\n🚨 錯誤分析:`);
    console.log(`   總錯誤數: ${errorAnalysis.totalErrors}`);
    console.log(`   近1小時錯誤: ${errorAnalysis.recentErrors.length}`);
    
    if (Object.keys(errorAnalysis.errorTypes).length > 0) {
      console.log(`\\n📋 錯誤類型分佈:`);
      Object.entries(errorAnalysis.errorTypes).forEach(([type, data]) => {
        const severity = data.config.severity.toUpperCase();
        console.log(`   ${severity.padEnd(8)} ${data.config.description}: ${data.count} 次`);
      });
    }

    // 服務狀態檢查
    const serviceStatus = await this.checkServiceStatus();
    console.log(`\\n🖥️  當前服務狀態:`);
    console.log(`   Dashboard 進程: ${serviceStatus.dashboard ? '✅ 運行中' : '❌ 未運行'}`);
    console.log(`   資料庫連接: ${serviceStatus.database ? '✅ 正常' : '❌ 異常'}`);
    console.log(`   端口 3000: ${serviceStatus.ports['3000'] ? '✅ 占用中' : '❌ 空閒'}`);

    // 修復建議
    if (errorAnalysis.suggestions.length > 0) {
      console.log(`\\n💡 修復建議:`);
      errorAnalysis.suggestions.forEach((suggestion, index) => {
        const priority = ['🚨', '⚠️', '💭', '📝'][suggestion.priority - 1] || '📝';
        console.log(`\\n${index + 1}. ${priority} ${suggestion.title}`);
        console.log(`   問題: ${suggestion.description}`);
        console.log(`   建議: ${suggestion.action}`);
      });
    } else {
      console.log(`\\n✅ 沒有發現需要修復的問題`);
    }

    // 最近的錯誤詳情
    if (errorAnalysis.recentErrors.length > 0) {
      console.log(`\\n📝 最近的錯誤詳情:`);
      errorAnalysis.recentErrors.slice(0, 5).forEach((error, index) => {
        console.log(`   ${index + 1}. [${error.timestamp?.toLocaleTimeString('zh-TW') || '未知時間'}] ${error.message}`);
      });
    }

    return {
      errorAnalysis,
      serviceStatus,
      recommendations: errorAnalysis.suggestions
    };
  }

  // 執行自動修復
  async autoFix(issueType) {
    console.log(`🔧 嘗試自動修復: ${issueType}`);
    
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    switch (issueType) {
      case 'port_conflict':
        try {
          console.log('   正在清理端口衝突...');
          await execAsync("pkill -f 'dashboard.*server.js'");
          await new Promise(resolve => setTimeout(resolve, 3000));
          await execAsync("cd ~/泡泡貓/dashboard && npm start > server.log 2>&1 &");
          console.log('   ✅ 端口衝突已修復');
          return true;
        } catch (error) {
          console.log(`   ❌ 修復失敗: ${error.message}`);
          return false;
        }

      case 'missing_dependency':
        try {
          console.log('   正在安裝缺失依賴...');
          await execAsync("cd ~/泡泡貓/dashboard && npm install");
          console.log('   ✅ 依賴已安裝');
          return true;
        } catch (error) {
          console.log(`   ❌ 修復失敗: ${error.message}`);
          return false;
        }

      default:
        console.log(`   ⚠️ 暫不支援自動修復此類問題: ${issueType}`);
        return false;
    }
  }
}

// CLI 介面
async function main() {
  const analyzer = new DashboardLogAnalyzer();
  const command = process.argv[2];

  switch (command) {
    case 'analyze':
    case 'report':
      await analyzer.generateReport();
      break;
    
    case 'fix':
      const issueType = process.argv[3];
      if (!issueType) {
        console.log('使用方式: node dashboard_log_analyzer.js fix <issue_type>');
        console.log('可用的修復類型: port_conflict, missing_dependency');
        return;
      }
      await analyzer.autoFix(issueType);
      break;
    
    case 'status':
      const status = await analyzer.checkServiceStatus();
      console.log('📊 服務狀態檢查:');
      Object.entries(status).forEach(([key, value]) => {
        console.log(`   ${key}: ${value ? '✅' : '❌'}`);
      });
      break;
    
    default:
      console.log('🔍 Dashboard 日誌分析器');
      console.log('\\n使用方式:');
      console.log('  node dashboard_log_analyzer.js analyze  - 完整分析報告');
      console.log('  node dashboard_log_analyzer.js status   - 檢查服務狀態');
      console.log('  node dashboard_log_analyzer.js fix <type> - 自動修復問題');
      console.log('\\n範例:');
      console.log('  node dashboard_log_analyzer.js analyze');
      console.log('  node dashboard_log_analyzer.js fix port_conflict');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}