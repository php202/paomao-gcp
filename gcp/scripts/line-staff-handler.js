import fetch from 'node-fetch';
import { nowTaipeiStr } from '../lib/date-tz.js';
import { readSheet, appendSheet } from '../lib/sheets.js';
import { lastMonthTipsReport } from './tips-report.js';
import {
  getCachedAttendanceSheetUrl,
  createAttendanceSpreadsheetAndShare,
  saveAttendanceRequestCache,
} from '../lib/attendance-sheet.js';
import {
  createAttendanceExcelAndUpload,
  getSignedUrlFromGcsPath,
} from '../lib/attendance-excel.js';
import { isUserAuthorized } from './line-checkin-handler.js';
import pool from '../lib/db.js';
import { getTomorrowReservationList } from '../api/stores-api.js';
import { findAvailableSlotsAction } from '../api/core-api.js';
import {
  ATT_KEYWORDS,
  MSG_NO_ACTION_PERMISSION,
  MSG_NO_MANAGED_STORES,
  MSG_USE_STORE_LAST_MONTH,
} from './staff-keyword-routes.js';

const REPORT_PAGE_URL = process.env.REPORT_PAGE_URL || 'https://www.paopaomao.tw/report';
/** 報告頁在官網/Odoo 開啟時，需帶 api_base 指向 GCP report-api（例：https://xxx.run.app/report-api） */
const REPORT_API_BASE = (process.env.REPORT_API_BASE || '').trim();
const CUSTOMER_INFO_PAGE_URL = process.env.CUSTOMER_INFO_PAGE_URL || 'https://www.paopaomao.tw/customer-info';
const PAO_CAT_CORE_API_URL = process.env.PAO_CAT_CORE_API_URL || '';
const PAO_CAT_SECRET_KEY = process.env.PAO_CAT_SECRET_KEY || '';
const LINE_STAFF_SS_ID = process.env.LINE_STAFF_SS_ID || '';
const LINE_HQ_SS_ID = process.env.LINE_HQ_SS_ID || '';
const STORE_INFO_SS_ID = process.env.LINE_STORE_SS_ID || process.env.INTEGRATED_SHEET_SS_ID || '';
const WORKFLOW_SHEET_SS_ID = (process.env.WORKFLOW_SHEET_SS_ID || '').trim();
const GCS_BUCKET_ATTENDANCE = (process.env.GCS_BUCKET_ATTENDANCE || '').trim();
const LINE_TOKEN_PAOSTAFF = (process.env.LINE_TOKEN_PAOSTAFF || '').trim();

/**
 * 呼叫 LINE Bot API 取得群組顯示名稱（用於神美日報開啟紀錄 C 排顯示真實群組名而非 UUID）
 * @param {string} groupId
 * @param {typeof fetch} fetcher
 * @returns {Promise<string>}
 */
async function getLineGroupName(groupId, fetcher = fetch) {
  if (!groupId || !LINE_TOKEN_PAOSTAFF) return '';
  try {
    const res = await fetcher(
      `https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/summary`,
      {
        method: 'get',
        headers: { Authorization: `Bearer ${LINE_TOKEN_PAOSTAFF}` },
      },
    );
    if (res.status !== 200) return '';
    const json = await res.json();
    return typeof json?.groupName === 'string' ? String(json.groupName).trim() : '';
  } catch {
    return '';
  }
}

// 店別顯示規則：所有【店別】區塊一律使用 getStoreDisplayName(storeNameMap, storeId, apiStoreName)，
// 不得直接使用 storeId 或 resolveStoreName(...) || storeId，避免出現【0001】等代碼。

function splitStoreIds(list) {
  const out = [];
  for (const raw of list || []) {
    String(raw || '')
      .split(/[,、，]/)
      .forEach((v) => {
        const t = String(v || '').trim();
        if (t) out.push(t);
      });
  }
  return [...new Set(out)];
}

/**
 * 將試算表 B 欄「打卡時間」各種格式統一為 Date（台北時間解讀）。
 * 支援：Excel 序列數字、Date、YYYY/MM/DD、YYYY-MM-DD、YYYY/M/D 上午 H:mm:ss、YYYY/M/D 下午 H:mm:ss 等。
 */
function normalizeDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    if (value > 100000) return null; // 可能是 Unix ms
    const d = new Date((value - 25569) * 86400 * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  if (!s) return null;

  // 試算表 zh-TW 常出現「2026/2/1 上午 9:41:36」「2026/2/1 下午 10:30:00」— 先正規化
  const matchTw = s.match(/^\s*(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s*(上午|下午)?\s*(\d{1,2})?:?(\d{2})?:?(\d{2})?\s*$/i);
  if (matchTw) {
    const [, y, m, day, ampm, h = '0', min = '0', sec = '0'] = matchTw;
    let hour = parseInt(h, 10) || 0;
    if (String(ampm || '').includes('下午') && hour < 12) hour += 12;
    if (String(ampm || '').includes('上午') && hour === 12) hour = 0;
    const iso = `${y}-${m.padStart(2, '0')}-${day.padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}+08:00`;
    const dateObj = new Date(iso);
    return Number.isNaN(dateObj.getTime()) ? null : dateObj;
  }

  // 其餘：YYYY-MM-DD、YYYY/MM/DD、YYYY-MM-DD HH:mm 等
  const iso = s.replace(/^\s*(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/, (_, y, m, d) =>
    `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`,
  );
  if (/^\d{4}-\d{2}-\d{2}([\sT]\d{1,2}:\d{2}|$)/.test(iso)) {
    let withTz = iso;
    if (iso.length <= 10) withTz = iso + 'T00:00:00+08:00';
    else if (!/[\+\-Z]/.test(iso)) withTz = iso.replace(/\s+/, 'T') + '+08:00';
    const d = new Date(withTz);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDateTime(d) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}

/** 僅輸出 HH:mm（台北），避免 slice 受 locale 影響導致店家今天出勤時間錯 */
function fmtTimeHHmm(d) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/** 輸出 HH:mm:ss（台北），用於出勤明細 */
function fmtTimeHHmmss(d) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}

function fmtDate(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function extractPhoneFromCustomerKeyword(text) {
  if (!text || typeof text !== 'string') return null;
  const s = text.replace(/我要了解客人\s*/i, '').trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length === 9 && digits[0] === '9') return `0${digits}`;
  if (digits.length >= 10 && digits[0] === '0') return digits.slice(0, 10);
  if (digits.length >= 9 && digits[0] === '9') return `0${digits.slice(0, 9)}`;
  const m = text.match(/09[\d\s-]{7,}/);
  if (!m) return null;
  const d = m[0].replace(/\D/g, '');
  if (d.length >= 10) return d.slice(0, 10);
  if (d.length === 9 && d.startsWith('09')) return d; // 9 碼 09 開頭也嘗試查詢
  return null;
}

function formatDirectStoreCompletionRate(val) {
  const n = val != null ? Number(val) : NaN;
  if (Number.isNaN(n)) return '—';
  if (n > 1) return `${n.toFixed(1)}%`;
  return `${(n * 100).toFixed(1)}%`;
}

async function callCoreApiGet(action, params = {}, fetcher = fetch) {
  if (!PAO_CAT_CORE_API_URL || !PAO_CAT_SECRET_KEY) return null;
  const url = new URL(PAO_CAT_CORE_API_URL);
  url.searchParams.set('key', PAO_CAT_SECRET_KEY);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && String(v) !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetcher(url.toString(), { method: 'get' });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callCoreApiPost(action, payload = {}, fetcher = fetch) {
  if (!PAO_CAT_CORE_API_URL || !PAO_CAT_SECRET_KEY) return null;
  const res = await fetcher(PAO_CAT_CORE_API_URL, {
    method: 'post',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: PAO_CAT_SECRET_KEY, action, ...payload }),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function storeIdCandidates(storeId) {
  const s = String(storeId || '').trim();
  if (!s) return [];
  const out = [s];
  if (/^\d+$/.test(s)) {
    const noLeading = s.replace(/^0+(?=\d)/, '');
    if (noLeading && noLeading !== s) out.push(noLeading);
    const n = Number(s);
    if (!Number.isNaN(n)) {
      const ns = String(n);
      if (ns && ns !== s && !out.includes(ns)) out.push(ns);
    }
  }
  return out;
}

async function readStoreNameMap(auth, sheetReader) {
  const map = new Map();
  if (!STORE_INFO_SS_ID) return map;
  const rows = await sheetReader(auth, STORE_INFO_SS_ID, "'店家基本資料'!A:I");
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = String(row[1] || '').trim();
    if (!name) continue;
    // F 欄 = SayDou 店家 ID（例 201969）；A 欄 = 店碼（例 0001、1437），管理者清單 C 欄多用店碼
    const saydouId = String(row[5] || '').trim();
    const storeCode = String(row[0] || '').trim();
    if (saydouId) {
      for (const key of storeIdCandidates(saydouId)) map.set(key, name);
    }
    if (storeCode) {
      for (const key of storeIdCandidates(storeCode)) map.set(key, name);
    }
  }
  return map;
}

/** 店碼 → SayDou 店家 ID（員工清單 byStore 以 saydouId 為 key，管理者清單給的是店碼，需對照才查得到人） */
async function readStoreIdToSaydouId(auth, sheetReader) {
  const map = new Map();
  if (!STORE_INFO_SS_ID) return map;
  const rows = await sheetReader(auth, STORE_INFO_SS_ID, "'店家基本資料'!A:I");
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const storeCode = String(row[0] || '').trim();
    const saydouId = String(row[5] || '').trim();
    if (!storeCode || !saydouId) continue;
    for (const key of storeIdCandidates(storeCode)) map.set(key, saydouId);
  }
  return map;
}

/** 依店碼取得該店成員（先試 storeId，再試店碼對應的 saydouId，最後 fallback 店名） */
function getMembersForStore(storeId, maps, storeNameMap, storeIdToSaydouId) {
  let members = maps.byStore.get(storeId) || [];
  if (!members.length && storeIdToSaydouId) {
    const saydouId = storeIdToSaydouId.get(storeId);
    if (saydouId) members = maps.byStore.get(saydouId) || [];
  }
  if (!members.length) {
    const storeName = getStoreDisplayName(storeNameMap, storeId);
    members = maps.byStoreName.get(String(storeName || '').trim()) || maps.byStore.get(storeId) || [];
  }
  return members;
}

function resolveStoreName(storeNameMap, storeId) {
  for (const key of storeIdCandidates(storeId)) {
    const name = storeNameMap.get(key);
    if (name) return name;
  }
  return '';
}

/**
 * 一律回傳「店名」用於顯示，不得直接顯示 storeId。
 * 優先：店家對照表 → API 回傳店名 →  fallback「店碼 xxx」。
 * 所有【店別】區塊請只用此函數，避免再出現【0001】等代碼。
 */
function getStoreDisplayName(storeNameMap, storeId, apiStoreName) {
  const fromMap = resolveStoreName(storeNameMap, storeId);
  if (fromMap && String(fromMap).trim()) return String(fromMap).trim();
  if (apiStoreName && String(apiStoreName).trim()) return String(apiStoreName).trim();
  const id = String(storeId || '').trim();
  return id ? `店碼 ${id}` : '—';
}

/**
 * 組「本月出勤／上月出勤」回覆文案。
 * 對齊 GAS：gas/泡泡貓 員工打卡 Line@/getAtt.js 的 formatAtt()、sendAtt.js 本月/上月出勤。
 * 格式：👤 員工: 姓名 (店名)、🔹 日期 出勤紀錄、✅ 上班: HH:mm:ss 、…、✅ 下班: …（無則留空）
 * @param {Array} records - 打卡紀錄 { userId, time, type }
 * @param {Map} employeeMap - lineId -> { name, store, ... }（同 GAS formatManagedStores 的 employeesByLineId）
 * @param {Map} [storeNameMap] - 店碼→店名；有則顯示店名（如 泡泡貓｜台中廣三店），無則用 emp.store（員工清單 B 欄）
 */
function buildAttendanceMessage(records, employeeMap, storeNameMap = new Map()) {
  if (!records.length) return '⚠️ 查無打卡紀錄';
  const byUser = new Map();
  for (const r of records) {
    const arr = byUser.get(r.userId) || [];
    arr.push(r);
    byUser.set(r.userId, arr);
  }
  const lines = [];
  for (const [uid, items] of byUser.entries()) {
    const emp = employeeMap.get(uid);
    if (!emp) continue;
    const storeLabel = getStoreDisplayName(storeNameMap, emp.store, null) || emp.store || '未設定門市';
    lines.push(`👤 員工: ${emp.name} (${storeLabel})`);
    const byDate = new Map();
    for (const it of items) {
      const key = fmtDate(it.time);
      const a = byDate.get(key) || [];
      a.push(it);
      byDate.set(key, a);
    }
    const sortedDates = [...byDate.keys()].sort();
    for (const date of sortedDates) {
      const dayItems = byDate.get(date);
      const onItems = dayItems.filter((x) => String(x.type).includes('上班')).sort((a, b) => a.time - b.time);
      const offItems = dayItems.filter((x) => String(x.type).includes('下班')).sort((a, b) => a.time - b.time);
      const onStr = onItems.length ? fmtTimeHHmmss(onItems[0].time) : '';
      const offStr = offItems.length ? fmtTimeHHmmss(offItems[offItems.length - 1].time) : '';
      lines.push(`🔹 ${date} 出勤紀錄`);
      lines.push(onStr ? `✅ 上班: ${onStr}` : `⏳ 上班: 未打卡`);
      lines.push(offStr ? `✅ 下班: ${offStr}` : `⏳ 下班: 未打卡`);
    }
    lines.push('');
  }
  return lines.join('\n').trim() || '⚠️ 查無打卡紀錄';
}

/** 與 GAS formatManagedStores 對齊：byStore 以 saydouId/店碼為 key；byStoreName 以店名(B欄)為 key，供 fallback */
async function readEmployeeMaps(auth, sheetReader) {
  const rows = await sheetReader(auth, LINE_STAFF_SS_ID, "'員工清單'!A:L");
  const byLineId = new Map();
  const byStore = new Map();
  const byStoreName = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const code = String(row[0] || '').trim();
    const store = String(row[1] || '').trim();
    const name = String(row[2] || '').trim();
    const lineId = String(row[3] || '').trim();
    const role = String(row[4] || '').trim();
    const saydouId = String(row[5] || '').trim();
    if (!name || !['員工', '組長', '店長', '工讀', '試用'].includes(role)) continue;
    const data = { code, store, name, lineId, saydouId };
    if (lineId) byLineId.set(lineId, data);
    if (saydouId) {
      const list = byStore.get(saydouId) || [];
      list.push(data);
      byStore.set(saydouId, list);
    }
    if (store) {
      if (store === saydouId) {
        byStore.set(store, byStore.get(saydouId));
      } else {
        const list = byStore.get(store) || [];
        list.push(data);
        byStore.set(store, list);
      }
      const nameKey = store.trim();
      if (nameKey) {
        const nList = byStoreName.get(nameKey) || [];
        nList.push(data);
        byStoreName.set(nameKey, nList);
      }
    }
  }
  return { byLineId, byStore, byStoreName };
}

function safeUserSuffix(userId) {
  const s = String(userId || '');
  return s ? s.slice(-6) : '';
}

/**
 * 取得人員打卡記錄 — DB 優先，Sheet fallback
 * DB: checkin_records (check_type: in/out)
 * Sheet: 員工打卡紀錄 / 打卡紀錄封存 (C欄: 上班打卡/下班打卡)
 */
async function readAttendance(auth, userIds, startDate, endDate, sheetReader) {
  const userSet = new Set((userIds || []).map(String));
  if (!userSet.size) return [];

  // ── Step 1: 從 DB 讀 ──
  let dbRecords = [];
  try {
    const { rows } = await pool.query(
      `SELECT line_user_id, checked_at, check_type, note
       FROM checkin_records
       WHERE line_user_id = ANY($1)
         AND checked_at >= $2 AND checked_at <= $3
         AND check_type IN ('in', 'out')
       ORDER BY checked_at`,
      [[...userSet], startDate, endDate]
    );
    dbRecords = rows.map(r => ({
      userId: r.line_user_id,
      time: new Date(r.checked_at),
      type: r.check_type === 'in' ? '上班打卡' : '下班打卡',
    }));
    if (dbRecords.length > 0) {
      console.log(`[attendance] DB: ${dbRecords.length} records for ${userSet.size} users`);
      return dbRecords;
    }
  } catch (e) {
    console.warn('[attendance] DB query failed, falling back to Sheet:', e.message);
  }

  // ── Step 2: DB 沒資料 → fallback 讀 Sheet ──
  console.log('[attendance] DB empty, falling back to Sheet');
  const now = new Date();
  const taipeiYMD = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const [ty, tm] = taipeiYMD.split('-').map(Number);
  const cutoffDate = new Date(`${ty}-${String(tm).padStart(2, '0')}-01T00:00:00+08:00`);

  const sheetsToRead = [];
  if (startDate < cutoffDate) sheetsToRead.push("'打卡紀錄封存'!A:G");
  if (endDate >= cutoffDate) sheetsToRead.push("'員工打卡紀錄'!A:G");
  if (sheetsToRead.length === 0) sheetsToRead.push("'員工打卡紀錄'!A:G");

  const rows = [];
  for (const src of sheetsToRead) {
    try {
      const data = await sheetReader(auth, LINE_STAFF_SS_ID, src);
      rows.push(...(data || []).slice(1));
    } catch {
      // ignore missing sheet
    }
  }

  return rows
    .map((row) => {
      const userId = String(row[0] || '').trim();
      const time = normalizeDate(row[1]);
      const type = String(row[2] || '').trim();
      const note = String(row[6] || '');
      const tagType = note.includes('補打卡') && type ? `${type}(補)` : type;
      return { userId, time, type: tagType };
    })
    .filter((x) => x.userId && userSet.has(x.userId) && x.time)
    .filter((x) => x.time >= startDate && x.time <= endDate)
    .filter((x) => x.type.includes('上班') || x.type.includes('下班'))
    .sort((a, b) => a.time - b.time);
}

async function handleAttendanceCommand({
  authClient,
  authResult,
  text,
  userId,
  replyText,
  replyMessages,
  sheetReader,
}) {
  // 關鍵字正規化：去除 BOM、零寬字元、所有空白，避免「店家 本月出勤」等無法匹配
  const textNorm = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .replace(/\s/g, '');

  if (text === '查詢打卡記錄' || textNorm === '查詢打卡記錄') {
    const items = [];
    if (authResult.identity.includes('employee')) {
      items.push({ type: 'action', action: { type: 'message', label: '本月出勤', text: '本月出勤' } });
      items.push({ type: 'action', action: { type: 'message', label: '上月出勤', text: '上月出勤' } });
    }
    if (authResult.identity.includes('manager')) {
      items.push({ type: 'action', action: { type: 'message', label: '店家今天出勤', text: '店家今天出勤' } });
      items.push({ type: 'action', action: { type: 'message', label: '店家本月出勤', text: '店家本月出勤' } });
      items.push({ type: 'action', action: { type: 'message', label: '店家上月出勤', text: '店家上月出勤' } });
      items.push({ type: 'action', action: { type: 'message', label: '店家可預約時間', text: '店家可預約時間' } });
    }
    await replyMessages([
      {
        type: 'text',
        text: '請選擇要查詢的出勤項目',
        quickReply: { items },
      },
    ]);
    return true;
  }

  if (!ATT_KEYWORDS.has(textNorm)) return false;

  // sendAtt 對齊：店家* 僅 manager；非 manager 回「您尚無本行動權限」
  const storeOnlyKeywords = new Set(['店家今天出勤', '店家本月出勤', '店家上月出勤', '店家可預約時間']);
  if (storeOnlyKeywords.has(textNorm) && !authResult.identity.includes('manager')) {
    await replyText(MSG_NO_ACTION_PERMISSION);
    return true;
  }

  const now = new Date();
  const taipeiTodayStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const [taipeiY, taipeiM, taipeiD] = taipeiTodayStr.split('-').map(Number);
  const y = taipeiY;
  const m = taipeiM - 1;
  const maps = await readEmployeeMaps(authClient, sheetReader);
  const storeNameMap = await readStoreNameMap(authClient, sheetReader);
  const storeIdToSaydouId = STORE_INFO_SS_ID ? await readStoreIdToSaydouId(authClient, sheetReader).catch(() => new Map()) : new Map();

  // #region agent log
  try {
    const sampleIds = splitStoreIds(authResult.identity.includes('manager') ? authResult.managedStores : authResult.workStores).slice(0, 5);
    const sampleResolved = sampleIds.map((id) => ({ id, name: resolveStoreName(storeNameMap, id) || null }));
    console.log(
      JSON.stringify({
        hypothesisId: 'H4',
        location: 'line-staff-handler.js:handleAttendanceCommand:storeNameMap',
        message: 'store name map size and sample lookups',
        data: {
          userSuffix: safeUserSuffix(userId),
          storeInfoSsIdSet: !!STORE_INFO_SS_ID,
          storeInfoSsIdPrefix: STORE_INFO_SS_ID ? String(STORE_INFO_SS_ID).slice(0, 8) : '',
          mapSize: storeNameMap.size,
          sampleResolved,
        },
        timestamp: Date.now(),
      }),
    );
  } catch {}
  // #endregion

  const managedStores = splitStoreIds(authResult.managedStores);

  // 先處理「店家本月／上月出勤」（Excel 連結），與 GAS sendAtt 順序一致，避免與「本月出勤」混淆
  // 資料來源：本月＝員工打卡紀錄；上月＝員工打卡紀錄＋打卡紀錄封存（readAttendance 依 cutoff 自動選表）
  if (textNorm === '店家本月出勤' || textNorm === '店家上月出勤') {
    if (!managedStores.length) {
      await replyText(MSG_NO_MANAGED_STORES);
      return true;
    }
    const isThisMonth = textNorm === '店家本月出勤';
    const [yStr, mStr] = taipeiTodayStr.split('-');
    let ym = parseInt(mStr, 10);
    let yy = parseInt(yStr, 10);
    if (!isThisMonth) {
      ym -= 1;
      if (ym === 0) {
        ym = 12;
        yy -= 1;
      }
    }
    const yyyyMM = `${yy}-${String(ym).padStart(2, '0')}`;
    const preparedLabel = isThisMonth ? `已經幫您準備好本月 ${yyyyMM} 出勤紀錄` : `已經幫您準備好上月 ${yyyyMM} 出勤紀錄`;
    const monthStart = new Date(`${yy}-${String(ym).padStart(2, '0')}-01T00:00:00+08:00`);
    const lastDay = new Date(yy, ym, 0).getDate();
    const monthEnd = new Date(`${yy}-${String(ym).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}T23:59:59.999+08:00`);

    const cachedValue = await getCachedAttendanceSheetUrl(
      authClient,
      sheetReader,
      LINE_STAFF_SS_ID,
      userId,
      yyyyMM,
    );
    if (cachedValue) {
      const gcsPathRaw = cachedValue.startsWith('gcs:') ? cachedValue.slice(4) : cachedValue;
      if (GCS_BUCKET_ATTENDANCE && (cachedValue.startsWith('attendance/') || cachedValue.startsWith('gcs:'))) {
        if (!gcsPathRaw.includes(`/${yyyyMM}/`) && !gcsPathRaw.includes(`/${yyyyMM}.`)) {
          // 快取路徑月份與請求不符（例如 C 欄 2026-02 但 D 欄為 2026-01 的舊檔），不採用快取，重新產檔
          console.log(`[handleAttendanceCommand] cache path month mismatch, requested ${yyyyMM}, path=${gcsPathRaw.slice(0, 50)}`);
        } else {
          let url = cachedValue;
          try {
            url = await getSignedUrlFromGcsPath(gcsPathRaw);
          } catch (e) {
            console.warn('[handleAttendanceCommand] getSignedUrlFromGcsPath failed:', e?.message);
          }
          if (url.startsWith('http')) {
            await replyMessages([
              {
                type: 'template',
                altText: `${preparedLabel}，請點擊按鈕下載`,
                template: {
                  type: 'buttons',
                  text: `${preparedLabel}\n請點擊下方按鈕下載`,
                  actions: [{ type: 'uri', label: '📥 下載 Excel', uri: url }],
                },
              },
            ]);
            return true;
          }
        }
      } else {
        await replyMessages([
          {
            type: 'template',
            altText: `${preparedLabel}，請點擊按鈕下載`,
            template: {
              type: 'buttons',
              text: `${preparedLabel}\n請點擊下方按鈕下載`,
              actions: [{ type: 'uri', label: '📥 下載 Excel', uri: cachedValue }],
            },
          },
        ]);
        return true;
      }
    }

    const perStoreData = [];
    const sortedDates = [];
    for (let d = new Date(monthStart.getTime()); d <= monthEnd; d.setDate(d.getDate() + 1)) {
      sortedDates.push(fmtDate(d));
    }
    for (const storeId of managedStores) {
      let members = getMembersForStore(storeId, maps, storeNameMap, storeIdToSaydouId);
      members = members.filter((m) => m.lineId && String(m.lineId) !== '#N/A');
      if (!members.length) continue;
      const storeName = String(getStoreDisplayName(storeNameMap, storeId) ?? storeId ?? '');
      const records = await readAttendance(
        authClient,
        members.map((m) => m.lineId),
        monthStart,
        monthEnd,
        sheetReader,
      );
      const byDateUser = {};
      for (const r of records) {
        const dateStr = fmtDate(r.time);
        if (!byDateUser[dateStr]) byDateUser[dateStr] = {};
        if (!byDateUser[dateStr][r.userId])
          byDateUser[dateStr][r.userId] = { checkIn: '-', checkOut: '-' };
        const cell = byDateUser[dateStr][r.userId];
        const t = fmtTimeHHmm(r.time);
        if (String(r.type).includes('上班')) {
          cell.checkIn = cell.checkIn === '-' ? t : cell.checkIn + '\n' + t;
        }
        if (String(r.type).includes('下班')) {
          cell.checkOut = cell.checkOut === '-' ? t : cell.checkOut + '\n' + t;
        }
      }
      const headerRow1 = [storeName, ...members.flatMap((m) => [String(m.name ?? ''), ''])];
      const headerRow2 = ['日期', ...members.flatMap(() => ['上班', '下班'])];
      const dataRows = sortedDates.map((dateStr) => [
        dateStr,
        ...members.flatMap((m) => {
          const c = byDateUser[dateStr]?.[m.lineId] || { checkIn: '-', checkOut: '-' };
          return [String(c.checkIn ?? '-'), String(c.checkOut ?? '-')];
        }),
      ]);
      perStoreData.push({ sheetTitle: storeName, headerRow1, headerRow2, dataRows });
    }
    if (perStoreData.length === 0) {
      await replyText('⚠️ 查無此區間的員工或打卡資料，無法產生檔案。\n（資料來源：試算表「員工打卡紀錄」）');
      return true;
    }
    const errorId =
      new Date()
        .toLocaleString('sv-SE', { timeZone: 'Asia/Taipei', hour12: false })
        .replace(/-/g, '')
        .replace(/:/g, '')
        .replace(' ', '_')
        .slice(0, 15) +
      '_' +
      String(Math.random()).slice(2, 6);
    const title =
      `泡泡貓_出勤記錄_` +
      new Date()
        .toLocaleString('sv-SE', {
          timeZone: 'Asia/Taipei',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
        .replace(/-/g, '')
        .replace(/:/g, '')
        .replace(' ', '_');
    try {
      let url;
      if (GCS_BUCKET_ATTENDANCE) {
        const { url: excelUrl, gcsPath } = await createAttendanceExcelAndUpload(
          title,
          perStoreData,
          userId,
          yyyyMM,
        );
        url = excelUrl;
        try {
          await saveAttendanceRequestCache(authClient, LINE_STAFF_SS_ID, userId, yyyyMM, gcsPath);
        } catch (cacheErr) {
          console.warn(
            '[handleAttendanceCommand] saveAttendanceRequestCache failed (url still sent):',
            cacheErr?.message,
            cacheErr?.response?.data,
          );
        }
      } else {
        const res = await createAttendanceSpreadsheetAndShare(authClient, title, perStoreData);
        url = res.url;
        try {
          await saveAttendanceRequestCache(authClient, LINE_STAFF_SS_ID, userId, yyyyMM, url);
        } catch (cacheErr) {
          console.warn(
            '[handleAttendanceCommand] saveAttendanceRequestCache failed (url still sent):',
            cacheErr?.message,
            cacheErr?.response?.data,
          );
        }
      }
      await replyMessages([
        {
          type: 'template',
          altText: `${preparedLabel}，請點擊按鈕下載`,
          template: {
            type: 'buttons',
            text: `${preparedLabel}\n請點擊下方按鈕下載`,
            actions: [{ type: 'uri', label: '📥 下載 Excel', uri: url }],
          },
        },
      ]);
    } catch (e) {
      const logPayload = {
        errorId,
        feature: '店家本月出勤',
        userId,
        yyyyMM,
        message: e?.message,
        stack: e?.stack,
        responseData: e?.response?.data ?? null,
      };
      console.error(
        '[handleAttendanceCommand] createAttendanceSpreadsheetAndShare failed',
        JSON.stringify(logPayload),
      );
      // 從錯誤內容抽出簡短原因，讓使用者在 LINE 能看到（不暴露敏感資訊）
      let reason = '';
      const msg = (e?.response?.data?.error?.message || e?.message || '').trim();
      if (/資料夾擁有者|資料夾.*儲存.*滿/i.test(msg)) reason = '可能原因：資料夾擁有者的 Drive 已滿，請至 drive.google.com 清理該帳號的檔案或換一個有空間的資料夾';
      else if (/quota|storage.*exceeded|儲存.*滿/i.test(msg)) reason = '可能原因：Drive 儲存空間已滿';
      else if (/permission|403|權限/i.test(msg)) reason = '可能原因：權限不足';
      else if (/File not found/i.test(msg)) reason = '可能原因：指定的資料夾不存在或未分享給服務帳號，請將資料夾分享給 pao-sheets-creator@gen-lang-client-0828139766.iam.gserviceaccount.com 權限「編輯者」';
      else if (msg) reason = '原因：' + String(msg).slice(0, 80).replace(/\n/g, ' ');
      const reply =
        `產出試算表時發生錯誤，請稍後再試或聯繫管理員。\n（錯誤代碼：${errorId}，提供此代碼可加速排查）` +
        (reason ? `\n${reason}` : '');
      await replyText(reply);
    }
    return true;
  }

  // 本月出勤：與 GAS 一致，employee 優先 → 本人本月 formatAtt；僅 manager（非 employee）→ 等同店家今天出勤
  if (textNorm === '本月出勤') {
    if (!authResult.identity.includes('employee') && !authResult.identity.includes('manager')) {
      await replyText(MSG_NO_ACTION_PERMISSION);
      return true;
    }
    if (authResult.identity.includes('employee')) {
      const [yStr, mStr] = taipeiTodayStr.split('-');
      const ym = parseInt(mStr, 10);
      const yy = parseInt(yStr, 10);
      const monthStart = new Date(`${yy}-${String(ym).padStart(2, '0')}-01T00:00:00+08:00`);
      const lastDay = new Date(yy, ym, 0).getDate();
      const monthEnd = new Date(`${yy}-${String(ym).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}T23:59:59.999+08:00`);
      const records = await readAttendance(authClient, [userId], monthStart, monthEnd, sheetReader);
      await replyText(buildAttendanceMessage(records, maps.byLineId, storeNameMap));
      return true;
    }
    if (authResult.identity.includes('manager')) {
      const managedStoresForToday = splitStoreIds(authResult.managedStores);
      if (!managedStoresForToday.length) {
        await replyText(MSG_NO_MANAGED_STORES);
        return true;
      }
      const dayStart = new Date(`${taipeiTodayStr}T00:00:00+08:00`);
      const dayEnd = new Date(`${taipeiTodayStr}T23:59:59.999+08:00`);
      const lines = [];
      for (const storeId of managedStoresForToday) {
        const members = getMembersForStore(storeId, maps, storeNameMap, storeIdToSaydouId);
        if (!members.length) continue;
        const records = await readAttendance(
          authClient,
          members.map((i) => i.lineId).filter(Boolean),
          dayStart,
          dayEnd,
          sheetReader,
        );
        const byUser = new Map();
        for (const r of records) {
          const arr = byUser.get(r.userId) || [];
          arr.push(r);
          byUser.set(r.userId, arr);
        }
        const attended = [];
        const absent = [];
        const unregistered = [];
        for (const mbr of members) {
          if (!mbr.lineId || mbr.lineId === '#N/A') {
            unregistered.push(mbr.name);
            continue;
          }
          const rs = byUser.get(mbr.lineId) || [];
          const hasClockIn = rs.some((r) => String(r.type).includes('上班'));
          if (hasClockIn) {
            const detail = rs
              .sort((a, b) => a.time - b.time)
              .map((r) => `${r.type} ${fmtDateTime(r.time).slice(11, 16)}`)
              .join('、');
            attended.push(`${mbr.name}: ${detail}`);
          } else {
            absent.push(mbr.name);
          }
        }
        lines.push(`【${getStoreDisplayName(storeNameMap, storeId)}】`);
        lines.push(`✅ 有上班：\n${attended.join('\n') || '無'}`);
        lines.push(`❌ 沒上班：${absent.join('、') || '無'}`);
        lines.push(`⚠️ 尚未註冊：${unregistered.join('、') || '無'}`);
        lines.push('');
      }
      await replyText(lines.join('\n').trim() || '查詢出勤失敗，請聯絡管理員');
      return true;
    }
    return true;
  }

  // 上月出勤：與本月出勤一致，employee 優先 → 個人上月（打卡紀錄封存）+ 產出格式同本月出勤（文字列表）；僅 manager → 引導改用店家上月出勤
  if (textNorm === '上月出勤') {
    if (!authResult.identity.includes('employee') && !authResult.identity.includes('manager')) {
      await replyText(MSG_NO_ACTION_PERMISSION);
      return true;
    }
    if (authResult.identity.includes('employee')) {
      const [yStr, mStr] = taipeiTodayStr.split('-');
      let ym = parseInt(mStr, 10);
      let yy = parseInt(yStr, 10);
      ym -= 1;
      if (ym === 0) {
        ym = 12;
        yy -= 1;
      }
      const monthStart = new Date(`${yy}-${String(ym).padStart(2, '0')}-01T00:00:00+08:00`);
      const lastDay = new Date(yy, ym, 0).getDate();
      const monthEnd = new Date(`${yy}-${String(ym).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}T23:59:59.999+08:00`);
      const records = await readAttendance(authClient, [userId], monthStart, monthEnd, sheetReader);
      await replyText(buildAttendanceMessage(records, maps.byLineId, storeNameMap));
      return true;
    }
    if (authResult.identity.includes('manager')) {
      await replyText(MSG_USE_STORE_LAST_MONTH);
      return true;
    }
  }

  // 店家今天出勤：manager → 今日各店出勤（與 GAS sendAtt 一致）
  if (textNorm === '店家今天出勤') {
    if (!managedStores.length) {
      await replyText(MSG_NO_MANAGED_STORES);
      return true;
    }
    const dayStart = new Date(`${taipeiTodayStr}T00:00:00+08:00`);
    const dayEnd = new Date(`${taipeiTodayStr}T23:59:59.999+08:00`);
    const lines = [];
    for (const storeId of managedStores) {
      const members = getMembersForStore(storeId, maps, storeNameMap, storeIdToSaydouId);
      if (!members.length) continue;
      const records = await readAttendance(
        authClient,
        members.map((i) => i.lineId).filter(Boolean),
        dayStart,
        dayEnd,
        sheetReader,
      );
      const byUser = new Map();
      for (const r of records) {
        const arr = byUser.get(r.userId) || [];
        arr.push(r);
        byUser.set(r.userId, arr);
      }
      const attended = [];
      const absent = [];
      const unregistered = [];
      for (const mbr of members) {
        if (!mbr.lineId || mbr.lineId === '#N/A') {
          unregistered.push(mbr.name);
          continue;
        }
        const rs = byUser.get(mbr.lineId) || [];
        const hasClockIn = rs.some((r) => String(r.type).includes('上班'));
        if (hasClockIn) {
          const detail = rs
            .sort((a, b) => a.time - b.time)
            .map((r) => `${r.type} ${fmtDateTime(r.time).slice(11, 16)}`)
            .join('、');
          attended.push(`${mbr.name}: ${detail}`);
        } else {
          absent.push(mbr.name);
        }
      }
      lines.push(`【${getStoreDisplayName(storeNameMap, storeId)}】`);
      lines.push(`✅ 有上班：\n${attended.join('\n') || '無'}`);
      lines.push(`❌ 沒上班：${absent.join('、') || '無'}`);
      lines.push(`⚠️ 尚未註冊：${unregistered.join('、') || '無'}`);
      lines.push('');
    }
    await replyText(lines.join('\n').trim() || '查詢出勤失敗，請聯絡管理員');
    return true;
  }

  if (!managedStores.length) {
    await replyText(MSG_NO_MANAGED_STORES);
    return true;
  }

  if (textNorm === '店家可預約時間') {
    const startDate = now.toISOString().slice(0, 10);
    const endDate = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const lines = [];
    for (const storeId of managedStores) {
      // 0001 通常是總公司代碼，不提供可預約時段；避免整段都看起來壞掉
      if (String(storeId) === '0001') {
        lines.push(`【${getStoreDisplayName(storeNameMap, storeId)}】`);
        lines.push('(此代碼不提供可預約時段)');
        lines.push('');
        continue;
      }
      // #region agent log
      try {
        console.log(
          JSON.stringify({
            hypothesisId: 'H3',
            location: 'line-staff-handler.js:handleAttendanceCommand:findAvailableSlots',
            message: 'calling core findAvailableSlots (raw storeId)',
            data: { storeId: String(storeId), userSuffix: safeUserSuffix(userId), startDate, endDate },
            timestamp: Date.now(),
          }),
        );
      } catch {}
      // #endregion

      // Preferred: call internal GCP implementation directly (no PAO_CAT_CORE_API_URL needed).
      let result = null;
      try {
        result = await findAvailableSlotsAction(authClient, {
          sayId: storeId,
          startDate,
          endDate,
          needPeople: 1,
          durationMin: 90,
          weekDays: [0, 1, 2, 3, 4, 5, 6],
          timeStart: '11:00',
          timeEnd: '21:00',
        });
      } catch {
        result = null;
      }

      // Fallback: legacy Core API (if configured)
      if (!result) {
        const r = await callCoreApiGet('findAvailableSlots', { sayId: storeId, startDate, endDate }, fetch);
        result = Array.isArray(r?.data)
          ? { status: true, data: r.data }
          : Array.isArray(r?.result?.data)
            ? { status: true, data: r.result.data }
            : null;
      }

      lines.push(`【${getStoreDisplayName(storeNameMap, storeId)}】`);

      const slotDays = Array.isArray(result?.data) ? result.data : [];
      if (!result || result.status !== true || slotDays.length === 0) {
        lines.push('(無可預約時段)');
      } else {
        for (const day of slotDays.slice(0, 7)) {
          lines.push(`${String(day.date || '').slice(5)} (${day.week || '-'})：${(day.times || []).join('、')}`);
        }
      }
      lines.push('');
    }
    await replyText(lines.join('\n').trim() || '查無可預約時間。');
    return true;
  }

  const dayStart = new Date(`${taipeiTodayStr}T00:00:00+08:00`);
  const dayEnd = new Date(`${taipeiTodayStr}T23:59:59.999+08:00`);
  const lines = [];
  for (const storeId of managedStores) {
    const members = getMembersForStore(storeId, maps, storeNameMap, storeIdToSaydouId);
    if (!members.length) continue;
    const records = await readAttendance(
      authClient,
      members.map((i) => i.lineId).filter(Boolean),
      dayStart,
      dayEnd,
      sheetReader,
    );
    const byUser = new Map();
    for (const r of records) {
      const arr = byUser.get(r.userId) || [];
      arr.push(r);
      byUser.set(r.userId, arr);
    }
    const attended = [];
    const absent = [];
    const unregistered = [];
    for (const mbr of members) {
      if (!mbr.lineId || mbr.lineId === '#N/A') {
        unregistered.push(mbr.name);
        continue;
      }
      const rs = byUser.get(mbr.lineId) || [];
      const hasClockIn = rs.some((r) => String(r.type).includes('上班'));
      if (hasClockIn) {
        const detail = rs
          .sort((a, b) => a.time - b.time)
          .map((r) => `${r.type} ${fmtDateTime(r.time).slice(11, 16)}`)
          .join('、');
        attended.push(`${mbr.name}: ${detail}`);
      } else {
        absent.push(mbr.name);
      }
    }
    lines.push(`【${getStoreDisplayName(storeNameMap, storeId)}】`);
    lines.push(`✅ 有上班：\n${attended.join('\n') || '無'}`);
    lines.push(`❌ 沒上班：${absent.join('、') || '無'}`);
    lines.push(`⚠️ 尚未註冊：${unregistered.join('、') || '無'}`);
    lines.push('');
  }
  await replyText(lines.join('\n').trim() || '查無負責店家的員工資料。');
  return true;
}

async function handleLineQuestion(replyText, authClient, sheetReader) {
  // 改讀 PostgreSQL API（api.paopaomao.tw）
  try {
    const resp = await fetch('https://api.paopaomao.tw/api/issues/pending?key=paomao-issues-2026&limit=50');
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const data = await resp.json();
    const pending = (data.issues || []).map(i => ({
      date: i.created_at ? new Date(i.created_at).toISOString().slice(5, 10) : '--/--',
      store: String(i.store_name || ''),
      content: String(i.description || '').replace(/[\n\r]/g, ' ').slice(0, 24),
      owner: String(i.assignee || ''),
    }));
    if (!pending.length) {
      await replyText('✅ 目前所有問題皆已處理完畢，辛苦了！');
      return true;
    }
    const top = pending.slice(0, 10);
    const lines = ['📝 【待處理問題清單】', '==============='];
    top.forEach((t, idx) => {
      lines.push(`${idx + 1}. [${t.date}] ${t.store}`);
      lines.push(`👤 ${t.owner}：${t.content}`);
      lines.push('---------------');
    });
    if (pending.length > 10) {
      lines.push(`⚠️ 還有 ${pending.length - 10} 筆未顯示，請至後台查看。`);
    } else {
      lines.push(`共計 ${pending.length} 筆未回傳。`);
    }
    await replyText(lines.join('\n'));
    return true;
  } catch (err) {
    console.error('[handleLineQuestion] API error:', err.message);
    await replyText('⚠️ 問題集查詢暫時無法使用，請稍後再試。');
    return true;
  }
}

/** 依關鍵字從「公司流程」試算表取得連結（與 GAS Core.getWorkflowLink 一致）；無設定或無匹配回 null */
async function getWorkflowLink(authClient, keyword, sheetReader) {
  if (!WORKFLOW_SHEET_SS_ID || !keyword || typeof sheetReader !== 'function') return null;
  const k = String(keyword).trim();
  if (!k) return null;
  try {
    const rows = await sheetReader(authClient, WORKFLOW_SHEET_SS_ID, "'公司流程'!A:B");
    for (let i = 0; i < rows.length; i++) {
      const key = String(rows[i][0] || '').trim();
      const link = rows[i][1];
      if (key && key === k) return link ? String(link).trim() : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function handleStoreReplyStatus(replyText, authClient, sheetReader) {
  if (!STORE_INFO_SS_ID) {
    await replyText('系統尚未設定訊息一覽表（請設定 LINE_STORE_SS_ID 或 INTEGRATED_SHEET_SS_ID）。');
    return true;
  }
  let stores;
  let msgs;
  try {
    stores = await sheetReader(authClient, STORE_INFO_SS_ID, "'店家基本資料'!A:L");
    msgs = await sheetReader(authClient, STORE_INFO_SS_ID, "'訊息一覽'!A:F");
  } catch (e) {
    console.error('[handleStoreReplyStatus] sheet read error:', e.message);
    await replyText('讀取訊息一覽表失敗，請確認試算表已共用給此服務的帳號，或聯繫管理員。');
    return true;
  }
  const direct = [];
  for (let i = 1; i < stores.length; i++) {
    const row = stores[i];
    const isDirect = row[7] === true || String(row[7]).toUpperCase() === 'TRUE';
    if (!isDirect) continue;
    const name = String(row[1] || '').trim();
    if (!name) continue;
    let total = 0;
    let unreplied = 0;
    for (let j = 1; j < msgs.length; j++) {
      const m = msgs[j];
      if (String(m[2] || '').trim() !== name) continue;
      total += 1;
      if (!String(m[5] || '').trim()) unreplied += 1;
    }
    const rateVal = total > 0 ? (total - unreplied) / total : null;
    direct.push({ name, total, unreplied, rateVal });
  }
  if (!direct.length) {
    await replyText('目前無直營店資料或 H 欄皆為 false');
    return true;
  }
  direct.sort((a, b) => b.unreplied - a.unreplied);
  let totalUnreplied = 0;
  let rateSum = 0;
  let rateCount = 0;
  const lines = ['【店家回覆狀態】'];
  for (const s of direct) {
    totalUnreplied += s.unreplied;
    if (s.rateVal != null) {
      rateSum += s.rateVal * 100;
      rateCount += 1;
    }
    lines.push(`${s.name}：未回覆 ${s.unreplied} 則 | 完成率 ${formatDirectStoreCompletionRate(s.rateVal)}`);
  }
  lines.push(
    rateCount > 0
      ? `直營店總未回覆：${totalUnreplied} 則 | 平均完成率：${(rateSum / rateCount).toFixed(1)}%`
      : `直營店總未回覆：${totalUnreplied} 則`,
  );
  lines.push('https://drive.google.com/drive/folders/14j3NL2pt9ISy66jN6TX2BxnaAquQZTKh?usp=drive_link');
  await replyText(lines.join('\n'));
  return true;
}

/**
 * 解析補打卡「補登時間」字串，一律以台北時間、今年度為準。
 * - 若未含四位數年份，自動帶入今年（台北）。
 * - 支援「下午/上午」：從整段補登時間文字取出時間部分並換算 24 小時。
 * @returns {Date|null} 台北時間的 Date，解析失敗回 null
 */
function parseMakeUpTimeTaipei(inputTimeStr) {
  const now = new Date();
  const taipeiYear = parseInt(now.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).split('-')[0], 10);
  let s = String(inputTimeStr || '').trim();
  // 支援「下午」「上午」：先抽出數字與分隔符，再處理 12 小時制
  const hasPM = /下午|pm|PM/.test(s);
  const hasAM = /上午|am|AM/.test(s);
  s = s.replace(/\s*上午\s*/gi, ' ').replace(/\s*下午\s*/gi, ' ');
  s = s.replace(/\//g, '-');
  // 若開頭不是四位數年份，補今年
  if (!/^\d{4}-\d/.test(s) && !/^\d{4}\s/.test(s)) {
    const m = s.match(/^(\d{1,2})-(\d{1,2})(\s|$)/);
    if (m) s = `${taipeiYear}-${m[1]}-${m[2]}${s.slice(m[0].length)}`;
    else s = `${taipeiYear}-${s}`;
  }
  // 時間部分：HH:mm 或 H:mm，下午則 +12
  const timePart = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/);
  if (timePart && (hasPM || hasAM)) {
    let hour = parseInt(timePart[1], 10);
    if (hasPM && hour < 12) hour += 12;
    if (hasAM && hour === 12) hour = 0;
    const min = timePart[2];
    const sec = timePart[3] || '00';
    const datePart = s.replace(/\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/, '').trim();
    s = `${datePart} ${String(hour).padStart(2, '0')}:${min}:${sec}`;
  }
  if (!/^\d{4}-\d{1,2}-\d{1,2}(\s+\d|$)/.test(s)) {
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) s = s + ' 00:00:00';
    else if (!s.match(/\d{1,2}:\d{2}/)) s = s.trim() + ' 00:00:00';
  }
  // 組成 ISO 台北時間：YYYY-MM-DDTHH:mm:ss+08:00
  if (!s.includes('+') && !s.includes('Z')) {
    const spaceTime = s.match(/^(\d{4}-\d{1,2}-\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (spaceTime) {
      const [, datePart, h, m, sec = '00'] = spaceTime;
      s = `${datePart}T${h.padStart(2, '0')}:${m}:${sec.padStart(2, '0')}+08:00`;
    } else if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
      s = s + 'T00:00:00+08:00';
    }
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 補打卡：與 GAS makeUpTime 對齊，只回範本或解析後寫入員工打卡紀錄；補登時間僅接受今年度（台北）。 */
async function handleMakeUpTime(authClient, authResult, userId, text, replyText, sheetReader) {
  if (!authResult.isAuthorized) {
    await replyText('您尚未註冊或無權限，無法使用補打卡功能。');
    return true;
  }
  const timeRegex = /補登時間[:：]\s*([\d\/\-\s:上午下午]+)/;
  const typeRegex = /輸入上\/下班[:：]\s*(.+)/;
  if (!text.includes('補登時間') && !text.includes('輸入上/下班')) {
    const defaultStore = (authResult.workStores && authResult.workStores[0]) ? authResult.workStores[0] : '請輸入店家';
    const nowStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\//g, '/');
    const template =
      '請「複製」以下內容，修改後傳送給機器人：\n\n' +
      '補打卡申請\n' +
      `店家：${defaultStore}\n` +
      `補登時間：${nowStr}\n` +
      '輸入上/下班：上班打卡';
    await replyText(template);
    return true;
  }
  const timeMatch = text.match(timeRegex);
  const typeMatch = text.match(typeRegex);
  if (!timeMatch || !typeMatch) {
    await replyText('❌ 格式錯誤！無法讀取時間或類型。\n請確保您保留了「補登時間：」與「輸入上/下班：」的標題。');
    return true;
  }
  let inputType = String(typeMatch[1]).trim();
  if (inputType.includes('上')) inputType = '上班打卡';
  else if (inputType.includes('下')) inputType = '下班打卡';
  else {
    await replyText('❌ 類型錯誤：請填寫「上班」或「下班」。');
    return true;
  }
  const makeUpDate = parseMakeUpTimeTaipei(String(timeMatch[1]).trim());
  if (!makeUpDate) {
    await replyText('❌ 時間格式錯誤！\n範例：2025/02/01 09:00 或 2/15 下午 9:00（僅限今年度）');
    return true;
  }
  const taipeiYearNow = parseInt(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).split('-')[0], 10);
  const makeUpYear = parseInt(makeUpDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).split('-')[0], 10);
  if (makeUpYear !== taipeiYearNow) {
    await replyText(`❌ 補打卡僅限今年度（西元 ${taipeiYearNow} 年），請修改補登時間。`);
    return true;
  }
  let storeName = (authResult.workStores && authResult.workStores[0]) || '未知店家';
  const storeMatch = text.match(/店家[:：]\s*(.+)/);
  if (storeMatch && String(storeMatch[1]).trim() !== '') storeName = String(storeMatch[1]).trim();
  const makeUpDateStr = makeUpDate.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 19);
  try {
    await appendSheet(authClient, LINE_STAFF_SS_ID, '員工打卡紀錄', [
      userId,
      makeUpDateStr,
      inputType,
      storeName,
      '',
      '',
      '📝補打卡',
    ]);
  } catch (e) {
    await replyText('系統錯誤：找不到打卡紀錄表，請聯繫管理員。');
    return true;
  }
  const displayTime = makeUpDate.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  await replyText(`✅ 補打卡成功！\n\n已為您補登：\n📅 ${displayTime}\n📍 ${inputType}\n(系統已標記為補打卡)`);
  return true;
}

/**
 * 將明日預約 API 資料轉成與圖示一致的文案（共 X店、Y人、明天預約人數 : N、姓名 (HH:mm) - 電話）。
 * @param {Object} data - { dateStr, byStore: [ { storeId, storeName, items, availableSlotsText } ] }
 * @param {Map<string, string>} [storeNameMap] - 店碼→店名（店家基本資料），有則顯示店名
 * @returns {{ lines: string[], phonesForQuickReply: Array<{ phone: string, label: string }> }}
 */
function buildTomorrowListFlexMessage(data, storeNameMap = new Map(), recipientUserId = '') {
  const stores = Array.isArray(data?.byStore) ? data.byStore : [];
  const customerInfoBase = String(CUSTOMER_INFO_PAGE_URL || '').trim() || 'https://www.paopaomao.tw/customer-info';

  const customerInfoUri = (item) => {
    const token = String(item?.token || '').trim();
    if (!token) return '';
    let uri = `${customerInfoBase}${customerInfoBase.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
    if (recipientUserId) uri += `&userId=${encodeURIComponent(String(recipientUserId))}`;
    return uri;
  };

  const normalizePhoneDisplay = (phone) => {
    if (!phone) return '—';
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length === 9 && digits[0] === '9') return `0${digits}`;
    if (digits.length >= 10) return digits.slice(-10);
    return digits || '—';
  };

  let totalStores = 0;
  let totalGuests = 0;
  for (const s of stores) {
    const n = (Array.isArray(s.items) ? s.items : []).length;
    if (n > 0) {
      totalStores += 1;
      totalGuests += n;
    }
  }

  const dateStr = String(data?.dateStr || '').trim();
  const bodyContents = [];
  const storeLimit = 8;
  const guestLimit = 10;

  for (const s of stores.slice(0, storeLimit)) {
    const items = Array.isArray(s.items) ? s.items : [];
    const slotsText = String(s.availableSlotsText || '').trim();
    const hasValidSlots = slotsText && slotsText !== '—' && slotsText !== '0 個空位' && slotsText.indexOf('還有') >= 0;

    const headerContents = [
      { type: 'text', text: `【${getStoreDisplayName(storeNameMap, s.storeId, s.storeName)}】`, weight: 'bold', size: 'sm' },
      { type: 'text', text: `明天預約人數：${items.length}`, size: 'xs' },
    ];
    if (hasValidSlots) {
      headerContents.splice(1, 0, { type: 'text', text: `明日可預約空位：${slotsText}`, size: 'xs', color: '#666666', wrap: true });
    }

    const storeBlockContents = [
      { type: 'box', layout: 'vertical', spacing: 'none', contents: headerContents },
    ];

    if (!items.length) {
      storeBlockContents.push({
        type: 'box',
        layout: 'vertical',
        margin: 'none',
        spacing: 'none',
        contents: [{ type: 'text', text: '（無預約）', size: 'xxs', color: '#999999' }],
      });
    } else {
      for (let chunkStart = 0; chunkStart < items.length; chunkStart += guestLimit) {
        const chunk = items.slice(chunkStart, chunkStart + guestLimit);
        const guestListContents = [];
        for (const o of chunk) {
          let timeText = String(o?.timeText || '').trim().slice(0, 5);
          if (!timeText) {
            let raw = String(o?.rsvtim || '').trim();
            if (raw.includes('T') || raw.includes(' ')) raw = (raw.split(/[T\s]/)[1] || '').slice(0, 5);
            timeText = raw || '';
          }
          const name = String(o?.name || '—').trim();
          const phone = String(o?.phone || '').trim();
          const displayPhone = normalizePhoneDisplay(phone);
          const uri = customerInfoUri(o);
          const mainText = timeText ? `${name}（${timeText}）` : name;

          if (uri) {
            guestListContents.push({
              type: 'box',
              layout: 'horizontal',
              margin: 'none',
              contents: [
                { type: 'text', text: mainText, size: 'xxs', wrap: true },
                {
                  type: 'box',
                  layout: 'vertical',
                  action: { type: 'uri', uri },
                  contents: [{ type: 'text', text: displayPhone, size: 'xxs', color: '#0066cc' }],
                },
              ],
            });
          } else {
            guestListContents.push({ type: 'text', text: `${mainText} ${displayPhone}`.trim(), size: 'xxs', wrap: true, margin: 'none' });
          }
        }
        storeBlockContents.push({
          type: 'box',
          layout: 'vertical',
          margin: 'none',
          spacing: 'none',
          contents: guestListContents.length ? guestListContents : [{ type: 'text', text: '（無預約）', size: 'xxs', color: '#999999' }],
        });
      }
    }

    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      margin: 'sm',
      spacing: 'none',
      contents: storeBlockContents,
    });
  }

  const bubble = {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: `📅 明日預約 ${dateStr} 共 ${totalStores} 店、${totalGuests} 人`, weight: 'bold', size: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      margin: 'none',
      spacing: 'xs',
      contents: bodyContents.length ? bodyContents : [{ type: 'text', text: '無預約資料', size: 'xs', color: '#999999' }],
    },
  };

  return {
    type: 'flex',
    altText: `明日預約 ${dateStr} 共 ${totalStores} 店、${totalGuests} 人`,
    contents: bubble,
  };
}

async function handleTomorrowList(text, authClient, authResult, replyText, replyMessages, fetcher, sheetReader, recipientUserId = '') {
  if (!(text === '明天預約清單' || text === '明日預約清單')) return false;
  const ids = splitStoreIds(authResult.identity.includes('manager') ? authResult.managedStores : authResult.workStores);
  if (!ids.length) {
    await replyText('無法判斷您所屬的門市，請管理者補上店家代碼。');
    return true;
  }

  // 店碼→店名（顯示用）：讀取店家基本資料，有則顯示店名（例：總公司、竹北光明）
  let storeNameMap = new Map();
  if (sheetReader && STORE_INFO_SS_ID) {
    try {
      storeNameMap = await readStoreNameMap(authClient, sheetReader);
    } catch (_) {}
  }

  let data = null;
  try {
    data = await getTomorrowReservationList(authClient, ids);
  } catch {
    data = null;
  }
  if (!data) {
    await replyText('取得明日預約清單失敗（GCP 尚未取得必要權限/設定），請稍後再試。');
    return true;
  }
  if (data.closed === true) {
    await replyText(data.message || '明日預約報告當日已關閉。');
    return true;
  }
  const stores = Array.isArray(data.byStore) ? data.byStore : [];
  if (!stores.length) {
    await replyText(`📅 明日（${data.dateStr || ''}）您負責的店家目前無預約。`);
    return true;
  }
  const flex = buildTomorrowListFlexMessage(data, storeNameMap, recipientUserId);
  await replyMessages([flex]);
  return true;
}

export async function handleStaffCommand({
  authClient,
  text,
  event,
  replyText,
  replyMessages,
  sheetReader = readSheet,
  fetcher = fetch,
  authorizeFn = isUserAuthorized,
}) {
  const userId = event?.source?.userId || '';
  if (!userId || !text) return false;

  // 與 handleAttendanceCommand 一致：關鍵字正規化（去 BOM、零寬、空白）以便正確路由
  const textNorm = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .replace(/\s/g, '');

  const authResult = await authorizeFn(authClient, LINE_STAFF_SS_ID, userId);
  if (!authResult.isAuthorized) {
    if (authResult.sheetError) {
      await replyText('⚠️ 系統暫時無法驗證權限，請稍後再試。若持續出現請通知泡泡貓負責顧問。');
    } else {
      await replyText('⚠️ 你的帳號尚未開通，麻煩通知泡泡貓負責顧問！');
    }
    return true;
  }

  // 0. 固定回覆：服務費說明
  if (text.includes('服務費包含哪些')) {
    await replyText(
      '您好：\n' +
      '關於服務費涵蓋的具體範圍，雙方簽署的合約上有完整的記載，再麻煩您撥冗翻閱。\n\n' +
      '先向您說明，總公司服務費用固定於每月 10 號扣款，目前的計費基準為：四床新台幣 8,000 元整（若後續有新增床位，則每張床位加收 2,000 元整）。\n\n' +
      '這筆常規服務費所包含的合約項目，條列如下：\n' +
      '✅ 教育訓練：Odoo 系統教學與訓練\n' +
      '✅ 營業內容：開發新品、新活動規劃\n' +
      '✅ 管理支援：採購及商品管理\n' +
      '✅ 授權維護：授權標的物之使用與維護\n\n' +
      '至於您目前正在使用的其他資源，其實並不包含在上述的常規服務費中，是我們考量雙方的合作關係，額外無償提供給貴公司的支援，包含：\n' +
      '🔹 104 徵才服務\n' +
      '🔹 神美系統\n' +
      '🔹 跑活動的相關贈品\n' +
      '🔹 顧問問答協助\n' +
      '🔹 總部文件提供\n\n' +
      '希望以上的條列說明，能幫助您更清楚我們提供的服務範疇。若您後續對於合約內的項目仍有不清楚的地方，我們也可以安排個時間簡單對焦，謝謝您。'
    );
    return true;
  }

  // GAS 順序：1. 我要了解客人（先於 switch）
  if (text.indexOf('我要了解客人') === 0 || text.includes('我要了解客人')) {
    const phone = extractPhoneFromCustomerKeyword(text);
    if (!phone) {
      await replyText('請輸入「我要了解客人」後面接手機號碼，例如：我要了解客人0925810424');
      return true;
    }
    const r = await callCoreApiPost('getCustomerAIResult', { phone }, fetcher);
    if (!r || r.status !== 'ok') {
      let msg = !r && (!PAO_CAT_CORE_API_URL || !PAO_CAT_SECRET_KEY)
        ? 'Core API 未設定，請聯繫管理員。'
        : (r && r.message) || '查詢時發生錯誤，請稍後再試。' + (phone.length === 9 ? ' 若為 10 碼手機請補齊再試。' : '');
      if (msg.includes('查無此客人')) {
        msg += '\n\n若該客人出現在「明日預約清單」，可點擊清單中的手機連結，系統會先產出資料後再顯示。';
      }
      await replyText(msg);
      return true;
    }
    await replyText(`【客人 ${phone} AI分析結果】\n\n${String(r.content || '該客人尚無 AI 分析結果。')}`);
    return true;
  }

  // 2. 完全匹配 switch（我要打卡在 server 已攔截）
  if (text === '查詢打卡記錄') {
    return handleAttendanceCommand({ authClient, authResult, text, userId, replyText, replyMessages, sheetReader });
  }
  if (text === '最新活動') {
    await replyText('📅 【最新活動資訊】\n\n請點擊下方連結查看所有活動檔案：\nhttps://drive.google.com/drive/folders/1Y2hoU5nhM2-lJxHbm0KwfBPznFDQThmg?usp=drive_link');
    return true;
  }
  if (text === '我要開店') {
    await replyMessages([
      {
        type: 'text',
        text: '請點擊下方按鈕，傳送您的店面位置以進行開店設定：',
        quickReply: {
          items: [{ type: 'action', action: { type: 'location', label: '📍 傳送店面位置' } }],
        },
      },
    ]);
    return true;
  }
  if (text === '特約商店') {
    await replyText('📅 【線上課程】\n\n請點擊下方連結查看所有課程：\nhttps://www.paopaomao.tw/slides');
    return true;
  }

  // 3. 出勤六關鍵字（完全匹配，sendAtt；用 textNorm 確保「店家 本月出勤」等能正確進入）
  if (ATT_KEYWORDS.has(textNorm)) {
    return handleAttendanceCommand({ authClient, authResult, text, userId, replyText, replyMessages, sheetReader });
  }

  // 4. 包含：補打卡、Line問題集
  if (text.includes('補打卡')) {
    return replyText('📢 補打卡功能已全面轉移至網頁版！\n\n請點擊連結登入系統進行補打卡：\nhttps://dashboard.paopaomao.tw/my#attendance\n\n登入後在「📋 出勤」分頁，點擊缺漏的 - 即可補打卡。');
  }
  if (text.includes('Line問題集')) {
    return handleLineQuestion(replyText, authClient, sheetReader);
  }

  // 5. 完全匹配：神美日報
  if (text.trim() === '神美日報') {
    const isManager = authResult.identity.includes('manager');
    const storeIds = splitStoreIds(isManager ? authResult.managedStores : authResult.workStores);
    if (!storeIds.length) {
      await replyText('無法判斷您所屬的門市，請管理者補上店家代碼。');
      return true;
    }
    const groupId = (event?.source?.groupId && String(event.source.groupId).trim()) || '';
    let groupName = '';
    if (groupId) groupName = await getLineGroupName(groupId, fetcher);
    const r = await callCoreApiPost(
      'createReportToken',
      {
        role: isManager ? 'manager' : 'employee',
        storeIds: storeIds.join(','),
        userId,
        employeeCode: authResult.employeeCode || '',
        groupId,
        groupName,
        employeeName: authResult.employeeName || authResult.displayName || '',
        userName: authResult.userName || authResult.displayName || '',
      },
      fetcher,
    );
    if (!r || r.status !== 'ok' || !r.token) {
      const msg = !r && (!PAO_CAT_CORE_API_URL || !PAO_CAT_SECRET_KEY)
        ? 'Core API 未設定，請聯繫管理員。'
        : (r && r.message) || '神美日報產出失敗，請稍後再試。';
      await replyText(msg);
      return true;
    }
    let uri = `${REPORT_PAGE_URL}${REPORT_PAGE_URL.includes('?') ? '&' : '?'}token=${encodeURIComponent(r.token)}`;
    if (REPORT_API_BASE) {
      uri += `${uri.includes('?') ? '&' : '?'}api_base=${encodeURIComponent(REPORT_API_BASE)}`;
    }
    await replyMessages([
      {
        type: 'template',
        altText: '神美日報：請點擊按鈕開啟日報（此連結僅可使用一次）',
        template: {
          type: 'buttons',
          text: '神美日報\n請點擊下方按鈕開啟日報\n（此連結僅可使用一次）',
          actions: [{ type: 'uri', label: '開啟日報', uri }],
        },
      },
    ]);
    return true;
  }

  // 6. 完全匹配：明日預約（四字）
  if (text.trim() === '明日預約') {
    await replyText('此功能暫時關閉，敬請見諒。');
    return true;
  }

  // 7. 完全匹配：明天預約清單 / 明日預約清單
  if (await handleTomorrowList(text, authClient, authResult, replyText, replyMessages, fetcher, sheetReader, userId)) {
    return true;
  }

  // 8. 上月小費 — 導向 Dashboard 個人頁面 + Excel 下載（不再產 Google Sheet）
  if (text.trim() === '上月小費' || text.indexOf('上月小費') >= 0) {
    try {
      const now = new Date();
      const lastM = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const ym = `${lastM.getFullYear()}-${String(lastM.getMonth() + 1).padStart(2, '0')}`;
      const dashboardUrl = 'https://dashboard.paopaomao.tw/my#tips';
      const downloadUrl = `https://dashboard.paopaomao.tw/api/tips/my/excel?month=${ym}`;
      await replyText(`✅ 上月小費（${ym}）\n\n📊 線上查看：\n${dashboardUrl}\n\n📥 下載 Excel：\n${downloadUrl}\n\n💡 需先用 LINE 登入儀表板`);
    } catch (e) {
      console.error('[上月小費] error:', e.message);
      await replyText(`上月小費報告失敗：${e.message}`);
    }
    return true;
  }

  // 9. 包含：店家回覆狀態（僅 manager）
  if (text.includes('店家回覆狀態')) {
    if (!authResult.identity.includes('manager')) {
      await replyText('此功能僅限管理者使用。');
      return true;
    }
    return handleStoreReplyStatus(replyText, authClient, sheetReader);
  }

  // 10. 報告關鍵字：GAS 有 Core.getReportHandlerFromKeyword，GCP 選用未實作

  // 11. 公司流程
  const workflowLink = await getWorkflowLink(authClient, text, sheetReader);
  if (workflowLink) {
    await replyText(`請點擊:\n${workflowLink}`);
    return true;
  }

  return false;
}

export const __testables__ = {
  extractPhoneFromCustomerKeyword,
  formatDirectStoreCompletionRate,
  splitStoreIds,
  buildAttendanceMessage,
  buildTomorrowListFlexMessage,
};
