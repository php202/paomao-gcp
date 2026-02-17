/**
 * 店家本月/上月出勤：產出 Excel 並上傳至 GCS，產生 signed URL
 * - 取代 Google Sheets（Drive 配額不足時無法建立）
 * - perStoreData 格式與 attendance-sheet.js 一致：{ sheetTitle, headerRow1, headerRow2, dataRows }
 */

import ExcelJS from 'exceljs';
import { Storage } from '@google-cloud/storage';

const BUCKET = (process.env.GCS_BUCKET_ATTENDANCE || '').trim();
/** signed URL 有效天數（使用者可在期限內下載） */
const SIGNED_URL_EXPIRY_DAYS = 7;

/**
 * 工作表名稱淨化：Excel 不可含 : \\ / ? * [ ]，長度上限約 31
 */
function sanitizeSheetTitle(title, fallback = 'Sheet') {
  let s = String(title || '').trim();
  s = s.replace(/[:\\/?*[\]]/g, '_').replace(/_+/g, '_').trim();
  if (s.length > 31) s = s.slice(0, 31);
  return s || fallback;
}

/**
 * 從 GCS 物件路徑產生 signed URL（給 cache 回傳時使用）
 * @param {string} gcsPath - 物件路徑，如 attendance/2026-02/userId_timestamp.xlsx
 * @returns {Promise<string>} signed URL
 */
export async function getSignedUrlFromGcsPath(gcsPath) {
  if (!BUCKET || !gcsPath) {
    throw new Error('GCS_BUCKET_ATTENDANCE 或 gcsPath 未設定');
  }
  const storage = new Storage();
  const file = storage.bucket(BUCKET).file(gcsPath);
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + SIGNED_URL_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  });
  return url;
}

/**
 * 建立 Excel 檔並上傳至 GCS，回傳 signed URL 與 GCS 路徑
 * @param {string} title - 檔名前綴，如 泡泡貓_出勤記錄_20260216_1345
 * @param {Array<{ sheetTitle: string, headerRow1: any[], headerRow2: any[], dataRows: any[][] }>} perStoreData - 各店資料
 * @param {string} userId - 使用者 ID（用於路徑）
 * @param {string} yyyyMM - 年月，如 2026-02
 * @returns {Promise<{ url: string, gcsPath: string }>}
 */
export async function createAttendanceExcelAndUpload(title, perStoreData, userId, yyyyMM) {
  if (!BUCKET) {
    throw new Error('請設定環境變數 GCS_BUCKET_ATTENDANCE（GCS bucket 名稱）');
  }
  if (!perStoreData || perStoreData.length === 0) {
    throw new Error('perStoreData 為空');
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'pao-checkin-api';
  workbook.created = new Date();

  for (let i = 0; i < perStoreData.length; i++) {
    const store = perStoreData[i];
    const sheetTitle = sanitizeSheetTitle(store.sheetTitle, `店${i + 1}`);
    const sheet = workbook.addWorksheet(sheetTitle);

    const rawRows = [
      Array.isArray(store.headerRow1) ? store.headerRow1 : [store.headerRow1],
      Array.isArray(store.headerRow2) ? store.headerRow2 : [store.headerRow2],
      ...(store.dataRows || []).map((r) => (Array.isArray(r) ? r : [r])),
    ];

    rawRows.forEach((values) => {
      const rowValues = (values || []).map((v) => (v != null ? v : ''));
      sheet.addRow(rowValues);
    });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const userSuffix = (userId || '').slice(-8).replace(/[^a-zA-Z0-9]/g, '') || 'anon';
  const gcsPath = `attendance/${yyyyMM}/${userSuffix}_${timestamp}.xlsx`;

  const buffer = await workbook.xlsx.writeBuffer();
  const storage = new Storage();
  const file = storage.bucket(BUCKET).file(gcsPath);
  await file.save(buffer, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    metadata: { cacheControl: 'private, max-age=86400' },
  });

  const url = await getSignedUrlFromGcsPath(gcsPath);
  return { url, gcsPath };
}
