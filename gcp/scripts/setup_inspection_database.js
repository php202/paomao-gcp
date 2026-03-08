#!/usr/bin/env node
/**
 * 泡泡貓巡店考核系統 - 數據庫初始化腳本
 */

import pool from '../lib/db.js';
import fs from 'fs/promises';

async function setupInspectionDatabase() {
    console.log('🏗️ 開始建立巡店考核系統數據庫...');

    try {
        await pool.query('BEGIN');

        // 1. 巡店檢核項目主表
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inspection_categories (
                id SERIAL PRIMARY KEY,
                category_name VARCHAR(100) NOT NULL,
                category_code VARCHAR(20) NOT NULL UNIQUE,
                sort_order INT DEFAULT 0,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ inspection_categories 表已建立');

        // 2. 巡店檢核細項表
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inspection_items (
                id SERIAL PRIMARY KEY,
                category_id INT NOT NULL,
                item_name VARCHAR(200) NOT NULL,
                item_code VARCHAR(50) NOT NULL UNIQUE,
                description TEXT,
                deduction_points INT DEFAULT 0,
                is_critical BOOLEAN DEFAULT FALSE,
                sort_order INT DEFAULT 0,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (category_id) REFERENCES inspection_categories(id)
            )
        `);
        console.log('✅ inspection_items 表已建立');

        // 3. 巡店計劃表
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inspection_schedules (
                id SERIAL PRIMARY KEY,
                store_id VARCHAR(50) NOT NULL,
                store_name VARCHAR(100) NOT NULL,
                quarter CHAR(6) NOT NULL,
                scheduled_date DATE,
                inspector_id INT,
                inspector_name VARCHAR(50),
                status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'scheduled', 'completed', 'overdue')),
                priority INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (store_id, quarter)
            )
        `);
        console.log('✅ inspection_schedules 表已建立');

        // 4. 巡店記錄主表
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inspection_records (
                id SERIAL PRIMARY KEY,
                schedule_id INT NOT NULL,
                store_id VARCHAR(50) NOT NULL,
                store_name VARCHAR(100) NOT NULL,
                store_type VARCHAR(20) NOT NULL CHECK (store_type IN ('direct', 'franchise')),
                inspection_date DATE NOT NULL,
                inspector_id INT NOT NULL,
                inspector_name VARCHAR(50) NOT NULL,
                
                total_items INT DEFAULT 0,
                passed_items INT DEFAULT 0,
                failed_items INT DEFAULT 0,
                deducted_points INT DEFAULT 0,
                final_score DECIMAL(5,2) DEFAULT 100.00,
                grade CHAR(2),
                
                status VARCHAR(20) DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'pending_improvement', 'closed')),
                improvement_deadline DATE,
                notes TEXT,
                
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                
                FOREIGN KEY (schedule_id) REFERENCES inspection_schedules(id)
            )
        `);
        console.log('✅ inspection_records 表已建立');

        // 5. 巡店檢核明細表
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inspection_details (
                id SERIAL PRIMARY KEY,
                record_id INT NOT NULL,
                item_id INT NOT NULL,
                item_code VARCHAR(50) NOT NULL,
                item_name VARCHAR(200) NOT NULL,
                
                result VARCHAR(10) NOT NULL CHECK (result IN ('pass', 'fail', 'na')),
                deduction_points INT DEFAULT 0,
                notes TEXT,
                
                requires_improvement BOOLEAN DEFAULT FALSE,
                improvement_required TEXT,
                improvement_deadline DATE,
                
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                
                FOREIGN KEY (record_id) REFERENCES inspection_records(id) ON DELETE CASCADE,
                FOREIGN KEY (item_id) REFERENCES inspection_items(id),
                UNIQUE (record_id, item_id)
            )
        `);
        console.log('✅ inspection_details 表已建立');

        // 6. 改善照片回傳表
        await pool.query(`
            CREATE TABLE IF NOT EXISTS improvement_photos (
                id SERIAL PRIMARY KEY,
                detail_id INT NOT NULL,
                record_id INT NOT NULL,
                store_id VARCHAR(50) NOT NULL,
                item_code VARCHAR(50) NOT NULL,
                
                photo_url VARCHAR(500) NOT NULL,
                photo_filename VARCHAR(200),
                photo_size INT,
                
                uploaded_by VARCHAR(100),
                uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                description TEXT,
                
                review_status VARCHAR(20) DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
                reviewed_by VARCHAR(100),
                reviewed_at TIMESTAMP,
                review_notes TEXT,
                
                FOREIGN KEY (detail_id) REFERENCES inspection_details(id) ON DELETE CASCADE,
                FOREIGN KEY (record_id) REFERENCES inspection_records(id) ON DELETE CASCADE
            )
        `);
        console.log('✅ improvement_photos 表已建立');

        // 7. 巡店提醒記錄表
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inspection_notifications (
                id SERIAL PRIMARY KEY,
                store_id VARCHAR(50) NOT NULL,
                notification_type VARCHAR(30) NOT NULL CHECK (notification_type IN ('due_soon', 'overdue', 'improvement_due', 'improvement_overdue')),
                recipient VARCHAR(100) NOT NULL,
                message TEXT NOT NULL,
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status VARCHAR(10) DEFAULT 'sent' CHECK (status IN ('sent', 'failed'))
            )
        `);
        console.log('✅ inspection_notifications 表已建立');

        await pool.query('COMMIT');
        console.log('🎉 數據庫表結構建立完成！');
        
        return true;
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('❌ 數據庫建立失敗:', error);
        return false;
    }
}

async function insertInitialData() {
    console.log('📊 插入初始檢核項目...');
    
    try {
        await pool.query('BEGIN');

        // 插入檢核大分類
        const categories = [
            ['法規遵循', 'LEGAL', 1],
            ['衛生管理', 'HYGIENE', 2],
            ['設備維護', 'EQUIPMENT', 3],
            ['環境清潔', 'CLEANLINESS', 4],
            ['服務區域', 'SERVICE_AREA', 5],
            ['員工規範', 'STAFF', 6]
        ];

        for (const [name, code, order] of categories) {
            await pool.query(`
                INSERT INTO inspection_categories (category_name, category_code, sort_order) 
                VALUES ($1, $2, $3) ON CONFLICT (category_code) DO NOTHING
            `, [name, code, order]);
        }
        console.log('✅ 檢核分類已插入');

        // 插入具體檢核項目
        const items = [
            // 法規遵循
            [1, '病媒防制措施記錄完整', 'LEGAL_001', 10, true, 1],
            [1, '中央空調冷卻水塔清潔記錄', 'LEGAL_002', 8, true, 2],
            [1, '員工契約書完整', 'LEGAL_003', 15, true, 3],
            [1, '員工健康檢查記錄', 'LEGAL_004', 12, true, 4],
            [1, '營業場所滅火器配備', 'LEGAL_005', 20, true, 5],

            // 衛生管理
            [2, '工具消毒設備完善', 'HYGIENE_001', 15, true, 1],
            [2, '客用工具清潔消毒落實', 'HYGIENE_002', 12, true, 2],
            [2, '身體接觸品清潔軟紙使用', 'HYGIENE_003', 8, true, 3],
            [2, '專用針管標示與保存', 'HYGIENE_004', 10, true, 4],
            [2, '凍晶粉保存期限標示', 'HYGIENE_005', 10, true, 5],
            [2, '酒精配置充足', 'HYGIENE_006', 5, false, 6],

            // 設備維護
            [3, '負氫離子機清潔度', 'EQUIPMENT_001', 8, false, 1],
            [3, '泡沖機清潔狀況', 'EQUIPMENT_002', 8, false, 2],
            [3, '殺菌消毒箱清潔度', 'EQUIPMENT_003', 10, true, 3],
            [3, '小氣泡機定期清洗', 'EQUIPMENT_004', 8, false, 4],
            [3, '水光槍定期清洗', 'EQUIPMENT_005', 8, false, 5],
            [3, '熱蒸機清潔保養', 'EQUIPMENT_006', 8, false, 6],
            [3, '台車清潔與防鏽', 'EQUIPMENT_007', 5, false, 7],

            // 環境清潔
            [4, '廁所清潔記錄表落實', 'CLEAN_001', 12, true, 1],
            [4, '廁所垃圾桶加蓋', 'CLEAN_002', 5, false, 2],
            [4, '客人接待區整潔', 'CLEAN_003', 8, false, 3],
            [4, '收銀櫃台整潔', 'CLEAN_004', 8, false, 4],
            [4, '地板清潔度', 'CLEAN_005', 8, false, 5],
            [4, '洗手台清潔度', 'CLEAN_006', 8, false, 6],

            // 服務區域
            [5, '肌膚檢測區整潔度', 'SERVICE_001', 10, false, 1],
            [5, '工作站清潔整理', 'SERVICE_002', 12, false, 2],
            [5, '潔面刷清潔無發霉', 'SERVICE_003', 15, true, 3],
            [5, '刮棒平整光滑', 'SERVICE_004', 8, false, 4],
            [5, '探頭清潔度', 'SERVICE_005', 8, false, 5],
            [5, '電視開啟狀況', 'SERVICE_006', 3, false, 6],

            // 員工規範
            [6, '服裝儀容清潔消毒', 'STAFF_001', 12, true, 1],
            [6, '指甲長度顏色清潔度', 'STAFF_002', 8, false, 2],
            [6, '口罩配戴規範', 'STAFF_003', 10, true, 3],
            [6, '妨礙公衛行為防治', 'STAFF_004', 15, true, 4]
        ];

        for (const [catId, name, code, points, critical, order] of items) {
            await pool.query(`
                INSERT INTO inspection_items (category_id, item_name, item_code, deduction_points, is_critical, sort_order)
                VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (item_code) DO NOTHING
            `, [catId, name, code, points, critical, order]);
        }
        console.log('✅ 檢核項目已插入');

        await pool.query('COMMIT');
        console.log('🎉 初始數據插入完成！');
        
        return true;
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('❌ 初始數據插入失敗:', error);
        return false;
    }
}

async function generateCurrentQuarterSchedule() {
    console.log('📅 生成本季巡店計劃...');
    
    const stores = [
        { id: '3677', name: '泡泡貓｜台南善化店', type: 'direct' },
        { id: '3151', name: '泡泡貓｜台南安南店', type: 'direct' },
        { id: '3678', name: '泡泡貓｜桃園南崁店', type: 'franchise' },
        { id: '3679', name: '泡泡貓｜小檜溪店', type: 'franchise' },
        { id: '3680', name: '泡泡貓｜楊梅金山店', type: 'franchise' },
        { id: '3681', name: '泡泡貓｜竹北光明店', type: 'franchise' },
        { id: '3682', name: '泡泡貓｜蘆洲集賢店', type: 'franchise' },
        { id: '3683', name: '泡泡貓｜新莊中平店', type: 'franchise' },
        { id: '3684', name: '泡泡貓｜土城中央店', type: 'franchise' },
        { id: '3685', name: '泡泡貓｜新竹公道店', type: 'franchise' },
        { id: '3686', name: '泡泡貓｜左營海軍店', type: 'franchise' },
        { id: '3687', name: '泡泡貓｜楠梓店', type: 'franchise' },
        { id: '3688', name: '泡泡貓｜平鎮店', type: 'franchise' }
    ];

    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentQuarter = Math.ceil((currentDate.getMonth() + 1) / 3);
    const quarter = `${currentYear}Q${currentQuarter}`;

    try {
        await pool.query('BEGIN');

        // 檢查是否已有本季計劃
        const { rows: existing } = await pool.query(`
            SELECT COUNT(*) as count FROM inspection_schedules WHERE quarter = $1
        `, [quarter]);

        if (existing[0].count > 0) {
            console.log(`✅ ${quarter} 巡店計劃已存在 (${existing[0].count} 間門市)`);
            await pool.query('COMMIT');
            return true;
        }

        // 計算本季日期範圍
        const quarterStartMonth = (currentQuarter - 1) * 3 + 1;
        
        for (const [index, store] of stores.entries()) {
            // 平均分配到本季剩餘月份
            const targetMonth = quarterStartMonth + (index % 3);
            const targetDay = 10 + (index % 20); // 10-29日
            const scheduledDate = new Date(currentYear, targetMonth - 1, targetDay);

            // 週末調整
            if (scheduledDate.getDay() === 0) scheduledDate.setDate(scheduledDate.getDate() + 1);
            if (scheduledDate.getDay() === 6) scheduledDate.setDate(scheduledDate.getDate() + 2);

            // 如果日期已過，調整到下個月
            if (scheduledDate < currentDate) {
                scheduledDate.setMonth(scheduledDate.getMonth() + 1);
            }

            const priority = store.type === 'franchise' ? 3 : 2;

            await pool.query(`
                INSERT INTO inspection_schedules 
                (store_id, store_name, quarter, scheduled_date, inspector_name, priority, status)
                VALUES ($1, $2, $3, $4, '圓圓', $5, 'pending')
            `, [store.id, store.name, quarter, scheduledDate, priority]);
        }

        await pool.query('COMMIT');
        console.log(`✅ ${quarter} 巡店計劃已生成 (${stores.length} 間門市)`);
        return true;

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('❌ 生成巡店計劃失敗:', error);
        return false;
    }
}

async function main() {
    console.log('🚀 泡泡貓巡店考核系統 - 數據庫初始化');
    console.log('=========================================');

    try {
        // 1. 建立數據庫結構
        const dbSetup = await setupInspectionDatabase();
        if (!dbSetup) throw new Error('數據庫建立失敗');

        // 2. 插入初始數據
        const dataSetup = await insertInitialData();
        if (!dataSetup) throw new Error('初始數據插入失敗');

        // 3. 生成本季巡店計劃
        const scheduleSetup = await generateCurrentQuarterSchedule();
        if (!scheduleSetup) throw new Error('巡店計劃生成失敗');

        // 4. 驗證設置
        const { rows: stats } = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM inspection_categories) as categories,
                (SELECT COUNT(*) FROM inspection_items) as items,
                (SELECT COUNT(*) FROM inspection_schedules) as schedules
        `);

        console.log('=========================================');
        console.log('🎉 數據庫初始化完成！');
        console.log(`📊 統計: ${stats[0].categories}個分類, ${stats[0].items}個檢核項目, ${stats[0].schedules}個巡店計劃`);
        
        return true;

    } catch (error) {
        console.error('❌ 初始化失敗:', error.message);
        return false;
    } finally {
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().then(success => process.exit(success ? 0 : 1));
}

export { setupInspectionDatabase, insertInitialData };