#!/usr/bin/env node
/**
 * 驗證巡店儀表板是否正確過濾只顯示加盟店
 */

import pool from '../lib/db.js';

async function verifyInspectionFranchiseFilter() {
    console.log('🔍 驗證巡店儀表板資料過濾...');

    try {
        const currentQuarter = `${new Date().getFullYear()}Q${Math.ceil((new Date().getMonth() + 1) / 3)}`;
        
        // 1. 檢查巡店計劃中的店家分類
        console.log(`📋 檢查 ${currentQuarter} 巡店計劃...`);
        const { rows: schedulesByType } = await pool.query(`
            SELECT 
                st.store_type,
                COUNT(*) as count,
                array_agg(s.store_name ORDER BY s.store_name) as stores
            FROM inspection_schedules s
            LEFT JOIN stores st ON s.store_id = st.id::text
            WHERE s.quarter = $1
            GROUP BY st.store_type
            ORDER BY count DESC
        `, [currentQuarter]);

        console.log('\n📊 巡店計劃按店家分類:');
        schedulesByType.forEach(type => {
            const emoji = type.store_type === 'franchise' ? '🏪' : 
                         type.store_type === 'direct' ? '🏢' : '❓';
            console.log(`\n${emoji} ${type.store_type || '未分類'}: ${type.count} 間`);
            
            if (type.count <= 5) {
                type.stores.forEach(store => console.log(`   ✅ ${store}`));
            } else {
                type.stores.slice(0, 3).forEach(store => console.log(`   ✅ ${store}`));
                console.log(`   ... 還有 ${type.count - 3} 間`);
            }
        });

        // 2. 驗證 API 查詢結果（模擬 dashboard API）
        console.log('\n🔍 驗證儀表板 API 查詢結果...');
        
        // 統計數據查詢
        const { rows: overview } = await pool.query(`
            SELECT 
                COUNT(*) as total_stores,
                COUNT(CASE WHEN s.scheduled_date < CURRENT_DATE AND s.status IN ('pending', 'scheduled') THEN 1 END) as overdue_inspections,
                COUNT(CASE WHEN s.status = 'pending' THEN 1 END) as pending_inspections,
                COUNT(CASE WHEN s.status = 'completed' THEN 1 END) as completed_this_quarter
            FROM inspection_schedules s
            LEFT JOIN stores st ON s.store_id = st.id::text
            WHERE s.quarter = $1 AND st.store_type = 'franchise'
        `, [currentQuarter]);

        console.log('\n📈 儀表板統計（只含加盟店）:');
        console.log(`   📊 總店數: ${overview[0].total_stores}`);
        console.log(`   ⏰ 過期檢查: ${overview[0].overdue_inspections}`);
        console.log(`   📋 待處理: ${overview[0].pending_inspections}`);
        console.log(`   ✅ 已完成: ${overview[0].completed_this_quarter}`);

        // 3. 檢查提醒列表（只含加盟店）
        const { rows: alerts } = await pool.query(`
            SELECT 
                s.id, s.store_name, s.scheduled_date,
                CASE 
                    WHEN s.scheduled_date < CURRENT_DATE THEN CURRENT_DATE - s.scheduled_date
                    ELSE s.scheduled_date - CURRENT_DATE  
                END as days_diff,
                CASE
                    WHEN s.scheduled_date < CURRENT_DATE THEN TRUE
                    ELSE FALSE
                END as is_overdue
            FROM inspection_schedules s
            LEFT JOIN stores st ON s.store_id = st.id::text
            WHERE s.quarter = $1 AND s.status IN ('pending', 'scheduled')
              AND st.store_type = 'franchise'
              AND (s.scheduled_date < CURRENT_DATE OR s.scheduled_date - CURRENT_DATE <= 7)
            ORDER BY is_overdue DESC, days_diff ASC
            LIMIT 10
        `, [currentQuarter]);

        console.log('\n🚨 需要提醒的加盟店:');
        if (alerts.length === 0) {
            console.log('   ✅ 目前沒有需要立即提醒的加盟店');
        } else {
            alerts.forEach(alert => {
                const status = alert.is_overdue ? '🔴 已過期' : '🟡 即將到期';
                console.log(`   ${status} ${alert.store_name} - ${alert.scheduled_date} (${Math.abs(alert.days_diff)} 天)`);
            });
        }

        // 4. 確認加盟店總數正確
        const { rows: totalFranchise } = await pool.query(`
            SELECT COUNT(*) as total FROM stores WHERE store_type = 'franchise' AND is_active = TRUE
        `);

        const scheduledFranchise = schedulesByType.find(t => t.store_type === 'franchise')?.count || 0;
        
        console.log('\n🎯 數據一致性檢查:');
        console.log(`   🏪 活躍加盟店總數: ${totalFranchise[0].total}`);
        console.log(`   📅 已安排巡店的加盟店: ${scheduledFranchise}`);
        
        if (totalFranchise[0].total == scheduledFranchise) {
            console.log('   ✅ 數據一致！所有加盟店都已安排巡店計劃');
        } else {
            const missing = totalFranchise[0].total - scheduledFranchise;
            console.log(`   ⚠️  有 ${missing} 間加盟店尚未安排巡店計劃`);
            
            // 找出遺漏的店家
            const { rows: missingStores } = await pool.query(`
                SELECT s.store_name, s.id
                FROM stores s
                WHERE s.store_type = 'franchise' AND s.is_active = TRUE
                  AND s.id::text NOT IN (
                    SELECT store_id FROM inspection_schedules WHERE quarter = $1
                  )
            `, [currentQuarter]);
            
            console.log('   遺漏的加盟店:');
            missingStores.forEach(store => {
                console.log(`     - [${store.id}] ${store.store_name}`);
            });
        }

        console.log('\n🎉 驗證完成！');
        
        // 總結
        const franchiseCount = schedulesByType.find(t => t.store_type === 'franchise')?.count || 0;
        const directCount = schedulesByType.find(t => t.store_type === 'direct')?.count || 0;
        const otherCount = schedulesByType.reduce((sum, t) => 
            sum + (t.store_type !== 'franchise' && t.store_type !== 'direct' ? t.count : 0), 0);

        console.log('\n📊 修正結果總結:');
        console.log(`   🏪 加盟店: ${franchiseCount} 間 (巡店對象)`);
        console.log(`   🏢 直營店: ${directCount} 間 (已排除)`);
        console.log(`   ❓ 其他: ${otherCount} 間 (已排除)`);
        
        if (franchiseCount === totalFranchise[0].total && directCount === 0 && otherCount === 0) {
            console.log('   ✅ 完美！巡店儀表板現在只顯示加盟店資料');
        } else if (franchiseCount === totalFranchise[0].total) {
            console.log('   ⚠️  加盟店資料正確，但仍有非加盟店出現在計劃中');
        } else {
            console.log('   ❌ 仍有資料不一致問題需要處理');
        }

    } catch (error) {
        console.error('❌ 驗證失敗:', error.message);
    } finally {
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    verifyInspectionFranchiseFilter();
}

export default verifyInspectionFranchiseFilter;