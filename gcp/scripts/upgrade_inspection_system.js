#!/usr/bin/env node
/**
 * 巡店考核系統升級 - 支持新評分系統和照片功能
 */

import pool from '../lib/db.js';

async function upgradeInspectionSystem() {
    console.log('🔧 開始升級巡店考核系統...');

    try {
        await pool.query('BEGIN');

        // 1. 更新 inspection_details 表支持新的評分系統
        console.log('📊 升級評分系統...');
        
        // 檢查是否已有 score 欄位
        const { rows: columnCheck } = await pool.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'inspection_details' AND column_name = 'score'
        `);
        
        if (columnCheck.length === 0) {
            await pool.query(`
                ALTER TABLE inspection_details 
                ADD COLUMN score INTEGER DEFAULT NULL,
                ADD COLUMN score_level VARCHAR(20) DEFAULT NULL
            `);
            console.log('✅ 已添加評分欄位');
        }

        // 2. 創建問題照片表
        console.log('📸 創建問題照片表...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inspection_problem_photos (
                id SERIAL PRIMARY KEY,
                detail_id INT NOT NULL,
                record_id INT NOT NULL,
                store_id VARCHAR(50) NOT NULL,
                item_code VARCHAR(50) NOT NULL,
                
                photo_url VARCHAR(500) NOT NULL,
                photo_filename VARCHAR(200),
                photo_size INT,
                photo_type VARCHAR(20) DEFAULT 'problem',
                
                uploaded_by VARCHAR(100) NOT NULL,
                uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                description TEXT,
                
                FOREIGN KEY (detail_id) REFERENCES inspection_details(id) ON DELETE CASCADE,
                FOREIGN KEY (record_id) REFERENCES inspection_records(id) ON DELETE CASCADE
            )
        `);
        console.log('✅ 問題照片表已創建');

        // 3. 更新改善照片表，增加審核功能
        console.log('🔍 升級改善照片審核...');
        
        const { rows: reviewColumns } = await pool.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'improvement_photos' AND column_name = 'score_adjustment'
        `);
        
        if (reviewColumns.length === 0) {
            await pool.query(`
                ALTER TABLE improvement_photos 
                ADD COLUMN score_adjustment INT DEFAULT 0,
                ADD COLUMN review_score INT DEFAULT NULL,
                ADD COLUMN review_level VARCHAR(20) DEFAULT NULL
            `);
            console.log('✅ 改善照片審核功能已升級');
        }

        // 4. 創建快速重檢表
        console.log('⚡ 創建快速重檢功能...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inspection_quick_recheck (
                id SERIAL PRIMARY KEY,
                original_record_id INT NOT NULL,
                store_id VARCHAR(50) NOT NULL,
                store_name VARCHAR(100) NOT NULL,
                
                recheck_items JSONB NOT NULL,  -- 需要重檢的項目
                recheck_date DATE,
                recheck_by VARCHAR(100),
                recheck_status VARCHAR(20) DEFAULT 'pending',
                
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP DEFAULT NULL,
                
                FOREIGN KEY (original_record_id) REFERENCES inspection_records(id)
            )
        `);
        console.log('✅ 快速重檢表已創建');

        // 5. 更新 inspection_records 表支持待審核狀態
        console.log('📋 更新記錄狀態...');
        await pool.query(`
            ALTER TABLE inspection_records 
            ALTER COLUMN status TYPE VARCHAR(30),
            DROP CONSTRAINT IF EXISTS inspection_records_status_check
        `);
        
        await pool.query(`
            ALTER TABLE inspection_records 
            ADD CONSTRAINT inspection_records_status_check 
            CHECK (status IN ('in_progress', 'completed', 'pending_improvement', 'pending_review', 'under_review', 'closed'))
        `);
        console.log('✅ 記錄狀態已更新');

        // 6. 創建建議功能表
        console.log('💡 創建頁面建議功能...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS page_suggestions (
                id SERIAL PRIMARY KEY,
                page_name VARCHAR(100) NOT NULL,
                user_name VARCHAR(100) NOT NULL,
                suggestion_text TEXT NOT NULL,
                
                status VARCHAR(20) DEFAULT 'pending',
                admin_response TEXT DEFAULT NULL,
                
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ 頁面建議表已創建');

        await pool.query('COMMIT');
        console.log('🎉 巡店考核系統升級完成！');

        // 7. 驗證升級
        console.log('✅ 驗證升級結果...');
        const { rows: tables } = await pool.query(`
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name LIKE '%inspection%'
            ORDER BY table_name
        `);
        
        console.log('📋 升級後的表結構:');
        tables.forEach(table => {
            console.log(`  ✅ ${table.table_name}`);
        });

        return true;

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('❌ 升級失敗:', error);
        return false;
    } finally {
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    upgradeInspectionSystem().then(success => {
        process.exit(success ? 0 : 1);
    });
}

export default upgradeInspectionSystem;