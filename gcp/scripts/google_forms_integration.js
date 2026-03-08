#!/usr/bin/env node
/**
 * Google Forms 維修系統整合
 * 功能：
 * 1. 接收 Google 表單報修資料
 * 2. 自動建立維修單
 * 3. 同步表單回應到資料庫
 */

import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { Pool } from 'pg';

const pool = new Pool({ database: 'paomao', host: 'localhost', port: 5432, max: 5 });

class GoogleFormsIntegration {
  constructor() {
    this.auth = null;
    this.forms = null;
    this.sheets = null;
    this.serviceAccountPath = path.join(process.env.HOME, '.openclaw', 'secrets', 'gcp-service-account.json');
  }

  // 初始化 Google API 認證
  async initAuth() {
    try {
      if (!fs.existsSync(this.serviceAccountPath)) {
        throw new Error('找不到 Google 服務帳號金鑰文件');
      }

      const credentials = JSON.parse(fs.readFileSync(this.serviceAccountPath, 'utf8'));
      
      this.auth = new google.auth.GoogleAuth({
        credentials,
        scopes: [
          'https://www.googleapis.com/auth/forms.responses.readonly',
          'https://www.googleapis.com/auth/spreadsheets.readonly',
          'https://www.googleapis.com/auth/drive.readonly'
        ]
      });

      const authClient = await this.auth.getClient();
      this.forms = google.forms({ version: 'v1', auth: authClient });
      this.sheets = google.sheets({ version: 'v4', auth: authClient });
      
      console.log('✅ Google API 認證成功');
    } catch (error) {
      console.error('❌ Google API 認證失敗:', error.message);
      throw error;
    }
  }

  // 建立報修表單
  async createRepairForm() {
    try {
      await this.initAuth();

      const form = {
        info: {
          title: '泡泡貓設備報修表單',
          description: '請詳細填寫設備故障資訊，我們將儘快為您處理。'
        }
      };

      const response = await this.forms.forms.create({
        requestBody: form
      });

      const formId = response.data.formId;
      console.log('✅ 報修表單建立成功');
      console.log('📋 表單 ID:', formId);
      console.log('🔗 表單連結:', `https://docs.google.com/forms/d/${formId}/edit`);

      // 建立問題
      await this.addFormQuestions(formId);

      return formId;
    } catch (error) {
      console.error('❌ 建立表單失敗:', error.message);
      throw error;
    }
  }

  // 添加表單問題
  async addFormQuestions(formId) {
    const requests = [
      {
        createItem: {
          item: {
            title: '店家名稱',
            questionItem: {
              question: {
                required: true,
                choiceQuestion: {
                  type: 'DROP_DOWN',
                  options: [
                    { value: '台北忠孝店' },
                    { value: '新北板橋店' },
                    { value: '桃園中壢店' },
                    { value: '新竹公道店' },
                    { value: '台中西屯店' },
                    { value: '高雄左營店' },
                    { value: '其他' }
                  ]
                }
              }
            }
          },
          location: { index: 0 }
        }
      },
      {
        createItem: {
          item: {
            title: '聯絡人姓名',
            questionItem: {
              question: {
                required: true,
                textQuestion: {
                  paragraph: false
                }
              }
            }
          },
          location: { index: 1 }
        }
      },
      {
        createItem: {
          item: {
            title: '聯絡電話',
            questionItem: {
              question: {
                required: true,
                textQuestion: {
                  paragraph: false
                }
              }
            }
          },
          location: { index: 2 }
        }
      },
      {
        createItem: {
          item: {
            title: '設備類型',
            questionItem: {
              question: {
                required: true,
                choiceQuestion: {
                  type: 'RADIO',
                  options: [
                    { value: '韓式科技洗臉機' },
                    { value: '超音波導入儀' },
                    { value: 'LED光療機' },
                    { value: '高週波儀' },
                    { value: '離子導入儀' },
                    { value: '其他設備' }
                  ]
                }
              }
            }
          },
          location: { index: 3 }
        }
      },
      {
        createItem: {
          item: {
            title: '設備型號 (如果知道)',
            questionItem: {
              question: {
                required: false,
                textQuestion: {
                  paragraph: false
                }
              }
            }
          },
          location: { index: 4 }
        }
      },
      {
        createItem: {
          item: {
            title: '設備序號 (機身標籤)',
            questionItem: {
              question: {
                required: false,
                textQuestion: {
                  paragraph: false
                }
              }
            }
          },
          location: { index: 5 }
        }
      },
      {
        createItem: {
          item: {
            title: '故障描述',
            description: '請詳細描述故障情況，例如：無法開機、異常噪音、顯示異常等',
            questionItem: {
              question: {
                required: true,
                textQuestion: {
                  paragraph: true
                }
              }
            }
          },
          location: { index: 6 }
        }
      },
      {
        createItem: {
          item: {
            title: '故障發生時間',
            questionItem: {
              question: {
                required: true,
                dateQuestion: {
                  includeTime: true
                }
              }
            }
          },
          location: { index: 7 }
        }
      },
      {
        createItem: {
          item: {
            title: '緊急程度',
            questionItem: {
              question: {
                required: true,
                choiceQuestion: {
                  type: 'RADIO',
                  options: [
                    { value: '非常緊急 - 影響營業' },
                    { value: '緊急 - 主要設備故障' },
                    { value: '一般 - 輔助設備問題' },
                    { value: '不緊急 - 可延後處理' }
                  ]
                }
              }
            }
          },
          location: { index: 8 }
        }
      },
      {
        createItem: {
          item: {
            title: '是否需要緊急到場維修',
            questionItem: {
              question: {
                required: true,
                choiceQuestion: {
                  type: 'RADIO',
                  options: [
                    { value: '是，請立即派技師到場' },
                    { value: '否，可安排時間維修' },
                    { value: '不確定，請聯絡評估' }
                  ]
                }
              }
            }
          },
          location: { index: 9 }
        }
      }
    ];

    const batchUpdateRequest = {
      requests: requests
    };

    await this.forms.forms.batchUpdate({
      formId: formId,
      requestBody: batchUpdateRequest
    });

    console.log('✅ 表單問題建立完成');
  }

  // 取得表單回應
  async getFormResponses(formId, limit = 50) {
    try {
      await this.initAuth();

      const response = await this.forms.forms.responses.list({
        formId: formId,
        pageSize: limit
      });

      const responses = response.data.responses || [];
      console.log(`📋 取得 ${responses.length} 筆表單回應`);

      return responses;
    } catch (error) {
      console.error('❌ 取得表單回應失敗:', error.message);
      throw error;
    }
  }

  // 處理表單回應並建立維修單
  async processFormResponse(formId, responseId) {
    try {
      const response = await this.forms.forms.responses.get({
        formId: formId,
        responseId: responseId
      });

      const answers = response.data.answers || {};
      const repairData = this.parseFormAnswers(answers);

      // 檢查是否已處理過
      const { rows: existing } = await pool.query(
        'SELECT id FROM repair_form_submissions WHERE form_response_id = $1',
        [responseId]
      );

      if (existing.length > 0) {
        console.log(`⚠️ 回應 ${responseId} 已處理過，跳過`);
        return null;
      }

      // 建立維修單
      const repairOrder = await this.createRepairOrderFromForm(repairData);

      // 記錄表單提交
      await pool.query(`
        INSERT INTO repair_form_submissions (form_response_id, repair_order_id, raw_data, processed)
        VALUES ($1, $2, $3, $4)
      `, [responseId, repairOrder.id, JSON.stringify(response.data), true]);

      console.log(`✅ 成功處理表單回應，建立維修單: ${repairOrder.order_number}`);
      return repairOrder;

    } catch (error) {
      console.error('❌ 處理表單回應失敗:', error.message);
      throw error;
    }
  }

  // 解析表單答案
  parseFormAnswers(answers) {
    const data = {
      store_name: '',
      contact_name: '',
      contact_phone: '',
      equipment_type: '',
      equipment_model: '',
      equipment_serial: '',
      fault_description: '',
      fault_time: null,
      urgency: '',
      need_emergency: ''
    };

    // 這裡需要根據實際的問題 ID 來對應
    // Google Forms API 會為每個問題生成唯一的 ID
    Object.entries(answers).forEach(([questionId, answer]) => {
      const value = answer.textAnswers?.answers?.[0]?.value || '';
      
      // 根據問題內容推測對應欄位 (簡化版本)
      if (value.includes('店') || ['台北', '新北', '桃園', '新竹', '台中', '高雄'].some(city => value.includes(city))) {
        data.store_name = value;
      } else if (value.includes('機') || value.includes('儀')) {
        data.equipment_type = value;
      } else if (value.length > 10 && (value.includes('無法') || value.includes('故障') || value.includes('異常'))) {
        data.fault_description = value;
      }
      // 更多欄位對應邏輯...
    });

    return data;
  }

  // 從表單資料建立維修單
  async createRepairOrderFromForm(formData) {
    // 生成維修單號碼
    const orderNumber = await this.generateOrderNumber();

    // 根據緊急程度設定優先級
    let priority = 3;
    if (formData.urgency.includes('非常緊急')) priority = 1;
    else if (formData.urgency.includes('緊急')) priority = 2;
    else if (formData.urgency.includes('不緊急')) priority = 4;

    const insertQuery = `
      INSERT INTO repair_orders (
        order_number, store_name, equipment_type, equipment_model,
        equipment_serial, fault_description, priority, status,
        internal_notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;

    const values = [
      orderNumber,
      formData.store_name,
      formData.equipment_type,
      formData.equipment_model,
      formData.equipment_serial,
      formData.fault_description,
      priority,
      'submitted',
      `聯絡人: ${formData.contact_name}, 電話: ${formData.contact_phone}`
    ];

    const result = await pool.query(insertQuery, values);
    const repairOrder = result.rows[0];

    // 記錄初始進度
    await pool.query(`
      INSERT INTO repair_progress (repair_order_id, status, description, technician_name)
      VALUES ($1, $2, $3, $4)
    `, [repairOrder.id, 'submitted', '從 Google 表單自動建立維修單', 'System']);

    return repairOrder;
  }

  // 生成維修單號碼
  async generateOrderNumber() {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    
    const result = await pool.query(`
      SELECT COUNT(*) FROM repair_orders 
      WHERE order_number LIKE $1
    `, [`RO${dateStr}%`]);
    
    const sequence = String(parseInt(result.rows[0].count) + 1).padStart(4, '0');
    return `RO${dateStr}${sequence}`;
  }

  // 監控新回應 (定期執行)
  async monitorNewResponses(formId) {
    try {
      console.log('🔄 開始監控新的表單回應...');
      
      // 取得最近的回應
      const responses = await this.getFormResponses(formId, 10);
      
      for (const response of responses) {
        try {
          await this.processFormResponse(formId, response.responseId);
        } catch (error) {
          console.error(`處理回應 ${response.responseId} 失敗:`, error.message);
        }
      }
      
      console.log('✅ 表單監控完成');
    } catch (error) {
      console.error('❌ 監控表單回應失敗:', error.message);
    }
  }

  // 同步表單到試算表 (備份用)
  async syncToSpreadsheet(formId, spreadsheetId) {
    try {
      const responses = await this.getFormResponses(formId);
      
      // 準備資料
      const rows = responses.map(response => {
        const answers = response.answers || {};
        return [
          new Date(response.createTime).toLocaleString('zh-TW'),
          response.responseId,
          // 根據實際問題順序填入答案
          ...Object.values(answers).map(answer => 
            answer.textAnswers?.answers?.[0]?.value || ''
          )
        ];
      });

      // 寫入試算表
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId,
        range: 'A2:Z1000', // 根據實際欄位調整
        valueInputOption: 'USER_ENTERED',
        resource: { values: rows }
      });

      console.log(`✅ 同步 ${rows.length} 筆資料到試算表`);
    } catch (error) {
      console.error('❌ 同步試算表失敗:', error.message);
    }
  }
}

// CLI 介面
async function main() {
  const integration = new GoogleFormsIntegration();
  const command = process.argv[2];
  const param1 = process.argv[3];
  const param2 = process.argv[4];

  switch (command) {
    case 'create-form':
      const formId = await integration.createRepairForm();
      console.log('\\n📋 下一步：');
      console.log('1. 複製表單 ID 並儲存');
      console.log('2. 設定表單回應通知 Webhook');
      console.log('3. 分享表單連結給各店使用');
      break;
    
    case 'monitor':
      if (!param1) {
        console.log('使用方式: node google_forms_integration.js monitor <form_id>');
        return;
      }
      await integration.monitorNewResponses(param1);
      break;
    
    case 'sync':
      if (!param1 || !param2) {
        console.log('使用方式: node google_forms_integration.js sync <form_id> <spreadsheet_id>');
        return;
      }
      await integration.syncToSpreadsheet(param1, param2);
      break;
    
    case 'process':
      if (!param1 || !param2) {
        console.log('使用方式: node google_forms_integration.js process <form_id> <response_id>');
        return;
      }
      await integration.processFormResponse(param1, param2);
      break;
    
    default:
      console.log('🔧 Google Forms 維修系統整合');
      console.log('\\n使用方式:');
      console.log('  node google_forms_integration.js create-form           - 建立報修表單');
      console.log('  node google_forms_integration.js monitor <form_id>     - 監控新回應');
      console.log('  node google_forms_integration.js sync <form_id> <sheet_id>  - 同步到試算表');
      console.log('  node google_forms_integration.js process <form_id> <response_id>  - 處理特定回應');
      console.log('\\n範例:');
      console.log('  node google_forms_integration.js create-form');
      console.log('  node google_forms_integration.js monitor 1FAIpQLSe...');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error).finally(() => pool.end());
}