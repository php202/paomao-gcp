#!/usr/bin/env node
/**
 * 巡店考核系統 - 自動提醒腳本
 * 每日運行，檢查：
 * 1. 即將到期的巡店計劃
 * 2. 已逾期的巡店計劃
 * 3. 待改善項目的提醒
 * 4. 改善照片審核提醒
 */

import pool from '../lib/db.js';
import fetch from 'node-fetch';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '8520607475:AAHKn1oBOmTGloSzvM_Y0ps41tigRG3torc';
const TG_OFFICE_GROUP = '-5220564261'; // 泡泡貓辦公室群組
const TG_ROBBY_CHAT = '7956245081'; // Robby 私訊

class InspectionReminder {
    constructor() {
        this.today = new Date();
        this.reminderSent = new Set();
    }

    async run() {
        console.log('🔔 巡店考核提醒系統啟動');
        console.log(`📅 執行日期: ${this.today.toLocaleDateString()}`);

        try {
            await this.checkUpcomingInspections();
            await this.checkOverdueInspections();
            await this.checkImprovementDeadlines();
            await this.checkPendingPhotos();
            
            console.log('✅ 提醒檢查完成');
        } catch (error) {
            console.error('❌ 提醒系統錯誤:', error);
            await this.sendErrorNotification(error);
        } finally {
            await pool.end();
        }
    }

    // 檢查即將到期的巡店計劃 (3天內)
    async checkUpcomingInspections() {
        const { rows: upcoming } = await pool.query(`
            SELECT store_id, store_name, scheduled_date, inspector_name
            FROM inspection_schedules
            WHERE status IN ('pending', 'scheduled')
              AND scheduled_date BETWEEN CURRENT_DATE + INTERVAL '1 day' AND CURRENT_DATE + INTERVAL '3 days'
            ORDER BY scheduled_date ASC
        `);

        if (upcoming.length > 0) {
            console.log(`⏰ 發現 ${upcoming.length} 個即將到期的巡店計劃`);
            
            const message = this.formatUpcomingMessage(upcoming);
            await this.sendTelegramMessage(TG_OFFICE_GROUP, message);
            
            // 記錄提醒
            for (const inspection of upcoming) {
                await this.recordNotification(inspection.store_id, 'due_soon', message);
            }
        }
    }

    // 檢查已逾期的巡店計劃
    async checkOverdueInspections() {
        const { rows: overdue } = await pool.query(`
            SELECT store_id, store_name, scheduled_date, inspector_name,
                   CURRENT_DATE - scheduled_date as days_overdue
            FROM inspection_schedules
            WHERE status IN ('pending', 'scheduled')
              AND scheduled_date < CURRENT_DATE
            ORDER BY days_overdue DESC
        `);

        if (overdue.length > 0) {
            console.log(`🚨 發現 ${overdue.length} 個逾期巡店計劃`);
            
            const message = this.formatOverdueMessage(overdue);
            await this.sendTelegramMessage(TG_OFFICE_GROUP, message);
            await this.sendTelegramMessage(TG_ROBBY_CHAT, `⚠️ 巡店逾期提醒\n\n${message}`);
            
            // 記錄提醒
            for (const inspection of overdue) {
                await this.recordNotification(inspection.store_id, 'overdue', message);
            }
        }
    }

    // 檢查改善項目截止日期
    async checkImprovementDeadlines() {
        // 檢查明天到期的改善項目
        const { rows: dueSoon } = await pool.query(`
            SELECT DISTINCT ir.store_name, ir.store_id, 
                   COUNT(*) as improvement_count,
                   ir.improvement_deadline
            FROM inspection_records ir
            JOIN inspection_details id ON ir.id = id.record_id
            WHERE ir.status = 'pending_improvement'
              AND ir.improvement_deadline = CURRENT_DATE + INTERVAL '1 day'
              AND id.requires_improvement = TRUE
              AND NOT EXISTS (
                  SELECT 1 FROM improvement_photos ip 
                  WHERE ip.detail_id = id.id AND ip.review_status = 'approved'
              )
            GROUP BY ir.store_name, ir.store_id, ir.improvement_deadline
        `);

        if (dueSoon.length > 0) {
            const message = this.formatImprovementDueMessage(dueSoon);
            await this.sendTelegramMessage(TG_OFFICE_GROUP, message);
            
            for (const store of dueSoon) {
                await this.recordNotification(store.store_id, 'improvement_due', message);
            }
        }

        // 檢查已逾期的改善項目
        const { rows: overdueImprovements } = await pool.query(`
            SELECT DISTINCT ir.store_name, ir.store_id, 
                   COUNT(*) as improvement_count,
                   CURRENT_DATE - ir.improvement_deadline as days_overdue
            FROM inspection_records ir
            JOIN inspection_details id ON ir.id = id.record_id
            WHERE ir.status = 'pending_improvement'
              AND ir.improvement_deadline < CURRENT_DATE
              AND id.requires_improvement = TRUE
              AND NOT EXISTS (
                  SELECT 1 FROM improvement_photos ip 
                  WHERE ip.detail_id = id.id AND ip.review_status = 'approved'
              )
            GROUP BY ir.store_name, ir.store_id, ir.improvement_deadline
        `);

        if (overdueImprovements.length > 0) {
            const message = this.formatImprovementOverdueMessage(overdueImprovements);
            await this.sendTelegramMessage(TG_ROBBY_CHAT, message);
            
            for (const store of overdueImprovements) {
                await this.recordNotification(store.store_id, 'improvement_overdue', message);
            }
        }
    }

    // 檢查待審核的改善照片
    async checkPendingPhotos() {
        const { rows: pendingPhotos } = await pool.query(`
            SELECT COUNT(*) as pending_count,
                   COUNT(CASE WHEN uploaded_at < CURRENT_DATE - INTERVAL '2 days' THEN 1 END) as old_pending
            FROM improvement_photos
            WHERE review_status = 'pending'
        `);

        const pending = pendingPhotos[0];
        
        if (pending.pending_count > 0) {
            console.log(`📸 發現 ${pending.pending_count} 張待審核照片 (${pending.old_pending} 張超過2天)`);
            
            if (pending.old_pending > 0) {
                const message = `📸 改善照片待審核提醒\n\n` +
                    `總共 ${pending.pending_count} 張待審核\n` +
                    `其中 ${pending.old_pending} 張已超過2天\n\n` +
                    `請儘快到巡店考核系統審核：\n` +
                    `https://dashboard.paopaomao.tw/inspection`;
                
                await this.sendTelegramMessage(TG_ROBBY_CHAT, message);
            }
        }
    }

    formatUpcomingMessage(inspections) {
        const lines = ['⏰ 即將到期的巡店計劃', ''];
        
        for (const inspection of inspections) {
            const date = new Date(inspection.scheduled_date);
            const daysDiff = Math.ceil((date - this.today) / (1000 * 60 * 60 * 24));
            
            lines.push(`📍 ${inspection.store_name}`);
            lines.push(`⏰ ${date.toLocaleDateString()} (${daysDiff}天後)`);
            lines.push(`👤 負責人: ${inspection.inspector_name || '未指派'}`);
            lines.push('');
        }
        
        lines.push('🔗 巡店系統: https://dashboard.paopaomao.tw/inspection');
        return lines.join('\n');
    }

    formatOverdueMessage(inspections) {
        const lines = ['🚨 已逾期的巡店計劃', ''];
        
        for (const inspection of inspections) {
            const date = new Date(inspection.scheduled_date);
            
            lines.push(`📍 ${inspection.store_name}`);
            lines.push(`⏰ 預定: ${date.toLocaleDateString()}`);
            lines.push(`🚨 已逾期 ${inspection.days_overdue} 天`);
            lines.push(`👤 負責人: ${inspection.inspector_name || '未指派'}`);
            lines.push('');
        }
        
        lines.push('請儘快安排巡店！');
        lines.push('🔗 巡店系統: https://dashboard.paopaomao.tw/inspection');
        return lines.join('\n');
    }

    formatImprovementDueMessage(stores) {
        const lines = ['⚠️ 改善項目即將到期 (明天)', ''];
        
        for (const store of stores) {
            const deadline = new Date(store.improvement_deadline);
            lines.push(`📍 ${store.store_name}`);
            lines.push(`📊 待改善項目: ${store.improvement_count}個`);
            lines.push(`⏰ 截止日期: ${deadline.toLocaleDateString()}`);
            lines.push('');
        }
        
        lines.push('請提醒門市上傳改善照片！');
        return lines.join('\n');
    }

    formatImprovementOverdueMessage(stores) {
        const lines = ['🚨 改善項目已逾期', ''];
        
        for (const store of stores) {
            lines.push(`📍 ${store.store_name}`);
            lines.push(`📊 逾期項目: ${store.improvement_count}個`);
            lines.push(`🚨 已逾期 ${store.days_overdue} 天`);
            lines.push('');
        }
        
        lines.push('需要立即跟進處理！');
        lines.push('🔗 巡店系統: https://dashboard.paopaomao.tw/inspection');
        return lines.join('\n');
    }

    async sendTelegramMessage(chatId, text) {
        if (!TG_BOT_TOKEN) {
            console.warn('⚠️ TG_BOT_TOKEN 未設定，跳過發送');
            return;
        }

        try {
            const response = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                })
            });

            const result = await response.json();
            
            if (!result.ok) {
                console.error('❌ Telegram 發送失敗:', result);
            } else {
                console.log(`✅ Telegram 訊息已發送至 ${chatId}`);
            }
        } catch (error) {
            console.error('❌ Telegram 發送錯誤:', error);
        }
    }

    async recordNotification(storeId, type, message) {
        try {
            await pool.query(`
                INSERT INTO inspection_notifications (store_id, notification_type, recipient, message)
                VALUES ($1, $2, $3, $4)
            `, [storeId, type, 'system', message]);
        } catch (error) {
            console.error('記錄提醒失敗:', error);
        }
    }

    async sendErrorNotification(error) {
        const message = `❌ 巡店提醒系統錯誤\n\n` +
            `錯誤時間: ${new Date().toLocaleString()}\n` +
            `錯誤訊息: ${error.message}\n\n` +
            `請檢查系統狀態。`;
        
        await this.sendTelegramMessage(TG_ROBBY_CHAT, message);
    }
}

// 執行提醒檢查
async function main() {
    const reminder = new InspectionReminder();
    await reminder.run();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export default InspectionReminder;