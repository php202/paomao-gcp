#!/usr/bin/env node
/**
 * Odoo 維修系統整合
 * 功能：
 * 1. 建立維修發票
 * 2. 追蹤付款狀態
 * 3. 庫存管理和警示
 * 4. 自動出貨通知
 */

import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { Pool } from 'pg';

const pool = new Pool({ database: 'paomao', host: 'localhost', port: 5432, max: 5 });

class OdooRepairIntegration {
  constructor() {
    this.odooConfig = this.loadOdooConfig();
    this.baseUrl = this.odooConfig.url;
    this.database = this.odooConfig.database;
    this.username = this.odooConfig.username;
    this.password = this.odooConfig.password;
    this.uid = null;
  }

  // 載入 Odoo 設定
  loadOdooConfig() {
    try {
      const configPath = path.join(process.env.HOME, '.openclaw', 'secrets', 'odoo-config.json');
      if (!fs.existsSync(configPath)) {
        throw new Error('找不到 Odoo 配置文件');
      }
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      console.error('❌ 載入 Odoo 配置失敗:', error.message);
      throw error;
    }
  }

  // Odoo API 認證
  async authenticate() {
    try {
      const response = await fetch(`${this.baseUrl}/xmlrpc/2/common`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: `<?xml version="1.0"?>
          <methodCall>
            <methodName>authenticate</methodName>
            <params>
              <param><value><string>${this.database}</string></value></param>
              <param><value><string>${this.username}</string></value></param>
              <param><value><string>${this.password}</string></value></param>
              <param><value><struct></struct></value></param>
            </params>
          </methodCall>`
      });

      const responseText = await response.text();
      const uidMatch = responseText.match(/<value><int>(\\d+)<\\/int><\\/value>/);
      
      if (uidMatch) {
        this.uid = parseInt(uidMatch[1]);
        console.log('✅ Odoo 認證成功, UID:', this.uid);
        return this.uid;
      } else {
        throw new Error('認證失敗');
      }
    } catch (error) {
      console.error('❌ Odoo 認證失敗:', error.message);
      throw error;
    }
  }

  // 執行 Odoo API 調用
  async callOdooAPI(model, method, args = [], kwargs = {}) {
    if (!this.uid) {
      await this.authenticate();
    }

    const xmlArgs = args.map(arg => this.pythonToXml(arg)).join('');
    const xmlKwargs = Object.entries(kwargs).map(([key, value]) => 
      `<member><name>${key}</name>${this.pythonToXml(value)}</member>`
    ).join('');

    const xmlBody = `<?xml version="1.0"?>
      <methodCall>
        <methodName>execute_kw</methodName>
        <params>
          <param><value><string>${this.database}</string></value></param>
          <param><value><int>${this.uid}</int></value></param>
          <param><value><string>${this.password}</string></value></param>
          <param><value><string>${model}</string></value></param>
          <param><value><string>${method}</string></value></param>
          <param><value><array><data>${xmlArgs}</data></array></value></param>
          <param><value><struct>${xmlKwargs}</struct></value></param>
        </params>
      </methodCall>`;

    try {
      const response = await fetch(`${this.baseUrl}/xmlrpc/2/object`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: xmlBody
      });

      const responseText = await response.text();
      return this.parseXmlResponse(responseText);
    } catch (error) {
      console.error('❌ Odoo API 調用失敗:', error.message);
      throw error;
    }
  }

  // Python 物件轉換為 XML-RPC 格式
  pythonToXml(obj) {
    if (Array.isArray(obj)) {
      const items = obj.map(item => `<value>${this.pythonToXml(item)}</value>`).join('');
      return `<array><data>${items}</data></array>`;
    } else if (typeof obj === 'object' && obj !== null) {
      const members = Object.entries(obj).map(([key, value]) => 
        `<member><name>${key}</name><value>${this.pythonToXml(value)}</value></member>`
      ).join('');
      return `<struct>${members}</struct>`;
    } else if (typeof obj === 'string') {
      return `<string>${obj}</string>`;
    } else if (typeof obj === 'number') {
      return Number.isInteger(obj) ? `<int>${obj}</int>` : `<double>${obj}</double>`;
    } else if (typeof obj === 'boolean') {
      return `<boolean>${obj ? 1 : 0}</boolean>`;
    } else {
      return `<string>${String(obj)}</string>`;
    }
  }

  // 解析 XML 回應
  parseXmlResponse(xml) {
    // 簡化的 XML 解析 (實際應用中建議使用專門的 XML 解析器)
    try {
      if (xml.includes('<fault>')) {
        const faultMatch = xml.match(/<string>([^<]+)<\\/string>/);
        throw new Error('Odoo Error: ' + (faultMatch ? faultMatch[1] : 'Unknown error'));
      }
      
      // 解析簡單的整數回應
      const intMatch = xml.match(/<int>(\\d+)<\\/int>/);
      if (intMatch) return parseInt(intMatch[1]);
      
      // 解析陣列 (簡化版)
      const arrayMatch = xml.match(/<array><data>(.*?)<\\/data><\\/array>/s);
      if (arrayMatch) {
        const items = arrayMatch[1].match(/<value><int>(\\d+)<\\/int><\\/value>/g);
        return items ? items.map(item => parseInt(item.match(/(\\d+)/)[1])) : [];
      }
      
      return xml;
    } catch (error) {
      console.error('❌ XML 回應解析失敗:', error.message);
      throw error;
    }
  }

  // 建立維修發票
  async createRepairInvoice(repairOrderId) {
    try {
      // 從資料庫取得維修單詳情
      const { rows: orderRows } = await pool.query(`
        SELECT ro.*, 
               COALESCE(
                 (SELECT json_agg(json_build_object(
                   'part_name', part_name,
                   'quantity', quantity, 
                   'unit_cost', unit_cost,
                   'total_cost', total_cost,
                   'odoo_product_id', odoo_product_id
                 )) FROM repair_parts_used WHERE repair_order_id = ro.id),
                 '[]'
               ) as parts_used
        FROM repair_orders ro 
        WHERE ro.id = $1
      `, [repairOrderId]);

      if (orderRows.length === 0) {
        throw new Error('找不到維修單');
      }

      const order = orderRows[0];
      const partsUsed = JSON.parse(order.parts_used);

      // 查找或建立客戶
      const partnerId = await this.findOrCreatePartner(order.store_name);

      // 建立發票
      const invoiceData = {
        partner_id: partnerId,
        move_type: 'out_invoice',
        ref: order.order_number,
        invoice_date: new Date().toISOString().split('T')[0],
        invoice_line_ids: []
      };

      // 添加工時費用
      if (order.actual_cost && order.actual_cost > 0) {
        invoiceData.invoice_line_ids.push([0, 0, {
          name: `維修服務 - ${order.equipment_type}`,
          quantity: 1,
          price_unit: order.actual_cost,
          account_id: 1 // 需要根據實際會計科目設定
        }]);
      }

      // 添加零件費用
      partsUsed.forEach(part => {
        if (part.total_cost > 0) {
          invoiceData.invoice_line_ids.push([0, 0, {
            name: `零件 - ${part.part_name}`,
            product_id: part.odoo_product_id || null,
            quantity: part.quantity,
            price_unit: part.unit_cost,
            account_id: 1 // 需要根據實際會計科目設定
          }]);
        }
      });

      // 在 Odoo 中建立發票
      const invoiceId = await this.callOdooAPI('account.move', 'create', [invoiceData]);

      // 更新維修單的發票 ID
      await pool.query(`
        UPDATE repair_orders 
        SET odoo_invoice_id = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [invoiceId, repairOrderId]);

      console.log(`✅ 維修單 ${order.order_number} 發票建立成功，Invoice ID: ${invoiceId}`);
      return invoiceId;

    } catch (error) {
      console.error('❌ 建立維修發票失敗:', error.message);
      throw error;
    }
  }

  // 查找或建立合作夥伴 (客戶)
  async findOrCreatePartner(storeName) {
    try {
      // 查找現有客戶
      const existingIds = await this.callOdooAPI('res.partner', 'search', [
        [['name', '=', storeName]]
      ]);

      if (existingIds.length > 0) {
        return existingIds[0];
      }

      // 建立新客戶
      const partnerData = {
        name: storeName,
        is_company: true,
        customer_rank: 1,
        category_id: [[6, 0, []]] // 標籤分類，根據需要設定
      };

      const partnerId = await this.callOdooAPI('res.partner', 'create', [partnerData]);
      console.log(`✅ 建立新客戶: ${storeName}, ID: ${partnerId}`);
      return partnerId;

    } catch (error) {
      console.error('❌ 查找/建立客戶失敗:', error.message);
      throw error;
    }
  }

  // 檢查發票付款狀態
  async checkInvoicePayment(invoiceId) {
    try {
      const invoiceData = await this.callOdooAPI('account.move', 'read', [
        [invoiceId],
        ['state', 'payment_state', 'amount_total', 'amount_residual']
      ]);

      if (invoiceData.length === 0) {
        throw new Error('找不到發票');
      }

      const invoice = invoiceData[0];
      const isPaid = invoice.payment_state === 'paid';
      
      console.log(`📋 發票 ${invoiceId} 狀態:`, {
        state: invoice.state,
        payment_state: invoice.payment_state,
        amount_total: invoice.amount_total,
        amount_residual: invoice.amount_residual,
        is_paid: isPaid
      });

      return {
        isPaid,
        state: invoice.state,
        payment_state: invoice.payment_state,
        amount_total: invoice.amount_total,
        amount_residual: invoice.amount_residual
      };

    } catch (error) {
      console.error('❌ 檢查發票付款狀態失敗:', error.message);
      throw error;
    }
  }

  // 更新維修單付款狀態
  async updateRepairPaymentStatus(repairOrderId) {
    try {
      // 取得維修單的發票 ID
      const { rows } = await pool.query(`
        SELECT odoo_invoice_id FROM repair_orders WHERE id = $1
      `, [repairOrderId]);

      if (rows.length === 0 || !rows[0].odoo_invoice_id) {
        throw new Error('維修單沒有關聯的發票');
      }

      const invoiceId = rows[0].odoo_invoice_id;
      const paymentStatus = await this.checkInvoicePayment(invoiceId);

      // 更新資料庫中的付款狀態
      const newPaymentStatus = paymentStatus.isPaid ? 'paid' : 'pending';
      
      await pool.query(`
        UPDATE repair_orders 
        SET payment_status = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [newPaymentStatus, repairOrderId]);

      // 如果已付款，觸發出貨通知
      if (paymentStatus.isPaid) {
        await this.triggerShippingNotification(repairOrderId);
      }

      console.log(`✅ 維修單 ${repairOrderId} 付款狀態更新: ${newPaymentStatus}`);
      return newPaymentStatus;

    } catch (error) {
      console.error('❌ 更新付款狀態失敗:', error.message);
      throw error;
    }
  }

  // 觸發出貨通知
  async triggerShippingNotification(repairOrderId) {
    try {
      // 記錄進度
      await pool.query(`
        INSERT INTO repair_progress (repair_order_id, status, description, technician_name)
        VALUES ($1, $2, $3, $4)
      `, [repairOrderId, 'payment_confirmed', '付款確認，通知倉儲出貨', 'System']);

      // 這裡可以發送 Telegram 通知給倉儲部門
      console.log(`📦 維修單 ${repairOrderId} 付款確認，已通知倉儲出貨`);

      // TODO: 實作 Telegram 通知功能
      // await this.sendTelegramNotification(repairOrderId, 'shipping_required');

    } catch (error) {
      console.error('❌ 出貨通知失敗:', error.message);
    }
  }

  // 檢查庫存水準
  async checkInventoryLevels() {
    try {
      // 從本地資料庫取得低庫存項目
      const { rows: lowStockItems } = await pool.query(`
        SELECT * FROM repair_inventory 
        WHERE current_stock <= safety_stock AND is_active = TRUE
        ORDER BY (current_stock::float / safety_stock) ASC
      `);

      console.log(`📦 發現 ${lowStockItems.length} 個低庫存項目`);

      for (const item of lowStockItems) {
        // 如果有 Odoo 產品 ID，檢查 Odoo 中的庫存
        if (item.odoo_product_id) {
          const odooStock = await this.getOdooProductStock(item.odoo_product_id);
          
          if (odooStock !== null && Math.abs(odooStock - item.current_stock) > 0) {
            console.log(`⚠️ 庫存差異 ${item.part_name}: 本地 ${item.current_stock}, Odoo ${odooStock}`);
            
            // 同步庫存到本地
            await pool.query(`
              UPDATE repair_inventory 
              SET current_stock = $1, updated_at = CURRENT_TIMESTAMP
              WHERE id = $2
            `, [odooStock, item.id]);
          }
        }

        // 生成進貨提醒
        if (item.current_stock <= item.safety_stock) {
          await this.createRestockAlert(item);
        }
      }

      return lowStockItems;

    } catch (error) {
      console.error('❌ 檢查庫存水準失敗:', error.message);
      throw error;
    }
  }

  // 取得 Odoo 產品庫存
  async getOdooProductStock(productId) {
    try {
      const stockData = await this.callOdooAPI('stock.quant', 'search_read', [
        [['product_id', '=', parseInt(productId)]],
        ['quantity', 'available_quantity']
      ]);

      if (stockData.length === 0) return null;

      const totalStock = stockData.reduce((sum, quant) => 
        sum + (quant.available_quantity || 0), 0
      );

      return totalStock;

    } catch (error) {
      console.error(`❌ 取得產品 ${productId} 庫存失敗:`, error.message);
      return null;
    }
  }

  // 建立進貨提醒
  async createRestockAlert(item) {
    try {
      const recommendedOrder = Math.max(
        item.safety_stock * 2 - item.current_stock,
        item.safety_stock
      );

      console.log(`🔔 庫存警示: ${item.part_name}`);
      console.log(`   目前庫存: ${item.current_stock}`);
      console.log(`   安全庫存: ${item.safety_stock}`);
      console.log(`   建議進貨: ${recommendedOrder}`);
      console.log(`   供應商: ${item.supplier}`);

      // TODO: 發送 Telegram 通知給採購人員
      // await this.sendTelegramNotification(null, 'restock_required', { item, recommendedOrder });

    } catch (error) {
      console.error('❌ 建立進貨提醒失敗:', error.message);
    }
  }

  // 同步維修零件到 Odoo
  async syncPartsToOdoo() {
    try {
      const { rows: parts } = await pool.query(`
        SELECT * FROM repair_inventory 
        WHERE odoo_product_id IS NULL AND is_active = TRUE
      `);

      console.log(`🔄 同步 ${parts.length} 個零件到 Odoo...`);

      for (const part of parts) {
        try {
          const productData = {
            name: part.part_name,
            default_code: part.part_code,
            type: 'product',
            categ_id: 1, // 需要根據實際產品分類設定
            list_price: part.unit_cost,
            standard_price: part.unit_cost,
            tracking: 'none'
          };

          const productId = await this.callOdooAPI('product.product', 'create', [productData]);

          // 更新本地記錄
          await pool.query(`
            UPDATE repair_inventory 
            SET odoo_product_id = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
          `, [productId, part.id]);

          console.log(`✅ 零件 ${part.part_name} 同步成功，Product ID: ${productId}`);

        } catch (error) {
          console.error(`❌ 同步零件 ${part.part_name} 失敗:`, error.message);
        }
      }

    } catch (error) {
      console.error('❌ 同步零件到 Odoo 失敗:', error.message);
    }
  }

  // 批次檢查未付款發票
  async checkPendingPayments() {
    try {
      const { rows: pendingOrders } = await pool.query(`
        SELECT id, order_number, odoo_invoice_id 
        FROM repair_orders 
        WHERE payment_status = 'pending' 
        AND odoo_invoice_id IS NOT NULL
      `);

      console.log(`🔄 檢查 ${pendingOrders.length} 個待付款維修單...`);

      for (const order of pendingOrders) {
        try {
          await this.updateRepairPaymentStatus(order.id);
        } catch (error) {
          console.error(`檢查維修單 ${order.order_number} 失敗:`, error.message);
        }
      }

    } catch (error) {
      console.error('❌ 批次檢查付款狀態失敗:', error.message);
    }
  }
}

// CLI 介面
async function main() {
  const integration = new OdooRepairIntegration();
  const command = process.argv[2];
  const param1 = process.argv[3];
  const param2 = process.argv[4];

  switch (command) {
    case 'create-invoice':
      if (!param1) {
        console.log('使用方式: node odoo_repair_integration.js create-invoice <repair_order_id>');
        return;
      }
      await integration.createRepairInvoice(parseInt(param1));
      break;
    
    case 'check-payment':
      if (!param1) {
        console.log('使用方式: node odoo_repair_integration.js check-payment <repair_order_id>');
        return;
      }
      await integration.updateRepairPaymentStatus(parseInt(param1));
      break;
    
    case 'check-inventory':
      await integration.checkInventoryLevels();
      break;
    
    case 'sync-parts':
      await integration.syncPartsToOdoo();
      break;
    
    case 'check-pending':
      await integration.checkPendingPayments();
      break;
    
    case 'test-auth':
      await integration.authenticate();
      break;
    
    default:
      console.log('🔧 Odoo 維修系統整合');
      console.log('\\n使用方式:');
      console.log('  node odoo_repair_integration.js create-invoice <repair_order_id>  - 建立維修發票');
      console.log('  node odoo_repair_integration.js check-payment <repair_order_id>   - 檢查付款狀態');
      console.log('  node odoo_repair_integration.js check-inventory                    - 檢查庫存水準');
      console.log('  node odoo_repair_integration.js sync-parts                        - 同步零件到 Odoo');
      console.log('  node odoo_repair_integration.js check-pending                     - 檢查待付款維修單');
      console.log('  node odoo_repair_integration.js test-auth                         - 測試 Odoo 連線');
      console.log('\\n範例:');
      console.log('  node odoo_repair_integration.js create-invoice 123');
      console.log('  node odoo_repair_integration.js check-payment 123');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error).finally(() => pool.end());
}