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

function getMonthDateRange(yearMonth) {
  if (!yearMonth || typeof yearMonth !== 'string') return null;
  const parts = yearMonth.trim().split('-');
  if (parts.length < 2) return null;
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(y) || isNaN(m) || m < 1 || m > 12) return null;
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
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

async function getEmployeeData(auth) {
  const ssId = process.env.LINE_STAFF_SS_ID || '1GH2XbihFIY0AX8SMF9Tk6igrVKPpA_vMJVlkDkJjpe4';
  const rows = await readSheet(auth, ssId, `'${EMPLOYEE_SHEET_NAME}'!A2:L2000`);
  const empCodes = [];
  const empMap = {};
  const storeIdByCode = {};
  let excluded = 0;
  for (const row of rows) {
    const code = (row[11] ?? '').toString().trim();
    const name = (row[2] ?? '').toString().trim();
    const statusH = (row[7] ?? '').toString().trim();
    const storeId = (row[5] ?? '').toString().trim();
    if (!code) continue;
    if (statusH.indexOf('離職') >= 0) { excluded++; continue; }
    empCodes.push(code);
    empMap[code] = name || code;
    storeIdByCode[code] = storeId;
  }
  if (excluded > 0) console.log(`[GCP] H 欄離職已排除 ${excluded} 人`);
  return { empCodes, empMap, storeIdByCode };
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

async function fetchTransactionStatistic(bearerToken, keyword, startDate, endDate, godsid = 0) {
  const godnam = godsid ? encodeURIComponent('小費') : '';
  const url = `https://saywebdatafeed.saydou.com/api/management/finance/transactionStatistic?page=0&limit=20&sort=ordrsn&order=desc` +
    `&keyword=${encodeURIComponent(keyword || '')}&start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}` +
    `&searchMemberCtrl=null&searchProductCtrl=null&searchStaffCtrl=null&membid=0&godsid=${godsid}` +
    `&usrsid=0&memnam=&godnam=${godnam}&usrnam=&assign=all&licnum=&goctString=`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${bearerToken}` },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  try {
    return parseRealTotal(JSON.parse(text));
  } catch {
    return 0;
  }
}

async function buildReport(auth, bearerToken, startYm, endYm) {
  const tipsGodsid = parseInt(process.env.TIPS_GODSID || '201969', 10);
  const batchSize = parseInt(process.env.FETCH_BATCH_SIZE || '20', 10);

  const { empCodes, empMap, storeIdByCode } = await getEmployeeData(auth);
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
    if (i + batchSize < requests.length) await new Promise((r) => setTimeout(r, 500));
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
  for (const [code, sid] of Object.entries(storeIdByCode || {})) {
    storeMap[code] = (storeIdToName[sid] || sid || '').trim();
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
      ]);
    }
  }
  return { rows, months: Object.keys(result).sort() };
}

async function writeToSheet(auth, rows) {
  const ssId = process.env.OUTPUT_SS_ID || '1ZMutegYTLZ51XQHCbfFZ7-iAj1qTZGgSo5VTThXPQ5U';
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: ssId });
  const sheet = spreadsheet.data.sheets?.find((s) =>
    s.properties?.sheetId === OUTPUT_SHEET_GID || s.properties?.title === OUTPUT_SHEET_NAME);
  if (!sheet) throw new Error('找不到員工業績月報工作表');

  const sheetName = sheet.properties.title;
  const readRange = `'${sheetName}'!A2:E5000`;
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
      toUpdate.push({ range: `'${sheetName}'!A${rowIdx}:E${rowIdx}`, values: [row] });
    } else {
      toAppend.push(row);
    }
  }

  if (toUpdate.length) {
    const body = { valueInputOption: 'USER_ENTERED', data: toUpdate };
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: ssId, requestBody: body });
  }
  if (toAppend.length) {
    const appendRange = `'${sheetName}'!A:E`;
    await sheets.spreadsheets.values.append({
      spreadsheetId: ssId,
      range: appendRange,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: toAppend },
    });
  }
  return { updated: toUpdate.length, appended: toAppend.length };
}

export async function run(args = []) {
  const startYm = args[0] || null;
  const endYm = args[1] || (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();

  console.log(`[GCP] 員工業績月報 開始 ${startYm || '2025-01'} ~ ${endYm}`);

  const auth = await getAuth();
  const bearerToken = await getBearerToken(auth);
  if (!bearerToken) {
    throw new Error('無 Bearer Token，請設 SAYDOU_BEARER_TOKEN 或 TOKEN_SHEET_SS_ID');
  }

  const actualStart = startYm || '2025-01';
  const { rows, months } = await buildReport(auth, bearerToken, actualStart, endYm);

  console.log(`[GCP] 產出 ${rows.length} 筆，月份 ${months.join(',')}`);

  if (rows.length > 0) {
    await writeToSheet(auth, rows);
    console.log(`[GCP] 已寫入試算表`);
  }

  console.log('[GCP] 完成');
}
