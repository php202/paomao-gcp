#!/usr/bin/env node
/**
 * 重新生成巡店計劃 - 只包含加盟店
 */

import pool from '../lib/db.js';

async function regenerateInspectionSchedules() {
    console.log('🔄 重新生成巡店計劃 - 只包含加盟店...');

    try {
        await pool.query('BEGIN');

        // 1. 先備份現有的巡店記錄
        console.log('📋 檢查現有的巡店記錄...');
        const { rows: existingRecords } = await pool.query(`
            SELECT COUNT(*) as count FROM inspection_records
        `);
        console.log(`⚠️  現有 ${existingRecords[0].count} 筆巡店記錄，將會保留`);

        // 2. 取得所有加盟店
        const { rows: franchiseStores } = await pool.query(`
            SELECT id, store_name, store_type, company
            FROM stores 
            WHERE store_type = 'franchise' 
              AND is_active = TRUE
            ORDER BY store_name
        `);

        console.log(`\n🏪 找到 ${franchiseStores.length} 間加盟店:`);
        franchiseStores.forEach(store => {
            console.log(`  ✅ [${store.id}] ${store.store_name} - ${store.company || '未設定公司'}`);
        });

        // 3. 清除現有的巡店計劃（保留有記錄的）
        console.log('\n🧹 清除無記錄的舊巡店計劃...');
        const { rowCount: deletedCount } = await pool.query(`
            DELETE FROM inspection_schedules 
            WHERE id NOT IN (
                SELECT DISTINCT schedule_id 
                FROM inspection_records 
                WHERE schedule_id IS NOT NULL
            )
        `);
        console.log(`🗑️  清除了 ${deletedCount} 筆無記錄的巡店計劃`);

        // 4. 為每間加盟店生成 2026 Q1 巡店計劃
        console.log('\n📅 生成 2026 Q1 加盟店巡店計劃...');
        const quarter = '2026Q1';
        const year = 2026;

        let insertCount = 0;
        for (const store of franchiseStores) {
            // 檢查是否已存在該店的 Q1 計劃
            const { rows: existing } = await pool.query(`
                SELECT id FROM inspection_schedules 
                WHERE store_id = $1 AND quarter = $2
            `, [store.id.toString(), quarter]);

            if (existing.length === 0) {
                // 隨機分配檢查日期（1月到3月）
                const baseDate = new Date('2026-01-15');
                const randomDays = Math.floor(Math.random() * 75); // 0-74天
                const scheduledDate = new Date(baseDate.getTime() + randomDays * 24 * 60 * 60 * 1000);
                
                const { rows: inserted } = await pool.query(`
                    INSERT INTO inspection_schedules 
                    (store_id, store_name, quarter, scheduled_date, 
                     priority, status, created_at)
                    VALUES ($1, $2, $3, $4, $5, 'scheduled', CURRENT_TIMESTAMP)
                    RETURNING id
                `, [
                    store.id.toString(), 
                    store.store_name, 
                    quarter, 
                    scheduledDate.toISOString().split('T')[0],
                    Math.floor(Math.random() * 5) + 1 // 隨機優先級 1-5
                ]);

                console.log(`  ✅ [${inserted[0].id}] ${store.store_name} - ${scheduledDate.toLocaleDateString()}`);
                insertCount++;
            } else {
                console.log(`  ⏭️  ${store.store_name} - 已存在計劃 (ID: ${existing[0].id})`);
            }
        }

        await pool.query('COMMIT');
        
        console.log(`\n🎉 巡店計劃重新生成完成！`);
        console.log(`   📊 總加盟店: ${franchiseStores.length} 間`);
        console.log(`   ➕ 新增計劃: ${insertCount} 筆`);
        console.log(`   📋 現有計劃: ${franchiseStores.length - insertCount} 筆`);

        // 5. 驗證結果
        console.log('\n✅ 驗證結果:');
        const { rows: summary } = await pool.query(`
            SELECT 
                st.store_type as actual_store_type,
                COUNT(*) as count,
                array_agg(s.store_name ORDER BY s.store_name) as stores
            FROM inspection_schedules s
            LEFT JOIN stores st ON s.store_id = st.id::text
            WHERE s.quarter = $1
            GROUP BY st.store_type
            ORDER BY count DESC
        `, [quarter]);

        summary.forEach(row => {
            console.log(`📊 店家分類: ${row.actual_store_type || '未知'} | 數量: ${row.count}`);
            if (row.count <= 5) {
                row.stores.forEach(store => console.log(`   - ${store}`));
            } else {
                row.stores.slice(0, 3).forEach(store => console.log(`   - ${store}`));
                console.log(`   ... 還有 ${row.count - 3} 間`);
            }
        });

        return true;

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('❌ 重新生成失敗:', error);
        return false;
    } finally {
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    regenerateInspectionSchedules().then(success => {
        process.exit(success ? 0 : 1);
    });
}

export default regenerateInspectionSchedules;