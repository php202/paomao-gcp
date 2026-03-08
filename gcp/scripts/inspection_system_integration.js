#!/usr/bin/env node
/**
 * 泡泡貓巡店考核系統整合腳本
 * 整合到現有Dashboard系統
 */

import fs from 'fs/promises';
import path from 'path';

// 巡店系統API路由
const INSPECTION_ROUTES = `
// ============================================================
// 泡泡貓巡店考核系統 API 路由
// ============================================================

// 1. 巡店儀表板首頁
app.get('/inspection/dashboard', requireAuth, requireRole(['admin', 'manager']), async (req, res) => {
    try {
        const { rows: overview } = await pool.query(\`
            SELECT 
                COUNT(*) as total_stores,
                COUNT(CASE WHEN status = 'overdue' THEN 1 END) as overdue_inspections,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_inspections,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_this_quarter
            FROM inspection_schedules 
            WHERE quarter = CONCAT(YEAR(CURDATE()), 'Q', QUARTER(CURDATE()))
        \`);

        const { rows: alerts } = await pool.query(\`
            SELECT store_id, store_name, days_until_due, is_overdue, priority
            FROM quarterly_inspection_alerts
            WHERE (days_until_due <= 7 AND days_until_due > 0) OR is_overdue = TRUE
            ORDER BY is_overdue DESC, days_until_due ASC
            LIMIT 10
        \`);

        const { rows: recentInspections } = await pool.query(\`
            SELECT store_name, inspection_date, final_score, grade, status
            FROM inspection_dashboard
            ORDER BY inspection_date DESC
            LIMIT 10
        \`);

        res.render('inspection/dashboard', {
            overview: overview[0],
            alerts,
            recentInspections,
            currentQuarter: \`\${new Date().getFullYear()}Q\${Math.ceil((new Date().getMonth() + 1) / 3)}\`
        });
    } catch (error) {
        console.error('巡店儀表板錯誤:', error);
        res.status(500).json({ error: '系統錯誤' });
    }
});

// 2. 季度巡店計劃
app.get('/inspection/schedule', requireAuth, requireRole(['admin']), async (req, res) => {
    const quarter = req.query.quarter || \`\${new Date().getFullYear()}Q\${Math.ceil((new Date().getMonth() + 1) / 3)}\`;
    
    try {
        const { rows: schedules } = await pool.query(\`
            SELECT s.*, 
                   CASE WHEN ir.id IS NOT NULL THEN 'completed' ELSE s.status END as actual_status,
                   ir.final_score, ir.grade
            FROM inspection_schedules s
            LEFT JOIN inspection_records ir ON s.id = ir.schedule_id
            WHERE s.quarter = $1
            ORDER BY s.priority DESC, s.scheduled_date ASC
        \`, [quarter]);

        res.render('inspection/schedule', { schedules, quarter });
    } catch (error) {
        console.error('巡店計劃錯誤:', error);
        res.status(500).json({ error: '系統錯誤' });
    }
});

// 3. 創建/更新巡店計劃
app.post('/inspection/schedule', requireAuth, requireRole(['admin']), async (req, res) => {
    const { stores, quarter } = req.body;
    
    try {
        await pool.query('BEGIN');
        
        for (const store of stores) {
            await pool.query(\`
                INSERT INTO inspection_schedules 
                (store_id, store_name, quarter, scheduled_date, inspector_name, priority)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (store_id, quarter) 
                DO UPDATE SET scheduled_date = EXCLUDED.scheduled_date,
                             inspector_name = EXCLUDED.inspector_name,
                             priority = EXCLUDED.priority
            \`, [store.id, store.name, quarter, store.scheduled_date, store.inspector, store.priority || 0]);
        }
        
        await pool.query('COMMIT');
        res.json({ success: true, message: '巡店計劃已更新' });
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('更新巡店計劃錯誤:', error);
        res.status(500).json({ error: '更新失敗' });
    }
});

// 4. 巡店記錄表單
app.get('/inspection/record/:scheduleId', requireAuth, requireRole(['admin', 'inspector']), async (req, res) => {
    const { scheduleId } = req.params;
    
    try {
        const { rows: schedule } = await pool.query(\`
            SELECT * FROM inspection_schedules WHERE id = $1
        \`, [scheduleId]);

        const { rows: categories } = await pool.query(\`
            SELECT ic.*, 
                   JSON_AGG(
                       JSON_BUILD_OBJECT(
                           'id', ii.id,
                           'item_name', ii.item_name,
                           'item_code', ii.item_code,
                           'deduction_points', ii.deduction_points,
                           'is_critical', ii.is_critical
                       ) ORDER BY ii.sort_order
                   ) as items
            FROM inspection_categories ic
            LEFT JOIN inspection_items ii ON ic.id = ii.category_id AND ii.is_active = TRUE
            WHERE ic.is_active = TRUE
            GROUP BY ic.id, ic.category_name, ic.sort_order
            ORDER BY ic.sort_order
        \`);

        if (!schedule.length) {
            return res.status(404).json({ error: '找不到巡店計劃' });
        }

        res.render('inspection/record-form', {
            schedule: schedule[0],
            categories,
            currentDate: new Date().toISOString().split('T')[0]
        });
    } catch (error) {
        console.error('巡店記錄表單錯誤:', error);
        res.status(500).json({ error: '系統錯誤' });
    }
});

// 5. 提交巡店記錄
app.post('/inspection/record', requireAuth, requireRole(['admin', 'inspector']), async (req, res) => {
    const { scheduleId, storeId, storeName, storeType, inspectionDate, items, notes } = req.body;
    const inspectorName = req.user.name;
    const inspectorId = req.user.id;

    try {
        await pool.query('BEGIN');

        // 計算得分
        let totalItems = items.length;
        let passedItems = items.filter(item => item.result === 'pass').length;
        let failedItems = items.filter(item => item.result === 'fail').length;
        let deductedPoints = items.reduce((sum, item) => 
            sum + (item.result === 'fail' ? item.deduction_points : 0), 0);
        let finalScore = Math.max(0, 100 - deductedPoints);
        
        // 計算等級
        let grade = 'D';
        if (finalScore >= 95) grade = 'A+';
        else if (finalScore >= 85) grade = 'A';
        else if (finalScore >= 75) grade = 'B';
        else if (finalScore >= 65) grade = 'C';

        // 判斷是否需要改善
        const needsImprovement = items.some(item => item.result === 'fail');
        const improvementDeadline = needsImprovement ? 
            new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) : null; // 5天後

        // 插入巡店記錄
        const { rows: recordResult } = await pool.query(\`
            INSERT INTO inspection_records 
            (schedule_id, store_id, store_name, store_type, inspection_date, 
             inspector_id, inspector_name, total_items, passed_items, failed_items,
             deducted_points, final_score, grade, status, improvement_deadline, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            RETURNING id
        \`, [scheduleId, storeId, storeName, storeType, inspectionDate, inspectorId, inspectorName,
             totalItems, passedItems, failedItems, deductedPoints, finalScore, grade,
             needsImprovement ? 'pending_improvement' : 'completed', improvementDeadline, notes]);

        const recordId = recordResult[0].id;

        // 插入檢核明細
        for (const item of items) {
            const requiresImprovement = item.result === 'fail';
            
            await pool.query(\`
                INSERT INTO inspection_details
                (record_id, item_id, item_code, item_name, result, deduction_points,
                 notes, requires_improvement, improvement_required, improvement_deadline)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            \`, [recordId, item.item_id, item.item_code, item.item_name, item.result,
                item.result === 'fail' ? item.deduction_points : 0, item.notes || null,
                requiresImprovement, item.improvement_notes || null,
                requiresImprovement ? improvementDeadline : null]);
        }

        // 更新巡店計劃狀態
        await pool.query(\`
            UPDATE inspection_schedules SET status = 'completed' WHERE id = $1
        \`, [scheduleId]);

        await pool.query('COMMIT');

        // 如果需要改善，發送通知
        if (needsImprovement) {
            // TODO: 發送 Telegram 通知到店長
            console.log(\`巡店完成，\${storeName} 需要改善，截止日期：\${improvementDeadline.toLocaleDateString()}\`);
        }

        res.json({ 
            success: true, 
            recordId, 
            finalScore, 
            grade,
            message: \`巡店記錄已保存。得分：\${finalScore}分 (\${grade}級)\`
        });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('提交巡店記錄錯誤:', error);
        res.status(500).json({ error: '提交失敗' });
    }
});

// 6. 店長查看巡店結果（整合到店長儀表板）
app.get('/manager/inspection-results', requireAuth, requireRole(['manager']), async (req, res) => {
    const managedStores = req.user.managed_stores || [];
    
    if (!managedStores.length) {
        return res.json({ results: [] });
    }

    try {
        const { rows: results } = await pool.query(\`
            SELECT ir.*, 
                   (SELECT COUNT(*) FROM inspection_details id 
                    WHERE id.record_id = ir.id AND id.requires_improvement = TRUE) as improvement_items,
                   (SELECT COUNT(*) FROM improvement_photos ip 
                    WHERE ip.record_id = ir.id AND ip.review_status = 'approved') as completed_improvements
            FROM inspection_records ir
            WHERE ir.store_id = ANY($1)
            ORDER BY ir.inspection_date DESC
            LIMIT 5
        \`, [managedStores]);

        res.json({ results });
    } catch (error) {
        console.error('店長巡店結果錯誤:', error);
        res.status(500).json({ error: '系統錯誤' });
    }
});

// 7. 改善照片上傳
app.post('/inspection/upload-improvement/:recordId/:itemCode', requireAuth, upload.single('photo'), async (req, res) => {
    const { recordId, itemCode } = req.params;
    const { description } = req.body;
    const uploadedBy = req.user.name;

    if (!req.file) {
        return res.status(400).json({ error: '請選擇照片' });
    }

    try {
        // 查找對應的檢核明細
        const { rows: details } = await pool.query(\`
            SELECT id FROM inspection_details 
            WHERE record_id = $1 AND item_code = $2 AND requires_improvement = TRUE
        \`, [recordId, itemCode]);

        if (!details.length) {
            return res.status(404).json({ error: '找不到需要改善的項目' });
        }

        // 保存照片記錄
        await pool.query(\`
            INSERT INTO improvement_photos
            (detail_id, record_id, store_id, item_code, photo_url, photo_filename,
             photo_size, uploaded_by, description)
            SELECT $1, $2, ir.store_id, $3, $4, $5, $6, $7, $8
            FROM inspection_records ir WHERE ir.id = $2
        \`, [details[0].id, recordId, itemCode, req.file.path, req.file.filename,
             req.file.size, uploadedBy, description]);

        res.json({ 
            success: true, 
            message: '改善照片已上傳，等待審核' 
        });

    } catch (error) {
        console.error('上傳改善照片錯誤:', error);
        res.status(500).json({ error: '上傳失敗' });
    }
});

// 8. 巡店提醒系統（定期執行）
async function sendInspectionReminders() {
    try {
        const { rows: alerts } = await pool.query(\`
            SELECT * FROM quarterly_inspection_alerts
            WHERE (days_until_due = 3 OR days_until_due = 1 OR is_overdue = TRUE)
            AND store_id NOT IN (
                SELECT store_id FROM inspection_notifications 
                WHERE sent_at > CURDATE() AND notification_type = 'due_soon'
            )
        \`);

        for (const alert of alerts) {
            const message = alert.is_overdue 
                ? \`⚠️ 【巡店逾期】\${alert.store_name} 巡店已逾期，請立即安排！\`
                : \`📅 【巡店提醒】\${alert.store_name} \${alert.days_until_due}天內需要巡店\`;

            // 發送 Telegram 通知（根據現有的 message API）
            // TODO: 整合現有的 Telegram 通知系統
            console.log(\`巡店提醒: \${message}\`);

            // 記錄通知
            await pool.query(\`
                INSERT INTO inspection_notifications
                (schedule_id, store_id, notification_type, recipient)
                SELECT id, store_id, 'due_soon', '總公司'
                FROM inspection_schedules
                WHERE store_id = $1
            \`, [alert.store_id]);
        }
    } catch (error) {
        console.error('發送巡店提醒錯誤:', error);
    }
}

// 定期執行提醒（每天早上9點）
setInterval(sendInspectionReminders, 24 * 60 * 60 * 1000); // 24小時執行一次

export { sendInspectionReminders };
`;

// Dashboard HTML 模板
const DASHBOARD_TEMPLATE = `
<!-- 巡店系統儀表板模板 -->
<div class="inspection-dashboard">
    <div class="row mb-4">
        <div class="col-md-12">
            <h2>🏪 巡店考核管理 - {{currentQuarter}}</h2>
        </div>
    </div>

    <!-- 統計卡片 -->
    <div class="row mb-4">
        <div class="col-md-3">
            <div class="card bg-primary text-white">
                <div class="card-body">
                    <h5>總門市數</h5>
                    <h2>{{overview.total_stores}}</h2>
                </div>
            </div>
        </div>
        <div class="col-md-3">
            <div class="card bg-success text-white">
                <div class="card-body">
                    <h5>已完成</h5>
                    <h2>{{overview.completed_this_quarter}}</h2>
                </div>
            </div>
        </div>
        <div class="col-md-3">
            <div class="card bg-warning text-white">
                <div class="card-body">
                    <h5>待巡店</h5>
                    <h2>{{overview.pending_inspections}}</h2>
                </div>
            </div>
        </div>
        <div class="col-md-3">
            <div class="card bg-danger text-white">
                <div class="card-body">
                    <h5>已逾期</h5>
                    <h2>{{overview.overdue_inspections}}</h2>
                </div>
            </div>
        </div>
    </div>

    <!-- 巡店提醒區域 -->
    {{#if alerts.length}}
    <div class="alert alert-warning">
        <h5>🔔 需要關注的門市：</h5>
        <ul class="mb-0">
            {{#each alerts}}
            <li>
                <strong>{{store_name}}</strong> - 
                {{#if is_overdue}}
                    <span class="text-danger">已逾期</span>
                {{else}}
                    <span class="text-warning">{{days_until_due}}天內到期</span>
                {{/if}}
                <a href="/inspection/record/{{schedule_id}}" class="btn btn-sm btn-primary ms-2">立即巡店</a>
            </li>
            {{/each}}
        </ul>
    </div>
    {{/if}}

    <!-- 最近巡店記錄 -->
    <div class="card">
        <div class="card-header">
            <h5>📊 最近巡店記錄</h5>
        </div>
        <div class="card-body">
            <div class="table-responsive">
                <table class="table">
                    <thead>
                        <tr>
                            <th>門市</th>
                            <th>巡店日期</th>
                            <th>得分</th>
                            <th>等級</th>
                            <th>狀態</th>
                        </tr>
                    </thead>
                    <tbody>
                        {{#each recentInspections}}
                        <tr>
                            <td>{{store_name}}</td>
                            <td>{{inspection_date}}</td>
                            <td>
                                <span class="badge {{#if (gte final_score 85)}}bg-success{{else if (gte final_score 75)}}bg-warning{{else}}bg-danger{{/if}}">
                                    {{final_score}}分
                                </span>
                            </td>
                            <td>
                                <span class="badge badge-{{grade}}">{{grade}}</span>
                            </td>
                            <td>
                                {{#if (eq status 'pending_improvement')}}
                                    <span class="text-warning">待改善</span>
                                {{else if (eq status 'completed')}}
                                    <span class="text-success">已完成</span>
                                {{else}}
                                    <span class="text-info">{{status}}</span>
                                {{/if}}
                            </td>
                        </tr>
                        {{/each}}
                    </tbody>
                </table>
            </div>
        </div>
    </div>
</div>
`;

// 創建整合腳本
async function createInspectionSystemFiles() {
    console.log('🏪 創建巡店考核系統檔案...');

    // 1. API 路由檔案
    await fs.writeFile(
        path.join(process.cwd(), 'routes', 'inspection.js'),
        INSPECTION_ROUTES
    );

    // 2. Dashboard 模板
    await fs.writeFile(
        path.join(process.cwd(), 'views', 'inspection', 'dashboard.hbs'),
        DASHBOARD_TEMPLATE
    );

    console.log('✅ 巡店考核系統檔案已創建');
}

if (import.meta.url === \`file://\${process.argv[1]}\`) {
    createInspectionSystemFiles();
}

export { createInspectionSystemFiles, sendInspectionReminders };