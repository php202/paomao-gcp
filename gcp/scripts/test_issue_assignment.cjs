#!/usr/bin/env node
/**
 * 測試和優化問題集自動分配
 * 分析現有問題集的分配狀況，測試自動分配效果
 */

const { autoAssignIssue, getAssignmentStats, batchAutoAssign } = require('../lib/issue-auto-assign.cjs');
const { getPool } = require('../lib/db-pool.cjs');

async function analyzeCurrentAssignments() {
  console.log('📊 分析現有問題集分配狀況...\n');
  
  try {
    const pool = getPool();
    
    // 取得最近 100 筆問題
    const { rows: issues } = await pool.query(`
      SELECT 
        issue_number,
        store_name,
        description,
        assignee,
        status,
        source,
        TO_CHAR(created_at, 'YYYY-MM-DD') as created_date
      FROM issues 
      WHERE created_at > NOW() - INTERVAL '30 days'
      ORDER BY issue_number DESC 
      LIMIT 100
    `);
    
    console.log(`📋 最近30天共 ${issues.length} 筆問題\n`);
    
    // 統計現有分配狀況
    const stats = getAssignmentStats(issues);
    console.log('📊 **目前分配統計:**');
    console.log(`- 總計: ${stats.total} 筆`);
    console.log(`- 已分配: ${stats.assigned} 筆 (${(stats.assigned/stats.total*100).toFixed(1)}%)`);
    console.log(`- 未分配: ${stats.unassigned} 筆 (${(stats.unassigned/stats.total*100).toFixed(1)}%)`);
    console.log('\n**各負責人分配數:**');
    Object.entries(stats.byAssignee)
      .sort(([,a], [,b]) => b - a)
      .forEach(([assignee, count]) => {
        console.log(`- ${assignee}: ${count} 筆`);
      });
    
    console.log('\n' + '='.repeat(60));
    console.log('🤖 **測試自動分配效果**\n');
    
    // 測試未分配的問題
    const unassigned = issues.filter(i => !i.assignee || !i.assignee.trim());
    console.log(`🔍 測試 ${unassigned.length} 筆未分配問題:\n`);
    
    let autoAssignedCount = 0;
    const assignmentResults = {};
    
    unassigned.forEach(issue => {
      const suggested = autoAssignIssue(
        issue.description, 
        issue.store_name,
        issue.source || ''
      );
      
      if (suggested) {
        autoAssignedCount++;
        assignmentResults[suggested] = (assignmentResults[suggested] || 0) + 1;
        console.log(`✅ #${issue.issue_number} → ${suggested}`);
        console.log(`   "${issue.description.substring(0, 50)}..."`);
        console.log(`   門市: ${issue.store_name || 'N/A'}\n`);
      } else {
        console.log(`⚠️  #${issue.issue_number} → 需人工分配`);
        console.log(`   "${issue.description.substring(0, 50)}..."`);
        console.log(`   門市: ${issue.store_name || 'N/A'}\n`);
      }
    });
    
    console.log('📊 **自動分配結果統計:**');
    console.log(`- 可自動分配: ${autoAssignedCount}/${unassigned.length} (${(autoAssignedCount/unassigned.length*100).toFixed(1)}%)`);
    console.log(`- 需人工分配: ${unassigned.length - autoAssignedCount} 筆\n`);
    
    if (Object.keys(assignmentResults).length > 0) {
      console.log('**建議分配給:**');
      Object.entries(assignmentResults)
        .sort(([,a], [,b]) => b - a)
        .forEach(([assignee, count]) => {
          console.log(`- ${assignee}: +${count} 筆`);
        });
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('💡 **分配規則優化建議**\n');
    
    // 分析已分配問題，找出可能的規則優化
    const assigned = issues.filter(i => i.assignee && i.assignee.trim());
    const mismatches = [];
    
    assigned.forEach(issue => {
      const suggested = autoAssignIssue(
        issue.description, 
        issue.store_name,
        issue.source || ''
      );
      
      if (suggested && suggested !== issue.assignee) {
        mismatches.push({
          issue_number: issue.issue_number,
          description: issue.description,
          actual: issue.assignee,
          suggested: suggested
        });
      }
    });
    
    if (mismatches.length > 0) {
      console.log(`🔍 發現 ${mismatches.length} 筆分配不一致的案例:\n`);
      mismatches.slice(0, 5).forEach(m => {
        console.log(`#${m.issue_number}: "${m.description.substring(0, 40)}..."`);
        console.log(`   實際: ${m.actual} | 建議: ${m.suggested}\n`);
      });
      
      if (mismatches.length > 5) {
        console.log(`   ...還有 ${mismatches.length - 5} 筆\n`);
      }
    } else {
      console.log('✅ 自動分配規則與現有分配基本一致\n');
    }
    
    await pool.end();
    
  } catch (error) {
    console.error('❌ 分析失敗:', error.message);
  }
}

// 測試特定關鍵字
async function testKeywords() {
  console.log('🧪 **測試關鍵字分配**\n');
  
  const testCases = [
    { desc: '客人要求刪單，訂單編號12345', expected: '小羅' },
    { desc: '儀器故障無法啟動', expected: 'Yen' },
    { desc: 'IG貼文需要修改文案', expected: '圓圓' },
    { desc: '員工詢問SOP流程', expected: '慈慈' },
    { desc: '預約系統當機', expected: 'Miya' },
    { desc: '新員工排班問題', expected: 'Rick' },
    { desc: '庫存盤點異常', expected: '家盈' },
    { desc: '緊急!系統崩潰', expected: null }, // 高難度
    { desc: '一般門市清潔問題', expected: null }, // 無明確分類
  ];
  
  testCases.forEach(({ desc, expected }) => {
    const result = autoAssignIssue(desc);
    const status = result === expected ? '✅' : '❌';
    console.log(`${status} "${desc}"`);
    console.log(`   期望: ${expected || '人工分配'} | 實際: ${result || '人工分配'}\n`);
  });
}

async function main() {
  console.log('🎯 問題集自動分配分析工具\n');
  
  // 解析命令行參數
  const args = process.argv.slice(2);
  
  if (args.includes('--keywords')) {
    await testKeywords();
  } else {
    await analyzeCurrentAssignments();
  }
  
  if (args.includes('--test-keywords')) {
    console.log('\n' + '='.repeat(60));
    await testKeywords();
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { analyzeCurrentAssignments, testKeywords };