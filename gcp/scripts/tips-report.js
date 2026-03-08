/**
 * 上月小費報表 — 本機版（取代 GAS lastMonthTipsReport）
 * 從小費統整表讀取上月資料，依身份篩選，產出新 Google Sheet 並回傳連結。
 */
import { google } from 'googleapis';

const TIPS_SS_ID = '1GH2XbihFIY0AX8SMF9Tk6igrVKPpA_vMJVlkDkJjpe4';
const TIPS_DATA_GID = 1727178779;    // 小費統整表 (資料)
const TIPS_LOG_GID = 1792957916;     // 請求紀錄表
const TZ = 'Asia/Taipei';

// 顯示欄位順序 (0-based col index from consolidated sheet)
// A(0)時間, T(19)姓名, B(1)手機, L(11)小費, R(17)儲值金, N(13)消費項目, O(14)消費備註, P(15)消費金額,
// E(4)再次光臨, F(5)服務體驗, G(6)品牌信任, K(10)星數, H(7)滿意服務, I(8)得知管道, J(9)建議
const DISPLAY_COLS = [0, 19, 1, 11, 17, 13, 14, 15, 4, 5, 6, 10, 7, 8, 9];

async function getAuth() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || `${process.env.HOME}/.openclaw/secrets/gcp-service-account.json`;
  return new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function getLastMonth() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based, so this is already "last month" relative to current
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0);
  const fmt = d => d.toLocaleDateString('sv-SE', { timeZone: TZ }); // yyyy-MM-dd
  return { startDate: fmt(first), endDate: fmt(last), monthStr: fmt(first).slice(0, 7) };
}

/**
 * Find the sheet name by gid
 */
async function getSheetNameByGid(sheets, ssId, gid) {
  const res = await sheets.spreadsheets.get({ spreadsheetId: ssId, fields: 'sheets.properties' });
  const sheet = res.data.sheets.find(s => s.properties.sheetId === gid);
  return sheet ? sheet.properties.title : null;
}

/**
 * Parse timestamp string like "2026/2/15 下午 2:30:00" into Date
 */
function parseTimestamp(str) {
  if (!str || typeof str !== 'string') return null;
  let s = str.trim();
  const isPM = s.includes('下午');
  const isAM = s.includes('上午');
  s = s.replace(/上午|下午/g, '').trim();
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  if (isPM && d.getHours() < 12) d.setHours(d.getHours() + 12);
  if (isAM && d.getHours() === 12) d.setHours(0);
  return d;
}

function dateStr(d) {
  return d.toLocaleDateString('sv-SE', { timeZone: TZ });
}

/**
 * Main: get or create last month tips sheet
 */
export async function lastMonthTipsReport({ userId, managedStoreIds = [], employeeCode = '' }) {
  if (!userId) return { ok: false, message: '缺少 userId' };

  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  // drive not needed — writing to existing spreadsheet tab

  const { startDate, endDate, monthStr } = getLastMonth();
  const monthKey = monthStr.replace('-', '');
  const remarkKey = `${monthKey}_小費_${userId}`;

  // 1. Check request log for cached result
  const logSheetName = await getSheetNameByGid(sheets, TIPS_SS_ID, TIPS_LOG_GID);
  if (logSheetName) {
    try {
      const logRes = await sheets.spreadsheets.values.get({
        spreadsheetId: TIPS_SS_ID,
        range: `'${logSheetName}'`,
      });
      const logRows = logRes.data.values || [];
      for (let i = 1; i < logRows.length; i++) {
        const row = logRows[i] || [];
        if ((row[6] || '').trim() === remarkKey && (row[3] || '').trim()) {
          return { ok: true, url: row[3].trim(), cached: true };
        }
      }
    } catch (e) {
      console.error('[tips] log read error:', e.message);
    }
  }

  // 2. Read consolidated data
  const dataSheetName = await getSheetNameByGid(sheets, TIPS_SS_ID, TIPS_DATA_GID);
  if (!dataSheetName) return { ok: false, message: '找不到小費統整表' };

  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: TIPS_SS_ID,
    range: `'${dataSheetName}'`,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const allRows = dataRes.data.values || [];
  if (allRows.length < 2) return { ok: false, message: '小費統整表無資料' };

  const header = allRows[0];
  // Find key columns
  let storIdCol = -1, remarkCol = -1;
  header.forEach((h, i) => {
    const t = (h || '').trim();
    if (t === '消費店家storId') storIdCol = i;
    if (t === '消費備註') remarkCol = i;
  });
  if (storIdCol < 0) return { ok: false, message: '小費統整表無「消費店家storId」欄' };

  // 3. Filter by date range + identity
  const ids = (managedStoreIds || []).map(s => String(s).trim()).filter(Boolean);
  const empCode = (employeeCode || '').trim().toLowerCase();

  const filtered = [];
  for (let r = 1; r < allRows.length; r++) {
    const row = allRows[r] || [];
    const tsVal = row[0] || '';
    const dt = parseTimestamp(tsVal) || new Date(tsVal);
    if (!dt || isNaN(dt.getTime())) continue;
    const ds = dateStr(dt);
    if (ds < startDate || ds > endDate) continue;

    // Filter by store (manager)
    if (ids.length > 0) {
      const sid = (row[storIdCol] || '').trim();
      if (!ids.includes(sid)) continue;
    }
    // Filter by employee code
    if (empCode) {
      const remark = remarkCol >= 0 ? (row[remarkCol] || '').toLowerCase() : '';
      if (!remark.includes(empCode)) continue;
    }
    filtered.push(row);
  }

  // Sort by storId if manager
  if (ids.length > 0) {
    filtered.sort((a, b) => ((a[storIdCol] || '') > (b[storIdCol] || '') ? 1 : -1));
  }

  // 4. Build display data
  const displayHeader = DISPLAY_COLS.map(c => {
    if (c === 19) return '姓名';
    if (c === 1) return '手機';
    return (c < header.length ? header[c] : '') || '';
  });

  const displayRows = filtered.map(row =>
    DISPLAY_COLS.map(c => {
      const v = c < row.length ? row[c] : '';
      return v != null ? String(v) : '';
    })
  );

  // 5. Write to a dedicated output sheet in the same spreadsheet (avoid SA Drive quota issue)
  //    Use a sheet named "報表_YYYYMM_userId-hash" to avoid conflicts
  const userHash = userId.slice(-8);
  const outputSheetTitle = `報表_${monthKey}_${userHash}`;
  
  // Check if output sheet already exists
  const ssMetaRes = await sheets.spreadsheets.get({ spreadsheetId: TIPS_SS_ID, fields: 'sheets.properties' });
  const existingSheet = ssMetaRes.data.sheets.find(s => s.properties.title === outputSheetTitle);
  
  if (existingSheet) {
    // Sheet exists — clear and rewrite
    await sheets.spreadsheets.values.clear({
      spreadsheetId: TIPS_SS_ID,
      range: `'${outputSheetTitle}'`,
    });
  } else {
    // Create new sheet tab
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: TIPS_SS_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: outputSheetTitle } } }],
      },
    });
  }

  // Write data
  const writeData = displayRows.length > 0
    ? [displayHeader, ...displayRows]
    : [displayHeader, ['（本月無符合條件的小費資料）']];

  await sheets.spreadsheets.values.update({
    spreadsheetId: TIPS_SS_ID,
    range: `'${outputSheetTitle}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: writeData },
  });

  // Get the new sheet's gid
  const updatedMeta = await sheets.spreadsheets.get({ spreadsheetId: TIPS_SS_ID, fields: 'sheets.properties' });
  const outputSheet = updatedMeta.data.sheets.find(s => s.properties.title === outputSheetTitle);
  const outputGid = outputSheet ? outputSheet.properties.sheetId : 0;

  const newUrl = `https://docs.google.com/spreadsheets/d/${TIPS_SS_ID}/edit#gid=${outputGid}`;

  // 6. Log request
  if (logSheetName) {
    const now = new Date();
    const timeStr = now.toLocaleString('sv-SE', { timeZone: TZ }).replace('T', ' ');
    const requestId = crypto.randomUUID();
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: TIPS_SS_ID,
        range: `'${logSheetName}'!A:G`,
        valueInputOption: 'RAW',
        requestBody: { values: [[requestId, userId, monthStr, newUrl, timeStr, timeStr, remarkKey]] },
      });
    } catch (e) {
      console.error('[tips] log write error:', e.message);
    }
  }

  return { ok: true, url: newUrl, cached: false, rowCount: filtered.length };
}
