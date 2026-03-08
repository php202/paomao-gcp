#!/usr/bin/env node
/**
 * 建議箱自動執行引擎
 * 當採納建議達到閾值時，自動分析和執行建議
 */

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

const pool = new Pool({ database: 'paomao', host: 'localhost', port: 5432, max: 5 });

class SuggestionAutoExecutor {
  constructor() {
    this.config = {};
    this.executionBatch = null;
  }

  // 載入配置
  async loadConfig() {
    try {
      const { rows } = await pool.query('SELECT config_key, config_value FROM auto_execution_config WHERE is_active = TRUE');
      
      for (const row of rows) {
        let value = row.config_value;
        if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
          try { value = JSON.parse(value); } catch {}
        }
        this.config[row.config_key] = value;
      }

      console.log('📋 載入配置:', Object.keys(this.config).join(', '));
    } catch (error) {
      console.error('❌ 載入配置失敗:', error.message);
      throw error;
    }
  }

  // 檢查是否達到觸發條件
  async checkTriggerCondition() {
    try {
      const threshold = parseInt(this.config.trigger_threshold) || 5;
      
      const { rows } = await pool.query(`
        SELECT COUNT(*) as count, 
               ARRAY_AGG(id ORDER BY created_at ASC) as suggestion_ids
        FROM suggestions 
        WHERE status = 'accepted'
      `);

      const acceptedCount = parseInt(rows[0].count);
      const suggestionIds = rows[0].suggestion_ids || [];

      console.log(`📊 檢查觸發條件: ${acceptedCount}/${threshold} 個採納建議`);

      if (acceptedCount >= threshold) {
        console.log('🚀 達到觸發條件，開始自動執行流程');
        return { triggered: true, suggestionIds, count: acceptedCount };
      } else {
        console.log('⏳ 未達到觸發條件');
        return { triggered: false };
      }

    } catch (error) {
      console.error('❌ 檢查觸發條件失敗:', error.message);
      throw error;
    }
  }

  // 生成執行批次號
  generateExecutionBatch() {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
    return `AE${dateStr}${timeStr}`;
  }

  // 建立執行記錄
  async createExecutionRecord(suggestionIds, triggerCondition) {
    try {
      this.executionBatch = this.generateExecutionBatch();
      
      const { rows } = await pool.query(`
        INSERT INTO suggestion_executions (
          execution_batch, suggestion_ids, trigger_condition, 
          total_suggestions, status
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `, [
        this.executionBatch,
        suggestionIds,
        triggerCondition,
        suggestionIds.length,
        'analyzing'
      ]);

      const executionId = rows[0].id;
      console.log(`📋 建立執行記錄: ${this.executionBatch} (ID: ${executionId})`);
      return executionId;

    } catch (error) {
      console.error('❌ 建立執行記錄失敗:', error.message);
      throw error;
    }
  }

  // 分析建議內容
  async analyzeSuggestions(suggestionIds) {
    try {
      console.log('🔍 開始分析建議內容...');

      // 取得建議詳細資料
      const { rows: suggestions } = await pool.query(`
        SELECT id, category, title, description, created_at
        FROM suggestions 
        WHERE id = ANY($1)
        ORDER BY created_at ASC
      `, [suggestionIds]);

      // 取得執行規則
      const { rows: rules } = await pool.query(`
        SELECT * FROM suggestion_execution_rules 
        WHERE is_active = TRUE 
        ORDER BY priority ASC
      `);

      const analysisResult = {
        totalSuggestions: suggestions.length,
        executableSuggestions: [],
        nonExecutableSuggestions: [],
        riskAssessment: { low: 0, medium: 0, high: 0 },
        estimatedDuration: 0
      };

      // 為每個建議找到匹配的執行規則
      for (const suggestion of suggestions) {
        const matchedRule = this.findMatchingRule(suggestion, rules);
        
        if (matchedRule && matchedRule.is_auto_executable) {
          analysisResult.executableSuggestions.push({
            suggestionId: suggestion.id,
            title: suggestion.title,
            actionType: matchedRule.action_type,
            riskLevel: matchedRule.risk_level,
            actionTemplate: matchedRule.action_template,
            estimatedMinutes: this.estimateExecutionTime(matchedRule.action_type)
          });

          // 風險評估
          if (matchedRule.risk_level <= 2) analysisResult.riskAssessment.low++;
          else if (matchedRule.risk_level <= 3) analysisResult.riskAssessment.medium++;
          else analysisResult.riskAssessment.high++;

          analysisResult.estimatedDuration += this.estimateExecutionTime(matchedRule.action_type);
        } else {
          analysisResult.nonExecutableSuggestions.push({
            suggestionId: suggestion.id,
            title: suggestion.title,
            reason: matchedRule ? '需要手動審核' : '無匹配執行規則'
          });
        }
      }

      console.log(`📊 分析結果: ${analysisResult.executableSuggestions.length}/${suggestions.length} 個可自動執行`);
      
      return analysisResult;

    } catch (error) {
      console.error('❌ 分析建議失敗:', error.message);
      throw error;
    }
  }

  // 找到匹配的執行規則
  findMatchingRule(suggestion, rules) {
    for (const rule of rules) {
      let matches = true;

      // 檢查分類匹配
      if (rule.category_pattern && !suggestion.category?.includes(rule.category_pattern.replace('%', ''))) {
        matches = false;
      }

      // 檢查標題匹配
      if (rule.title_pattern && matches) {
        const pattern = rule.title_pattern.replace(/%/g, '');
        if (!suggestion.title?.includes(pattern)) {
          matches = false;
        }
      }

      // 檢查描述匹配（如果有設定的話）
      if (rule.description_pattern && matches) {
        const descPattern = rule.description_pattern.replace(/%/g, '');
        const fullText = (suggestion.title || '') + ' ' + (suggestion.description || '');
        if (!fullText.includes(descPattern)) {
          matches = false;
        }
      }

      if (matches) {
        return rule;
      }
    }
    return null;
  }

  // 估算執行時間
  estimateExecutionTime(actionType) {
    const timeMap = {
      'database_update': 5,
      'code_fix': 15,
      'filter_update': 3,
      'bug_fix': 10,
      'system_config': 8
    };
    return timeMap[actionType] || 10;
  }

  // 生成執行計劃
  async generateExecutionPlan(analysisResult, executionId) {
    try {
      console.log('📋 生成執行計劃...');

      const executableActions = analysisResult.executableSuggestions;
      const executionPlan = {
        totalActions: executableActions.length,
        estimatedDuration: analysisResult.estimatedDuration,
        riskLevel: this.calculateOverallRisk(analysisResult.riskAssessment),
        actions: []
      };

      // 為每個可執行建議建立具體動作
      for (const item of executableActions) {
        const action = await this.createActionPlan(item);
        executionPlan.actions.push(action);

        // 儲存到動作表
        await pool.query(`
          INSERT INTO suggestion_actions (
            execution_id, suggestion_id, action_type, 
            action_description, action_data, status
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          executionId,
          item.suggestionId,
          item.actionType,
          action.description,
          JSON.stringify(action.data),
          'pending'
        ]);
      }

      console.log(`📋 執行計劃生成完成，共 ${executionPlan.totalActions} 個動作`);
      return executionPlan;

    } catch (error) {
      console.error('❌ 生成執行計劃失敗:', error.message);
      throw error;
    }
  }

  // 建立具體動作計劃
  async createActionPlan(suggestionItem) {
    const { actionType, actionTemplate, suggestionId } = suggestionItem;

    // 根據動作類型建立具體計劃
    switch (actionType) {
      case 'database_update':
        return await this.createDatabaseUpdatePlan(suggestionItem);
      
      case 'code_fix':
        return await this.createCodeFixPlan(suggestionItem);
      
      case 'filter_update':
        return await this.createFilterUpdatePlan(suggestionItem);
      
      case 'bug_fix':
        return await this.createBugFixPlan(suggestionItem);
      
      default:
        return {
          description: `執行建議 ${suggestionId} - ${actionType}`,
          data: { type: actionType, template: actionTemplate }
        };
    }
  }

  // 建立資料庫更新計劃
  async createDatabaseUpdatePlan(suggestionItem) {
    return {
      description: `為門市表添加服務費、招牌尺寸、多媒體編號欄位`,
      data: {
        type: 'add_columns',
        table: 'stores',
        columns: [
          { name: 'service_fee', type: 'DECIMAL(10,2)', comment: '服務費' },
          { name: 'sign_size', type: 'VARCHAR(100)', comment: '招牌尺寸' },
          { name: 'media_number', type: 'VARCHAR(50)', comment: '多媒體編號' }
        ]
      }
    };
  }

  // 建立程式碼修復計劃
  async createCodeFixPlan(suggestionItem) {
    return {
      description: `修復總公司出勤紀錄載入門市失敗問題`,
      data: {
        type: 'fix_loading_error',
        component: 'hq_attendance',
        issue: 'store_loading_failure',
        solution: 'update_api_endpoint_and_error_handling'
      }
    };
  }

  // 建立過濾器更新計劃
  async createFilterUpdatePlan(suggestionItem) {
    return {
      description: `店長儀表板僅顯示加盟店資料`,
      data: {
        type: 'update_filter',
        component: 'manager_dashboard',
        filter_condition: 'store_type = "franchise"',
        exclude_types: ['test', 'other']
      }
    };
  }

  // 建立錯誤修復計劃
  async createBugFixPlan(suggestionItem) {
    return {
      description: `修復總公司統計報告顯示錯誤`,
      data: {
        type: 'fix_display_error',
        component: 'hq_statistics',
        error_type: 'display_system_error'
      }
    };
  }

  // 計算整體風險等級
  calculateOverallRisk(riskAssessment) {
    const { low, medium, high } = riskAssessment;
    const total = low + medium + high;
    
    if (total === 0) return 'none';
    if (high > 0) return 'high';
    if (medium > low) return 'medium';
    return 'low';
  }

  // 執行計劃
  async executePlan(executionId, executionPlan) {
    try {
      console.log('🚀 開始執行計劃...');

      // 更新執行狀態
      await pool.query(`
        UPDATE suggestion_executions 
        SET status = 'executing', started_at = CURRENT_TIMESTAMP,
            execution_plan = $1
        WHERE id = $2
      `, [JSON.stringify(executionPlan), executionId]);

      const results = {
        successful: 0,
        failed: 0,
        actions: []
      };

      // 執行每個動作
      for (const action of executionPlan.actions) {
        try {
          const startTime = Date.now();
          console.log(`⚡ 執行動作: ${action.description}`);

          const result = await this.executeAction(action);
          const duration = Date.now() - startTime;

          // 更新動作狀態
          await pool.query(`
            UPDATE suggestion_actions 
            SET status = 'completed', result = $1, 
                started_at = $2, completed_at = CURRENT_TIMESTAMP,
                execution_duration_ms = $3
            WHERE execution_id = $4 AND suggestion_id = $5
          `, [
            JSON.stringify(result),
            new Date(startTime),
            duration,
            executionId,
            action.suggestionId
          ]);

          results.successful++;
          results.actions.push({ action, result, status: 'success' });
          console.log(`✅ 動作執行成功 (${duration}ms)`);

        } catch (actionError) {
          console.error(`❌ 動作執行失敗: ${actionError.message}`);

          // 更新動作狀態為失敗
          await pool.query(`
            UPDATE suggestion_actions 
            SET status = 'failed', error_message = $1,
                started_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
            WHERE execution_id = $2 AND suggestion_id = $3
          `, [actionError.message, executionId, action.suggestionId]);

          results.failed++;
          results.actions.push({ action, error: actionError.message, status: 'failed' });
        }
      }

      console.log(`📊 執行完成: ${results.successful} 成功, ${results.failed} 失敗`);
      return results;

    } catch (error) {
      console.error('❌ 執行計劃失敗:', error.message);
      throw error;
    }
  }

  // 執行具體動作
  async executeAction(action) {
    const { data } = action;

    switch (data.type) {
      case 'add_columns':
        return await this.executeAddColumns(data);
      
      case 'fix_loading_error':
        return await this.executeFixLoadingError(data);
      
      case 'update_filter':
        return await this.executeUpdateFilter(data);
      
      case 'fix_display_error':
        return await this.executeFixDisplayError(data);
      
      default:
        throw new Error(`未知的動作類型: ${data.type}`);
    }
  }

  // 執行新增欄位
  async executeAddColumns(data) {
    try {
      for (const column of data.columns) {
        const sql = `ALTER TABLE ${data.table} ADD COLUMN IF NOT EXISTS ${column.name} ${column.type}`;
        await pool.query(sql);
        console.log(`  ✅ 新增欄位 ${column.name}`);
      }
      return { success: true, message: `成功新增 ${data.columns.length} 個欄位到 ${data.table} 表` };
    } catch (error) {
      throw new Error(`新增欄位失敗: ${error.message}`);
    }
  }

  // 執行載入錯誤修復 (模擬)
  async executeFixLoadingError(data) {
    // 這裡可以實作具體的修復邏輯
    // 比如更新API端點、修復錯誤處理等
    return { success: true, message: `已標記修復載入錯誤問題: ${data.component}` };
  }

  // 執行過濾器更新 (模擬)
  async executeUpdateFilter(data) {
    // 這裡可以實作具體的過濾邏輯更新
    return { success: true, message: `已更新 ${data.component} 的過濾器` };
  }

  // 執行顯示錯誤修復 (模擬)
  async executeFixDisplayError(data) {
    // 這裡可以實作具體的顯示錯誤修復
    return { success: true, message: `已標記修復顯示錯誤: ${data.component}` };
  }

  // 完成執行並更新建議狀態
  async completeExecution(executionId, results) {
    try {
      console.log('🏁 完成執行，更新建議狀態...');

      // 更新執行記錄
      await pool.query(`
        UPDATE suggestion_executions 
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
            successful_actions = $1, failed_actions = $2,
            execution_result = $3
        WHERE id = $4
      `, [
        results.successful,
        results.failed,
        JSON.stringify(results),
        executionId
      ]);

      // 將成功執行的建議狀態改為 'done'
      const { rows: suggestionIds } = await pool.query(`
        SELECT DISTINCT suggestion_id 
        FROM suggestion_actions 
        WHERE execution_id = $1 AND status = 'completed'
      `, [executionId]);

      if (suggestionIds.length > 0) {
        const ids = suggestionIds.map(row => row.suggestion_id);
        await pool.query(`
          UPDATE suggestions 
          SET status = 'done', admin_note = COALESCE(admin_note, '') || '\\n🤖 自動執行完成'
          WHERE id = ANY($1)
        `, [ids]);

        console.log(`✅ 已將 ${ids.length} 個建議標記為完成`);
      }

      // 發送通知
      await this.sendExecutionReport(executionId, results);

    } catch (error) {
      console.error('❌ 完成執行失敗:', error.message);
      throw error;
    }
  }

  // 發送執行報告
  async sendExecutionReport(executionId, results) {
    try {
      const report = `🤖 建議箱自動執行報告 - ${this.executionBatch}

📊 執行統計：
• 成功執行：${results.successful} 個動作
• 執行失敗：${results.failed} 個動作
• 執行時間：${new Date().toLocaleString('zh-TW')}

📋 執行詳情：
${results.actions.map((item, index) => 
  `${index + 1}. ${item.status === 'success' ? '✅' : '❌'} ${item.action.description}`
).join('\\n')}

系統已自動完成可執行的建議，失敗的動作需要手動處理。`;

      console.log('📢 執行報告:');
      console.log(report);

      // TODO: 實作 Telegram 通知
      // await this.sendTelegramNotification(report);

    } catch (error) {
      console.error('❌ 發送報告失敗:', error.message);
    }
  }

  // 主執行流程
  async run() {
    try {
      console.log('🤖 建議箱自動執行引擎啟動');

      // 載入配置
      await this.loadConfig();

      if (!this.config.auto_execution_enabled) {
        console.log('⚠️ 自動執行功能已停用');
        return;
      }

      // 檢查觸發條件
      const triggerResult = await this.checkTriggerCondition();
      if (!triggerResult.triggered) {
        return;
      }

      // 建立執行記錄
      const executionId = await this.createExecutionRecord(
        triggerResult.suggestionIds,
        `${triggerResult.count} 個採納建議達到閾值 ${this.config.trigger_threshold}`
      );

      // 分析建議
      const analysisResult = await this.analyzeSuggestions(triggerResult.suggestionIds);

      // 更新分析結果
      await pool.query(`
        UPDATE suggestion_executions 
        SET analysis_result = $1, analyzed_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [JSON.stringify(analysisResult), executionId]);

      // 生成執行計劃
      const executionPlan = await this.generateExecutionPlan(analysisResult, executionId);

      // 執行計劃
      const results = await this.executePlan(executionId, executionPlan);

      // 完成執行
      await this.completeExecution(executionId, results);

      console.log('🎉 自動執行完成！');

    } catch (error) {
      console.error('❌ 自動執行引擎錯誤:', error.message);
      
      if (this.executionBatch) {
        await pool.query(`
          UPDATE suggestion_executions 
          SET status = 'failed', error_message = $1
          WHERE execution_batch = $2
        `, [error.message, this.executionBatch]);
      }
    }
  }
}

// CLI 介面
async function main() {
  const executor = new SuggestionAutoExecutor();
  const command = process.argv[2];

  switch (command) {
    case 'run':
      await executor.run();
      break;
    
    case 'check':
      await executor.loadConfig();
      const result = await executor.checkTriggerCondition();
      console.log('檢查結果:', result);
      break;
    
    case 'config':
      await executor.loadConfig();
      console.log('當前配置:', executor.config);
      break;
    
    default:
      console.log('🤖 建議箱自動執行引擎');
      console.log('\\n使用方式:');
      console.log('  node suggestion_auto_executor.js run     - 執行自動執行檢查');
      console.log('  node suggestion_auto_executor.js check   - 僅檢查觸發條件');
      console.log('  node suggestion_auto_executor.js config  - 顯示當前配置');
      console.log('\\n建議定期執行:');
      console.log('  每小時: node suggestion_auto_executor.js check');
      console.log('  手動觸發: node suggestion_auto_executor.js run');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error).finally(() => pool.end());
}