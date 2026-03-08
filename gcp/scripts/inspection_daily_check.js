#!/usr/bin/env node
/**
 * 巡店考核每日檢查腳本
 * 每天早上執行，檢查需要提醒的巡店和改善項目
 */

import pool from '../lib/db.js';

// Telegram 通知模板
const NOTIFICATION_TEMPLATES = {
    inspection_due_soon: (store, days) => 
        `📅 【巡店提醒】${store} 還有 ${days} 天需要巡店，請安排時間！`,
    
    inspection_overdue: (store, overdueDays) => 
        `⚠️ 【巡店逾期】${store} 巡店已逾期 ${overdueDays} 天，請立即處理！`,
    
    improvement_due_soon: (store, items, deadline) => 
        `📸 【改善提醒】${store} 有 ${items} 項需要在 ${deadline} 前上傳改善照片`,
    
    improvement_overdue: (store, items, overdueDays) => 
        `🚨 【改善逾期】${store} 有 ${items} 項改善照片已逾期 ${overdueDays} 天！`
};

// 泡泡貓所有門市資料
const ALL_STORES = [
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
    // 更多門市...
];

async function checkInspectionSchedules() {
    console.log('📅 檢查巡店計劃...');
    
    try {
        // 查詢需要提醒的巡店
        const { rows: alerts } = await pool.query(`
            SELECT 
                store_id,
                store_name,
                scheduled_date,
                CASE 
                    WHEN scheduled_date < CURRENT_DATE THEN CURRENT_DATE - scheduled_date
                    ELSE 0
                END as overdue_days,
                CASE
                    WHEN scheduled_date < CURRENT_DATE THEN 0
                    ELSE scheduled_date - CURRENT_DATE  
                END as days_until_due,
                CASE
                    WHEN scheduled_date < CURRENT_DATE THEN TRUE
                    ELSE FALSE
                END as is_overdue
            FROM inspection_schedules
            WHERE quarter = CONCAT(EXTRACT(YEAR FROM CURRENT_DATE), 'Q', EXTRACT(QUARTER FROM CURRENT_DATE))
              AND status IN ('pending', 'scheduled')
              AND (
                  scheduled_date < CURRENT_DATE OR  -- 已逾期
                  scheduled_date - CURRENT_DATE <= 3  -- 3天內到期
              )
              AND store_id NOT IN (
                  SELECT store_id FROM inspection_notifications
                  WHERE DATE(sent_at) = CURRENT_DATE
                    AND notification_type IN ('due_soon', 'overdue')
              )
        `);

        const notifications = [];

        for (const alert of alerts) {
            let message;
            let notificationType;

            if (alert.is_overdue) {
                message = NOTIFICATION_TEMPLATES.inspection_overdue(
                    alert.store_name, 
                    alert.overdue_days
                );
                notificationType = 'overdue';
            } else {
                message = NOTIFICATION_TEMPLATES.inspection_due_soon(
                    alert.store_name,
                    alert.days_until_due
                );
                notificationType = 'due_soon';
            }

            notifications.push({
                store_id: alert.store_id,
                message,
                type: notificationType,
                priority: alert.is_overdue ? 'high' : 'medium'
            });
        }

        return notifications;

    } catch (error) {
        console.error('❌ 檢查巡店計劃錯誤:', error);
        return [];
    }
}

async function checkImprovementDeadlines() {
    console.log('📸 檢查改善項目截止期限...');
    
    try {
        // 查詢即將到期和已逾期的改善項目
        const { rows: improvements } = await pool.query(`
            SELECT 
                ir.store_id,
                ir.store_name,
                COUNT(id.id) as improvement_items,
                ir.improvement_deadline,
                CASE 
                    WHEN ir.improvement_deadline < CURRENT_DATE 
                    THEN CURRENT_DATE - ir.improvement_deadline
                    ELSE 0
                END as overdue_days,
                CASE
                    WHEN ir.improvement_deadline < CURRENT_DATE 
                    THEN 0
                    ELSE ir.improvement_deadline - CURRENT_DATE  
                END as days_until_due,
                CASE
                    WHEN ir.improvement_deadline < CURRENT_DATE 
                    THEN TRUE
                    ELSE FALSE
                END as is_overdue
            FROM inspection_records ir
            JOIN inspection_details id ON ir.id = id.record_id
            WHERE ir.status = 'pending_improvement'
              AND id.requires_improvement = TRUE
              AND id.id NOT IN (
                  SELECT ip.detail_id FROM improvement_photos ip
                  WHERE ip.review_status = 'approved'
              )
              AND (
                  ir.improvement_deadline < CURRENT_DATE OR  -- 已逾期
                  ir.improvement_deadline - CURRENT_DATE <= 1  -- 1天內到期
              )
              AND ir.store_id NOT IN (
                  SELECT store_id FROM inspection_notifications
                  WHERE DATE(sent_at) = CURRENT_DATE
                    AND notification_type IN ('improvement_due', 'improvement_overdue')
              )
            GROUP BY ir.id, ir.store_id, ir.store_name, ir.improvement_deadline
        `);

        const notifications = [];

        for (const improvement of improvements) {
            let message;
            let notificationType;

            if (improvement.is_overdue) {
                message = NOTIFICATION_TEMPLATES.improvement_overdue(
                    improvement.store_name,
                    improvement.improvement_items,
                    improvement.overdue_days
                );
                notificationType = 'improvement_overdue';
            } else {
                const deadline = new Date(improvement.improvement_deadline)
                    .toLocaleDateString('zh-TW');
                message = NOTIFICATION_TEMPLATES.improvement_due_soon(
                    improvement.store_name,
                    improvement.improvement_items,
                    deadline
                );
                notificationType = 'improvement_due';
            }

            notifications.push({
                store_id: improvement.store_id,
                message,
                type: notificationType,
                priority: improvement.is_overdue ? 'urgent' : 'high'
            });
        }

        return notifications;

    } catch (error) {
        console.error('❌ 檢查改善期限錯誤:', error);
        return [];
    }
}

async function recordNotification(storeId, type, message) {
    try {
        await pool.query(`
            INSERT INTO inspection_notifications (store_id, notification_type, recipient, message)
            VALUES ($1, $2, '總公司', $3)
        `, [storeId, type, message]);
    } catch (error) {
        console.error('記錄通知失敗:', error);
    }
}

async function sendTelegramNotification(message, priority = 'medium') {
    // TODO: 整合現有的 Telegram 通知系統
    // 根據優先級選擇不同的發送目標
    const targets = {
        urgent: '7956245081', // Robby 私訊
        high: '-5220564261',  // 辦公室群組
        medium: '-5220564261' // 辦公室群組
    };

    console.log(`📢 [${priority.toUpperCase()}] ${message}`);
    // 實際發送邏輯待整合
}

async function generateQuarterlySchedule() {
    console.log('📋 檢查季度巡店計劃...');
    
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentQuarter = Math.ceil((currentDate.getMonth() + 1) / 3);
    const quarter = `${currentYear}Q${currentQuarter}`;

    try {
        // 檢查本季是否已有計劃
        const { rows: existingSchedule } = await pool.query(`
            SELECT COUNT(*) as count FROM inspection_schedules 
            WHERE quarter = $1
        `, [quarter]);

        if (existingSchedule[0].count > 0) {
            console.log(`✅ ${quarter} 巡店計劃已存在`);
            return;
        }

        console.log(`📝 創建 ${quarter} 巡店計劃...`);

        // 計算本季的巡店日期分布
        const quarterStartMonth = (currentQuarter - 1) * 3 + 1;
        const quarterEndMonth = currentQuarter * 3;
        
        // 為每間門市安排巡店日期
        for (const [index, store] of ALL_STORES.entries()) {
            // 平均分配到整季
            const targetMonth = quarterStartMonth + (index % 3);
            const targetDay = 10 + (index % 20); // 10-29日之間
            const scheduledDate = new Date(currentYear, targetMonth - 1, targetDay);

            // 週末調整到週一
            if (scheduledDate.getDay() === 0) { // 週日
                scheduledDate.setDate(scheduledDate.getDate() + 1);
            } else if (scheduledDate.getDay() === 6) { // 週六
                scheduledDate.setDate(scheduledDate.getDate() + 2);
            }

            // 設定優先級（問題較多的店優先）
            const priority = store.type === 'franchise' ? 3 : 2; // 加盟店優先

            await pool.query(`
                INSERT INTO inspection_schedules 
                (store_id, store_name, quarter, scheduled_date, inspector_name, priority, status)
                VALUES ($1, $2, $3, $4, '圓圓', $5, 'pending')
            `, [store.id, store.name, quarter, scheduledDate, priority]);
        }

        console.log(`✅ 已創建 ${ALL_STORES.length} 間門市的 ${quarter} 巡店計劃`);

    } catch (error) {
        console.error('❌ 創建季度巡店計劃錯誤:', error);
    }
}

async function main() {
    console.log('🏪 泡泡貓巡店考核每日檢查開始...');
    console.log(`⏰ 執行時間: ${new Date().toLocaleString('zh-TW')}`);

    try {
        // 1. 檢查並創建季度計劃
        await generateQuarterlySchedule();

        // 2. 檢查巡店提醒
        const inspectionNotifications = await checkInspectionSchedules();

        // 3. 檢查改善項目提醒
        const improvementNotifications = await checkImprovementDeadlines();

        // 4. 合併所有通知
        const allNotifications = [
            ...inspectionNotifications,
            ...improvementNotifications
        ];

        // 5. 發送通知
        if (allNotifications.length > 0) {
            console.log(`📢 發送 ${allNotifications.length} 條通知...`);

            // 按優先級分組
            const groupedNotifications = {
                urgent: allNotifications.filter(n => n.priority === 'urgent'),
                high: allNotifications.filter(n => n.priority === 'high'),
                medium: allNotifications.filter(n => n.priority === 'medium')
            };

            // 發送緊急通知
            for (const notification of groupedNotifications.urgent) {
                await sendTelegramNotification(notification.message, 'urgent');
                await recordNotification(notification.store_id, notification.type, notification.message);
            }

            // 合併一般通知
            const regularNotifications = [
                ...groupedNotifications.high,
                ...groupedNotifications.medium
            ];

            if (regularNotifications.length > 0) {
                const summaryMessage = `📊 【巡店考核每日提醒】\n\n${regularNotifications.map(n => n.message).join('\n\n')}`;
                await sendTelegramNotification(summaryMessage, 'medium');

                // 記錄所有通知
                for (const notification of regularNotifications) {
                    await recordNotification(notification.store_id, notification.type, notification.message);
                }
            }

            console.log(`✅ 通知發送完成`);
        } else {
            console.log('✅ 今日無需要提醒的項目');
        }

        // 6. 統計信息
        const { rows: stats } = await pool.query(`
            SELECT 
                COUNT(*) as total_stores,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
                COUNT(CASE WHEN status = 'overdue' THEN 1 END) as overdue
            FROM inspection_schedules
            WHERE quarter = CONCAT(EXTRACT(YEAR FROM CURRENT_DATE), 'Q', EXTRACT(QUARTER FROM CURRENT_DATE))
        `);

        console.log('📊 本季巡店統計:');
        console.log(`   總門市: ${stats[0].total_stores}`);
        console.log(`   已完成: ${stats[0].completed}`);
        console.log(`   待巡店: ${stats[0].pending}`);
        console.log(`   已逾期: ${stats[0].overdue}`);

        console.log('🎉 巡店考核每日檢查完成');
        return true;

    } catch (error) {
        console.error('❌ 每日檢查執行錯誤:', error);
        
        // 發送錯誤通知
        await sendTelegramNotification(
            `🚨 【系統錯誤】巡店考核每日檢查執行失敗: ${error.message}`,
            'urgent'
        );
        
        return false;
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().then(success => {
        process.exit(success ? 0 : 1);
    });
}

export { main as inspectionDailyCheck };