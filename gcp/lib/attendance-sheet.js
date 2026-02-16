/**
 * 店家本月/上月出勤：產出試算表並回傳連結（與 GAS SendExcel.js 行為對齊）
 * - 同人同月先查「請求表單紀錄」快取，有則回傳既有連結
 * - 無則建立新試算表、寫入各店出勤、設為「知道連結即可檢視」、寫回快取
 */

import { randomUUID } from 'crypto';
import { google } from 'googleapis';
import {
  readSheet,
  appendSheet,
  getLastRow,
  batchUpdateValues,
  writeSheet,
} from './sheets.js';

const REQUEST_LOG_SHEET = '請求表單紀錄';

/** 試算表名稱中的單引號要雙寫 */
function escapeSheetTitle(title) {
  return String(title || '').replace(/'/g, "''");
}

/** 1-based 欄位索引轉 A1 表示法：1=A, 26=Z, 27=AA */
function colIndexToLetter(n) {
  let s = '';
  let k = Number(n) || 0;
  if (k <= 0) return 'A';
  while (k > 0) {
    const r = (k - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    k = Math.floor((k - 1) / 26);
  }
  return s;
}

/** 上月小費寫入同一表時 G 欄為 YYYYMM_小費_userId，此列不可當作出勤快取 */
const TIPS_ROW_G_PATTERN = /^\d{6}_小費_/;

/**
 * 從「請求表單紀錄」查同人同月是否已有「出勤」連結。
 * 與「上月小費」共用同一工作表時，僅採用非小費列（G 欄非 YYYYMM_小費_ 開頭）。
 * A=uuid, B=userId, C=start(yyyy-MM), D=url, E=createTime, F=updateTime, G=備註(小費為 YYYYMM_小費_userId)
 * @returns {Promise<string|null>} 已有則回傳 url，無則 null
 */
export async function getCachedAttendanceSheetUrl(auth, sheetReader, staffSsId, userId, yyyyMM) {
  if (!staffSsId || !userId || !yyyyMM) return null;
  try {
    const rows = await sheetReader(auth, staffSsId, `'${REQUEST_LOG_SHEET}'!A:G`);
    if (!rows || rows.length < 2) return null;
    for (let i = rows.length - 1; i >= 1; i--) {
      const row = rows[i];
      const rowG = String(row[6] || '').trim();
      if (TIPS_ROW_G_PATTERN.test(rowG)) continue; // 上月小費列，跳過
      const rowUserId = String(row[1] || '').trim();
      const rowStart = row[2];
      const rowUrl = String(row[3] || '').trim();
      if (rowUserId !== userId || !rowUrl) continue;
      // 與 GAS 一致：C 欄可能是 Date（GAS 寫入）或字串；Date 須用台北時區取 yyyy-MM，避免 UTC 造成月份錯誤
      const rowYyyyMM =
        rowStart instanceof Date
          ? rowStart.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).slice(0, 7)
          : String(rowStart || '').trim().slice(0, 7);
      if (rowYyyyMM === yyyyMM) return rowUrl;
    }
  } catch (e) {
    console.error('[attendance-sheet] getCachedAttendanceSheetUrl:', e.message);
  }
  return null;
}

/**
 * 建立新試算表、寫入各店出勤、設為任何人可檢視，回傳試算表 URL
 * @param {object} auth - Google Auth client
 * @param {string} title - 試算表標題，如 泡泡貓_出勤記錄_20260216_1345
 * @param {Array<{ sheetTitle: string, headerRow1: any[], headerRow2: any[], dataRows: any[][] }>} perStoreData - 各店資料（與 GAS SendExcel 格式一致）
 * @returns {Promise<{ url: string, spreadsheetId: string }>}
 */
export async function createAttendanceSpreadsheetAndShare(auth, title, perStoreData) {
  if (!perStoreData || perStoreData.length === 0) {
    throw new Error('perStoreData 為空');
  }
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  const sheetProps = perStoreData.map((s) => ({
    properties: { title: s.sheetTitle },
  }));

  const createRes = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: sheetProps,
    },
  });
  const spreadsheetId = createRes.data.spreadsheetId;
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  for (let i = 0; i < perStoreData.length; i++) {
    const store = perStoreData[i];
    const sheetTitle = store.sheetTitle;
    const values = [store.headerRow1, store.headerRow2, ...(store.dataRows || [])];
    if (values.length === 0) continue;
    const rows = values.length;
    const cols = Math.max(...values.map((r) => (r || []).length), 1);
    const colLetter = colIndexToLetter(cols);
    const range = `'${escapeSheetTitle(sheetTitle)}'!A1:${colLetter}${rows}`;
    await writeSheet(auth, spreadsheetId, range, values);
  }

  await drive.permissions.create({
    fileId: spreadsheetId,
    requestBody: { type: 'anyone', role: 'reader' },
  });

  return { url, spreadsheetId };
}

/**
 * 在「請求表單紀錄」新增一列並寫入 url、更新時間（與 GAS getSignExcel + modifySignExcel 對齊）
 * 欄位：A=uuid, B=userId, C=yyyyMM, D=url, E=createTime, F=updateTime
 */
export async function saveAttendanceRequestCache(auth, staffSsId, userId, yyyyMM, url) {
  const uuid = randomUUID();
  const now = new Date();
  const nowStr = now.toISOString();
  const lastRow = await getLastRow(auth, staffSsId, REQUEST_LOG_SHEET);
  const newRow = [uuid, userId, yyyyMM, '', nowStr, nowStr];
  await appendSheet(auth, staffSsId, REQUEST_LOG_SHEET, newRow);
  const rowToUpdate = lastRow + 1;
  await batchUpdateValues(auth, staffSsId, [
    { range: `'${REQUEST_LOG_SHEET}'!D${rowToUpdate}`, values: [[url]] },
    { range: `'${REQUEST_LOG_SHEET}'!F${rowToUpdate}`, values: [[nowStr]] },
  ]);
}
