-- ============================================================
-- 泡泡貓巡店考核系統 - 數據庫結構
-- ============================================================

-- 1. 巡店檢核項目主表
CREATE TABLE inspection_categories (
    id INT PRIMARY KEY AUTO_INCREMENT,
    category_name VARCHAR(100) NOT NULL COMMENT '大分類',
    category_code VARCHAR(20) NOT NULL UNIQUE,
    sort_order INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. 巡店檢核細項表
CREATE TABLE inspection_items (
    id INT PRIMARY KEY AUTO_INCREMENT,
    category_id INT NOT NULL,
    item_name VARCHAR(200) NOT NULL COMMENT '檢核項目',
    item_code VARCHAR(50) NOT NULL UNIQUE,
    description TEXT COMMENT '詳細說明',
    deduction_points INT DEFAULT 0 COMMENT '扣分分數',
    is_critical BOOLEAN DEFAULT FALSE COMMENT '是否關鍵項目',
    sort_order INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES inspection_categories(id)
);

-- 3. 巡店計劃表
CREATE TABLE inspection_schedules (
    id INT PRIMARY KEY AUTO_INCREMENT,
    store_id VARCHAR(50) NOT NULL COMMENT '門市ID',
    store_name VARCHAR(100) NOT NULL,
    quarter CHAR(6) NOT NULL COMMENT '季度 2026Q1',
    scheduled_date DATE COMMENT '預計巡店日期',
    inspector_id INT COMMENT '巡店人員ID',
    inspector_name VARCHAR(50),
    status ENUM('pending', 'scheduled', 'completed', 'overdue') DEFAULT 'pending',
    priority INT DEFAULT 0 COMMENT '優先級 1-5',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_store_quarter (store_id, quarter)
);

-- 4. 巡店記錄主表
CREATE TABLE inspection_records (
    id INT PRIMARY KEY AUTO_INCREMENT,
    schedule_id INT NOT NULL,
    store_id VARCHAR(50) NOT NULL,
    store_name VARCHAR(100) NOT NULL,
    store_type ENUM('direct', 'franchise') NOT NULL COMMENT '直營/加盟',
    inspection_date DATE NOT NULL,
    inspector_id INT NOT NULL,
    inspector_name VARCHAR(50) NOT NULL,
    
    -- 評分結果
    total_items INT DEFAULT 0 COMMENT '總檢核項目數',
    passed_items INT DEFAULT 0 COMMENT '通過項目數',
    failed_items INT DEFAULT 0 COMMENT '未通過項目數',
    deducted_points INT DEFAULT 0 COMMENT '總扣分',
    final_score DECIMAL(5,2) DEFAULT 100.00 COMMENT '最終得分',
    grade CHAR(2) COMMENT '等級 A+ A B C D',
    
    -- 狀態管理
    status ENUM('in_progress', 'completed', 'pending_improvement', 'closed') DEFAULT 'in_progress',
    improvement_deadline DATE COMMENT '改善期限',
    notes TEXT COMMENT '總體備註',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (schedule_id) REFERENCES inspection_schedules(id),
    INDEX idx_store_date (store_id, inspection_date),
    INDEX idx_inspector_date (inspector_id, inspection_date)
);

-- 5. 巡店檢核明細表
CREATE TABLE inspection_details (
    id INT PRIMARY KEY AUTO_INCREMENT,
    record_id INT NOT NULL,
    item_id INT NOT NULL,
    item_code VARCHAR(50) NOT NULL,
    item_name VARCHAR(200) NOT NULL,
    
    -- 檢核結果
    result ENUM('pass', 'fail', 'na') NOT NULL COMMENT '通過/不通過/不適用',
    deduction_points INT DEFAULT 0,
    notes TEXT COMMENT '詳細說明',
    
    -- 改善要求
    requires_improvement BOOLEAN DEFAULT FALSE,
    improvement_required TEXT COMMENT '改善要求說明',
    improvement_deadline DATE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (record_id) REFERENCES inspection_records(id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES inspection_items(id),
    UNIQUE KEY uk_record_item (record_id, item_id)
);

-- 6. 改善照片回傳表
CREATE TABLE improvement_photos (
    id INT PRIMARY KEY AUTO_INCREMENT,
    detail_id INT NOT NULL COMMENT '對應檢核明細ID',
    record_id INT NOT NULL,
    store_id VARCHAR(50) NOT NULL,
    item_code VARCHAR(50) NOT NULL,
    
    -- 照片資訊
    photo_url VARCHAR(500) NOT NULL,
    photo_filename VARCHAR(200),
    photo_size INT COMMENT '檔案大小bytes',
    
    -- 回傳資訊
    uploaded_by VARCHAR(100) COMMENT '上傳者',
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    description TEXT COMMENT '照片說明',
    
    -- 審核狀態
    review_status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    reviewed_by VARCHAR(100),
    reviewed_at TIMESTAMP NULL,
    review_notes TEXT,
    
    FOREIGN KEY (detail_id) REFERENCES inspection_details(id) ON DELETE CASCADE,
    FOREIGN KEY (record_id) REFERENCES inspection_records(id) ON DELETE CASCADE,
    INDEX idx_store_upload (store_id, uploaded_at)
);

-- 7. 巡店提醒記錄表
CREATE TABLE inspection_notifications (
    id INT PRIMARY KEY AUTO_INCREMENT,
    schedule_id INT NOT NULL,
    store_id VARCHAR(50) NOT NULL,
    notification_type ENUM('due_soon', 'overdue', 'improvement_due', 'improvement_overdue') NOT NULL,
    recipient VARCHAR(100) NOT NULL COMMENT '接收人',
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status ENUM('sent', 'failed') DEFAULT 'sent',
    
    FOREIGN KEY (schedule_id) REFERENCES inspection_schedules(id)
);

-- ============================================================
-- 初始化巡店檢核項目
-- ============================================================

-- 插入檢核大分類
INSERT INTO inspection_categories (category_name, category_code, sort_order) VALUES
('法規遵循', 'LEGAL', 1),
('衛生管理', 'HYGIENE', 2),
('設備維護', 'EQUIPMENT', 3),
('環境清潔', 'CLEANLINESS', 4),
('服務區域', 'SERVICE_AREA', 5),
('員工規範', 'STAFF', 6);

-- 插入具體檢核項目（根據參考資料整理）
INSERT INTO inspection_items (category_id, item_name, item_code, deduction_points, is_critical, sort_order) VALUES
-- 法規遵循 (1)
(1, '病媒防制措施記錄完整', 'LEGAL_001', 10, TRUE, 1),
(1, '中央空調冷卻水塔清潔記錄', 'LEGAL_002', 8, TRUE, 2),
(1, '員工契約書完整', 'LEGAL_003', 15, TRUE, 3),
(1, '員工健康檢查記錄', 'LEGAL_004', 12, TRUE, 4),
(1, '營業場所滅火器配備', 'LEGAL_005', 20, TRUE, 5),

-- 衛生管理 (2)
(2, '工具消毒設備完善', 'HYGIENE_001', 15, TRUE, 1),
(2, '客用工具清潔消毒落實', 'HYGIENE_002', 12, TRUE, 2),
(2, '身體接觸品清潔軟紙使用', 'HYGIENE_003', 8, TRUE, 3),
(2, '專用針管標示與保存', 'HYGIENE_004', 10, TRUE, 4),
(2, '凍晶粉保存期限標示', 'HYGIENE_005', 10, TRUE, 5),
(2, '酒精配置充足', 'HYGIENE_006', 5, FALSE, 6),

-- 設備維護 (3)
(3, '負氫離子機清潔度', 'EQUIPMENT_001', 8, FALSE, 1),
(3, '泡沖機清潔狀況', 'EQUIPMENT_002', 8, FALSE, 2),
(3, '殺菌消毒箱清潔度', 'EQUIPMENT_003', 10, TRUE, 3),
(3, '小氣泡機定期清洗', 'EQUIPMENT_004', 8, FALSE, 4),
(3, '水光槍定期清洗', 'EQUIPMENT_005', 8, FALSE, 5),
(3, '熱蒸機清潔保養', 'EQUIPMENT_006', 8, FALSE, 6),
(3, '台車清潔與防鏽', 'EQUIPMENT_007', 5, FALSE, 7),

-- 環境清潔 (4)
(4, '廁所清潔記錄表落實', 'CLEAN_001', 12, TRUE, 1),
(4, '廁所垃圾桶加蓋', 'CLEAN_002', 5, FALSE, 2),
(4, '客人接待區整潔', 'CLEAN_003', 8, FALSE, 3),
(4, '收銀櫃台整潔', 'CLEAN_004', 8, FALSE, 4),
(4, '地板清潔度', 'CLEAN_005', 8, FALSE, 5),
(4, '洗手台清潔度', 'CLEAN_006', 8, FALSE, 6),

-- 服務區域 (5)
(5, '肌膚檢測區整潔度', 'SERVICE_001', 10, FALSE, 1),
(5, '工作站清潔整理', 'SERVICE_002', 12, FALSE, 2),
(5, '潔面刷清潔無發霉', 'SERVICE_003', 15, TRUE, 3),
(5, '刮棒平整光滑', 'SERVICE_004', 8, FALSE, 4),
(5, '探頭清潔度', 'SERVICE_005', 8, FALSE, 5),
(5, '電視開啟狀況', 'SERVICE_006', 3, FALSE, 6),

-- 員工規範 (6)
(6, '服裝儀容清潔消毒', 'STAFF_001', 12, TRUE, 1),
(6, '指甲長度顏色清潔度', 'STAFF_002', 8, FALSE, 2),
(6, '口罩配戴規範', 'STAFF_003', 10, TRUE, 3),
(6, '妨礙公衛行為防治', 'STAFF_004', 15, TRUE, 4);

-- ============================================================
-- 建立視圖：巡店儀表板
-- ============================================================
CREATE VIEW inspection_dashboard AS
SELECT 
    ir.id,
    ir.store_id,
    ir.store_name,
    ir.store_type,
    ir.inspection_date,
    ir.inspector_name,
    ir.total_items,
    ir.passed_items,
    ir.failed_items,
    ir.deducted_points,
    ir.final_score,
    ir.grade,
    ir.status,
    ir.improvement_deadline,
    CASE 
        WHEN ir.improvement_deadline < CURDATE() AND ir.status = 'pending_improvement' 
        THEN TRUE 
        ELSE FALSE 
    END AS is_overdue,
    (SELECT COUNT(*) FROM improvement_photos ip WHERE ip.record_id = ir.id AND ip.review_status = 'pending') AS pending_photos
FROM inspection_records ir
ORDER BY ir.inspection_date DESC;

-- ============================================================
-- 建立視圖：季度巡店提醒
-- ============================================================
CREATE VIEW quarterly_inspection_alerts AS
SELECT 
    s.store_id,
    s.store_name,
    s.quarter,
    s.scheduled_date,
    s.inspector_name,
    s.status,
    s.priority,
    CASE 
        WHEN s.status = 'pending' THEN DATEDIFF(CURDATE(), DATE_SUB(s.scheduled_date, INTERVAL 7 DAY))
        ELSE NULL 
    END AS days_until_due,
    CASE 
        WHEN s.scheduled_date < CURDATE() AND s.status IN ('pending', 'scheduled') 
        THEN TRUE 
        ELSE FALSE 
    END AS is_overdue
FROM inspection_schedules s
WHERE s.quarter = CONCAT(YEAR(CURDATE()), 'Q', QUARTER(CURDATE()))
ORDER BY s.priority DESC, s.scheduled_date ASC;