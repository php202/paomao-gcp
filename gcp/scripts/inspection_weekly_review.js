#!/usr/bin/env node
/**
 * 巡店考核系統 - 每週檢視報告
 */

import pool from '../lib/db.js';
import fetch from 'node-fetch';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '8520607475:AAHKn1oBOmTGloSzvM_Y0ps41tigRG3torc';
const TG_ROBBY_CHAT = '7956245081';

async function generateWeeklyReport() {
    console.log('📊 生成每週巡店檢視報告...');
    
    const currentQuarter = `${new Date().getFullYear()}Q${Math.ceil((new Date().getMonth() + 1) / 3)}`;
    
    try {
        // 1. 本季進度統計
        const { rows: progress } = await pool.query(`
            SELECT 
                COUNT(*) as total_planned,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
                COUNT(CASE WHEN scheduled_date < CURRENT_DATE AND status != 'completed' THEN 1 END) as overdue
            FROM inspection_schedules 
            WHERE quarter = $1
        `, [currentQuarter]);

        // 2. 本週完成的巡店
        const { rows: thisWeek } = await pool.query(`
            SELECT ir.store_name, ir.final_score, ir.grade, ir.inspection_date
            FROM inspection_records ir
            WHERE ir.inspection_date >= CURRENT_DATE - INTERVAL '7 days'
            ORDER BY ir.final_score DESC
        `);

        // 3. 下週計劃的巡店
        const { rows: nextWeek } = await pool.query(`
            SELECT store_name, scheduled_date, inspector_name
            FROM inspection_schedules
            WHERE scheduled_date BETWEEN CURRENT_DATE + INTERVAL '1 day' AND CURRENT_DATE + INTERVAL '8 days'
              AND status IN ('pending', 'scheduled')
            ORDER BY scheduled_date ASC
        `);

        // 4. 需要關注的門市
        const { rows: alerts } = await pool.query(`
            SELECT store_name, scheduled_date, 
                   CURRENT_DATE - scheduled_date as days_overdue
            FROM inspection_schedules
            WHERE scheduled_date < CURRENT_DATE 
              AND status IN ('pending', 'scheduled')
            ORDER BY days_overdue DESC
            LIMIT 5
        `);

        // 生成報告
        const report = generateReportMessage(currentQuarter, progress[0], thisWeek, nextWeek, alerts);
        
        // 發送報告
        await sendTelegramMessage(TG_ROBBY_CHAT, report);
        
        console.log('✅ 每週報告已發送');
        
    } catch (error) {
        console.error('❌ 生成報告失敗:', error);
    } finally {
        await pool.end();
    }
}

function generateReportMessage(quarter, progress, thisWeek, nextWeek, alerts) {
    const lines = [
        '📊 巡店考核系統週報',
        `📅 ${new Date().toLocaleDateString()} (${quarter})`,
        '',
        '■ 本季進度概況',
        `  ├ 計劃巡店: ${progress.total_planned} 間`,
        `  ├ 已完成: ${progress.completed} 間 (${Math.round(progress.completed / progress.total_planned * 100)}%)`,
        `  └ 已逾期: ${progress.overdue} 間`,
        ''
    ];

    if (thisWeek.length > 0) {
        lines.push('■ 本週完成巡店');
        thisWeek.forEach(store => {
            lines.push(`  ├ ${store.store_name}: ${store.final_score}分 (${store.grade}級)`);
        });
        lines.push('');
    }

    if (nextWeek.length > 0) {
        lines.push('■ 下週計劃巡店');
        nextWeek.forEach(store => {
            const date = new Date(store.scheduled_date);
            lines.push(`  ├ ${store.store_name} (${date.toLocaleDateString()})`);
        });
        lines.push('');
    }

    if (alerts.length > 0) {
        lines.push('🚨 需要關注的門市');
        alerts.forEach(store => {
            lines.push(`  ├ ${store.store_name} - 逾期${store.days_overdue}天`);
        });
        lines.push('');
    }

    lines.push('🔗 巡店系統: https://dashboard.paopaomao.tw/inspection');
    
    return lines.join('\n');
}

async function sendTelegramMessage(chatId, text) {
    if (!TG_BOT_TOKEN) return;

    try {
        const response = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                disable_web_page_preview: true
            })
        });

        if (response.ok) {
            console.log('✅ Telegram 週報已發送');
        }
    } catch (error) {
        console.error('❌ 發送週報失敗:', error);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    generateWeeklyReport().catch(console.error);
}