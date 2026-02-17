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
/** 配額不足時每輪最多刪除的試算表數（服務帳號約 15GB，多輪清理直到可建立或無可刪） */
const QUOTA_CLEANUP_PAGE_SIZE = 100;
const QUOTA_CLEANUP_MAX_ROUNDS = 5;

/**
 * 查詢目前 Drive 儲存用量（about.get）
 * @param {object} drive - google.drive('v3') 實例
 * @returns {Promise<{ limit?: string, usage?: string, usageInDrive?: string }|null>}
 */
async function getDriveStorageQuota(drive) {
  try {
    const about = await drive.about.get({ fields: 'storageQuota' });
    const q = about?.data?.storageQuota || {};
    return {
      limit: q.limit,
      usage: q.usage,
      usageInDrive: q.usageInDrive,
      usageInDriveTrash: q.usageInDriveTrash,
    };
  } catch (e) {
    console.warn('[attendance-sheet] about.get failed:', e?.message);
    return null;
  }
}

/**
 * 配額不足時刪除可刪的舊檔案以釋出空間
 * 順序：1) 自己擁有的試算表 2) 自己擁有的所有檔案 3) 若 folderId 有設，該資料夾內的試算表
 * @param {object} drive - google.drive('v3') 實例
 * @param {string} [folderId] - FOLDER_ID_FOR_ATTENDANCE_SHEETS，若檔案在共用資料夾內
 * @returns {Promise<number>} 刪除的檔案數
 */
async function deleteOldAttendanceSpreadsheets(drive, folderId = '') {
  let deleted = 0;
  try {
    const quota = await getDriveStorageQuota(drive);
    if (quota) {
      const limitGb = quota.limit ? (Number(quota.limit) / 1e9).toFixed(2) : '?';
      const usageGb = quota.usage ? (Number(quota.usage) / 1e9).toFixed(2) : '?';
      console.warn('[attendance-sheet] Drive storage: usage=', usageGb, 'GB, limit=', limitGb, 'GB');
    }
    let files = [];
    const listOpts = {
      fields: 'files(id, name, createdTime, mimeType)',
      orderBy: 'createdTime asc',
      pageSize: QUOTA_CLEANUP_PAGE_SIZE,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    };
    const queries = [
      "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and 'me' in owners",
      "trashed = false and 'me' in owners",
    ];
    if (folderId) {
      queries.push(`mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and '${folderId}' in parents`);
    }
    for (const q of queries) {
      console.warn('[attendance-sheet] quota exceeded, listing for cleanup, q=', q.slice(0, 80), '...');
      const res = await drive.files.list({ ...listOpts, q });
      files = res.data.files || [];
      if (files.length > 0) break;
    }
    console.warn('[attendance-sheet] quota cleanup: found', files.length, 'files, deleting oldest');
    for (const f of files) {
      try {
        await drive.files.delete({ fileId: f.id, supportsAllDrives: true });
        deleted++;
        console.warn('[attendance-sheet] deleted for quota:', f.id, f.name);
      } catch (e) {
        const msg = e?.response?.data?.error?.message || e?.message;
        const code = e?.response?.data?.error?.code || e?.code;
        console.warn('[attendance-sheet] delete failed:', f.id, 'code=', code, 'message=', msg);
      }
    }
    console.warn('[attendance-sheet] quota cleanup: deleted', deleted, 'files');
  } catch (e) {
    console.warn('[attendance-sheet] deleteOldAttendanceSpreadsheets error:', e?.message);
  }
  return deleted;
}

/** 試算表名稱中的單引號要雙寫（用於 A1 範圍） */
function escapeSheetTitle(title) {
  return String(title || '').replace(/'/g, "''");
}

/** 工作表名稱淨化：Google Sheets 不可含 : \\ / ? * [ ]，長度上限約 100 */
function sanitizeSheetTitle(title, fallback = 'Sheet') {
  let s = String(title || '').trim();
  s = s.replace(/[:\\/?*[\]]/g, '_').replace(/_+/g, '_').trim();
  if (s.length > 100) s = s.slice(0, 100);
  return s || fallback;
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
  // 記錄實際呼叫者，方便 403 時排查（ADC 時 getCredentials 常無 client_email，改從 metadata 取）
  let caller = '(unknown)';
  try {
    const creds = await auth.getCredentials?.();
    caller = creds?.client_email ?? null;
    if (!caller && typeof fetch === 'function') {
      const meta =
        await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email', {
          headers: { 'Metadata-Flavor': 'Google' },
        }).then((r) => (r.ok ? r.text() : null)).catch(() => null);
      if (meta) caller = meta;
    }
    if (!caller) caller = '(ADC, enable Drive API in project)';
  } catch (e) {
    caller = `(error: ${e?.message})`;
  }
  console.warn('[attendance-sheet] createSpreadsheet caller:', caller);

  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  // 與 GAS SendExcel 一致：工作表名稱須淨化（不可含 : \ / ? * [ ]），避免 create 失敗
  const sheetProps = perStoreData.map((s, i) => ({
    properties: { title: sanitizeSheetTitle(s.sheetTitle, `店${i + 1}`) },
  }));

  let spreadsheetId;
  let createRes = null;
  try {
    createRes = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: sheetProps,
      },
    });
    spreadsheetId = createRes.data.spreadsheetId;
  } catch (e) {
    const err = e?.response?.data?.error;
    const is403 = (err?.code === 403 || err?.status === 'PERMISSION_DENIED');
    const msg = err?.message || e?.message;
    console.error(
      '[attendance-sheet] spreadsheets.create failed:',
      msg,
      'code=',
      err?.code,
      'status=',
      err?.status,
      err?.errors ? 'details=' + JSON.stringify(err.errors) : '',
    );
    if (is403) {
      const folderId = (process.env.FOLDER_ID_FOR_ATTENDANCE_SHEETS || '').trim();
      const driveBody = {
        name: title,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        ...(folderId ? { parents: [folderId] } : {}),
      };
      if (folderId) {
        console.warn('[attendance-sheet] creating spreadsheet in folder (FOLDER_ID_FOR_ATTENDANCE_SHEETS):', folderId);
      }
      try {
        let driveRes = null;
        for (let round = 0; round < QUOTA_CLEANUP_MAX_ROUNDS && !driveRes; round++) {
          try {
            driveRes = await drive.files.create({ requestBody: driveBody });
          } catch (driveErr) {
            const dm = driveErr?.response?.data?.error?.message || driveErr?.message;
            const isQuotaExceeded = /quota|storage.*exceeded/i.test(dm || '');
            // 服務帳號建立檔案時，無論是否有 parents，檔案擁有者都是服務帳號，配額計入 SA 的 15GB
            // 故有 folderId 時也要清服務帳號 Drive 的舊試算表，再重試
            if (isQuotaExceeded) {
              const cleaned = await deleteOldAttendanceSpreadsheets(drive, folderId);
              if (cleaned > 0) {
                console.warn('[attendance-sheet] quota cleanup round', round + 1, ', deleted', cleaned, ', retrying create');
                continue;
              }
              if (cleaned === 0 && round === 0) {
                console.warn('[attendance-sheet] quota exceeded but no owned spreadsheets to delete (or delete failed)');
              }
            }
            throw driveErr;
          }
        }
        if (driveRes) {
          spreadsheetId = driveRes.data.id;
          console.warn('[attendance-sheet] spreadsheets.create 403, used drive.files.create fallback, id=', spreadsheetId, folderId ? 'folder=' + folderId : '');
          createRes = { data: { spreadsheetId } };
        }
      } catch (driveErr) {
        const dm = driveErr?.response?.data?.error?.message || driveErr?.message;
        const driveCode = driveErr?.response?.data?.error?.code ?? driveErr?.code;
        const rawData = driveErr?.response?.data ? JSON.stringify(driveErr.response.data) : '';
        console.error('[attendance-sheet] drive.files.create fallback failed:', 'code=', driveCode, 'message=', dm, 'raw=', rawData);
        throw new Error(`建立試算表失敗（Drive）: ${dm || msg}`);
      }
    } else {
      throw new Error(`建立試算表失敗: ${msg}`);
    }
  }

  if (!spreadsheetId) spreadsheetId = createRes?.data?.spreadsheetId;
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  // 若用 Drive API 建立，試算表只有預設 Sheet1，需用 Sheets API 新增各店工作表
  const usedDriveFallback = !createRes?.data?.sheets?.length && spreadsheetId;
  if (usedDriveFallback && perStoreData.length > 0) {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: perStoreData.map((store, i) => ({
            addSheet: {
              properties: { title: sanitizeSheetTitle(store.sheetTitle, `店${i + 1}`) },
            },
          })),
        },
      });
    } catch (e) {
      console.error('[attendance-sheet] batchUpdate addSheet failed:', e?.response?.data?.error?.message || e?.message);
      throw new Error(`建立試算表失敗: 無法新增工作表（${e?.response?.data?.error?.message || e?.message}）`);
    }
  }

  for (let i = 0; i < perStoreData.length; i++) {
    const store = perStoreData[i];
    const sheetTitle = sanitizeSheetTitle(store.sheetTitle, `店${i + 1}`);
    const rawRows = [
      Array.isArray(store.headerRow1) ? store.headerRow1 : [store.headerRow1],
      Array.isArray(store.headerRow2) ? store.headerRow2 : [store.headerRow2],
      ...(store.dataRows || []).map((r) => (Array.isArray(r) ? r : [r])),
    ];
    if (rawRows.length === 0) continue;
    const rows = rawRows.length;
    const cols = Math.max(...rawRows.map((r) => (r || []).length), 1);
    const padded = rawRows.map((row) => {
      const r = [...(Array.isArray(row) ? row : [row])];
      while (r.length < cols) r.push('');
      return r.slice(0, cols).map((c) => (c == null ? '' : c));
    });
    const colLetter = colIndexToLetter(cols);
    const range = `'${escapeSheetTitle(sheetTitle)}'!A1:${colLetter}${rows}`;
    try {
      await writeSheet(auth, spreadsheetId, range, padded);
    } catch (e) {
      const msg = e?.response?.data?.error?.message || e?.message;
      console.error('[attendance-sheet] writeSheet failed sheetIndex=', i, 'sheetTitle=', sheetTitle, msg, e?.response?.data);
      throw new Error(`寫入工作表「${sheetTitle}」失敗: ${msg}`);
    }
  }

  try {
    await drive.permissions.create({
      fileId: spreadsheetId,
      requestBody: { type: 'anyone', role: 'reader' },
    });
  } catch (e) {
    console.warn('[attendance-sheet] set anyone reader failed:', e?.message, 'spreadsheetId=', spreadsheetId);
  }

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
