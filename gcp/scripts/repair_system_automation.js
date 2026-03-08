#!/usr/bin/env node
/**
 * 維修系統自動化流程
 * 整合 Google Forms + AI 診斷 + Odoo 系統
 */

import { spawn } from 'child_process';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

const pool = new Pool({ database: 'paomao', host: 'localhost', port: 5432, max: 5 });

class RepairSystemAutomation {
  constructor() {
    this.config = {
      google_form_id: process.env.REPAIR_FORM_ID || '',
      telegram_chat_id: process.env.REPAIR_TELEGRAM_CHAT_ID || '-5220564261', // 辦公室群組
      telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN || '',
    };
  }

  // 完整的維修流程自動化
  async runCompleteFlow() {
    console.log('🔄 開始執行維修系統自動化流程...');
    
    try {
      // 1. 監控 Google 表單新回應
      if (this.config.google_form_id) {
        console.log('📋 1. 監控 Google 表單新回應...');
        await this.monitorGoogleForms();
      }

      // 2. 處理待診斷的維修單
      console.log('🔍 2. 處理待診斷的維修單...');
      await this.processNewRepairOrders();

      // 3. 檢查付款狀態
      console.log('💰 3. 檢查維修單付款狀態...');
      await this.checkPaymentStatus();

      // 4. 檢查庫存警示
      console.log('📦 4. 檢查庫存水準...');
      await this.checkInventoryAlerts();

      // 5. 發送日報
      console.log('📊 5. 生成維修日報...');
      await this.generateDailyReport();

      console.log('✅ 維修系統自動化流程完成');

    } catch (error) {
      console.error('❌ 自動化流程執行失敗:', error.message);
      await this.sendErrorAlert(error);
    }
  }

  // 監控 Google 表單
  async monitorGoogleForms() {
    if (!this.config.google_form_id) {
      console.log('⚠️ 未設定 Google 表單 ID，跳過表單監控');
      return;
    }

    return new Promise((resolve, reject) => {
      const process = spawn('node', [
        path.join(process.cwd(), 'scripts', 'google_forms_integration.js'),
        'monitor',
        this.config.google_form_id
      ], { cwd: process.cwd() });

      let output = '';
      process.stdout.on('data', (data) => {
        output += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          console.log('✅ Google 表單監控完成');
          if (output.includes('建立維修單')) {
            console.log('📋 發現新的維修單');
          }
          resolve();
        } else {
          reject(new Error('Google 表單監控失敗'));
        }
      });
    });
  }

  // 處理新維修單的 AI 診斷
  async processNewRepairOrders() {
    try {
      // 找到需要診斷的維修單
      const { rows: pendingOrders } = await pool.query(`
        SELECT id, equipment_type, fault_description, store_name, order_number
        FROM repair_orders 
        WHERE status = 'submitted' AND solution_type = 'pending'
        ORDER BY created_at ASC
        LIMIT 10
      `);

      if (pendingOrders.length === 0) {
        console.log('ℹ️ 沒有待診斷的維修單');
        return;
      }

      console.log(`🔍 發現 ${pendingOrders.length} 個待診斷維修單`);

      for (const order of pendingOrders) {
        try {
          // 呼叫 AI 診斷 API
          const diagnosisResult = await this.callAIDiagnosis({
            equipment_type: order.equipment_type,
            fault_description: order.fault_description,
            store_name: order.store_name
          });

          if (diagnosisResult) {
            // 更新維修單診斷結果
            await pool.query(`
              UPDATE repair_orders 
              SET diagnosis_result = $1,
                  solution_type = $2,
                  repair_method = $3,
                  estimated_cost = $4,
                  estimated_days = $5,
                  status = 'diagnosed',
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = $6
            `, [
              diagnosisResult.diagnosis,
              diagnosisResult.solution_type,
              diagnosisResult.solution_steps,
              diagnosisResult.estimated_cost,
              diagnosisResult.estimated_days,
              order.id
            ]);

            // 記錄進度
            await pool.query(`
              INSERT INTO repair_progress (repair_order_id, status, description, technician_name)
              VALUES ($1, $2, $3, $4)
            `, [order.id, 'diagnosed', `AI 自動診斷完成: ${diagnosisResult.diagnosis}`, 'AI System']);

            // 如果是簡單維修，發送維修指引
            if (diagnosisResult.solution_type === 'simple_fix') {
              await this.sendRepairGuidance(order, diagnosisResult);
            } else {
              // 需要送修，通知技師
              await this.notifyTechnician(order, diagnosisResult);
            }

            console.log(`✅ 維修單 ${order.order_number} 診斷完成`);
          }

        } catch (error) {
          console.error(`❌ 診斷維修單 ${order.order_number} 失敗:`, error.message);
        }
      }

    } catch (error) {
      console.error('❌ 處理新維修單失敗:', error.message);
      throw error;
    }
  }

  // 呼叫 AI 診斷 API
  async callAIDiagnosis(orderData) {
    try {
      const response = await fetch('http://localhost:3000/api/repair/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderData)
      });

      if (!response.ok) {
        throw new Error(`診斷 API 回應錯誤: ${response.status}`);
      }

      const result = await response.json();
      if (result.success) {
        return {
          diagnosis: result.data.diagnosis.diagnosis,
          solution_type: result.data.diagnosis.solution_type,
          solution_steps: result.data.diagnosis.solution_steps,
          estimated_cost: result.data.cost_estimate.max_cost,
          estimated_days: Math.ceil((result.data.diagnosis.estimated_time || 60) / 480)
        };
      } else {
        throw new Error(result.error);
      }

    } catch (error) {
      console.error('❌ AI 診斷失敗:', error.message);
      return null;
    }
  }

  // 發送維修指引 (簡單維修)
  async sendRepairGuidance(order, diagnosis) {
    const message = `🛠️ 維修指引 - ${order.order_number}

店家：${order.store_name}
設備：${order.equipment_type}
診斷：${diagnosis.diagnosis}

🔧 維修步驟：
${diagnosis.solution_steps}

預估時間：${diagnosis.estimated_time || 60} 分鐘
建議：可由店家自行處理

如需技術支援，請聯絡維修部門。`;

    await this.sendTelegramMessage(message);
  }

  // 通知技師 (需要送修)
  async notifyTechnician(order, diagnosis) {
    const message = `🏭 新維修單通知 - ${order.order_number}

店家：${order.store_name}
設備：${order.equipment_type}
診斷：${diagnosis.diagnosis}

⚠️ 需要專業維修
預估費用：NT$${Math.round(diagnosis.estimated_cost)}
預估時間：${diagnosis.estimated_days} 天

請聯絡店家安排送修事宜。`;

    await this.sendTelegramMessage(message);
  }

  // 檢查付款狀態
  async checkPaymentStatus() {
    return new Promise((resolve, reject) => {
      const process = spawn('node', [
        path.join(process.cwd(), 'scripts', 'odoo_repair_integration.js'),
        'check-pending'
      ], { cwd: process.cwd() });

      let output = '';
      process.stdout.on('data', (data) => {
        output += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          console.log('✅ 付款狀態檢查完成');
          if (output.includes('付款確認')) {
            console.log('💰 發現新的付款確認');
          }
          resolve();
        } else {
          console.log('⚠️ 付款狀態檢查遇到問題，但繼續執行');
          resolve(); // 不中斷流程
        }
      });
    });
  }

  // 檢查庫存警示
  async checkInventoryAlerts() {
    return new Promise((resolve, reject) => {
      const process = spawn('node', [
        path.join(process.cwd(), 'scripts', 'odoo_repair_integration.js'),
        'check-inventory'
      ], { cwd: process.cwd() });

      let output = '';
      process.stdout.on('data', (data) => {
        output += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          console.log('✅ 庫存檢查完成');
          
          // 解析庫存警示
          const alertMatches = output.match(/庫存警示: (.+)/g);
          if (alertMatches && alertMatches.length > 0) {
            this.sendInventoryAlert(alertMatches);
          }
          
          resolve();
        } else {
          console.log('⚠️ 庫存檢查遇到問題，但繼續執行');
          resolve(); // 不中斷流程
        }
      });
    });
  }

  // 發送庫存警示
  async sendInventoryAlert(alerts) {
    const message = `📦 庫存警示

以下零件庫存不足，請安排進貨：

${alerts.join('\\n')}

請聯絡採購部門處理。`;

    await this.sendTelegramMessage(message);
  }

  // 生成每日報告
  async generateDailyReport() {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      // 統計今日維修單
      const { rows: todayStats } = await pool.query(`
        SELECT 
          COUNT(*) as total_orders,
          COUNT(CASE WHEN status = 'submitted' THEN 1 END) as new_orders,
          COUNT(CASE WHEN status = 'diagnosed' THEN 1 END) as diagnosed_orders,
          COUNT(CASE WHEN status = 'in_repair' THEN 1 END) as in_repair_orders,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_orders,
          AVG(CASE WHEN estimated_cost IS NOT NULL THEN estimated_cost END) as avg_cost
        FROM repair_orders
        WHERE DATE(created_at) = $1
      `, [today]);

      const stats = todayStats[0];

      // 統計本週趨勢
      const { rows: weekStats } = await pool.query(`
        SELECT 
          DATE(created_at) as date,
          COUNT(*) as count
        FROM repair_orders
        WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY DATE(created_at)
        ORDER BY date
      `);

      // 低庫存項目
      const { rows: lowStock } = await pool.query(`
        SELECT part_name, current_stock, safety_stock
        FROM repair_inventory
        WHERE current_stock <= safety_stock AND is_active = TRUE
        LIMIT 5
      `);

      const report = `📊 維修系統日報 - ${today}

📋 今日維修單統計：
• 新增維修單：${stats.new_orders} 筆
• 已診斷：${stats.diagnosed_orders} 筆  
• 維修中：${stats.in_repair_orders} 筆
• 已完成：${stats.completed_orders} 筆
• 平均預估費用：NT$${stats.avg_cost ? Math.round(stats.avg_cost).toLocaleString() : '0'}

📈 本週趨勢：
${weekStats.map(day => `• ${day.date}: ${day.count} 筆`).join('\\n')}

${lowStock.length > 0 ? `📦 庫存警示：
${lowStock.map(item => 
  `• ${item.part_name}: ${item.current_stock}/${item.safety_stock}`
).join('\\n')}` : '✅ 庫存狀況良好'}

系統運行正常 🟢`;

      await this.sendTelegramMessage(report);
      console.log('✅ 日報發送完成');

    } catch (error) {
      console.error('❌ 生成日報失敗:', error.message);
    }
  }

  // 發送 Telegram 訊息
  async sendTelegramMessage(message) {
    if (!this.config.telegram_bot_token || !this.config.telegram_chat_id) {
      console.log('⚠️ 未設定 Telegram 配置，跳過訊息發送');
      console.log('訊息內容:', message);
      return;
    }

    try {
      const response = await fetch(`https://api.telegram.org/bot${this.config.telegram_bot_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.telegram_chat_id,
          text: message,
          parse_mode: 'HTML'
        })
      });

      if (response.ok) {
        console.log('✅ Telegram 訊息發送成功');
      } else {
        console.log('⚠️ Telegram 訊息發送失敗');
      }

    } catch (error) {
      console.error('❌ 發送 Telegram 訊息失敗:', error.message);
    }
  }

  // 發送錯誤警示
  async sendErrorAlert(error) {
    const message = `🚨 維修系統自動化錯誤

錯誤時間：${new Date().toLocaleString('zh-TW')}
錯誤訊息：${error.message}

請檢查系統狀態。`;

    await this.sendTelegramMessage(message);
  }

  // 手動觸發特定維修單的完整流程
  async processSpecificOrder(orderId) {
    try {
      console.log(`🔄 處理維修單 ${orderId} 的完整流程...`);

      // 1. 取得維修單資料
      const { rows } = await pool.query(`
        SELECT * FROM repair_orders WHERE id = $1
      `, [orderId]);

      if (rows.length === 0) {
        throw new Error('找不到維修單');
      }

      const order = rows[0];
      console.log(`📋 處理維修單: ${order.order_number}`);

      // 2. 如果還沒診斷，執行 AI 診斷
      if (order.solution_type === 'pending') {
        console.log('🔍 執行 AI 診斷...');
        const diagnosis = await this.callAIDiagnosis({
          equipment_type: order.equipment_type,
          fault_description: order.fault_description,
          store_name: order.store_name
        });

        if (diagnosis) {
          await pool.query(`
            UPDATE repair_orders 
            SET diagnosis_result = $1, solution_type = $2, repair_method = $3,
                estimated_cost = $4, estimated_days = $5, status = 'diagnosed'
            WHERE id = $6
          `, [
            diagnosis.diagnosis, diagnosis.solution_type, diagnosis.solution_steps,
            diagnosis.estimated_cost, diagnosis.estimated_days, orderId
          ]);

          console.log('✅ 診斷完成');
        }
      }

      // 3. 如果需要送修且還沒建立發票，建立 Odoo 發票
      if (order.solution_type === 'need_repair' && !order.odoo_invoice_id) {
        console.log('💰 建立 Odoo 發票...');
        
        return new Promise((resolve, reject) => {
          const process = spawn('node', [
            path.join(process.cwd(), 'scripts', 'odoo_repair_integration.js'),
            'create-invoice',
            orderId.toString()
          ], { cwd: process.cwd() });

          process.on('close', (code) => {
            if (code === 0) {
              console.log('✅ 發票建立完成');
              resolve();
            } else {
              console.log('⚠️ 發票建立失敗，但繼續流程');
              resolve();
            }
          });
        });
      }

      console.log(`✅ 維修單 ${order.order_number} 流程處理完成`);

    } catch (error) {
      console.error(`❌ 處理維修單 ${orderId} 失敗:`, error.message);
      throw error;
    }
  }
}

// CLI 介面
async function main() {
  const automation = new RepairSystemAutomation();
  const command = process.argv[2];
  const param1 = process.argv[3];

  switch (command) {
    case 'full':
      await automation.runCompleteFlow();
      break;
    
    case 'process-order':
      if (!param1) {
        console.log('使用方式: node repair_system_automation.js process-order <repair_order_id>');
        return;
      }
      await automation.processSpecificOrder(parseInt(param1));
      break;
    
    case 'daily-report':
      await automation.generateDailyReport();
      break;
    
    case 'check-forms':
      await automation.monitorGoogleForms();
      break;
    
    case 'process-new':
      await automation.processNewRepairOrders();
      break;
    
    case 'check-payments':
      await automation.checkPaymentStatus();
      break;
    
    case 'check-inventory':
      await automation.checkInventoryAlerts();
      break;
    
    default:
      console.log('🔧 維修系統自動化');
      console.log('\\n使用方式:');
      console.log('  node repair_system_automation.js full                    - 執行完整自動化流程');
      console.log('  node repair_system_automation.js process-order <id>     - 處理特定維修單');
      console.log('  node repair_system_automation.js daily-report           - 生成每日報告');
      console.log('  node repair_system_automation.js check-forms            - 監控 Google 表單');
      console.log('  node repair_system_automation.js process-new            - 處理新維修單');
      console.log('  node repair_system_automation.js check-payments         - 檢查付款狀態');
      console.log('  node repair_system_automation.js check-inventory        - 檢查庫存警示');
      console.log('\\n範例:');
      console.log('  node repair_system_automation.js full');
      console.log('  node repair_system_automation.js process-order 123');
      console.log('\\n定期執行建議:');
      console.log('  每小時: node repair_system_automation.js process-new');
      console.log('  每4小時: node repair_system_automation.js check-payments');
      console.log('  每天早上: node repair_system_automation.js full');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error).finally(() => pool.end());
}