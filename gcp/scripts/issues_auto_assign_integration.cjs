#!/usr/bin/env node
/**
 * 問題集自動分配整合腳本
 * 定期檢查未分配問題，自動分配給負責人
 */

const { optimizedAutoAssign } = require('../lib/issue-auto-assign-optimized.cjs');
const { getPool } = require('../lib/db-pool.cjs');
const fs = require('fs');

const TELEGRAM_GROUP_ID = '-5220564261'; // 泡泡貓辦公室群

// Telegram 發送函數
async function sendTelegramMessage(chatId, text) {
  try {
    const token = fs.readFileSync('/Users/paopaomao/.openclaw/secrets/telegram-bot-token.txt', 'utf8').trim();
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown'
      })
    });
    return await response.json();
  } catch (error) {
    console.error('Telegram 發送失敗:', error.message);
    throw error;
  }
}

async function processUnassignedIssues(options = {}) {
  const { dateFilter = 'today', dryRun = false } = options;
  
  console.log(`🤖 開始處理未分配問題 (範圍: ${dateFilter})...\n`);
  
  try {
    const pool = getPool();
    
    // 根據時間範圍設定查詢條件
    let dateCondition;
    switch (dateFilter) {
      case 'today':
        dateCondition = "DATE(created_at) = CURRENT_DATE";
        break;
      case 'yesterday':
        dateCondition = "DATE(created_at) = CURRENT_DATE - INTERVAL '1 day'";
        break;
      case 'week':
        dateCondition = "created_at > NOW() - INTERVAL '7 days'";
        break;
      case 'all':
        dateCondition = "created_at > NOW() - INTERVAL '30 days'";
        break;
      default:
        dateCondition = "DATE(created_at) = CURRENT_DATE";
    }
    
    // 查找未分配的問題
    const { rows: unassigned } = await pool.query(`
      SELECT 
        issue_number,
        store_name,
        description,
        source,
        created_at
      FROM issues 
      WHERE (assignee IS NULL OR assignee = '')
        AND status != 'resolved'
        AND ${dateCondition}
      ORDER BY issue_number DESC
    `);
    
    if (unassigned.length === 0) {
      console.log('✅ 沒有未分配問題');
      return;
    }
    
    console.log(`📝 找到 ${unassigned.length} 筆未分配問題\n`);
    
    let autoAssignedCount = 0;
    let manualAssignCount = 0;
    const assignmentResults = {};
    
    for (const issue of unassigned) {
      console.log(`📋 處理問題 #${issue.issue_number}:`);
      console.log(`   "${issue.description.substring(0, 60)}..."`);
      console.log(`   門市: ${issue.store_name || 'N/A'}`);
      
      const suggestedAssignee = optimizedAutoAssign(
        issue.description,
        issue.store_name || '',
        issue.source || ''
      );
      
      if (suggestedAssignee) {
        if (!dryRun) {
          // 自動分配
          await pool.query(
            'UPDATE issues SET assignee = $1, updated_at = NOW() WHERE issue_number = $2',
            [suggestedAssignee, issue.issue_number]
          );
          console.log(`   ✅ 已分配給: ${suggestedAssignee}\n`);
        } else {
          console.log(`   ✅ 建議分配給: ${suggestedAssignee} (乾跑模式)\n`);
        }
        
        autoAssignedCount++;
        assignmentResults[suggestedAssignee] = (assignmentResults[suggestedAssignee] || 0) + 1;
      } else {
        manualAssignCount++;
        console.log(`   ⚠️ 需人工分配\n`);
      }
    }
    
    // 統計結果
    console.log('📊 **分配結果統計:**');
    console.log(`- 總計: ${unassigned.length} 筆`);
    console.log(`- 自動分配: ${autoAssignedCount} 筆 (${(autoAssignedCount/unassigned.length*100).toFixed(1)}%)`);
    console.log(`- 需人工分配: ${manualAssignCount} 筆 (${(manualAssignCount/unassigned.length*100).toFixed(1)}%)`);
    
    if (Object.keys(assignmentResults).length > 0) {
      console.log('\n**分配詳情:**');
      Object.entries(assignmentResults)
        .sort(([,a], [,b]) => b - a)
        .forEach(([assignee, count]) => {
          console.log(`- ${assignee}: ${count} 筆`);
        });
    }
    
    // 發送 Telegram 通知 (如果有分配且非乾跑模式)
    if (autoAssignedCount > 0 && !dryRun) {
      const message = `🤖 **問題集自動分配完成** (範圍: ${dateFilter})\n\n` +
        `📝 處理了 ${unassigned.length} 筆未分配問題\n` +
        `✅ 自動分配: ${autoAssignedCount} 筆\n` +
        `⚠️ 需人工分配: ${manualAssignCount} 筆\n\n` +
        `**分配明細:**\n` +
        Object.entries(assignmentResults)
          .map(([assignee, count]) => `• ${assignee}: ${count} 筆`)
          .join('\n') +
        (manualAssignCount > 0 ? `\n\n⚠️ 還有 ${manualAssignCount} 筆需要人工分配` : '');
      
      await sendTelegramMessage(TELEGRAM_GROUP_ID, message);
      console.log('\n📱 已發送 Telegram 通知');
    } else if (dryRun && autoAssignedCount > 0) {
      console.log('\n🔍 乾跑模式 - 跳過 Telegram 通知');
    }
    
    await pool.end();
    
  } catch (error) {
    console.error('❌ 處理失敗:', error.message);
    
    // 發送錯誤通知
    try {
      await sendTelegramMessage(TELEGRAM_GROUP_ID, 
        `❌ **問題集自動分配失敗**\n\n錯誤: ${error.message}`);
    } catch (telegramError) {
      console.error('Telegram 通知失敗:', telegramError.message);
    }
  }
}

// 檢查特定問題的分配建議
async function checkIssueAssignment(issueNumber) {
  try {
    const pool = getPool();
    
    const { rows } = await pool.query(
      'SELECT * FROM issues WHERE issue_number = $1',
      [issueNumber]
    );
    
    if (rows.length === 0) {
      console.log(`❌ 找不到問題 #${issueNumber}`);
      return;
    }
    
    const issue = rows[0];
    console.log(`📋 問題 #${issueNumber} 分析:`);
    console.log(`描述: ${issue.description}`);
    console.log(`門市: ${issue.store_name || 'N/A'}`);
    console.log(`目前分配: ${issue.assignee || '未分配'}`);
    
    const suggested = optimizedAutoAssign(
      issue.description,
      issue.store_name || '',
      issue.source || ''
    );
    
    console.log(`建議分配: ${suggested || '人工處理'}`);
    
    await pool.end();
    
  } catch (error) {
    console.error('❌ 檢查失敗:', error.message);
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args[0] === '--check' && args[1]) {
    // 檢查特定問題
    await checkIssueAssignment(parseInt(args[1]));
  } else {
    // 解析參數
    const options = {
      dryRun: args.includes('--dry-run'),
      dateFilter: 'today' // 預設只處理今天
    };
    
    // 處理時間範圍參數
    if (args.includes('--today')) options.dateFilter = 'today';
    else if (args.includes('--yesterday')) options.dateFilter = 'yesterday';
    else if (args.includes('--week')) options.dateFilter = 'week';
    else if (args.includes('--all')) options.dateFilter = 'all';
    
    if (options.dryRun) {
      console.log('🔍 乾跑模式 - 僅分析不更新\n');
    }
    
    if (options.dateFilter !== 'today') {
      console.log(`⚠️ 注意: 正在處理 "${options.dateFilter}" 範圍的問題\n`);
    }
    
    await processUnassignedIssues(options);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { processUnassignedIssues, checkIssueAssignment };