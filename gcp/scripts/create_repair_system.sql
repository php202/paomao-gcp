-- 泡泡貓維修系統資料庫結構
-- 執行: psql -h localhost -d paomao -f create_repair_system.sql

BEGIN;

-- 1. 維修單主表
CREATE TABLE IF NOT EXISTS repair_orders (
    id SERIAL PRIMARY KEY,
    order_number VARCHAR(50) UNIQUE NOT NULL, -- RO202603050001 格式
    store_name VARCHAR(100) NOT NULL,
    store_id VARCHAR(50),
    equipment_type VARCHAR(100) NOT NULL, -- 設備類型
    equipment_model VARCHAR(100), -- 型號
    equipment_serial VARCHAR(100), -- 序號
    fault_description TEXT NOT NULL, -- 故障描述
    fault_category VARCHAR(50), -- 故障分類 (electrical, mechanical, software, etc.)
    
    -- 診斷結果
    diagnosis_result TEXT, -- AI/技師診斷結果
    solution_type VARCHAR(20) DEFAULT 'pending', -- simple_fix, need_repair, need_replace
    repair_method TEXT, -- 自行維修方法
    estimated_cost DECIMAL(10,2), -- 預估費用
    estimated_days INTEGER, -- 預估維修天數
    
    -- 狀態追蹤
    status VARCHAR(20) DEFAULT 'submitted', -- submitted, diagnosed, in_repair, completed, cancelled
    priority INTEGER DEFAULT 3, -- 1-5, 1最緊急
    
    -- 時間記錄
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    received_at TIMESTAMP, -- 收到設備時間
    started_at TIMESTAMP, -- 開始維修時間
    completed_at TIMESTAMP, -- 完成時間
    returned_at TIMESTAMP, -- 歸還時間
    
    -- 費用相關
    actual_cost DECIMAL(10,2),
    payment_status VARCHAR(20) DEFAULT 'pending', -- pending, paid, refunded
    odoo_invoice_id VARCHAR(50), -- Odoo 發票ID
    
    -- 其他
    technician_name VARCHAR(100), -- 負責技師
    internal_notes TEXT, -- 內部備註
    customer_feedback INTEGER, -- 1-5 客戶滿意度
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. 維修進度記錄表
CREATE TABLE IF NOT EXISTS repair_progress (
    id SERIAL PRIMARY KEY,
    repair_order_id INTEGER REFERENCES repair_orders(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL,
    description TEXT NOT NULL,
    technician_name VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    estimated_completion TIMESTAMP -- 預估完成時間
);

-- 3. 維修零件使用記錄
CREATE TABLE IF NOT EXISTS repair_parts_used (
    id SERIAL PRIMARY KEY,
    repair_order_id INTEGER REFERENCES repair_orders(id) ON DELETE CASCADE,
    part_name VARCHAR(200) NOT NULL,
    part_code VARCHAR(100),
    quantity INTEGER DEFAULT 1,
    unit_cost DECIMAL(10,2),
    total_cost DECIMAL(10,2),
    odoo_product_id VARCHAR(50), -- 對應 Odoo 產品ID
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. 零件庫存管理
CREATE TABLE IF NOT EXISTS repair_inventory (
    id SERIAL PRIMARY KEY,
    part_name VARCHAR(200) NOT NULL,
    part_code VARCHAR(100) UNIQUE,
    category VARCHAR(100), -- 零件分類
    current_stock INTEGER DEFAULT 0,
    safety_stock INTEGER DEFAULT 10, -- 安全庫存
    unit_cost DECIMAL(10,2),
    supplier VARCHAR(200),
    odoo_product_id VARCHAR(50),
    last_restock_date TIMESTAMP,
    notes TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. 故障知識庫
CREATE TABLE IF NOT EXISTS repair_knowledge_base (
    id SERIAL PRIMARY KEY,
    equipment_type VARCHAR(100) NOT NULL,
    fault_symptoms TEXT NOT NULL, -- 故障症狀
    fault_category VARCHAR(50),
    diagnosis TEXT NOT NULL, -- 診斷
    solution_type VARCHAR(20) NOT NULL, -- simple_fix, need_repair, need_replace
    solution_steps TEXT, -- 解決步驟
    estimated_time INTEGER, -- 預估時間(分鐘)
    required_parts TEXT, -- 需要零件
    difficulty_level INTEGER DEFAULT 1, -- 1-5 難度等級
    success_rate DECIMAL(5,2) DEFAULT 90.00, -- 成功率
    created_by VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. Google 表單整合記錄
CREATE TABLE IF NOT EXISTS repair_form_submissions (
    id SERIAL PRIMARY KEY,
    form_response_id VARCHAR(100), -- Google Form 回應ID
    repair_order_id INTEGER REFERENCES repair_orders(id),
    raw_data JSONB, -- 原始表單資料
    processed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. 維修統計月報
CREATE TABLE IF NOT EXISTS repair_monthly_stats (
    id SERIAL PRIMARY KEY,
    year_month VARCHAR(7) NOT NULL, -- 2024-03 格式
    store_name VARCHAR(100),
    equipment_type VARCHAR(100),
    total_repairs INTEGER DEFAULT 0,
    avg_repair_days DECIMAL(5,2),
    total_cost DECIMAL(12,2),
    customer_satisfaction DECIMAL(3,2),
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 插入初始數據

-- 常見故障知識庫
INSERT INTO repair_knowledge_base (equipment_type, fault_symptoms, fault_category, diagnosis, solution_type, solution_steps, estimated_time, difficulty_level) VALUES
('韓式科技洗臉機', '無法開機，電源燈不亮', 'electrical', '電源供應問題，可能是電源線或內部保險絲', 'simple_fix', '1. 檢查電源線是否插好\n2. 更換電源線測試\n3. 檢查牆壁插座\n4. 如仍無效需檢查內部保險絲', 15, 2),
('韓式科技洗臉機', '開機後異常震動或噪音', 'mechanical', '內部零件鬆動或馬達問題', 'need_repair', '需要拆機檢查內部零件，馬達可能需要更換', 120, 4),
('韓式科技洗臉機', '螢幕顯示異常', 'software', '系統軟體問題或螢幕硬體故障', 'simple_fix', '1. 重新開關機\n2. 執行系統重置\n3. 如仍有問題可能需要更換螢幕模組', 30, 3),
('超音波導入儀', '導入效果不佳', 'mechanical', '探頭老化或功率設定問題', 'simple_fix', '1. 清潔探頭表面\n2. 檢查功率設定\n3. 確認凝膠使用正確\n4. 如無改善需更換探頭', 20, 2),
('LED光療機', '部分燈管不亮', 'electrical', 'LED燈珠故障或驅動電路問題', 'need_repair', '需要更換故障的LED燈珠或驅動模組', 60, 3);

-- 常用零件庫存
INSERT INTO repair_inventory (part_name, part_code, category, current_stock, safety_stock, unit_cost, supplier) VALUES
('洗臉機電源線', 'PWR-001', '電源配件', 20, 5, 150.00, '韓國原廠'),
('洗臉機保險絲5A', 'FUSE-5A', '電子零件', 50, 10, 15.00, '台灣電子'),
('超音波探頭', 'PROBE-US01', '核心零件', 8, 3, 2800.00, '韓國原廠'),
('LED燈珠模組', 'LED-MOD01', '光療零件', 15, 5, 450.00, '台灣光電'),
('螢幕顯示模組', 'LCD-7INCH', '顯示零件', 5, 2, 1200.00, '台灣面板廠'),
('洗臉機馬達', 'MOTOR-001', '核心零件', 3, 1, 3500.00, '韓國原廠'),
('凝膠導管', 'TUBE-GEL', '耗材', 100, 20, 25.00, '台灣塑膠'),
('清潔布', 'CLOTH-CLN', '耗材', 200, 50, 8.00, '台灣紡織');

-- 建立索引優化查詢
CREATE INDEX IF NOT EXISTS idx_repair_orders_status ON repair_orders(status);
CREATE INDEX IF NOT EXISTS idx_repair_orders_store ON repair_orders(store_name);
CREATE INDEX IF NOT EXISTS idx_repair_orders_created ON repair_orders(created_at);
CREATE INDEX IF NOT EXISTS idx_repair_inventory_stock ON repair_inventory(current_stock, safety_stock);
CREATE INDEX IF NOT EXISTS idx_repair_progress_order ON repair_progress(repair_order_id);

-- 建立觸發器自動更新時間
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER repair_orders_updated_at
    BEFORE UPDATE ON repair_orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER repair_inventory_updated_at
    BEFORE UPDATE ON repair_inventory
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMIT;

-- 顯示建立結果
SELECT 'repair_orders' as table_name, COUNT(*) as record_count FROM repair_orders
UNION ALL
SELECT 'repair_knowledge_base', COUNT(*) FROM repair_knowledge_base
UNION ALL
SELECT 'repair_inventory', COUNT(*) FROM repair_inventory;

ANALYZE repair_orders;
ANALYZE repair_knowledge_base;
ANALYZE repair_inventory;