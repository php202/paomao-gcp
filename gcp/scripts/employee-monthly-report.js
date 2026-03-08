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
import pool from '../lib/db.js';

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

/** 員工清單：從 PostgreSQL DB employees 表讀取 */
async function getEmployeeData(auth) {
  // 保留 auth 參數以維持相容性，但實際不使用
  const empCodes = [];
  const empMap = {};
  const storeIdByCode = {};
  const storeNameByCode = {}; // 店家名稱，報表顯示用
  const multiStoreMap = {}; // empCode -> [storeId, storeId, ...]
  let excluded = 0;

  try {
    // 從 employees 表讀取在職員工資料
    const { rows } = await pool.query(`
      SELECT employee_code, name, store_name, saydou_store_id, managed_stores
      FROM employees 
      WHERE is_active = true 
        AND employee_code IS NOT NULL 
        AND employee_code != ''
      ORDER BY employee_code
    `);

    for (const row of rows) {
      const code = (row.employee_code || '').toString().trim();
      const name = (row.name || '').toString().trim();
      const storeId = (row.saydou_store_id || '').toString().trim();
      const storeName = (row.store_name || '').toString().trim();
      const managedStores = row.managed_stores || [];

      if (!code) continue;
      
      empCodes.push(code);
      empMap[code] = name || code;
      storeIdByCode[code] = storeId;
      if (storeName) storeNameByCode[code] = storeName;

      // 處理多店歸屬
      if (managedStores.length > 1) {
        multiStoreMap[code] = managedStores.map(s => String(s).trim()).filter(Boolean);
      }
    }

    // 計算排除的員工數（is_active = false）
    const { rows: inactiveRows } = await pool.query(`
      SELECT COUNT(*) as count 
      FROM employees 
      WHERE is_active = false 
        AND employee_code IS NOT NULL 
        AND employee_code != ''
    `);
    excluded = parseInt(inactiveRows[0]?.count || 0);

    if (excluded > 0) console.log(`[GCP] is_active=false 離職已排除 ${excluded} 人`);
    console.log(`[GCP] 從 DB 讀取在職員工 ${empCodes.length} 人`);
    console.log(`[GCP] 多店員工 ${Object.keys(multiStoreMap).length} 人：${Object.entries(multiStoreMap).map(([c, s]) => `${empMap[c] || c}(${s.length}店)`).join(', ')}`);

  } catch (e) {
    console.error('[GCP] 從 DB 讀取員工資料失敗:', e.message);
    throw new Error(`無法從資料庫讀取員工資料: ${e.message}`);
  }

  return { empCodes, empMap, storeIdByCode, storeNameByCode, multiStoreMap };
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

/** 多店員工：用明細 API 拿所有交易，按 storid 分組加總
 *  回傳 { storeId: amount, ... } */
async function fetchTransactionsByStore(bearerToken, keyword, startDate, endDate, tipsGodsid) {
  const PAGE_SIZE = 50;
  const MAX_PAGES = 20;
  const byStore = {}; // storeId -> { total: 0, tips: 0 }

  // 拿全部交易（不含小費）
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://saywebdatafeed.saydou.com/api/management/finance/transaction?page=${page}&limit=${PAGE_SIZE}&sort=ordrsn&order=desc` +
      `&keyword=${encodeURIComponent(keyword)}&start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}` +
      `&searchMemberCtrl=null&searchProductCtrl=null&searchStaffCtrl=null&membid=0&godsid=0` +
      `&usrsid=0&memnam=&godnam=&usrnam=&assign=all&licnum=&goctString=`;
    let json;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${bearerToken}` },
        signal: AbortSignal.timeout(60000),
      });
      json = await res.json();
    } catch (e) {
      console.warn(`[GCP] 多店明細 API 失敗 ${keyword} page=${page}:`, e.message);
      break;
    }
    if (!json?.data?.items?.length) break;
    for (const item of json.data.items) {
      const sid = String(item.storid || 'unknown');
      if (!byStore[sid]) byStore[sid] = { total: 0, tips: 0 };
      const amt = Number(item.rprice ?? item.price_ ?? item.ordamt ?? 0) || 0;
      byStore[sid].total += amt;
    }
    if (json.data.items.length < PAGE_SIZE) break;
    await new Promise(r => setTimeout(r, 500));
  }

  // 拿小費交易
  for (let page = 0; page < MAX_PAGES; page++) {
    const godnam = encodeURIComponent('小費');
    const url = `https://saywebdatafeed.saydou.com/api/management/finance/transaction?page=${page}&limit=${PAGE_SIZE}&sort=ordrsn&order=desc` +
      `&keyword=${encodeURIComponent(keyword)}&start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}` +
      `&searchMemberCtrl=null&searchProductCtrl=null&searchStaffCtrl=null&membid=0&godsid=${tipsGodsid}` +
      `&usrsid=0&memnam=&godnam=${godnam}&usrnam=&assign=all&licnum=&goctString=`;
    let json;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${bearerToken}` },
        signal: AbortSignal.timeout(60000),
      });
      json = await res.json();
    } catch (e) { break; }
    if (!json?.data?.items?.length) break;
    for (const item of json.data.items) {
      const sid = String(item.storid || 'unknown');
      if (!byStore[sid]) byStore[sid] = { total: 0, tips: 0 };
      const amt = Number(item.rprice ?? item.price_ ?? item.ordamt ?? 0) || 0;
      byStore[sid].tips += amt;
    }
    if (json.data.items.length < PAGE_SIZE) break;
    await new Promise(r => setTimeout(r, 500));
  }

  // 計算每店淨業績
  const result = {};
  for (const [sid, v] of Object.entries(byStore)) {
    const net = Math.max(0, v.total - v.tips);
    if (net > 0) result[sid] = net;
  }
  return result;
}

async function buildReport(auth, bearerToken, startYm, endYm) {
  const tipsGodsid = parseInt(process.env.TIPS_GODSID || '201969', 10);
  const batchSize = parseInt(process.env.FETCH_BATCH_SIZE || '10', 10);

  const { empCodes, empMap, storeIdByCode, storeNameByCode, multiStoreMap } = await getEmployeeData(auth);
  const storeIdToName = await getStoreIdToName(auth);

  const months = listMonthsFrom2025(endYm);
  const startIdx = months.indexOf(startYm);
  const toRun = startIdx >= 0 ? months.slice(startIdx) : months;

  // --- 單店員工：用 transactionStatistic API（快速） ---
  const singleStoreCodes = empCodes.filter(c => !multiStoreMap[c] || multiStoreMap[c].length <= 1);
  const multiStoreCodes = empCodes.filter(c => multiStoreMap[c] && multiStoreMap[c].length > 1);

  const requests = [];
  const meta = [];
  for (const ym of toRun) {
    const range = getMonthDateRange(ym);
    if (!range) continue;
    for (const code of singleStoreCodes) {
      requests.push({ keyword: code, ...range, godsid: 0 });
      meta.push({ empCode: code, ym, isTips: false });
      requests.push({ keyword: code, ...range, godsid: tipsGodsid });
      meta.push({ empCode: code, ym, isTips: true });
    }
  }

  console.log(`[GCP] 單店 ${singleStoreCodes.length} 人 → ${requests.length} 個統計 API 請求，每批 ${batchSize} 個`);
  console.log(`[GCP] 多店 ${multiStoreCodes.length} 人 → 用明細 API 按店分組`);

  const totalMap = {};
  const tipsMap = {};

  for (let i = 0; i < requests.length; i += batchSize) {
    const chunk = requests.slice(i, i + batchSize);
    const chunkMeta = meta.slice(i, i + batchSize);
    const vals = await Promise.all(chunk.map((r) =>
      fetchTransactionStatistic(bearerToken, r.keyword, r.startDate, r.endDate, r.godsid)));
    for (let j = 0; j < chunkMeta.length; j++) {
      const m = chunkMeta[j];
      const targetMap = m.isTips ? tipsMap : totalMap;
      if (!targetMap[m.ym]) targetMap[m.ym] = {};
      targetMap[m.ym][m.empCode] = vals[j];
    }
    console.log(`[GCP] 單店已完成 ${Math.min(i + batchSize, requests.length)}/${requests.length}`);
    if (i + batchSize < requests.length) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }

  // --- 多店員工：用 transaction 明細 API 按 storid 分組 ---
  const multiStoreResults = {}; // ym -> code -> { storeId: amt }
  for (const ym of toRun) {
    const range = getMonthDateRange(ym);
    if (!range) continue;
    multiStoreResults[ym] = {};
    for (const code of multiStoreCodes) {
      console.log(`[GCP] 多店明細 ${empMap[code] || code} (${code}) ${ym}...`);
      const byStore = await fetchTransactionsByStore(bearerToken, code, range.startDate, range.endDate, tipsGodsid);
      multiStoreResults[ym][code] = byStore;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // --- 組報表 rows ---
  const storeMap = {};
  for (const code of empCodes) {
    storeMap[code] = (storeNameByCode[code] || storeIdToName[storeIdByCode[code]] || storeIdByCode[code] || '').trim();
  }

  const rows = [];
  for (const ym of toRun) {
    for (const code of empCodes) {
      if (multiStoreMap[code] && multiStoreMap[code].length > 1) {
        // 多店員工：每店一列 + 合計列
        const byStore = multiStoreResults[ym]?.[code] || {};
        let grandTotal = 0;
        const storeRows = [];
        for (const [storeId, amt] of Object.entries(byStore)) {
          if (amt > 0) {
            const sName = storeIdToName[storeId] || ('店' + storeId);
            storeRows.push([ym, code, empMap[code] || '', sName, amt, '', '', '', '', '', '', '']);
            grandTotal += amt;
          }
        }
        if (grandTotal > 0) {
          // 按店名排序
          storeRows.sort((a, b) => String(a[3]).localeCompare(String(b[3])));
          rows.push(...storeRows);
          // 合計列：獎金門檻看合計
          rows.push([
            ym, code, empMap[code] || '', '【合計】', grandTotal, '', '', '',
            grandTotal >= 90000 ? '1' : '0',
            grandTotal >= 100000 ? '1' : '0',
            grandTotal >= 110000 ? '1' : '0',
            grandTotal >= 120000 ? '1' : '0',
          ]);
        }
      } else {
        // 單店員工
        const total = totalMap[ym]?.[code] ?? 0;
        const tips = tipsMap[ym]?.[code] ?? 0;
        const amt = Math.max(0, total - tips);
        if (amt > 0) {
          rows.push([
            ym, code, empMap[code] || '', storeMap[code] || '', amt, '', '', '',
            amt >= 90000 ? '1' : '0',
            amt >= 100000 ? '1' : '0',
            amt >= 110000 ? '1' : '0',
            amt >= 120000 ? '1' : '0',
          ]);
        }
      }
    }
  }
  return { rows, months: toRun };
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

/** 存入 DB（upsert） */
async function saveToDB(rows, storeIdToName) {
  let saved = 0;
  for (const row of rows) {
    const [month, empCode, empName, storeName, amount] = row;
    const isSummary = storeName === '【合計】';
    // 找 store saydou id（反查）
    let storeId = '_total';
    if (!isSummary) {
      for (const [sid, sname] of Object.entries(storeIdToName)) {
        if (sname === storeName) { storeId = sid; break; }
      }
    }
    try {
      await pool.query(`
        INSERT INTO employee_performance (month, employee_code, employee_name, store_name, store_saydou_id, revenue, tip_total, is_summary, data_source, synced_at)
        VALUES ($1, $2, $3, $4, $5, $6, 0, $7, 'saydou', NOW())
        ON CONFLICT (store_name, employee_code, month)
        DO UPDATE SET revenue = $6, employee_name = $3, store_saydou_id = $5, is_summary = $7, synced_at = NOW()
      `, [month, empCode, empName, storeName, storeId, amount, isSummary]);
      saved++;
    } catch (e) {
      console.warn(`[GCP] DB upsert 失敗 ${empCode} ${month} ${storeName}:`, e.message);
    }
  }
  return saved;
}

/** 從 DB 讀取快取（某月份有資料就不打 API） */
async function loadFromDB(months) {
  const { rows } = await pool.query(
    `SELECT month, employee_code, employee_name, store_name, store_saydou_id, revenue, is_summary
     FROM employee_performance WHERE month = ANY($1) ORDER BY month, employee_code, is_summary`,
    [months]
  );
  return rows;
}

export async function run(args = []) {
  const d = new Date();
  const currentYm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const startYm = args[0] ?? null;
  const endYm = args[1] ?? currentYm;
  const forceRefresh = args.includes('--refresh');

  // 未帶參數時只跑「當月」（GCP 排程用），避免每次 2025-01～今天資料量過大
  const actualStart = (startYm || args[1]) ? (startYm || '2025-01') : currentYm;
  const actualEnd = endYm;

  console.log(`[GCP] 員工業績月報 開始 ${actualStart} ~ ${actualEnd}${forceRefresh ? ' (強制重整)' : ''}`);

  const auth = await getAuth();

  // 計算需要的月份
  const allMonths = listMonthsFrom2025(actualEnd);
  const startIdx = allMonths.indexOf(actualStart);
  const targetMonths = startIdx >= 0 ? allMonths.slice(startIdx) : allMonths;

  // 檢查 DB 快取（除非 --refresh）
  let cachedRows = [];
  let monthsToFetch = targetMonths;
  if (!forceRefresh) {
    try {
      cachedRows = await loadFromDB(targetMonths);
      const cachedMonths = [...new Set(cachedRows.map(r => r.month))];
      monthsToFetch = targetMonths.filter(m => !cachedMonths.includes(m));
      if (cachedMonths.length > 0) {
        console.log(`[GCP] DB 快取命中 ${cachedMonths.length} 個月份，需重新拉取 ${monthsToFetch.length} 個月份`);
      }
    } catch (e) {
      console.warn('[GCP] 讀取 DB 快取失敗，全部重新拉取:', e.message);
      monthsToFetch = targetMonths;
    }
  }

  let newRows = [];
  const storeIdToName = await getStoreIdToName(auth);

  if (monthsToFetch.length > 0) {
    const bearerToken = await getBearerToken(auth);
    if (!bearerToken) {
      throw new Error('無 Bearer Token，請設 SAYDOU_BEARER_TOKEN 或 TOKEN_SHEET_SS_ID');
    }

    const fetchStart = monthsToFetch[0];
    const fetchEnd = monthsToFetch[monthsToFetch.length - 1];
    const { rows } = await buildReport(auth, bearerToken, fetchStart, fetchEnd);
    newRows = rows;

    // 存入 DB
    if (newRows.length > 0) {
      const saved = await saveToDB(newRows, storeIdToName);
      console.log(`[GCP] 已存入 DB ${saved} 筆`);
    }
  }

  // 合併：DB 快取 + 新拉的資料
  const allRows = [];

  // DB 快取轉回 sheet row 格式
  for (const r of cachedRows) {
    const amt = Number(r.revenue) || 0;
    allRows.push([
      r.month, r.employee_code, r.employee_name || '', r.store_name || '',
      amt, '', '', '',
      r.is_summary ? (amt >= 90000 ? '1' : '0') : '',
      r.is_summary ? (amt >= 100000 ? '1' : '0') : '',
      r.is_summary ? (amt >= 110000 ? '1' : '0') : '',
      r.is_summary ? (amt >= 120000 ? '1' : '0') : '',
    ]);
  }
  // 加上新拉的
  allRows.push(...newRows);

  console.log(`[GCP] 總計 ${allRows.length} 筆（快取 ${cachedRows.length} + 新拉 ${newRows.length}）`);

  if (allRows.length > 0) {
    await writeToSheet(auth, allRows);
    console.log(`[GCP] 已寫入試算表`);
  }

  console.log('[GCP] 完成');
}
