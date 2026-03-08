#!/usr/bin/env node
/**
 * 建立維修系統資料庫結構
 */

import { Pool } from 'pg';
import fs from 'fs';

const pool = new Pool({ database: 'paomao', host: 'localhost', port: 5432, max: 5 });

async function createRepairTables() {
  console.log('🔧 開始建立維修系統資料庫結構...');
  
  try {
    await pool.query('BEGIN');

    // 1. 維修單主表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS repair_orders (
        id SERIAL PRIMARY KEY,
        order_number VARCHAR(50) UNIQUE NOT NULL,
        store_name VARCHAR(100) NOT NULL,
        store_id VARCHAR(50),
        equipment_type VARCHAR(100) NOT NULL,
        equipment_model VARCHAR(100),
        equipment_serial VARCHAR(100),
        fault_description TEXT NOT NULL,
        fault_category VARCHAR(50),
        
        diagnosis_result TEXT,
        solution_type VARCHAR(20) DEFAULT 'pending',
        repair_method TEXT,
        estimated_cost DECIMAL(10,2),
        estimated_days INTEGER,
        
        status VARCHAR(20) DEFAULT 'submitted',
        priority INTEGER DEFAULT 3,
        
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        received_at TIMESTAMP,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        returned_at TIMESTAMP,
        
        actual_cost DECIMAL(10,2),
        payment_status VARCHAR(20) DEFAULT 'pending',
        odoo_invoice_id VARCHAR(50),
        
        technician_name VARCHAR(100),
        internal_notes TEXT,
        customer_feedback INTEGER,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ repair_orders 表建立完成');

    // 2. 維修進度記錄表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS repair_progress (
        id SERIAL PRIMARY KEY,
        repair_order_id INTEGER REFERENCES repair_orders(id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL,
        description TEXT NOT NULL,
        technician_name VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        estimated_completion TIMESTAMP
      )
    `);
    console.log('✅ repair_progress 表建立完成');

    // 3. 維修零件使用記錄
    await pool.query(`
      CREATE TABLE IF NOT EXISTS repair_parts_used (
        id SERIAL PRIMARY KEY,
        repair_order_id INTEGER REFERENCES repair_orders(id) ON DELETE CASCADE,
        part_name VARCHAR(200) NOT NULL,
        part_code VARCHAR(100),
        quantity INTEGER DEFAULT 1,
        unit_cost DECIMAL(10,2),
        total_cost DECIMAL(10,2),
        odoo_product_id VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ repair_parts_used 表建立完成');

    // 4. 零件庫存管理
    await pool.query(`
      CREATE TABLE IF NOT EXISTS repair_inventory (
        id SERIAL PRIMARY KEY,
        part_name VARCHAR(200) NOT NULL,
        part_code VARCHAR(100) UNIQUE,
        category VARCHAR(100),
        current_stock INTEGER DEFAULT 0,
        safety_stock INTEGER DEFAULT 10,
        unit_cost DECIMAL(10,2),
        supplier VARCHAR(200),
        odoo_product_id VARCHAR(50),
        last_restock_date TIMESTAMP,
        notes TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ repair_inventory 表建立完成');

    // 5. 故障知識庫
    await pool.query(`
      CREATE TABLE IF NOT EXISTS repair_knowledge_base (
        id SERIAL PRIMARY KEY,
        equipment_type VARCHAR(100) NOT NULL,
        fault_symptoms TEXT NOT NULL,
        fault_category VARCHAR(50),
        diagnosis TEXT NOT NULL,
        solution_type VARCHAR(20) NOT NULL,
        solution_steps TEXT,
        estimated_time INTEGER,
        required_parts TEXT,
        difficulty_level INTEGER DEFAULT 1,
        success_rate DECIMAL(5,2) DEFAULT 90.00,
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ repair_knowledge_base 表建立完成');

    // 6. Google 表單整合記錄
    await pool.query(`
      CREATE TABLE IF NOT EXISTS repair_form_submissions (
        id SERIAL PRIMARY KEY,
        form_response_id VARCHAR(100),
        repair_order_id INTEGER REFERENCES repair_orders(id),
        raw_data JSONB,
        processed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ repair_form_submissions 表建立完成');

    // 7. 維修統計月報
    await pool.query(`
      CREATE TABLE IF NOT EXISTS repair_monthly_stats (
        id SERIAL PRIMARY KEY,
        year_month VARCHAR(7) NOT NULL,
        store_name VARCHAR(100),
        equipment_type VARCHAR(100),
        total_repairs INTEGER DEFAULT 0,
        avg_repair_days DECIMAL(5,2),
        total_cost DECIMAL(12,2),
        customer_satisfaction DECIMAL(3,2),
        generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ repair_monthly_stats 表建立完成');

    // 建立索引
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_repair_orders_status ON repair_orders(status)',
      'CREATE INDEX IF NOT EXISTS idx_repair_orders_store ON repair_orders(store_name)',
      'CREATE INDEX IF NOT EXISTS idx_repair_orders_created ON repair_orders(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_repair_inventory_stock ON repair_inventory(current_stock, safety_stock)',
      'CREATE INDEX IF NOT EXISTS idx_repair_progress_order ON repair_progress(repair_order_id)'
    ];

    for (const indexSql of indexes) {
      await pool.query(indexSql);
    }
    console.log('✅ 索引建立完成');

    // 建立觸發器
    await pool.query(`
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
      END;
      $$ language 'plpgsql'
    `);

    await pool.query(`
      DROP TRIGGER IF EXISTS repair_orders_updated_at ON repair_orders;
      CREATE TRIGGER repair_orders_updated_at
          BEFORE UPDATE ON repair_orders
          FOR EACH ROW EXECUTE FUNCTION update_updated_at()
    `);

    await pool.query(`
      DROP TRIGGER IF EXISTS repair_inventory_updated_at ON repair_inventory;
      CREATE TRIGGER repair_inventory_updated_at
          BEFORE UPDATE ON repair_inventory
          FOR EACH ROW EXECUTE FUNCTION update_updated_at()
    `);
    
    console.log('✅ 觸發器建立完成');

    await pool.query('COMMIT');
    console.log('🎉 資料庫結構建立完成！');

    // 插入初始數據
    await insertInitialData();
    
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('❌ 資料庫建立失敗:', error);
    throw error;
  }
}

async function insertInitialData() {
  console.log('📋 插入初始數據...');
  
  try {
    // 檢查是否已有數據
    const { rows: existingKB } = await pool.query('SELECT COUNT(*) FROM repair_knowledge_base');
    if (parseInt(existingKB[0].count) > 0) {
      console.log('ℹ️ 知識庫已有數據，跳過插入');
    } else {
      // 插入故障知識庫
      const knowledgeItems = [
        {
          equipment_type: '韓式科技洗臉機',
          fault_symptoms: '無法開機，電源燈不亮',
          fault_category: 'electrical',
          diagnosis: '電源供應問題，可能是電源線或內部保險絲',
          solution_type: 'simple_fix',
          solution_steps: '1. 檢查電源線是否插好\\n2. 更換電源線測試\\n3. 檢查牆壁插座\\n4. 如仍無效需檢查內部保險絲',
          estimated_time: 15,
          difficulty_level: 2
        },
        {
          equipment_type: '韓式科技洗臉機',
          fault_symptoms: '開機後異常震動或噪音',
          fault_category: 'mechanical',
          diagnosis: '內部零件鬆動或馬達問題',
          solution_type: 'need_repair',
          solution_steps: '需要拆機檢查內部零件，馬達可能需要更換',
          estimated_time: 120,
          difficulty_level: 4
        },
        {
          equipment_type: '韓式科技洗臉機',
          fault_symptoms: '螢幕顯示異常',
          fault_category: 'software',
          diagnosis: '系統軟體問題或螢幕硬體故障',
          solution_type: 'simple_fix',
          solution_steps: '1. 重新開關機\\n2. 執行系統重置\\n3. 如仍有問題可能需要更換螢幕模組',
          estimated_time: 30,
          difficulty_level: 3
        },
        {
          equipment_type: '超音波導入儀',
          fault_symptoms: '導入效果不佳',
          fault_category: 'mechanical',
          diagnosis: '探頭老化或功率設定問題',
          solution_type: 'simple_fix',
          solution_steps: '1. 清潔探頭表面\\n2. 檢查功率設定\\n3. 確認凝膠使用正確\\n4. 如無改善需更換探頭',
          estimated_time: 20,
          difficulty_level: 2
        },
        {
          equipment_type: 'LED光療機',
          fault_symptoms: '部分燈管不亮',
          fault_category: 'electrical',
          diagnosis: 'LED燈珠故障或驅動電路問題',
          solution_type: 'need_repair',
          solution_steps: '需要更換故障的LED燈珠或驅動模組',
          estimated_time: 60,
          difficulty_level: 3
        }
      ];

      for (const item of knowledgeItems) {
        await pool.query(`
          INSERT INTO repair_knowledge_base 
          (equipment_type, fault_symptoms, fault_category, diagnosis, solution_type, solution_steps, estimated_time, difficulty_level)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          item.equipment_type, item.fault_symptoms, item.fault_category, 
          item.diagnosis, item.solution_type, item.solution_steps, 
          item.estimated_time, item.difficulty_level
        ]);
      }
      console.log('✅ 故障知識庫數據插入完成');
    }

    // 檢查庫存數據
    const { rows: existingInv } = await pool.query('SELECT COUNT(*) FROM repair_inventory');
    if (parseInt(existingInv[0].count) > 0) {
      console.log('ℹ️ 庫存已有數據，跳過插入');
    } else {
      // 插入零件庫存
      const inventoryItems = [
        { part_name: '洗臉機電源線', part_code: 'PWR-001', category: '電源配件', current_stock: 20, safety_stock: 5, unit_cost: 150.00, supplier: '韓國原廠' },
        { part_name: '洗臉機保險絲5A', part_code: 'FUSE-5A', category: '電子零件', current_stock: 50, safety_stock: 10, unit_cost: 15.00, supplier: '台灣電子' },
        { part_name: '超音波探頭', part_code: 'PROBE-US01', category: '核心零件', current_stock: 8, safety_stock: 3, unit_cost: 2800.00, supplier: '韓國原廠' },
        { part_name: 'LED燈珠模組', part_code: 'LED-MOD01', category: '光療零件', current_stock: 15, safety_stock: 5, unit_cost: 450.00, supplier: '台灣光電' },
        { part_name: '螢幕顯示模組', part_code: 'LCD-7INCH', category: '顯示零件', current_stock: 5, safety_stock: 2, unit_cost: 1200.00, supplier: '台灣面板廠' },
        { part_name: '洗臉機馬達', part_code: 'MOTOR-001', category: '核心零件', current_stock: 3, safety_stock: 1, unit_cost: 3500.00, supplier: '韓國原廠' },
        { part_name: '凝膠導管', part_code: 'TUBE-GEL', category: '耗材', current_stock: 100, safety_stock: 20, unit_cost: 25.00, supplier: '台灣塑膠' },
        { part_name: '清潔布', part_code: 'CLOTH-CLN', category: '耗材', current_stock: 200, safety_stock: 50, unit_cost: 8.00, supplier: '台灣紡織' }
      ];

      for (const item of inventoryItems) {
        await pool.query(`
          INSERT INTO repair_inventory 
          (part_name, part_code, category, current_stock, safety_stock, unit_cost, supplier)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          item.part_name, item.part_code, item.category, 
          item.current_stock, item.safety_stock, item.unit_cost, item.supplier
        ]);
      }
      console.log('✅ 零件庫存數據插入完成');
    }

    // 顯示統計
    const { rows: stats } = await pool.query(`
      SELECT 'repair_orders' as table_name, COUNT(*) as record_count FROM repair_orders
      UNION ALL
      SELECT 'repair_knowledge_base', COUNT(*) FROM repair_knowledge_base
      UNION ALL
      SELECT 'repair_inventory', COUNT(*) FROM repair_inventory
    `);

    console.log('\\n📊 資料表統計:');
    stats.forEach(stat => {
      console.log(`   ${stat.table_name}: ${stat.record_count} 筆記錄`);
    });

  } catch (error) {
    console.error('❌ 初始數據插入失敗:', error);
    throw error;
  }
}

async function main() {
  try {
    await createRepairTables();
    console.log('\\n🎉 維修系統資料庫建立完成！');
  } catch (error) {
    console.error('❌ 建立失敗:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();