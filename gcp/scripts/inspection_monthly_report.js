#!/usr/bin/env node
/**
 * 巡店考核系統 - 月度統計報告
 */

import pool from '../lib/db.js';
import fetch from 'node-fetch';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '8520607475:AAHKn1oBOmTGloSzvM_Y0ps41tigRG3torc';
const TG_ROBBY_CHAT = '7956245081';

async function generateMonthlyReport() {
    console.log('📈 生成月度巡店統計報告...');
    
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    
    try {
        // 1. 上月巡店統計
        const { rows: monthlyStats } = await pool.query(`
            SELECT 
                COUNT(*) as total_inspections,
                ROUND(AVG(final_score), 1) as avg_score,
                COUNT(CASE WHEN grade IN ('A+', 'A') THEN 1 END) as excellent_count,
                COUNT(CASE WHEN grade = 'D' THEN 1 END) as poor_count,
                COUNT(CASE WHEN store_type = 'direct' THEN 1 END) as direct_count,
                COUNT(CASE WHEN store_type = 'franchise' THEN 1 END) as franchise_count
            FROM inspection_records
            WHERE inspection_date >= $1 AND inspection_date < $2
        `, [lastMonth, thisMonthStart]);

        // 2. 門市排名 (上月)
        const { rows: storeRankings } = await pool.query(`
            SELECT store_name, store_type, final_score, grade, inspection_date
            FROM inspection_records
            WHERE inspection_date >= $1 AND inspection_date < $2
            ORDER BY final_score DESC
            LIMIT 10
        `, [lastMonth, thisMonthStart]);

        // 3. 常見問題分析
        const { rows: commonIssues } = await pool.query(`
            SELECT 
                id.item_name,
                COUNT(*) as failure_count,
                ROUND(AVG(id.deduction_points), 1) as avg_deduction
            FROM inspection_details id
            JOIN inspection_records ir ON id.record_id = ir.id
            WHERE id.result = 'fail' 
              AND ir.inspection_date >= $1 AND ir.inspection_date < $2
            GROUP BY id.item_name, id.item_code
            ORDER BY failure_count DESC
            LIMIT 8
        `, [lastMonth, thisMonthStart]);

        // 4. 改善項目統計
        const { rows: improvementStats } = await pool.query(`
            SELECT 
                COUNT(DISTINCT ir.id) as records_with_improvements,
                COUNT(id.id) as total_improvement_items,
                COUNT(CASE WHEN ip.review_status = 'approved' THEN 1 END) as completed_improvements,
                COUNT(CASE WHEN ip.review_status = 'pending' THEN 1 END) as pending_photos
            FROM inspection_records ir
            JOIN inspection_details id ON ir.id = id.record_id
            LEFT JOIN improvement_photos ip ON id.id = ip.detail_id
            WHERE ir.inspection_date >= $1 AND ir.inspection_date < $2
              AND id.requires_improvement = TRUE
        `, [lastMonth, thisMonthStart]);

        // 生成完整報告
        const report = generateDetailedReport(lastMonth, monthlyStats[0], storeRankings, commonIssues, improvementStats[0]);
        
        // 發送報告
        await sendTelegramMessage(TG_ROBBY_CHAT, report);
        
        console.log('✅ 月度報告已發送');
        
    } catch (error) {
        console.error('❌ 生成月度報告失敗:', error);
    } finally {
        await pool.end();
    }
}

function generateDetailedReport(month, stats, rankings, issues, improvements) {
    const monthName = month.toLocaleDateString('zh-TW', { year: 'numeric', month: 'long' });
    
    const lines = [
        '📈 巡店考核系統月報',
        `📅 ${monthName}`,
        '',
        '■ 整體統計',
        `  ├ 巡店次數: ${stats.total_inspections}次`,
        `  ├ 平均得分: ${stats.avg_score || 0}分`,
        `  ├ 優秀門市: ${stats.excellent_count}間 (A級以上)`,
        `  ├ 待改善門市: ${stats.poor_count}間 (D級)`,
        `  ├ 直營店: ${stats.direct_count}間`,
        `  └ 加盟店: ${stats.franchise_count}間`,
        ''
    ];

    if (rankings.length > 0) {
        lines.push('🏆 門市表現排名 (前5名)');
        rankings.slice(0, 5).forEach((store, index) => {
            const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][index];
            const storeType = store.store_type === 'direct' ? '直營' : '加盟';
            lines.push(`  ${medal} ${store.store_name} - ${store.final_score}分 (${store.grade}級) [${storeType}]`);
        });
        lines.push('');
    }

    if (issues.length > 0) {
        lines.push('⚠️ 最常見問題項目');
        issues.slice(0, 5).forEach(issue => {
            lines.push(`  ├ ${issue.item_name} (${issue.failure_count}次)`);
        });
        lines.push('');
    }

    if (improvements.total_improvement_items > 0) {
        const completionRate = Math.round((improvements.completed_improvements / improvements.total_improvement_items) * 100);
        lines.push('🔧 改善項目追蹤');
        lines.push(`  ├ 需改善門市: ${improvements.records_with_improvements}間`);
        lines.push(`  ├ 改善項目: ${improvements.total_improvement_items}個`);
        lines.push(`  ├ 已完成: ${improvements.completed_improvements}個 (${completionRate}%)`);
        lines.push(`  └ 待審核照片: ${improvements.pending_photos}張`);
        lines.push('');
    }

    // 趨勢分析和建議
    lines.push('📊 趨勢分析');
    if (stats.avg_score >= 85) {
        lines.push('  ✅ 整體表現優異，繼續保持');
    } else if (stats.avg_score >= 75) {
        lines.push('  ⚠️ 整體表現良好，仍有改善空間');
    } else {
        lines.push('  🚨 整體表現需要關注，建議加強培訓');
    }

    if (stats.poor_count > 0) {
        lines.push(`  📈 建議重點關注 ${stats.poor_count}間 D級門市`);
    }

    if (issues.length > 0) {
        lines.push(`  🎯 重點改善項目: ${issues[0].item_name}`);
    }

    lines.push('');
    lines.push('🔗 詳細數據: https://dashboard.paopaomao.tw/inspection');
    
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
            console.log('✅ Telegram 月報已發送');
        }
    } catch (error) {
        console.error('❌ 發送月報失敗:', error);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    generateMonthlyReport().catch(console.error);
}