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
        const uploadPath = path.join(process.cwd(), 'uploads', 'inspections');
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

// 權限檢查中間件
const requireAuth = (req, res, next) => {
    // 模擬用戶認證（實際使用時需要替換成真實的認證系統）
    req.user = { 
        id: 1, 
        name: '圓圓', 
        roles: ['admin', 'inspector'],
        managed_stores: [] // 店長管理的門市
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
// 1. 巡店儀表板 - 支援總公司和店長視角
// ============================================================
router.get('/dashboard', requireAuth, async (req, res) => {
    try {
        const currentQuarter = `${new Date().getFullYear()}Q${Math.ceil((new Date().getMonth() + 1) / 3)}`;
        const isManager = req.user.roles.includes('manager');
        const managedStores = req.user.managed_stores || [];

        // 基本統計（根據用戶角色過濾）
        let whereClause = '';
        let params = [currentQuarter];
        
        if (isManager && managedStores.length > 0) {
            whereClause = 'AND s.store_id = ANY($2)';
            params.push(managedStores);
        }

        const overviewQuery = `
            SELECT 
                COUNT(*) as total_stores,
                COUNT(CASE WHEN s.status = 'overdue' THEN 1 END) as overdue_inspections,
                COUNT(CASE WHEN s.status IN ('planned', 'assigned') THEN 1 END) as pending_inspections,
                COUNT(CASE WHEN s.status = 'completed' THEN 1 END) as completed_this_quarter
            FROM inspection_schedules s
            WHERE s.quarter = $1 ${whereClause}
        `;
        const { rows: overview } = await pool.query(overviewQuery, params);

        // 需要關注的門市（逾期、即將到期、需改善）
        const alertsQuery = `
            SELECT DISTINCT
                s.store_id, s.store_name, s.planned_date, s.status,
                ir.final_score, ir.grade, ir.items_need_improvement,
                ir.improvement_deadline,
                CASE 
                    WHEN s.planned_date < CURRENT_DATE AND s.status IN ('planned', 'assigned') THEN 'inspection_overdue'
                    WHEN s.planned_date - CURRENT_DATE <= 3 AND s.status IN ('planned', 'assigned') THEN 'inspection_due_soon'
                    WHEN ir.improvement_deadline < CURRENT_DATE AND ir.status = 'pending_improvement' THEN 'improvement_overdue'
                    WHEN ir.improvement_deadline - CURRENT_DATE <= 2 AND ir.status = 'pending_improvement' THEN 'improvement_due_soon'
                    ELSE NULL
                END as alert_type,
                CASE 
                    WHEN s.planned_date < CURRENT_DATE THEN CURRENT_DATE - s.planned_date
                    WHEN ir.improvement_deadline < CURRENT_DATE THEN CURRENT_DATE - ir.improvement_deadline
                    ELSE LEAST(s.planned_date - CURRENT_DATE, COALESCE(ir.improvement_deadline - CURRENT_DATE, 999))
                END as days_diff
            FROM inspection_schedules s
            LEFT JOIN inspection_records ir ON s.id = ir.schedule_id
            WHERE s.quarter = $1 ${whereClause}
            HAVING alert_type IS NOT NULL
            ORDER BY days_diff DESC, s.priority DESC
            LIMIT 10
        `;
        const { rows: alerts } = await pool.query(alertsQuery, params);

        // 最近巡店記錄（含分數分佈統計）
        const recentQuery = `
            SELECT 
                ir.store_name, ir.inspection_date, ir.final_score, ir.grade, 
                ir.status, ir.items_need_improvement, ir.inspector_name,
                ir.bonus_points, ir.penalty_points,
                CASE 
                    WHEN ir.final_score >= 95 THEN 'excellent'
                    WHEN ir.final_score >= 85 THEN 'good'
                    WHEN ir.final_score >= 75 THEN 'average'
                    WHEN ir.final_score >= 65 THEN 'below_average'
                    ELSE 'poor'
                END as performance_category
            FROM inspection_records ir
            ${isManager && managedStores.length > 0 ? 'WHERE ir.store_id = ANY($' + (params.length + 1) + ')' : ''}
            ORDER BY ir.inspection_date DESC
            LIMIT 15
        `;
        if (isManager && managedStores.length > 0) {
            params.push(managedStores);
        }
        const { rows: recentInspections } = await pool.query(recentQuery, params.slice(0, isManager && managedStores.length > 0 ? params.length : 1));

        // 待審核改善照片數
        const photosQuery = `
            SELECT COUNT(*) as pending_photos_count
            FROM improvement_photos ip
            JOIN inspection_records ir ON ip.record_id = ir.id
            WHERE ip.review_status = 'pending'
            ${isManager && managedStores.length > 0 ? 'AND ir.store_id = ANY($1)' : ''}
        `;
        const { rows: photosCount } = await pool.query(
            photosQuery, 
            isManager && managedStores.length > 0 ? [managedStores] : []
        );

        // 平均分數統計
        const avgScoreQuery = `
            SELECT 
                ROUND(AVG(ir.final_score), 1) as avg_score,
                ROUND(AVG(ir.bonus_points), 1) as avg_bonus,
                ROUND(AVG(ir.penalty_points), 1) as avg_penalty
            FROM inspection_records ir
            JOIN inspection_schedules s ON ir.schedule_id = s.id
            WHERE s.quarter = $1
            ${isManager && managedStores.length > 0 ? 'AND ir.store_id = ANY($2)' : ''}
        `;
        const { rows: avgScore } = await pool.query(
            avgScoreQuery, 
            isManager && managedStores.length > 0 ? [currentQuarter, managedStores] : [currentQuarter]
        );

        res.json({
            success: true,
            data: {
                overview: overview[0],
                alerts: alerts,
                recentInspections: recentInspections,
                pendingPhotos: photosCount[0]?.pending_photos_count || 0,
                averageScore: avgScore[0]?.avg_score || 0,
                averageBonus: avgScore[0]?.avg_bonus || 0,
                averagePenalty: avgScore[0]?.avg_penalty || 0,
                currentQuarter,
                userRole: isManager ? 'manager' : 'admin',
                managedStores: managedStores
            }
        });

    } catch (error) {
        console.error('巡店儀表板錯誤:', error);
        res.status(500).json({ error: '系統錯誤', details: error.message });
    }
});

// ============================================================
// 2. 載入門市列表（從現有系統同步）
// ============================================================
router.get('/stores', requireAuth, async (req, res) => {
    try {
        // 這裡應該從現有的門市資料庫查詢
        // 暫時使用模擬資料，實際部署時需要連接真實資料源
        const stores = [
            { id: '3677', name: '新竹公道店', type: 'franchise', manager: '店長A' },
            { id: '3151', name: '桃園南崁店', type: 'direct', manager: '店長B' },
            { id: '3152', name: '楊梅金山店', type: 'franchise', manager: '店長C' },
            { id: '3153', name: '竹北光明店', type: 'direct', manager: '店長D' },
            { id: '3154', name: '蘆洲集賢店', type: 'franchise', manager: '店長E' },
            { id: '3155', name: '新莊中平店', type: 'franchise', manager: '店長F' },
            { id: '3156', name: '土城中央店', type: 'direct', manager: '店長G' },
        ];

        // 如果是店長角色，只返回管理的門市
        const isManager = req.user.roles.includes('manager');
        const managedStores = req.user.managed_stores || [];
        
        const filteredStores = isManager && managedStores.length > 0 
            ? stores.filter(store => managedStores.includes(store.id))
            : stores;

        res.json({
            success: true,
            data: { stores: filteredStores }
        });

    } catch (error) {
        console.error('載入門市列表錯誤:', error);
        res.status(500).json({ error: '系統錯誤' });
    }
});

// ============================================================
// 3. 載入檢核項目和表單數據
// ============================================================
router.get('/inspection-form/:storeId?', requireAuth, requireRole(['admin', 'inspector']), async (req, res) => {
    try {
        const { storeId } = req.params;

        // 載入檢核分類和項目
        const categoriesQuery = `
            SELECT 
                ic.id, ic.category_name, ic.category_code, ic.sort_order,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'id', ii.id,
                            'item_name', ii.item_name,
                            'item_code', ii.item_code,
                            'description', ii.description,
                            'score_3_desc', ii.score_3_desc,
                            'score_2_desc', ii.score_2_desc,
                            'score_1_desc', ii.score_1_desc,
                            'score_0_desc', ii.score_0_desc,
                            'score_neg1_desc', ii.score_neg1_desc,
                            'score_neg2_desc', ii.score_neg2_desc,
                            'score_neg3_desc', ii.score_neg3_desc,
                            'weight', ii.weight,
                            'is_critical', ii.is_critical,
                            'requires_photo_if_negative', ii.requires_photo_if_negative
                        ) ORDER BY ii.sort_order
                    ) FILTER (WHERE ii.id IS NOT NULL), 
                    '[]'
                ) as items
            FROM inspection_categories ic
            LEFT JOIN inspection_items ii ON ic.id = ii.category_id AND ii.is_active = TRUE
            WHERE ic.is_active = TRUE
            GROUP BY ic.id, ic.category_name, ic.category_code, ic.sort_order
            ORDER BY ic.sort_order
        `;
        const { rows: categories } = await pool.query(categoriesQuery);

        // 如果指定了門市，查詢門市資訊
        let storeInfo = null;
        if (storeId) {
            // 這裡應該查詢真實門市資料
            const mockStores = {
                '3677': { id: '3677', name: '新竹公道店', type: 'franchise' },
                '3151': { id: '3151', name: '桃園南崁店', type: 'direct' },
            };
            storeInfo = mockStores[storeId] || null;
        }

        res.json({
            success: true,
            data: {
                categories,
                storeInfo,
                inspector: {
                    id: req.user.id,
                    name: req.user.name
                },
                currentDate: new Date().toISOString().split('T')[0]
            }
        });

    } catch (error) {
        console.error('載入檢核表單錯誤:', error);
        res.status(500).json({ error: '系統錯誤' });
    }
});

// ============================================================
// 4. 提交巡店記錄（支援新評分系統）
// ============================================================
router.post('/submit-inspection', requireAuth, requireRole(['admin', 'inspector']), async (req, res) => {
    const { 
        storeId, 
        storeName, 
        storeType, 
        inspectionDate, 
        items, // [{ item_code, item_id, score, notes, photos }]
        overallNotes,
        startTime,
        endTime
    } = req.body;

    if (!storeId || !items || items.length === 0) {
        return res.status(400).json({ error: '請完成必要的檢核項目' });
    }

    const connection = await pool.connect();
    
    try {
        await connection.query('BEGIN');

        // 1. 創建或查找巡店計劃
        const currentQuarter = `${new Date().getFullYear()}Q${Math.ceil((new Date().getMonth() + 1) / 3)}`;
        
        let scheduleId;
        const { rows: existingSchedule } = await connection.query(`
            SELECT id FROM inspection_schedules 
            WHERE store_id = $1 AND quarter = $2
        `, [storeId, currentQuarter]);

        if (existingSchedule.length > 0) {
            scheduleId = existingSchedule[0].id;
        } else {
            const { rows: newSchedule } = await connection.query(`
                INSERT INTO inspection_schedules (store_id, store_name, store_type, quarter, status)
                VALUES ($1, $2, $3, $4, 'in_progress')
                RETURNING id
            `, [storeId, storeName, storeType, currentQuarter]);
            scheduleId = newSchedule[0].id;
        }

        // 2. 計算評分結果
        let totalScore = 100; // 基準分數
        let bonusPoints = 0;
        let penaltyPoints = 0;
        let itemsNeedImprovement = 0;
        let criticalIssues = 0;

        // 檢查每個項目並計算分數
        for (const item of items) {
            const { rows: itemInfo } = await connection.query(`
                SELECT weight, is_critical FROM inspection_items WHERE id = $1
            `, [item.item_id]);

            if (itemInfo.length === 0) continue;

            const weight = parseFloat(itemInfo[0].weight) || 1.0;
            const isCritical = itemInfo[0].is_critical;
            const score = parseInt(item.score);
            const weightedScore = score * weight;

            if (score > 0) {
                bonusPoints += weightedScore;
            } else if (score < 0) {
                penaltyPoints += Math.abs(weightedScore);
                itemsNeedImprovement++;
                
                if (isCritical) {
                    criticalIssues++;
                }
            }
        }

        const finalScore = Math.max(0, totalScore + bonusPoints - penaltyPoints);

        // 等級評定（考慮關鍵項目影響）
        let grade = 'D';
        if (criticalIssues > 0 && finalScore < 70) {
            grade = 'D'; // 有關鍵問題強制降級
        } else if (finalScore >= 95) {
            grade = 'A+';
        } else if (finalScore >= 85) {
            grade = 'A';
        } else if (finalScore >= 75) {
            grade = 'B';
        } else if (finalScore >= 65) {
            grade = 'C';
        } else {
            grade = 'D';
        }

        // 3. 插入巡店記錄主表
        const improvementDeadline = itemsNeedImprovement > 0 ? 
            new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) : null;

        const { rows: recordResult } = await connection.query(`
            INSERT INTO inspection_records 
            (schedule_id, store_id, store_name, store_type, inspection_date, 
             inspector_id, inspector_name, total_items, base_score, bonus_points, 
             penalty_points, final_score, grade, items_need_improvement, critical_issues,
             improvement_deadline, status, inspector_comments, inspection_start_time, 
             inspection_end_time)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
            RETURNING id
        `, [
            scheduleId, storeId, storeName, storeType, inspectionDate,
            req.user.id, req.user.name, items.length, totalScore, bonusPoints,
            penaltyPoints, finalScore, grade, itemsNeedImprovement, criticalIssues,
            improvementDeadline, itemsNeedImprovement > 0 ? 'pending_improvement' : 'completed',
            overallNotes, startTime, endTime
        ]);

        const recordId = recordResult[0].id;

        // 4. 插入檢核明細
        for (const item of items) {
            const score = parseInt(item.score);
            const requiresImprovement = score < 0;

            // 獲取項目權重
            const { rows: itemInfo } = await connection.query(`
                SELECT weight FROM inspection_items WHERE id = $1
            `, [item.item_id]);
            const weight = parseFloat(itemInfo[0]?.weight) || 1.0;

            await connection.query(`
                INSERT INTO inspection_details
                (record_id, item_id, item_code, item_name, score, score_weight, 
                 weighted_score, inspector_notes, requires_improvement, improvement_required,
                 improvement_deadline, improvement_priority)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            `, [
                recordId, item.item_id, item.item_code, item.item_name, score, weight,
                score * weight, item.notes || null, requiresImprovement, 
                requiresImprovement ? item.improvement_notes || '請改善此項目' : null,
                requiresImprovement ? improvementDeadline : null,
                requiresImprovement ? (score <= -2 ? 'high' : 'medium') : null
            ]);
        }

        // 5. 更新巡店計劃狀態
        await connection.query(`
            UPDATE inspection_schedules SET status = 'completed' WHERE id = $1
        `, [scheduleId]);

        await connection.query('COMMIT');

        console.log(`✅ 巡店完成：${storeName} - ${finalScore}分 (${grade}級) - ${itemsNeedImprovement}項需改善`);

        res.json({ 
            success: true, 
            data: {
                recordId, 
                finalScore, 
                grade,
                bonusPoints,
                penaltyPoints,
                itemsNeedImprovement,
                criticalIssues,
                improvementDeadline: improvementDeadline?.toISOString(),
                status: itemsNeedImprovement > 0 ? 'pending_improvement' : 'completed',
                message: `巡店記錄已保存。得分：${finalScore}分 (${grade}級)${itemsNeedImprovement > 0 ? `，${itemsNeedImprovement}項需改善` : ''}`
            }
        });

    } catch (error) {
        await connection.query('ROLLBACK');
        console.error('提交巡店記錄錯誤:', error);
        res.status(500).json({ error: '提交失敗', details: error.message });
    } finally {
        connection.release();
    }
});

// ============================================================
// 5. 店長檢視巡店結果和改善項目
// ============================================================
router.get('/manager/inspection-results', requireAuth, requireRole(['manager', 'admin']), async (req, res) => {
    try {
        const managedStores = req.user.managed_stores || [];
        
        if (req.user.roles.includes('manager') && managedStores.length === 0) {
            return res.json({ success: true, data: { results: [], improvements: [] } });
        }

        let whereClause = '';
        let params = [];
        
        if (req.user.roles.includes('manager')) {
            whereClause = 'WHERE ir.store_id = ANY($1)';
            params = [managedStores];
        }

        // 最近巡店結果
        const resultsQuery = `
            SELECT 
                ir.*,
                (SELECT COUNT(*) FROM inspection_details id 
                 WHERE id.record_id = ir.id AND id.requires_improvement = TRUE) as total_improvement_items,
                (SELECT COUNT(*) FROM improvement_photos ip 
                 WHERE ip.record_id = ir.id AND ip.review_status = 'approved') as completed_improvements,
                (SELECT COUNT(*) FROM improvement_photos ip 
                 WHERE ip.record_id = ir.id AND ip.review_status = 'pending') as pending_review_photos
            FROM inspection_records ir
            ${whereClause}
            ORDER BY ir.inspection_date DESC
            LIMIT 10
        `;
        const { rows: results } = await pool.query(resultsQuery, params);

        // 需要改善的項目（負分項目）
        const improvementsQuery = `
            SELECT 
                id.id as detail_id,
                ir.store_name,
                id.item_name,
                id.item_code,
                id.score,
                id.inspector_notes,
                id.improvement_required,
                id.improvement_deadline,
                id.improvement_priority,
                CASE 
                    WHEN id.improvement_deadline < CURRENT_DATE THEN TRUE 
                    ELSE FALSE 
                END as is_overdue,
                (SELECT COUNT(*) FROM improvement_photos ip 
                 WHERE ip.detail_id = id.id AND ip.review_status = 'approved') as completed_photos,
                (SELECT COUNT(*) FROM improvement_photos ip 
                 WHERE ip.detail_id = id.id) as total_photos
            FROM inspection_details id
            JOIN inspection_records ir ON id.record_id = ir.id
            WHERE id.requires_improvement = TRUE
            ${req.user.roles.includes('manager') ? 'AND ir.store_id = ANY($1)' : ''}
            ORDER BY id.improvement_deadline ASC, id.improvement_priority DESC
        `;
        const { rows: improvements } = await pool.query(improvementsQuery, params);

        res.json({ 
            success: true, 
            data: { 
                results, 
                improvements,
                summary: {
                    totalResults: results.length,
                    totalImprovements: improvements.length,
                    overdueImprovements: improvements.filter(item => item.is_overdue).length
                }
            } 
        });

    } catch (error) {
        console.error('店長巡店結果錯誤:', error);
        res.status(500).json({ error: '系統錯誤' });
    }
});

// ============================================================
// 6. 上傳改善照片（店長功能）
// ============================================================
router.post('/upload-improvement-photo/:detailId', requireAuth, upload.single('photo'), async (req, res) => {
    const { detailId } = req.params;
    const { description, photoType = 'improvement' } = req.body;

    if (!req.file) {
        return res.status(400).json({ error: '請選擇照片' });
    }

    try {
        // 查找改善項目詳情
        const { rows: details } = await pool.query(`
            SELECT id.*, ir.store_id, ir.store_name, ir.id as record_id
            FROM inspection_details id
            JOIN inspection_records ir ON id.record_id = ir.id
            WHERE id.id = $1 AND id.requires_improvement = TRUE
        `, [detailId]);

        if (!details.length) {
            return res.status(404).json({ error: '找不到需要改善的項目' });
        }

        const detail = details[0];

        // 保存照片記錄
        await pool.query(`
            INSERT INTO improvement_photos
            (detail_id, record_id, store_id, item_code, photo_type, photo_url, 
             photo_filename, photo_size, uploaded_by, uploader_role, description)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
            detailId, detail.record_id, detail.store_id, detail.item_code,
            photoType, req.file.path, req.file.filename, req.file.size,
            req.user.name, req.user.roles.includes('manager') ? 'manager' : 'staff',
            description || ''
        ]);

        console.log(`📸 改善照片已上傳：${detail.store_name} - ${detail.item_name}`);

        res.json({ 
            success: true, 
            message: '改善照片已上傳，等待督導審核',
            data: {
                filename: req.file.filename,
                uploadedBy: req.user.name
            }
        });

    } catch (error) {
        console.error('上傳改善照片錯誤:', error);
        res.status(500).json({ error: '上傳失敗' });
    }
});

// ============================================================
// 7. 督導審核改善照片
// ============================================================
router.get('/review/pending-photos', requireAuth, requireRole(['admin', 'inspector']), async (req, res) => {
    try {
        const { rows: pendingPhotos } = await pool.query(`
            SELECT 
                ip.*,
                ir.store_name,
                id.item_name,
                id.improvement_required,
                ir.inspection_date
            FROM improvement_photos ip
            JOIN inspection_records ir ON ip.record_id = ir.id
            JOIN inspection_details id ON ip.detail_id = id.id
            WHERE ip.review_status = 'pending'
            ORDER BY ip.uploaded_at ASC
        `);

        res.json({ 
            success: true, 
            data: { photos: pendingPhotos }
        });

    } catch (error) {
        console.error('獲取待審核照片錯誤:', error);
        res.status(500).json({ error: '系統錯誤' });
    }
});

router.post('/review/photo/:photoId', requireAuth, requireRole(['admin', 'inspector']), async (req, res) => {
    const { photoId } = req.params;
    const { status, reviewNotes } = req.body; // status: 'approved' | 'rejected' | 'needs_resubmit'

    if (!['approved', 'rejected', 'needs_resubmit'].includes(status)) {
        return res.status(400).json({ error: '無效的審核狀態' });
    }

    try {
        await pool.query(`
            UPDATE improvement_photos 
            SET review_status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, review_notes = $3
            WHERE id = $4
        `, [status, req.user.name, reviewNotes || null, photoId]);

        const statusText = {
            'approved': '通過審核',
            'rejected': '審核不通過', 
            'needs_resubmit': '需要重新提交'
        }[status];

        res.json({ 
            success: true, 
            message: `照片${statusText}`,
            data: { status, reviewedBy: req.user.name }
        });

    } catch (error) {
        console.error('審核照片錯誤:', error);
        res.status(500).json({ error: '審核失敗' });
    }
});

// ============================================================
// 8. 季度巡店計劃管理
// ============================================================
router.post('/schedule/generate-quarterly', requireAuth, requireRole(['admin']), async (req, res) => {
    const { quarter, stores } = req.body;

    if (!quarter || !stores || !Array.isArray(stores)) {
        return res.status(400).json({ error: '請提供季度和門市列表' });
    }

    const connection = await pool.connect();

    try {
        await connection.query('BEGIN');

        let insertCount = 0;
        const quarterStart = new Date();
        
        for (let i = 0; i < stores.length; i++) {
            const store = stores[i];
            const plannedDate = new Date(quarterStart.getTime() + (i * 7 + Math.floor(Math.random() * 7)) * 24 * 60 * 60 * 1000);
            
            // 檢查是否已存在計劃
            const { rows: existing } = await connection.query(`
                SELECT id FROM inspection_schedules 
                WHERE store_id = $1 AND quarter = $2
            `, [store.id, quarter]);

            if (existing.length === 0) {
                await connection.query(`
                    INSERT INTO inspection_schedules 
                    (store_id, store_name, store_type, quarter, planned_date, status, priority)
                    VALUES ($1, $2, $3, $4, $5, 'planned', $6)
                `, [store.id, store.name, store.type, quarter, plannedDate, Math.floor(Math.random() * 3) + 3]);
                
                insertCount++;
            }
        }

        await connection.query('COMMIT');

        res.json({ 
            success: true, 
            message: `成功產生 ${insertCount} 筆季度巡店計劃`,
            data: { quarter, insertCount }
        });

    } catch (error) {
        await connection.query('ROLLBACK');
        console.error('產生季度計劃錯誤:', error);
        res.status(500).json({ error: '產生計劃失敗' });
    } finally {
        connection.release();
    }
});

// ============================================================
// 9. 統計報告
// ============================================================
router.get('/reports/statistics', requireAuth, requireRole(['admin']), async (req, res) => {
    const quarter = req.query.quarter || `${new Date().getFullYear()}Q${Math.ceil((new Date().getMonth() + 1) / 3)}`;

    try {
        // 整體統計
        const { rows: overall } = await pool.query(`
            SELECT 
                COUNT(*) as total_inspections,
                ROUND(AVG(ir.final_score), 1) as avg_score,
                ROUND(AVG(ir.bonus_points), 1) as avg_bonus,
                ROUND(AVG(ir.penalty_points), 1) as avg_penalty,
                COUNT(CASE WHEN ir.grade IN ('A+', 'A') THEN 1 END) as excellent_count,
                COUNT(CASE WHEN ir.grade = 'D' THEN 1 END) as poor_count,
                SUM(ir.items_need_improvement) as total_improvement_items,
                SUM(ir.critical_issues) as total_critical_issues
            FROM inspection_records ir
            JOIN inspection_schedules s ON ir.schedule_id = s.id
            WHERE s.quarter = $1
        `, [quarter]);

        // 門市排名
        const { rows: storeRankings } = await pool.query(`
            SELECT 
                ir.store_name,
                ir.store_type,
                ir.final_score,
                ir.grade,
                ir.bonus_points,
                ir.penalty_points,
                ir.items_need_improvement,
                ir.inspection_date,
                ROW_NUMBER() OVER (ORDER BY ir.final_score DESC) as ranking
            FROM inspection_records ir
            JOIN inspection_schedules s ON ir.schedule_id = s.id
            WHERE s.quarter = $1
            ORDER BY ir.final_score DESC
        `, [quarter]);

        // 最常見問題（負分項目統計）
        const { rows: commonIssues } = await pool.query(`
            SELECT 
                id.item_name,
                id.item_code,
                COUNT(*) as failure_count,
                ROUND(AVG(ABS(id.score)), 1) as avg_penalty_score,
                ROUND(AVG(id.score_weight), 2) as avg_weight,
                COUNT(CASE WHEN ii.is_critical THEN 1 END) as critical_failures
            FROM inspection_details id
            JOIN inspection_items ii ON id.item_id = ii.id
            JOIN inspection_records ir ON id.record_id = ir.id
            JOIN inspection_schedules s ON ir.schedule_id = s.id
            WHERE id.score < 0 AND s.quarter = $1
            GROUP BY id.item_name, id.item_code
            ORDER BY failure_count DESC, avg_penalty_score DESC
            LIMIT 15
        `, [quarter]);

        // 改善追蹤統計
        const { rows: improvementStats } = await pool.query(`
            SELECT 
                COUNT(*) as total_improvements,
                COUNT(CASE WHEN ip.review_status = 'approved' THEN 1 END) as completed_improvements,
                COUNT(CASE WHEN ip.review_status = 'pending' THEN 1 END) as pending_improvements,
                COUNT(CASE WHEN id.improvement_deadline < CURRENT_DATE 
                           AND ip.review_status != 'approved' THEN 1 END) as overdue_improvements
            FROM inspection_details id
            JOIN inspection_records ir ON id.record_id = ir.id
            JOIN inspection_schedules s ON ir.schedule_id = s.id
            LEFT JOIN improvement_photos ip ON id.id = ip.detail_id
            WHERE id.requires_improvement = TRUE AND s.quarter = $1
        `, [quarter]);

        res.json({
            success: true,
            data: {
                quarter,
                overall: overall[0],
                storeRankings,
                commonIssues,
                improvementStats: improvementStats[0],
                generatedAt: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('統計報告錯誤:', error);
        res.status(500).json({ error: '系統錯誤' });
    }
});

// ============================================================
// 10. 系統管理功能
// ============================================================

// 獲取檢核項目管理
router.get('/admin/inspection-items', requireAuth, requireRole(['admin']), async (req, res) => {
    try {
        const { rows: items } = await pool.query(`
            SELECT ii.*, ic.category_name
            FROM inspection_items ii
            JOIN inspection_categories ic ON ii.category_id = ic.id
            ORDER BY ic.sort_order, ii.sort_order
        `);

        res.json({ success: true, data: { items } });
    } catch (error) {
        console.error('獲取檢核項目錯誤:', error);
        res.status(500).json({ error: '系統錯誤' });
    }
});

// 更新檢核項目
router.put('/admin/inspection-items/:itemId', requireAuth, requireRole(['admin']), async (req, res) => {
    const { itemId } = req.params;
    const updateData = req.body;

    try {
        const setClause = Object.keys(updateData)
            .map((key, index) => `${key} = $${index + 2}`)
            .join(', ');
        
        const values = [itemId, ...Object.values(updateData)];
        
        await pool.query(`
            UPDATE inspection_items 
            SET ${setClause}, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, values);

        res.json({ success: true, message: '檢核項目已更新' });
    } catch (error) {
        console.error('更新檢核項目錯誤:', error);
        res.status(500).json({ error: '更新失敗' });
    }
});

export default router;