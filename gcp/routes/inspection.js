/**
 * 泡泡貓巡店考核系統 V2.0 API 路由
 * 支援 -3 到 +3 分評分系統
 * 專業督導標準，季度巡店，改善追蹤
 */

import express from 'express';
import pool from '../lib/db.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';

const router = express.Router();

// 文件上傳配置
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadPath = path.join(process.cwd(), 'uploads', 'improvements');
        await fs.mkdir(uploadPath, { recursive: true });
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('只允許上傳圖片文件'), false);
        }
    }
});

// 模擬權限檢查中間件 - 實際使用時需要替換成真實的權限系統
const requireAuth = (req, res, next) => {
    req.user = { 
        id: 1, 
        name: '圓圓', 
        roles: ['admin', 'inspector'],
        managed_stores: ['3677', '3151'] 
    };
    next();
};

const requireRole = (roles) => (req, res, next) => {
    if (roles.some(role => req.user.roles.includes(role))) {
        next();
    } else {
        res.status(403).json({ error: '權限不足' });
    }
};

// ============================================================
// 1. 巡店儀表板首頁
// ============================================================
router.get('/dashboard', requireAuth, requireRole(['admin', 'inspector']), async (req, res) => {
    try {
        const currentQuarter = `${new Date().getFullYear()}Q${Math.ceil((new Date().getMonth() + 1) / 3)}`;

        // 統計數據
        const { rows: overview } = await pool.query(`
            SELECT 
                COUNT(*) as total_stores,
                COUNT(CASE WHEN status = 'overdue' THEN 1 END) as overdue_inspections,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_inspections,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_this_quarter
            FROM inspection_schedules 
            WHERE quarter = $1
        `, [currentQuarter]);

        // 需要提醒的門市
        const { rows: alerts } = await pool.query(`
            SELECT 
                store_id, store_name, scheduled_date,
                CASE 
                    WHEN scheduled_date < CURRENT_DATE THEN CURRENT_DATE - scheduled_date
                    ELSE scheduled_date - CURRENT_DATE  
                END as days_diff,
                CASE
                    WHEN scheduled_date < CURRENT_DATE THEN TRUE
                    ELSE FALSE
                END as is_overdue,
                priority
            FROM inspection_schedules
            WHERE quarter = $1 AND status IN ('pending', 'scheduled')
              AND (scheduled_date < CURRENT_DATE OR scheduled_date - CURRENT_DATE <= 7)
            ORDER BY is_overdue DESC, days_diff ASC
            LIMIT 10
        `, [currentQuarter]);

        // 最近巡店記錄
        const { rows: recentInspections } = await pool.query(`
            SELECT store_name, inspection_date, final_score, grade, status
            FROM inspection_records
            ORDER BY inspection_date DESC
            LIMIT 10
        `);

        res.json({
            success: true,
            data: {
                overview: overview[0],
                alerts,
                recentInspections,
                currentQuarter
            }
        });

    } catch (error) {
        console.error('巡店儀表板錯誤:', error);
        res.status(500).json({ error: '系統錯誤' });
    }
});

// ============================================================
// 2. 季度巡店計劃
// ============================================================
router.get('/schedule', requireAuth, requireRole(['admin']), async (req, res) => {
    const quarter = req.query.quarter || `${new Date().getFullYear()}Q${Math.ceil((new Date().getMonth() + 1) / 3)}`;
    
    try {
        const { rows: schedules } = await pool.query(`
            SELECT s.*, 
                   CASE WHEN ir.id IS NOT NULL THEN 'completed' ELSE s.status END as actual_status,
                   ir.final_score, ir.grade
            FROM inspection_schedules s
            LEFT JOIN inspection_records ir ON s.id = ir.schedule_id
            WHERE s.quarter = $1
            ORDER BY s.priority DESC, s.scheduled_date ASC
        `, [quarter]);

        res.json({
            success: true,
            data: { schedules, quarter }
        });

    } catch (error) {
        console.error('巡店計劃錯誤:', error);
        res.status(500).json({ error: '系統錯誤' });
    }
});

// ============================================================
// 3. 巡店記錄表單數據
// ============================================================
router.get('/record-form/:scheduleId', requireAuth, requireRole(['admin', 'inspector']), async (req, res) => {
    const { scheduleId } = req.params;
    
    try {
        const { rows: schedule } = await pool.query(`
            SELECT * FROM inspection_schedules WHERE id = $1
        `, [scheduleId]);

        const { rows: categories } = await pool.query(`
            SELECT 
                ic.*,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'id', ii.id,
                            'item_name', ii.item_name,
                            'item_code', ii.item_code,
                            'deduction_points', ii.deduction_points,
                            'is_critical', ii.is_critical,
                            'description', ii.description
                        ) ORDER BY ii.sort_order
                    ) FILTER (WHERE ii.id IS NOT NULL), 
                    '[]'
                ) as items
            FROM inspection_categories ic
            LEFT JOIN inspection_items ii ON ic.id = ii.category_id AND ii.is_active = TRUE
            WHERE ic.is_active = TRUE
            GROUP BY ic.id, ic.category_name, ic.sort_order
            ORDER BY ic.sort_order
        `);

        if (!schedule.length) {
            return res.status(404).json({ error: '找不到巡店計劃' });
        }

        res.json({
            success: true,
            data: {
                schedule: schedule[0],
                categories,
                currentDate: new Date().toISOString().split('T')[0]
            }
        });

    } catch (error) {
        console.error('巡店記錄表單錯誤:', error);
        res.status(500).json({ error: '系統錯誤' });
    }
});

// ============================================================
// 4. 提交巡店記錄
// ============================================================
router.post('/record', requireAuth, requireRole(['admin', 'inspector']), async (req, res) => {
    const { scheduleId, storeId, storeName, storeType, inspectionDate, items, notes } = req.body;
    const inspectorName = req.user.name;
    const inspectorId = req.user.id;

    try {
        await pool.query('BEGIN');

        // 計算得分
        const totalItems = items.length;
        const passedItems = items.filter(item => item.result === 'pass').length;
        const failedItems = items.filter(item => item.result === 'fail').length;
        const deductedPoints = items.reduce((sum, item) => 
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
        const { rows: recordResult } = await pool.query(`
            INSERT INTO inspection_records 
            (schedule_id, store_id, store_name, store_type, inspection_date, 
             inspector_id, inspector_name, total_items, passed_items, failed_items,
             deducted_points, final_score, grade, status, improvement_deadline, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            RETURNING id
        `, [scheduleId, storeId, storeName, storeType, inspectionDate, inspectorId, inspectorName,
             totalItems, passedItems, failedItems, deductedPoints, finalScore, grade,
             needsImprovement ? 'pending_improvement' : 'completed', improvementDeadline, notes]);

        const recordId = recordResult[0].id;

        // 插入檢核明細
        for (const item of items) {
            const requiresImprovement = item.result === 'fail';
            
            await pool.query(`
                INSERT INTO inspection_details
                (record_id, item_id, item_code, item_name, result, deduction_points,
                 notes, requires_improvement, improvement_required, improvement_deadline)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [recordId, item.item_id, item.item_code, item.item_name, item.result,
                item.result === 'fail' ? item.deduction_points : 0, item.notes || null,
                requiresImprovement, item.improvement_notes || null,
                requiresImprovement ? improvementDeadline : null]);
        }

        // 更新巡店計劃狀態
        await pool.query(`
            UPDATE inspection_schedules SET status = 'completed' WHERE id = $1
        `, [scheduleId]);

        await pool.query('COMMIT');

        console.log(`✅ 巡店完成：${storeName} - ${finalScore}分 (${grade}級)`);

        res.json({ 
            success: true, 
            data: {
                recordId, 
                finalScore, 
                grade,
                needsImprovement,
                improvementDeadline: improvementDeadline?.toISOString(),
                message: `巡店記錄已保存。得分：${finalScore}分 (${grade}級)`
            }
        });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('提交巡店記錄錯誤:', error);
        res.status(500).json({ error: '提交失敗' });
    }
});

// ============================================================
// 5. 店長查看巡店結果（整合到店長儀表板）
// ============================================================
router.get('/manager/results', requireAuth, requireRole(['manager']), async (req, res) => {
    const managedStores = req.user.managed_stores || [];
    
    if (!managedStores.length) {
        return res.json({ success: true, data: { results: [] } });
    }

    try {
        const { rows: results } = await pool.query(`
            SELECT ir.*, 
                   (SELECT COUNT(*) FROM inspection_details id 
                    WHERE id.record_id = ir.id AND id.requires_improvement = TRUE) as improvement_items,
                   (SELECT COUNT(*) FROM improvement_photos ip 
                    WHERE ip.record_id = ir.id AND ip.review_status = 'approved') as completed_improvements
            FROM inspection_records ir
            WHERE ir.store_id = ANY($1)
            ORDER BY ir.inspection_date DESC
            LIMIT 5
        `, [managedStores]);

        res.json({ success: true, data: { results } });

    } catch (error) {
        console.error('店長巡店結果錯誤:', error);
        res.status(500).json({ error: '系統錯誤' });
    }
});

// ============================================================
// 6. 改善照片上傳
// ============================================================
router.post('/improvement/:recordId/:itemCode', requireAuth, upload.single('photo'), async (req, res) => {
    const { recordId, itemCode } = req.params;
    const { description } = req.body;
    const uploadedBy = req.user.name;

    if (!req.file) {
        return res.status(400).json({ error: '請選擇照片' });
    }

    try {
        // 查找對應的檢核明細
        const { rows: details } = await pool.query(`
            SELECT id FROM inspection_details 
            WHERE record_id = $1 AND item_code = $2 AND requires_improvement = TRUE
        `, [recordId, itemCode]);

        if (!details.length) {
            return res.status(404).json({ error: '找不到需要改善的項目' });
        }

        // 保存照片記錄
        await pool.query(`
            INSERT INTO improvement_photos
            (detail_id, record_id, store_id, item_code, photo_url, photo_filename,
             photo_size, uploaded_by, description)
            SELECT $1, $2, ir.store_id, $3, $4, $5, $6, $7, $8
            FROM inspection_records ir WHERE ir.id = $2
        `, [details[0].id, recordId, itemCode, req.file.path, req.file.filename,
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

// ============================================================
// 7. 待審核改善照片列表
// ============================================================
router.get('/improvement/pending', requireAuth, requireRole(['admin', 'inspector']), async (req, res) => {
    try {
        const { rows: pendingPhotos } = await pool.query(`
            SELECT 
                ip.*, 
                ir.store_name,
                id.item_name,
                ir.inspection_date
            FROM improvement_photos ip
            JOIN inspection_records ir ON ip.record_id = ir.id
            JOIN inspection_details id ON ip.detail_id = id.id
            WHERE ip.review_status = 'pending'
            ORDER BY ip.uploaded_at DESC
        `);

        res.json({ success: true, data: { photos: pendingPhotos } });

    } catch (error) {
        console.error('獲取待審核照片錯誤:', error);
        res.status(500).json({ error: '系統錯誤' });
    }
});

// ============================================================
// 8. 審核改善照片
// ============================================================
router.post('/improvement/review/:photoId', requireAuth, requireRole(['admin', 'inspector']), async (req, res) => {
    const { photoId } = req.params;
    const { status, notes } = req.body; // status: 'approved' | 'rejected'
    const reviewedBy = req.user.name;

    try {
        await pool.query(`
            UPDATE improvement_photos 
            SET review_status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, review_notes = $3
            WHERE id = $4
        `, [status, reviewedBy, notes, photoId]);

        res.json({ 
            success: true, 
            message: status === 'approved' ? '照片已通過審核' : '照片審核不通過'
        });

    } catch (error) {
        console.error('審核照片錯誤:', error);
        res.status(500).json({ error: '審核失敗' });
    }
});

// ============================================================
// 9. 巡店統計報告
// ============================================================
router.get('/statistics', requireAuth, requireRole(['admin']), async (req, res) => {
    const quarter = req.query.quarter || `${new Date().getFullYear()}Q${Math.ceil((new Date().getMonth() + 1) / 3)}`;

    try {
        // 整體統計
        const { rows: overall } = await pool.query(`
            SELECT 
                COUNT(*) as total_inspections,
                AVG(final_score) as avg_score,
                COUNT(CASE WHEN grade IN ('A+', 'A') THEN 1 END) as excellent_count,
                COUNT(CASE WHEN grade = 'D' THEN 1 END) as poor_count
            FROM inspection_records ir
            JOIN inspection_schedules is ON ir.schedule_id = is.id
            WHERE is.quarter = $1
        `, [quarter]);

        // 分店得分排名
        const { rows: storeRankings } = await pool.query(`
            SELECT 
                ir.store_name,
                ir.store_type,
                ir.final_score,
                ir.grade,
                ir.inspection_date
            FROM inspection_records ir
            JOIN inspection_schedules is ON ir.schedule_id = is.id
            WHERE is.quarter = $1
            ORDER BY ir.final_score DESC
        `, [quarter]);

        // 常見問題項目
        const { rows: commonIssues } = await pool.query(`
            SELECT 
                id.item_name,
                COUNT(*) as failure_count,
                AVG(id.deduction_points) as avg_deduction
            FROM inspection_details id
            JOIN inspection_records ir ON id.record_id = ir.id
            JOIN inspection_schedules is ON ir.schedule_id = is.id
            WHERE id.result = 'fail' AND is.quarter = $1
            GROUP BY id.item_name, id.item_code
            ORDER BY failure_count DESC
            LIMIT 10
        `, [quarter]);

        res.json({
            success: true,
            data: {
                quarter,
                overall: overall[0],
                storeRankings,
                commonIssues
            }
        });

    } catch (error) {
        console.error('統計報告錯誤:', error);
        res.status(500).json({ error: '系統錯誤' });
    }
});

export default router;