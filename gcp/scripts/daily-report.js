/**
 * 各店日報（GCP 版）
 * 目的：以 Node.js 直接呼叫 SayDou dailyIncome，避開 GAS UrlFetch 配額。
 *
 * 用法：
 *   node index.js daily-report [date]
 *   node index.js daily-report [startDate] [endDate]
 * 範例：
 *   node index.js daily-report 2026-02-11
 *   node index.js daily-report 2026-02-10 2026-02-11
 */

import fetch from 'node-fetch';
import { google } from 'googleapis';
import { getAuth } from '../lib/auth.js';
import { getBearerToken } from '../lib/saydou.js';

const SHEET_ALL = '營收報表';
const SHEET_DIRECT = '營收報表_直營';
const HEADER = ['日期', '店家', '現金總額', '消費紀錄(現金)', '儲值(現金)', '第三方總額', '轉帳入帳', 'LINE入帳', '轉帳未收', 'LINE未收', '今日業績'];
const FETCH_BATCH_SIZE = Number.parseInt(process.env.FETCH_BATCH_SIZE || '10', 10);
const BATCH_DELAY_MS = Number.parseInt(process.env.DAILY_REPORT_BATCH_DELAY_MS || '1500', 10);

function parseYmd(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function formatYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDateRange(args = []) {
  const rawA = args[0] ? String(args[0]).trim() : '';
  const rawB = args[1] ? String(args[1]).trim() : '';
  const a = parseYmd(rawA);
  const b = parseYmd(rawB);

  if (rawA && !a) throw new Error('日期格式錯誤：請使用 yyyy-MM-dd（start/date）');
  if (rawB && !b) throw new Error('日期格式錯誤：請使用 yyyy-MM-dd（endDate）');

  if (a && b) {
    if (a > b) throw new Error('日期區間錯誤：startDate 不可大於 endDate');
    return { start: a, end: b };
  }
  if (a) return { start: a, end: a };

  const today = new Date();
  return { start: today, end: today };
}

async function callCoreApi(coreUrl, coreKey, action) {
  if (!coreUrl || !coreKey) throw new Error('缺少 PAO_CAT_CORE_API_URL 或 PAO_CAT_SECRET_KEY');
  const sep = coreUrl.includes('?') ? '&' : '?';
  const url = `${coreUrl}${sep}key=${encodeURIComponent(coreKey)}&action=${encodeURIComponent(action)}`;
  const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Core API 回傳非 JSON（action=${action}）：${text.slice(0, 120)}`);
  }
  if (!parsed || parsed.status !== 'ok') {
    throw new Error(`Core API 失敗（action=${action}）：${parsed?.message || 'unknown'}`);
  }
  return parsed.data;
}

function parseStores(storeMap) {
  const out = [];
  const vals = Object.values(storeMap || {});
  for (const info of vals) {
    const storeId = info?.saydouId != null ? String(info.saydouId).trim() : '';
    if (!storeId) continue;
    // SayDou 的總公司代碼（0001）通常不提供 dailyIncome，避免讓整批失敗。
    if (storeId === '0001') continue;
    out.push({
      storid: storeId,
      alias: (info?.name != null ? String(info.name) : '').trim() || storeId,
      isDirect: info?.isDirect === true,
    });
  }
  return out;
}

async function fetchDailyIncome(bearerToken, dateStr, storeId) {
  const url = `https://saywebdatafeed.saydou.com/api/management/finance/dailyIncome?storid=${encodeURIComponent(storeId)}&date=${encodeURIComponent(dateStr)}&end_date=${encodeURIComponent(dateStr)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${bearerToken}` },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();

  if (res.status === 401 || res.status === 403) {
    throw new Error(`SayDou Token 無效或過期（HTTP ${res.status}）`);
  }
  if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
    throw new Error(`SayDou 回傳 HTML（store=${storeId}, date=${dateStr}）`);
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`SayDou 回傳非 JSON（store=${storeId}, date=${dateStr}）`);
  }

  return json;
}

function parseDailyRow(dateStr, store, apiJson) {
  const runData = apiJson?.data?.totalRow;
  if (!runData) return null;

  const cashTotal = runData.sum_paymentMethod?.[0]?.total || 0;
  const cashBusiness = runData.cashpay?.business || 0;
  const cashUnearn = runData.cashpay?.unearn || 0;
  const lineTotal = runData.sum_paymentMethod?.[2]?.total || 0;
  const transferTotal = runData.sum_paymentMethod?.[9]?.total || 0;
  const thirdPayTotal = lineTotal + transferTotal;
  const lineRecord = runData.paymentMethod?.[2]?.total || 0;
  const transferRecord = runData.paymentMethod?.[9]?.total || 0;
  const transferUnearn = transferTotal - transferRecord;
  const lineUnearn = lineTotal - lineRecord;
  const todayService = runData.businessIncome?.service ?? 0;

  return [
    dateStr,
    store.alias,
    cashTotal,
    cashBusiness,
    cashUnearn,
    thirdPayTotal,
    transferRecord,
    lineRecord,
    transferUnearn,
    lineUnearn,
    todayService,
  ];
}

async function ensureHeader(sheets, spreadsheetId, sheetName) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetName}'!B1:L1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [HEADER] },
  });
}

async function buildDateStoreRowMap(sheets, spreadsheetId, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!B2:C5000`,
  });
  const rows = res.data.values || [];
  const map = {};
  for (let i = 0; i < rows.length; i++) {
    const dateStr = (rows[i][0] ?? '').toString().trim();
    const store = (rows[i][1] ?? '').toString().trim();
    if (dateStr && store) map[`${dateStr}|${store}`] = i + 2;
  }
  return map;
}

async function upsertRows(sheets, spreadsheetId, sheetName, rowMap, rows) {
  if (!rows.length) return { updated: 0, appended: 0 };

  const updates = [];
  const appends = [];

  for (const row of rows) {
    const key = `${row[0]}|${String(row[1] || '').trim()}`;
    const rowIndex = rowMap[key];
    if (rowIndex) {
      updates.push({ range: `'${sheetName}'!B${rowIndex}:L${rowIndex}`, values: [row] });
    } else {
      appends.push(row);
    }
  }

  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
    });
  }

  if (appends.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${sheetName}'!B:L`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: appends },
    });
  }

  return { updated: updates.length, appended: appends.length };
}

async function runOneDate(sheets, spreadsheetId, bearerToken, stores, dateStr, rowMapAll, rowMapDirect) {
  console.log(`[GCP][daily-report] [${dateStr}] 開始抓取，店家 ${stores.length} 間`);
  const dailyAllRows = [];
  const dailyDirectRows = [];
  let failed = 0;

  for (let i = 0; i < stores.length; i += FETCH_BATCH_SIZE) {
    const batch = stores.slice(i, i + FETCH_BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map((s) => fetchDailyIncome(bearerToken, dateStr, s.storid)));

    for (let j = 0; j < settled.length; j++) {
      const store = batch[j];
      const res = settled[j];
      if (res.status !== 'fulfilled') {
        failed++;
        console.warn(`[GCP][daily-report] [${dateStr}] ${store.alias}(${store.storid}) 失敗: ${res.reason?.message || res.reason}`);
        continue;
      }
      const row = parseDailyRow(dateStr, store, res.value);
      if (!row) continue;
      dailyAllRows.push(row);
      if (store.isDirect) dailyDirectRows.push(row);
    }

    if (i + FETCH_BATCH_SIZE < stores.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  if (failed > 0) {
    throw new Error(`[${dateStr}] 有 ${failed} 間店抓取失敗，為避免寫入不完整資料，本日未寫入`);
  }

  const allWrite = await upsertRows(sheets, spreadsheetId, SHEET_ALL, rowMapAll, dailyAllRows);
  const directWrite = await upsertRows(sheets, spreadsheetId, SHEET_DIRECT, rowMapDirect, dailyDirectRows);

  console.log(`[GCP][daily-report] [${dateStr}] 完成（全門市 更新${allWrite.updated}/新增${allWrite.appended}；直營 更新${directWrite.updated}/新增${directWrite.appended}）`);
}

export async function run(args = []) {
  const { start, end } = getDateRange(args);
  const auth = await getAuth();
  const bearerToken = await getBearerToken(auth);
  if (!bearerToken) throw new Error('無 Bearer Token，請設 SAYDOU_BEARER_TOKEN 或 TOKEN_SHEET_SS_ID');

  const coreUrl = (process.env.PAO_CAT_CORE_API_URL || '').trim();
  const coreKey = (process.env.PAO_CAT_SECRET_KEY || '').trim();
  const [coreConfig, storeMap] = await Promise.all([
    callCoreApi(coreUrl, coreKey, 'getCoreConfig'),
    callCoreApi(coreUrl, coreKey, 'getLineSayDouInfoMap'),
  ]);
  const spreadsheetId = (process.env.DAILY_ACCOUNT_REPORT_SS_ID || coreConfig?.DAILY_ACCOUNT_REPORT_SS_ID || '').trim();
  if (!spreadsheetId) throw new Error('缺少 DAILY_ACCOUNT_REPORT_SS_ID（可設 env 或由 Core getCoreConfig 提供）');

  const stores = parseStores(storeMap);
  if (!stores.length) throw new Error('店家清單為空（getLineSayDouInfoMap）');

  const sheets = google.sheets({ version: 'v4', auth });
  await ensureHeader(sheets, spreadsheetId, SHEET_ALL);
  await ensureHeader(sheets, spreadsheetId, SHEET_DIRECT);
  const rowMapAll = await buildDateStoreRowMap(sheets, spreadsheetId, SHEET_ALL);
  const rowMapDirect = await buildDateStoreRowMap(sheets, spreadsheetId, SHEET_DIRECT);

  const dates = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    dates.push(formatYmd(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  console.log(`[GCP][daily-report] 開始 ${formatYmd(start)} ~ ${formatYmd(end)}，共 ${dates.length} 天`);
  for (const dateStr of dates) {
    await runOneDate(sheets, spreadsheetId, bearerToken, stores, dateStr, rowMapAll, rowMapDirect);
  }
  console.log('[GCP][daily-report] 全部完成');
}
