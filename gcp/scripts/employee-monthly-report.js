/**
 * 員工業績月報 GCP 版本
 * 使用 transactionStatistic API，避開 GAS urlfetch 每日限制
 *
 * 環境變數：SAYDOU_BEARER_TOKEN, LINE_STAFF_SS_ID, LINE_STORE_SS_ID, OUTPUT_SS_ID,
 *   TOKEN_SHEET_SS_ID, TIPS_GODSID, FETCH_BATCH_SIZE
 *
 * 執行：node index.js employee-monthly-report [startYm] [endYm]
 */

import { google } from 'googleapis';
import fetch from 'node-fetch';
import { getAuth } from '../lib/auth.js';
import { readSheet } from '../lib/sheets.js';
import { getBearerToken } from '../lib/saydou.js';

const EMPLOYEE_SHEET_NAME = '員工清單';
const STORE_SHEET_NAME = '店家基本資料';
const OUTPUT_SHEET_NAME = '員工業績月報';
const OUTPUT_SHEET_GID = 833948053;
const OUTPUT_HEADERS = ['月份', '員工編號', '姓名', '店家', '業績', '', '', '', '9萬', '10萬', '11萬', '12萬'];

/** 與 GAS 一致：月份起迄用日曆日期 yyyy-MM-dd（不依賴伺服器時區） */
function getMonthDateRange(yearMonth) {
  if (!yearMonth || typeof yearMonth !== 'string') return null;
  const parts = yearMonth.trim().split('-');
  if (parts.length < 2) return null;
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(y) || isNaN(m) || m < 1 || m > 12) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = new Date(y, m, 0).getDate();
  return {
    startDate: `${y}-${pad(m)}-01`,
    endDate: `${y}-${pad(m)}-${pad(lastDay)}`,
  };
}

function listMonthsFrom2025(endYearMonth) {
  const out = [];
  const parts = (endYearMonth || '').trim().split('-');
  const endY = parts.length >= 1 ? parseInt(parts[0], 10) : new Date().getFullYear();
  const endM = parts.length >= 2 ? parseInt(parts[1], 10) : new Date().getMonth() + 1;
  if (isNaN(endY) || isNaN(endM)) return out;
  let y = 2025, m = 1;
  while (y < endY || (y === endY && m <= endM)) {
    out.push(y + '-' + (m < 10 ? '0' : '') + m);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function parseRealTotal(json) {
  if (!json || json.status !== true || !json.data) return 0;
  const d = json.data;
  if (d.realTotal != null) return Number(d.realTotal) || 0;
  if (d.total != null) return Number(d.total) || 0;
  if (d.summary?.realTotal != null) return Number(d.summary.realTotal) || 0;
  if (d.summary?.total != null) return Number(d.summary.total) || 0;
  if (Array.isArray(d.items)) {
    return d.items.reduce((s, t) => {
      const v = t?.realTotal ?? t?.total ?? t?.ordamt ?? t?.price_ ?? t?.rprice;
      return s + (v != null ? Number(v) || 0 : 0);
    }, 0);
  }
  return 0;
}

/** 員工清單欄位：A?, B店家(1), C姓名(2), D LineId(3), E職稱(4), F?(5), ..., H狀態(7), ..., L員工編號(11) */
async function getEmployeeData(auth) {
  const ssId = process.env.LINE_STAFF_SS_ID || '1GH2XbihFIY0AX8SMF9Tk6igrVKPpA_vMJVlkDkJjpe4';
  const rows = await readSheet(auth, ssId, `'${EMPLOYEE_SHEET_NAME}'!A2:L2000`);
  const empCodes = [];
  const empMap = {};
  const storeIdByCode = {};
  const storeNameByCode = {}; // B 欄店家名稱，報表顯示用
  let excluded = 0;
  for (const row of rows) {
    const code = (row[11] ?? '').toString().trim();
    const name = (row[2] ?? '').toString().trim();
    const statusH = (row[7] ?? '').toString().trim();
    const storeId = (row[5] ?? '').toString().trim();
    const storeName = (row[1] ?? '').toString().trim();
    if (!code) continue;
    if (statusH.indexOf('離職') >= 0) { excluded++; continue; }
    empCodes.push(code);
    empMap[code] = name || code;
    storeIdByCode[code] = storeId;
    if (storeName) storeNameByCode[code] = storeName;
  }
  if (excluded > 0) console.log(`[GCP] H 欄離職已排除 ${excluded} 人`);
  return { empCodes, empMap, storeIdByCode, storeNameByCode };
}

async function getStoreIdToName(auth) {
  const ssId = process.env.LINE_STORE_SS_ID || '1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0';
  const rows = await readSheet(auth, ssId, `'${STORE_SHEET_NAME}'!A2:I1000`);
  const map = {};
  for (const row of rows) {
    const name = (row[1] ?? '').toString().trim();
    const saydouId = (row[5] ?? '').toString().trim();
    if (saydouId) map[saydouId] = name || ('店' + saydouId);
  }
  if (map['2862']) map['2862'] = '左營海軍';
  return map;
}

const API_PAGE_SIZE = 10;
const FETCH_RETRIES = 3;
const BATCH_DELAY_MS = 3000;

/** 單次請求，使用 API 回傳的 data.realTotal（不分頁），失敗會重試 */
async function fetchTransactionStatistic(bearerToken, keyword, startDate, endDate, godsid = 0) {
  const godnam = godsid ? encodeURIComponent('小費') : '';
  const url = `https://saywebdatafeed.saydou.com/api/management/finance/transactionStatistic?page=0&limit=${API_PAGE_SIZE}&sort=ordrsn&order=desc` +
    `&keyword=${encodeURIComponent(keyword || '')}&start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}` +
    `&searchMemberCtrl=null&searchProductCtrl=null&searchStaffCtrl=null&membid=0&godsid=${godsid}` +
    `&usrsid=0&memnam=&godnam=${godnam}&usrnam=&assign=all&licnum=&goctString=`;
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${bearerToken}` },
        signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      return parseRealTotal(JSON.parse(text));
    } catch (e) {
      lastErr = e;
      if (attempt < FETCH_RETRIES) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  if (lastErr) console.warn('[GCP] API 重試後仍失敗:', lastErr.message);
  return 0;
}

async function buildReport(auth, bearerToken, startYm, endYm) {
  const tipsGodsid = parseInt(process.env.TIPS_GODSID || '201969', 10);
  const batchSize = parseInt(process.env.FETCH_BATCH_SIZE || '10', 10);

  const { empCodes, empMap, storeIdByCode, storeNameByCode } = await getEmployeeData(auth);
  const storeIdToName = await getStoreIdToName(auth);

  const months = listMonthsFrom2025(endYm);
  const startIdx = months.indexOf(startYm);
  const toRun = startIdx >= 0 ? months.slice(startIdx) : months;

  const result = {};
  const totalMap = {};
  const tipsMap = {};

  const requests = [];
  const meta = [];
  for (const ym of toRun) {
    const range = getMonthDateRange(ym);
    if (!range) continue;
    for (const code of empCodes) {
      requests.push({ keyword: code, ...range, godsid: 0 });
      meta.push({ empCode: code, ym, isTips: false });
      requests.push({ keyword: code, ...range, godsid: tipsGodsid });
      meta.push({ empCode: code, ym, isTips: true });
    }
  }

  console.log(`[GCP] 共 ${requests.length} 個 API 請求，每批 ${batchSize} 個`);

  for (let i = 0; i < requests.length; i += batchSize) {
    const chunk = requests.slice(i, i + batchSize);
    const chunkMeta = meta.slice(i, i + batchSize);
    const vals = await Promise.all(chunk.map((r) =>
      fetchTransactionStatistic(bearerToken, r.keyword, r.startDate, r.endDate, r.godsid)));
    for (let j = 0; j < chunkMeta.length; j++) {
      const m = chunkMeta[j];
      if (m.isTips) {
        if (!tipsMap[m.ym]) tipsMap[m.ym] = {};
        tipsMap[m.ym][m.empCode] = vals[j];
      } else {
        if (!totalMap[m.ym]) totalMap[m.ym] = {};
        totalMap[m.ym][m.empCode] = vals[j];
      }
    }
    console.log(`[GCP] 已完成 ${Math.min(i + batchSize, requests.length)}/${requests.length}`);
    if (i + batchSize < requests.length) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }

  for (const ym of toRun) {
    result[ym] = {};
    for (const code of empCodes) {
      const total = totalMap[ym]?.[code] ?? 0;
      const tips = tipsMap[ym]?.[code] ?? 0;
      const amt = Math.max(0, total - tips);
      if (amt > 0) result[ym][code] = amt;
    }
  }

  const storeMap = {};
  for (const code of empCodes) {
    storeMap[code] = (storeNameByCode[code] || storeIdToName[storeIdByCode[code]] || storeIdByCode[code] || '').trim();
  }

  const rows = [];
  for (const ym of Object.keys(result).sort()) {
    const byEmp = result[ym];
    for (const code of Object.keys(byEmp).sort()) {
      const amt = byEmp[code];
      if (amt <= 0) continue;
      rows.push([
        ym,
        code,
        empMap[code] || '',
        storeMap[code] || '',
        amt,
        '',
        '',
        '',
        amt >= 90000 ? '1' : '0',
        amt >= 100000 ? '1' : '0',
        amt >= 110000 ? '1' : '0',
        amt >= 120000 ? '1' : '0',
      ]);
    }
  }
  return { rows, months: Object.keys(result).sort() };
}

/** 寫入員工業績月報：一律從 A 欄開始（A1 標題，A2 起資料），更新既有列或接在後面 append */
async function writeToSheet(auth, rows) {
  const ssId = process.env.OUTPUT_SS_ID || '1ZMutegYTLZ51XQHCbfFZ7-iAj1qTZGgSo5VTThXPQ5U';
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: ssId });
  const sheet = spreadsheet.data.sheets?.find((s) =>
    s.properties?.sheetId === OUTPUT_SHEET_GID || s.properties?.title === OUTPUT_SHEET_NAME);
  if (!sheet) throw new Error('找不到員工業績月報工作表');

  const sheetName = sheet.properties.title;

  // 標題列固定 A1:L1
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId,
    range: `'${sheetName}'!A1:L1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [OUTPUT_HEADERS] },
  });

  // 既有資料讀 A2:L（A=月份、B=員工編號）
  const readRange = `'${sheetName}'!A2:L5000`;
  const existing = await readSheet(auth, ssId, readRange);
  const keyToRow = {};
  for (let i = 0; i < existing.length; i++) {
    const m = (existing[i][0] ?? '').toString().trim();
    const code = (existing[i][1] ?? '').toString().trim();
    keyToRow[m + '|' + code] = i + 2;
  }

  const toAppend = [];
  const toUpdate = [];
  for (const row of rows) {
    const key = (row[0] ?? '') + '|' + (row[1] ?? '');
    const rowIdx = keyToRow[key];
    if (rowIdx) {
      toUpdate.push({ range: `'${sheetName}'!A${rowIdx}:L${rowIdx}`, values: [row] });
    } else {
      toAppend.push(row);
    }
  }

  if (toUpdate.length) {
    const body = { valueInputOption: 'USER_ENTERED', data: toUpdate };
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: ssId, requestBody: body });
  }
  if (toAppend.length) {
    const startRow = 2 + existing.length;
    const endRow = startRow + toAppend.length - 1;
    const maxRows = sheet.properties?.gridProperties?.rowCount ?? 1000;
    if (endRow > maxRows) {
      const addRows = endRow - maxRows;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: ssId,
        requestBody: {
          requests: [{ appendDimension: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', length: addRows } }],
        },
      });
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId,
      range: `'${sheetName}'!A${startRow}:L${endRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: toAppend },
    });
  }
  return { updated: toUpdate.length, appended: toAppend.length };
}

export async function run(args = []) {
  const d = new Date();
  const currentYm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const startYm = args[0] ?? null;
  const endYm = args[1] ?? currentYm;

  // 未帶參數時只跑「當月」（GCP 排程用），避免每次 2025-01～今天資料量過大
  const actualStart = (startYm || args[1]) ? (startYm || '2025-01') : currentYm;
  const actualEnd = endYm;

  console.log(`[GCP] 員工業績月報 開始 ${actualStart} ~ ${actualEnd}`);

  const auth = await getAuth();
  const bearerToken = await getBearerToken(auth);
  if (!bearerToken) {
    throw new Error('無 Bearer Token，請設 SAYDOU_BEARER_TOKEN 或 TOKEN_SHEET_SS_ID');
  }

  const { rows, months } = await buildReport(auth, bearerToken, actualStart, actualEnd);

  console.log(`[GCP] 產出 ${rows.length} 筆，月份 ${months.join(',')}`);

  if (rows.length > 0) {
    await writeToSheet(auth, rows);
    console.log(`[GCP] 已寫入試算表`);
  }

  console.log('[GCP] 完成');
}
