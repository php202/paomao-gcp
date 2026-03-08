import { getAuth } from '../lib/auth.js';
import { readSheet } from '../lib/sheets.js';
import pool from '../lib/db.js';

const SHEET_ID = '1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0';

// 將 Excel 序列號轉換為日期
function excelSerialToDate(serial) {
    if (!serial || typeof serial !== 'number') return null;
    // Excel 日期起始點是 1900/1/1，但實際上是 1899/12/30
    const excelEpoch = new Date(1899, 11, 30); // 1899年12月30日
    const date = new Date(excelEpoch.getTime() + serial * 24 * 60 * 60 * 1000);
    return date.toISOString();
}

// 處理日期時間字串
function parseDateTime(dateStr) {
    if (!dateStr) return null;
    
    // 如果是數字，當作 Excel 序列號
    if (typeof dateStr === 'number') {
        return excelSerialToDate(dateStr);
    }
    
    // 如果是字串，嘗試解析
    try {
        const date = new Date(dateStr);
        return isNaN(date.getTime()) ? null : date.toISOString();
    } catch (e) {
        console.warn(`無法解析日期: ${dateStr}`);
        return null;
    }
}

// 遷移客人消費狀態
async function migrateCustomerStatus() {
    console.log('開始遷移客人消費狀態...');
    
    const auth = await getAuth();
    const rows = await readSheet(auth, SHEET_ID, "'客人消費狀態'!A:S");
    
    if (!rows || rows.length <= 1) {
        console.log('沒有找到資料');
        return { success: 0, failed: 0 };
    }
    
    const headers = rows[0];
    const dataRows = rows.slice(1);
    
    console.log(`找到 ${dataRows.length} 筆客人消費狀態資料`);
    
    let success = 0;
    let failed = 0;
    
    for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        
        try {
            const 時間 = parseDateTime(row[0]);
            const 手機 = row[1] || null;
            const 員工填寫 = row[2] || null;
            const 客人問卷 = row[3] || null;
            const line對話 = row[4] || null;
            const 消費紀錄 = row[5] || null;
            const 儲值紀錄 = row[6] || null;
            const saydouUserId = row[7] || null;
            const ai_prompt = row[8] || null;
            const lineUserId = row[9] || null;
            const AI分析結果 = row[10] || null;
            const ai調整建議 = row[11] || null;
            const 預約記錄 = row[12] || null;
            const 建議下次回訪日 = parseDateTime(row[13])?.split('T')[0] || null; // 只取日期部分
            const 最後推播時間 = parseDateTime(row[14]);
            const 推播次數 = row[15] && !isNaN(parseInt(row[15])) ? parseInt(row[15]) : null;
            const 點擊積分 = row[16] && !isNaN(parseInt(row[16])) ? parseInt(row[16]) : null;
            const 連續未點擊 = row[17] && !isNaN(parseInt(row[17])) ? parseInt(row[17]) : null;
            const 客戶類型 = row[18] || null;
            
            await pool.query(`
                INSERT INTO customer_status (
                    時間, 手機, 員工填寫, 客人問卷, line對話, 消費紀錄, 儲值紀錄,
                    saydouUserId, ai_prompt, lineUserId, AI分析結果, ai調整建議,
                    預約記錄, 建議下次回訪日, 最後推播時間, 推播次數, 點擊積分,
                    連續未點擊, 客戶類型
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
            `, [
                時間, 手機, 員工填寫, 客人問卷, line對話, 消費紀錄, 儲值紀錄,
                saydouUserId, ai_prompt, lineUserId, AI分析結果, ai調整建議,
                預約記錄, 建議下次回訪日, 最後推播時間, 推播次數, 點擊積分,
                連續未點擊, 客戶類型
            ]);
            
            success++;
        } catch (error) {
            console.error(`第 ${i + 1} 筆資料插入失敗:`, error.message);
            failed++;
        }
    }
    
    return { success, failed };
}

// 遷移表單回覆
async function migrateFormResponses() {
    console.log('開始遷移表單回覆...');
    
    const auth = await getAuth();
    const rows = await readSheet(auth, SHEET_ID, "'表單回覆 3'!A:G");
    
    if (!rows || rows.length <= 1) {
        console.log('沒有找到資料');
        return { success: 0, failed: 0 };
    }
    
    const headers = rows[0];
    const dataRows = rows.slice(1);
    
    console.log(`找到 ${dataRows.length} 筆表單回覆資料`);
    
    let success = 0;
    let failed = 0;
    
    for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        
        try {
            const 時間戳記 = parseDateTime(row[0]);
            const 客人手機 = row[1] || null;
            const 互動喜好度 = row[2] && !isNaN(parseInt(row[2])) ? parseInt(row[2]) : null;
            const 肌膚類型 = row[3] || null;
            const 推薦項目 = row[4] || null;
            const 使用產品備註 = row[5] || null;
            const 特別紀錄 = row[6] || null;
            
            await pool.query(`
                INSERT INTO customer_form_responses (
                    時間戳記, 客人手機, 互動喜好度, 肌膚類型, 推薦項目, 使用產品備註, 特別紀錄
                ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [
                時間戳記, 客人手機, 互動喜好度, 肌膚類型, 推薦項目, 使用產品備註, 特別紀錄
            ]);
            
            success++;
        } catch (error) {
            console.error(`第 ${i + 1} 筆資料插入失敗:`, error.message);
            failed++;
        }
    }
    
    return { success, failed };
}

// 主要執行函數
export async function run() {
    try {
        console.log('=== 開始遷移客人消費狀態資料 ===');
        
        // 清空現有資料（可選）
        await pool.query('TRUNCATE TABLE customer_status RESTART IDENTITY');
        await pool.query('TRUNCATE TABLE customer_form_responses RESTART IDENTITY');
        console.log('已清空現有資料');
        
        // 遷移客人消費狀態
        const customerStatusResult = await migrateCustomerStatus();
        
        // 遷移表單回覆
        const formResponsesResult = await migrateFormResponses();
        
        // 總結
        console.log('\n=== 遷移完成 ===');
        console.log(`客人消費狀態: 成功 ${customerStatusResult.success} 筆, 失敗 ${customerStatusResult.failed} 筆`);
        console.log(`表單回覆: 成功 ${formResponsesResult.success} 筆, 失敗 ${formResponsesResult.failed} 筆`);
        console.log(`總計: 成功 ${customerStatusResult.success + formResponsesResult.success} 筆, 失敗 ${customerStatusResult.failed + formResponsesResult.failed} 筆`);
        
        // 檢查資料庫記錄數
        const statusCountResult = await pool.query('SELECT COUNT(*) FROM customer_status');
        const formCountResult = await pool.query('SELECT COUNT(*) FROM customer_form_responses');
        
        console.log(`\n資料庫確認:`);
        console.log(`customer_status 表: ${statusCountResult.rows[0].count} 筆`);
        console.log(`customer_form_responses 表: ${formCountResult.rows[0].count} 筆`);
        
    } catch (error) {
        console.error('遷移失敗:', error);
    } finally {
        await pool.end();
    }
}

// 如果直接執行此檔案
if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}