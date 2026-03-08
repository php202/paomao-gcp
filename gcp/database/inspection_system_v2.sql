-- ============================================================
-- 泡泡貓巡店考核系統 V2.0 - 專業督導評分系統
-- 評分範圍：3, 2, 1, 0, -1, -2, -3 分
-- 基準分數：100分，各項目評分累加
-- 每季巡店一次，低於0分的項目需改善追蹤
-- ============================================================

-- 重新設計數據庫結構，支援新的評分系統

-- 1. 門市基本資料表（從現有系統同步）
CREATE TABLE stores (
    id VARCHAR(20) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type ENUM('direct', 'franchise') NOT NULL COMMENT '直營/加盟',
    address VARCHAR(200),
    phone VARCHAR(20),
    manager_name VARCHAR(50),
    status ENUM('active', 'inactive') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. 督導人員表
CREATE TABLE inspectors (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(50) NOT NULL,
    employee_id VARCHAR(20) UNIQUE,
    department VARCHAR(50),
    level ENUM('junior', 'senior', 'supervisor') DEFAULT 'junior',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. 巡店檢核項目分類
CREATE TABLE inspection_categories (
    id INT PRIMARY KEY AUTO_INCREMENT,
    category_name VARCHAR(100) NOT NULL,
    category_code VARCHAR(20) NOT NULL UNIQUE,
    description TEXT,
    sort_order INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. 巡店檢核項目明細（重新設計評分邏輯）
CREATE TABLE inspection_items (
    id INT PRIMARY KEY AUTO_INCREMENT,
    category_id INT NOT NULL,
    item_name VARCHAR(200) NOT NULL,
    item_code VARCHAR(50) NOT NULL UNIQUE,
    description TEXT COMMENT '檢核標準說明',
    
    -- 評分標準說明
    score_3_desc VARCHAR(200) COMMENT '+3分：卓越標準',
    score_2_desc VARCHAR(200) COMMENT '+2分：優秀標準', 
    score_1_desc VARCHAR(200) COMMENT '+1分：良好標準',
    score_0_desc VARCHAR(200) COMMENT '0分：合格標準',
    score_neg1_desc VARCHAR(200) COMMENT '-1分：需改善',
    score_neg2_desc VARCHAR(200) COMMENT '-2分：嚴重問題',
    score_neg3_desc VARCHAR(200) COMMENT '-3分：極嚴重',
    
    -- 項目權重與重要性
    weight DECIMAL(3,2) DEFAULT 1.00 COMMENT '項目權重',
    is_critical BOOLEAN DEFAULT FALSE COMMENT '是否關鍵項目（影響等級）',
    requires_photo_if_negative BOOLEAN DEFAULT TRUE COMMENT '負分時是否需要照片',
    
    sort_order INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (category_id) REFERENCES inspection_categories(id)
);

-- 5. 季度巡店計劃表
CREATE TABLE inspection_schedules (
    id INT PRIMARY KEY AUTO_INCREMENT,
    store_id VARCHAR(20) NOT NULL,
    store_name VARCHAR(100) NOT NULL,
    store_type ENUM('direct', 'franchise') NOT NULL,
    
    -- 計劃時間
    quarter CHAR(6) NOT NULL COMMENT '季度 2026Q1',
    planned_date DATE COMMENT '計劃巡店日期',
    
    -- 分派督導
    inspector_id INT,
    inspector_name VARCHAR(50),
    
    -- 狀態管理
    status ENUM('planned', 'assigned', 'in_progress', 'completed', 'overdue') DEFAULT 'planned',
    priority INT DEFAULT 3 COMMENT '優先級 1-5，5最高',
    
    -- 提醒設置
    reminder_days INT DEFAULT 7 COMMENT '提前幾天提醒',
    last_reminder_sent TIMESTAMP NULL,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (store_id) REFERENCES stores(id),
    FOREIGN KEY (inspector_id) REFERENCES inspectors(id),
    UNIQUE KEY uk_store_quarter (store_id, quarter)
);

-- 6. 巡店記錄主表（重新設計評分體系）
CREATE TABLE inspection_records (
    id INT PRIMARY KEY AUTO_INCREMENT,
    schedule_id INT NOT NULL,
    store_id VARCHAR(20) NOT NULL,
    store_name VARCHAR(100) NOT NULL,
    store_type ENUM('direct', 'franchise') NOT NULL,
    
    -- 巡店基本資訊
    inspection_date DATE NOT NULL,
    inspector_id INT NOT NULL,
    inspector_name VARCHAR(50) NOT NULL,
    weather VARCHAR(50) COMMENT '天氣狀況',
    
    -- 新的評分體系
    total_items INT DEFAULT 0 COMMENT '總檢核項目數',
    base_score DECIMAL(5,2) DEFAULT 100.00 COMMENT '基準分數',
    bonus_points DECIMAL(5,2) DEFAULT 0.00 COMMENT '加分項總計',
    penalty_points DECIMAL(5,2) DEFAULT 0.00 COMMENT '扣分項總計',
    final_score DECIMAL(5,2) DEFAULT 100.00 COMMENT '最終得分',
    
    -- 等級評定（專業督導標準）
    grade ENUM('A+', 'A', 'B', 'C', 'D') COMMENT '綜合等級',
    performance_level VARCHAR(50) COMMENT '表現水準描述',
    
    -- 改善追蹤
    items_need_improvement INT DEFAULT 0 COMMENT '需改善項目數',
    critical_issues INT DEFAULT 0 COMMENT '嚴重問題數',
    improvement_deadline DATE COMMENT '改善截止日期',
    
    -- 狀態管理
    status ENUM('in_progress', 'completed', 'pending_improvement', 'improvement_completed', 'closed') DEFAULT 'in_progress',
    
    -- 督導總評
    inspector_comments TEXT COMMENT '督導總體評語',
    recommendations TEXT COMMENT '改善建議',
    follow_up_required BOOLEAN DEFAULT FALSE COMMENT '是否需要追蹤複查',
    next_inspection_priority INT DEFAULT 3 COMMENT '下次巡店優先級',
    
    -- 時間記錄
    inspection_start_time TIME,
    inspection_end_time TIME,
    inspection_duration INT COMMENT '巡店時長（分鐘）',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (schedule_id) REFERENCES inspection_schedules(id),
    FOREIGN KEY (store_id) REFERENCES stores(id),
    FOREIGN KEY (inspector_id) REFERENCES inspectors(id),
    
    INDEX idx_store_date (store_id, inspection_date),
    INDEX idx_inspector_date (inspector_id, inspection_date),
    INDEX idx_status (status),
    INDEX idx_grade (grade)
);

-- 7. 巡店檢核明細表（支援-3到+3評分）
CREATE TABLE inspection_details (
    id INT PRIMARY KEY AUTO_INCREMENT,
    record_id INT NOT NULL,
    item_id INT NOT NULL,
    item_code VARCHAR(50) NOT NULL,
    item_name VARCHAR(200) NOT NULL,
    category_name VARCHAR(100),
    
    -- 評分結果（-3到+3）
    score INT NOT NULL COMMENT '得分 -3到+3',
    score_weight DECIMAL(3,2) DEFAULT 1.00 COMMENT '權重',
    weighted_score DECIMAL(5,2) COMMENT '加權後得分',
    
    -- 檢核詳情
    inspector_notes TEXT COMMENT '督導檢核說明',
    found_issues TEXT COMMENT '發現的問題',
    improvement_suggestions TEXT COMMENT '改善建議',
    
    -- 改善追蹤（負分項目）
    requires_improvement BOOLEAN DEFAULT FALSE COMMENT '是否需要改善',
    improvement_required TEXT COMMENT '具體改善要求',
    improvement_deadline DATE,
    improvement_priority ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
    
    -- 複查記錄
    follow_up_required BOOLEAN DEFAULT FALSE,
    follow_up_date DATE,
    follow_up_status ENUM('pending', 'scheduled', 'completed') DEFAULT 'pending',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (record_id) REFERENCES inspection_records(id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES inspection_items(id),
    UNIQUE KEY uk_record_item (record_id, item_id)
);

-- 8. 改善照片管理表（增強版）
CREATE TABLE improvement_photos (
    id INT PRIMARY KEY AUTO_INCREMENT,
    detail_id INT NOT NULL COMMENT '對應檢核明細ID',
    record_id INT NOT NULL,
    store_id VARCHAR(20) NOT NULL,
    item_code VARCHAR(50) NOT NULL,
    
    -- 照片類型分類
    photo_type ENUM('problem', 'improvement', 'completion') NOT NULL COMMENT '問題照片/改善過程/完成照片',
    
    -- 照片資訊
    photo_url VARCHAR(500) NOT NULL,
    photo_filename VARCHAR(200),
    photo_size INT COMMENT '檔案大小bytes',
    photo_hash VARCHAR(64) COMMENT '照片hash防重複',
    
    -- 上傳資訊
    uploaded_by VARCHAR(100) COMMENT '上傳者（店長/員工）',
    uploader_role ENUM('manager', 'staff', 'inspector') DEFAULT 'manager',
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    description TEXT COMMENT '照片說明',
    
    -- 審核流程
    review_status ENUM('pending', 'approved', 'rejected', 'needs_resubmit') DEFAULT 'pending',
    reviewed_by VARCHAR(100) COMMENT '審核人',
    reviewed_at TIMESTAMP NULL,
    review_notes TEXT COMMENT '審核意見',
    
    -- 地理位置（可選）
    gps_lat DECIMAL(10,8),
    gps_lng DECIMAL(11,8),
    
    FOREIGN KEY (detail_id) REFERENCES inspection_details(id) ON DELETE CASCADE,
    FOREIGN KEY (record_id) REFERENCES inspection_records(id) ON DELETE CASCADE,
    FOREIGN KEY (store_id) REFERENCES stores(id),
    
    INDEX idx_store_type (store_id, photo_type),
    INDEX idx_review_status (review_status),
    INDEX idx_upload_date (uploaded_at)
);

-- 9. 督導提醒與通知表
CREATE TABLE inspection_notifications (
    id INT PRIMARY KEY AUTO_INCREMENT,
    
    -- 關聯對象
    schedule_id INT,
    record_id INT,
    store_id VARCHAR(20) NOT NULL,
    
    -- 通知類型
    notification_type ENUM('due_soon', 'overdue', 'improvement_due', 'improvement_overdue', 'follow_up_required', 'critical_issue') NOT NULL,
    priority ENUM('low', 'medium', 'high', 'urgent') DEFAULT 'medium',
    
    -- 通知內容
    title VARCHAR(200) NOT NULL,
    message TEXT,
    
    -- 接收人
    recipient_type ENUM('inspector', 'manager', 'admin', 'store_manager') NOT NULL,
    recipient_name VARCHAR(100),
    recipient_contact VARCHAR(100) COMMENT '聯絡方式',
    
    -- 發送狀態
    status ENUM('pending', 'sent', 'failed', 'acknowledged') DEFAULT 'pending',
    sent_at TIMESTAMP NULL,
    acknowledged_at TIMESTAMP NULL,
    
    -- 重試機制
    retry_count INT DEFAULT 0,
    max_retries INT DEFAULT 3,
    next_retry_at TIMESTAMP NULL,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (schedule_id) REFERENCES inspection_schedules(id),
    FOREIGN KEY (record_id) REFERENCES inspection_records(id),
    FOREIGN KEY (store_id) REFERENCES stores(id),
    
    INDEX idx_store_type (store_id, notification_type),
    INDEX idx_status_priority (status, priority),
    INDEX idx_due_time (next_retry_at)
);

-- 10. 巡店模板與標準表（專業督導標準）
CREATE TABLE inspection_templates (
    id INT PRIMARY KEY AUTO_INCREMENT,
    template_name VARCHAR(100) NOT NULL,
    template_code VARCHAR(20) NOT NULL UNIQUE,
    store_type ENUM('direct', 'franchise', 'both') DEFAULT 'both',
    
    -- 模板設定
    total_items INT DEFAULT 0,
    estimated_duration INT DEFAULT 120 COMMENT '預估巡店時長（分鐘）',
    
    -- 評分標準
    excellent_threshold INT DEFAULT 95 COMMENT 'A+級門檻',
    good_threshold INT DEFAULT 85 COMMENT 'A級門檻',
    average_threshold INT DEFAULT 75 COMMENT 'B級門檻',
    poor_threshold INT DEFAULT 65 COMMENT 'C級門檻',
    
    -- 模板狀態
    is_active BOOLEAN DEFAULT TRUE,
    is_default BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ============================================================
-- 初始化基礎數據
-- ============================================================

-- 插入督導人員
INSERT INTO inspectors (name, employee_id, department, level) VALUES
('圓圓', 'EMP001', '品牌管理', 'senior'),
('Rick', 'EMP002', '營運管理', 'supervisor'),
('慈慈', 'EMP003', '教育訓練', 'junior');

-- 插入檢核分類（基於現有Google Sheets）
INSERT INTO inspection_categories (category_name, category_code, sort_order) VALUES
('法規遵循與安全', 'LEGAL_SAFETY', 1),
('環境清潔與衛生', 'CLEAN_HYGIENE', 2),
('設備維護與保養', 'EQUIPMENT', 3),
('服務區域管理', 'SERVICE_AREA', 4),
('員工規範與服務', 'STAFF_SERVICE', 5),
('專業用品管理', 'SUPPLIES', 6);

-- 插入具體檢核項目（基於Google Sheets，調整為-3到+3評分）
INSERT INTO inspection_items (category_id, item_name, item_code, description, score_3_desc, score_2_desc, score_1_desc, score_0_desc, score_neg1_desc, score_neg2_desc, score_neg3_desc, is_critical, weight, sort_order) VALUES

-- 法規遵循與安全
(1, '病媒防制措施記錄', 'LEGAL_001', '三個月清潔一次，需有完整填寫記錄單', '記錄完整，提前執行', '記錄清楚，按時執行', '記錄大致完整', '基本記錄存在', '記錄不完整', '缺少記錄單', '完全無記錄', TRUE, 1.5, 1),
(1, '中央空調清潔記錄', 'LEGAL_002', '定期清潔保養記錄', '保養記錄詳細，設備清潔', '記錄完整', '有基本記錄', '符合標準', '記錄缺漏', '設備髒污', '嚴重缺失', TRUE, 1.3, 2),
(1, '工具消毒設備及急救箱', 'LEGAL_003', '急救箱需整理並放在固定位置', '設備齊全，整理完善', '設備完整', '基本齊全', '符合要求', '略有缺失', '設備不全', '嚴重缺乏', TRUE, 1.2, 3),
(1, '營業場所滅火器配備', 'LEGAL_004', '滅火器需定期檢查，保持清潔', '檢查記錄完整，位置標準', '定期檢查', '有檢查記錄', '基本符合', '檢查不定期', '滅火器髒污', '缺少滅火器', TRUE, 2.0, 4),
(1, '員工健康檢查記錄', 'LEGAL_005', '員工需定期健康檢查，記錄完整', '記錄完整，全員合格', '大部分完整', '基本符合', '符合標準', '部分缺失', '多數過期', '嚴重缺失', TRUE, 1.8, 5),

-- 環境清潔與衛生
(2, '客人接待區整潔', 'CLEAN_001', '不可有私人物品，需保持整潔', '環境優美，無任何雜物', '整潔有序', '基本整潔', '符合標準', '略有雜物', '較為雜亂', '嚴重雜亂', FALSE, 1.0, 1),
(2, '收銀櫃台整潔', 'CLEAN_002', '檯面整潔，無私人用品或雜物', '檯面一塵不染，物品擺放整齊', '檯面清潔', '基本整潔', '符合要求', '略有雜物', '檯面凌亂', '極度髒亂', FALSE, 1.0, 2),
(2, '廁所清潔記錄表落實', 'CLEAN_003', '清潔表需貼在廁所門後，確實記錄', '記錄詳細，清潔標準高', '記錄完整', '有基本記錄', '符合要求', '記錄不完整', '清潔表未貼', '無清潔記錄', TRUE, 1.5, 3),
(2, '廁所垃圾桶加蓋', 'CLEAN_004', '垃圾桶需有蓋子並確實蓋上', '垃圾桶清潔，蓋子密合', '蓋子完好', '基本符合', '有蓋子', '蓋子未蓋緊', '蓋子破損', '無蓋子', FALSE, 0.8, 4),
(2, '地板清潔度', 'CLEAN_005', '地板無髒污、無積水、無雜物', '地板光亮如新', '地板清潔', '基本乾淨', '符合標準', '略有髒污', '明顯髒污', '嚴重髒亂', FALSE, 1.0, 5),

-- 設備維護與保養
(3, '負氫離子機清潔度', 'EQUIP_001', '無水垢、無泛黃，保持乾淨', '設備如新，保養良好', '設備清潔', '基本清潔', '符合要求', '略有水垢', '明顯泛黃', '嚴重髒污', FALSE, 1.2, 1),
(3, '泡沖機清潔狀況', 'EQUIP_002', '內部無發霉，定期清潔', '內外清潔，無異味', '清潔良好', '基本清潔', '符合標準', '略有異味', '有發霉跡象', '嚴重發霉', TRUE, 1.8, 2),
(3, '殺菌消毒箱清潔', 'EQUIP_003', '鐵架無生鏽，無水垢積累', '設備完好，無鏽蝕', '基本良好', '略有瑕疵', '符合使用', '輕微生鏽', '明顯鏽蝕', '嚴重鏽蝕', TRUE, 1.5, 3),
(3, '台車清潔與防鏽', 'EQUIP_004', '台車無生鏽，保持清潔', '台車如新', '保養良好', '基本清潔', '符合使用', '輕微生鏽', '鏽蝕明顯', '嚴重鏽蝕', FALSE, 1.0, 4),
(3, '小氣泡機定期清洗', 'EQUIP_005', '確認無黃垢，定期清洗保養', '設備清潔，保養記錄完整', '定期保養', '基本清潔', '符合使用', '略有黃垢', '黃垢明顯', '設備髒污', FALSE, 1.3, 5),

-- 服務區域管理
(4, '肌膚檢測區整潔度', 'SERVICE_001', '檢測區整齊，無灰塵', '環境完美，設備整齊', '整潔有序', '基本整齊', '符合要求', '略有灰塵', '較為雜亂', '嚴重雜亂', FALSE, 1.2, 1),
(4, '工作站清潔整理', 'SERVICE_002', '工作區不可雜亂，保持整潔', '工作區完美整理', '整理良好', '基本整齊', '符合標準', '略顯雜亂', '明顯雜亂', '極度雜亂', TRUE, 1.5, 2),
(4, '潔面刷清潔無發霉', 'SERVICE_003', '潔面刷不可有發霉或變黑情況', '潔面刷如新', '清潔良好', '基本清潔', '符合使用', '略有髒污', '有發霉跡象', '嚴重發霉', TRUE, 2.0, 3),
(4, '電視開啟狀況', 'SERVICE_004', '營業時間電視需開啟', '電視內容合適，音量適中', '正常開啟', '基本符合', '電視開啟', '未及時開啟', '電視故障', '電視關閉', FALSE, 0.5, 4),
(4, '酒精配置充足', 'SERVICE_005', '各區域酒精充足，隨時可用', '酒精充足，擺放整齊', '配置充足', '基本夠用', '符合需求', '略顯不足', '明顯不足', '嚴重缺乏', TRUE, 1.0, 5),

-- 員工規範與服務
(5, '服裝儀容清潔消毒', 'STAFF_001', '員工服裝整潔，事前清潔消毒', '儀容完美，消毒徹底', '儀容良好', '基本整潔', '符合標準', '略有不當', '儀容不整', '嚴重不當', TRUE, 1.8, 1),
(5, '指甲長度顏色清潔度', 'STAFF_002', '指甲長度適中，顏色自然，保持清潔', '指甲完美符合標準', '符合規範', '基本合格', '符合要求', '略有不當', '明顯不符', '嚴重違規', FALSE, 1.0, 2),
(5, '口罩配戴規範', 'STAFF_003', '正確配戴口罩，覆蓋口鼻', '口罩配戴完美', '配戴正確', '基本符合', '有配戴', '配戴不當', '口罩髒污', '未配戴', TRUE, 1.5, 3),
(5, '寵物入內防範措施', 'STAFF_004', '告知客人寵物不落地原則', '主動告知，執行徹底', '有告知', '基本執行', '符合規定', '告知不足', '未主動告知', '未執行', FALSE, 0.8, 4),

-- 專業用品管理
(6, '專用針管標示與保存', 'SUPPLIES_001', '針管需有標示，無卡頓現象', '標示清楚，保存完善', '標示完整', '基本標示', '有標示', '標示不清', '缺少標示', '無標示', TRUE, 1.5, 1),
(6, '凍晶粉保存期限標示', 'SUPPLIES_002', '需寫明保存期限在瓶身', '標示清楚，保存良好', '標示完整', '基本標示', '有標示', '標示不清', '部分無標示', '完全無標示', TRUE, 1.3, 2),
(6, '營養液正常存放', 'SUPPLIES_003', '營養液存放整齊，在有效期內', '存放完美，標示清楚', '存放整齊', '基本整齊', '符合要求', '略有問題', '存放不當', '嚴重問題', FALSE, 1.0, 3),
(6, '刮棒平整光滑', 'SUPPLIES_004', '刮棒表面光滑平整，無損傷', '刮棒如新', '狀況良好', '基本平整', '符合使用', '輕微損傷', '明顯損傷', '嚴重損傷', FALSE, 1.2, 4);

-- 插入檢核模板
INSERT INTO inspection_templates (template_name, template_code, store_type, total_items, estimated_duration) VALUES
('泡泡貓標準巡店模板', 'STANDARD_V2', 'both', (SELECT COUNT(*) FROM inspection_items WHERE is_active = TRUE), 150);

-- ============================================================
-- 建立專業督導視圖
-- ============================================================

-- 巡店綜合儀表板視圖
CREATE VIEW inspection_dashboard_v2 AS
SELECT 
    ir.id,
    ir.store_id,
    ir.store_name,
    ir.store_type,
    ir.inspection_date,
    ir.inspector_name,
    ir.base_score,
    ir.bonus_points,
    ir.penalty_points,
    ir.final_score,
    ir.grade,
    ir.performance_level,
    ir.status,
    ir.items_need_improvement,
    ir.critical_issues,
    ir.improvement_deadline,
    ir.follow_up_required,
    
    -- 狀態判斷
    CASE 
        WHEN ir.improvement_deadline < CURDATE() AND ir.status = 'pending_improvement' THEN TRUE 
        ELSE FALSE 
    END AS is_improvement_overdue,
    
    -- 待處理照片數
    (SELECT COUNT(*) FROM improvement_photos ip 
     WHERE ip.record_id = ir.id AND ip.review_status = 'pending') AS pending_photos_count,
     
    -- 改善完成率
    CASE 
        WHEN ir.items_need_improvement > 0 THEN
            ROUND((SELECT COUNT(*) FROM improvement_photos ip 
                  WHERE ip.record_id = ir.id AND ip.review_status = 'approved') * 100.0 / ir.items_need_improvement, 1)
        ELSE 100.0
    END AS improvement_completion_rate,
    
    ir.created_at,
    ir.updated_at
FROM inspection_records ir
ORDER BY ir.inspection_date DESC, ir.final_score DESC;

-- 季度巡店計劃視圖
CREATE VIEW quarterly_inspection_schedule AS
SELECT 
    s.id,
    s.store_id,
    s.store_name,
    s.store_type,
    s.quarter,
    s.planned_date,
    s.inspector_name,
    s.status,
    s.priority,
    
    -- 時間計算
    CASE 
        WHEN s.status = 'planned' AND s.planned_date IS NOT NULL THEN 
            DATEDIFF(s.planned_date, CURDATE())
        ELSE NULL 
    END AS days_until_planned,
    
    CASE 
        WHEN s.planned_date < CURDATE() AND s.status IN ('planned', 'assigned') THEN TRUE 
        ELSE FALSE 
    END AS is_overdue,
    
    -- 上次巡店資訊
    (SELECT ir.final_score FROM inspection_records ir 
     WHERE ir.store_id = s.store_id 
     ORDER BY ir.inspection_date DESC LIMIT 1) AS last_score,
     
    (SELECT ir.grade FROM inspection_records ir 
     WHERE ir.store_id = s.store_id 
     ORDER BY ir.inspection_date DESC LIMIT 1) AS last_grade,
     
    (SELECT ir.inspection_date FROM inspection_records ir 
     WHERE ir.store_id = s.store_id 
     ORDER BY ir.inspection_date DESC LIMIT 1) AS last_inspection_date,
    
    s.created_at,
    s.updated_at
FROM inspection_schedules s
ORDER BY s.priority DESC, s.planned_date ASC;

-- 改善追蹤視圖
CREATE VIEW improvement_tracking AS
SELECT 
    id.id AS detail_id,
    ir.store_id,
    ir.store_name,
    ir.store_type,
    id.item_name,
    id.item_code,
    id.score,
    id.inspector_notes,
    id.improvement_required,
    id.improvement_deadline,
    id.improvement_priority,
    
    -- 照片狀態統計
    (SELECT COUNT(*) FROM improvement_photos ip 
     WHERE ip.detail_id = id.id) AS total_photos,
     
    (SELECT COUNT(*) FROM improvement_photos ip 
     WHERE ip.detail_id = id.id AND ip.review_status = 'approved') AS approved_photos,
     
    (SELECT COUNT(*) FROM improvement_photos ip 
     WHERE ip.detail_id = id.id AND ip.review_status = 'pending') AS pending_photos,
    
    -- 改善狀態
    CASE 
        WHEN id.improvement_deadline < CURDATE() THEN 'overdue'
        WHEN (SELECT COUNT(*) FROM improvement_photos ip 
              WHERE ip.detail_id = id.id AND ip.review_status = 'approved') > 0 THEN 'completed'
        WHEN (SELECT COUNT(*) FROM improvement_photos ip 
              WHERE ip.detail_id = id.id AND ip.review_status = 'pending') > 0 THEN 'pending_review'
        ELSE 'pending_action'
    END AS improvement_status,
    
    ir.inspection_date,
    ir.inspector_name,
    id.created_at
FROM inspection_details id
JOIN inspection_records ir ON id.record_id = ir.id
WHERE id.requires_improvement = TRUE
ORDER BY id.improvement_deadline ASC, id.improvement_priority DESC;

-- ============================================================
-- 建立觸發器：自動計算分數和等級
-- ============================================================

DELIMITER $$

CREATE TRIGGER calculate_inspection_score
AFTER INSERT ON inspection_details
FOR EACH ROW
BEGIN
    DECLARE total_score DECIMAL(5,2) DEFAULT 0;
    DECLARE bonus_total DECIMAL(5,2) DEFAULT 0;
    DECLARE penalty_total DECIMAL(5,2) DEFAULT 0;
    DECLARE final_score DECIMAL(5,2) DEFAULT 100;
    DECLARE grade_result CHAR(2) DEFAULT 'D';
    DECLARE improvement_count INT DEFAULT 0;
    DECLARE critical_count INT DEFAULT 0;
    
    -- 計算加分和扣分
    SELECT 
        COALESCE(SUM(CASE WHEN score > 0 THEN score * score_weight ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN score < 0 THEN ABS(score * score_weight) ELSE 0 END), 0),
        COUNT(CASE WHEN score < 0 THEN 1 END),
        COUNT(CASE WHEN score < 0 AND (SELECT is_critical FROM inspection_items WHERE id = NEW.item_id) THEN 1 END)
    INTO bonus_total, penalty_total, improvement_count, critical_count
    FROM inspection_details id
    JOIN inspection_items ii ON id.item_id = ii.id
    WHERE id.record_id = NEW.record_id;
    
    -- 計算最終得分
    SET final_score = 100 + bonus_total - penalty_total;
    SET final_score = GREATEST(final_score, 0); -- 確保不低於0分
    
    -- 等級評定（考慮關鍵項目）
    IF critical_count > 0 AND final_score < 70 THEN
        SET grade_result = 'D'; -- 有關鍵問題且得分低
    ELSEIF final_score >= 95 THEN
        SET grade_result = 'A+';
    ELSEIF final_score >= 85 THEN
        SET grade_result = 'A';
    ELSEIF final_score >= 75 THEN
        SET grade_result = 'B';
    ELSEIF final_score >= 65 THEN
        SET grade_result = 'C';
    ELSE
        SET grade_result = 'D';
    END IF;
    
    -- 更新巡店記錄
    UPDATE inspection_records 
    SET 
        bonus_points = bonus_total,
        penalty_points = penalty_total,
        final_score = final_score,
        grade = grade_result,
        items_need_improvement = improvement_count,
        critical_issues = critical_count,
        improvement_deadline = CASE WHEN improvement_count > 0 THEN DATE_ADD(CURDATE(), INTERVAL 5 DAY) ELSE NULL END,
        status = CASE WHEN improvement_count > 0 THEN 'pending_improvement' ELSE 'completed' END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.record_id;
    
    -- 自動標記需要改善的項目
    UPDATE inspection_details
    SET requires_improvement = CASE WHEN score < 0 THEN TRUE ELSE FALSE END,
        improvement_deadline = CASE WHEN score < 0 THEN DATE_ADD(CURDATE(), INTERVAL 5 DAY) ELSE NULL END
    WHERE id = NEW.id;
    
END$$

DELIMITER ;