import crypto from 'crypto';
import fetch from 'node-fetch';
import { google } from 'googleapis';
import { readSheet } from '../lib/sheets.js';
import { getDirectStoreReplyStatusText } from '../lib/store-reply-status.js';
import { getBearerToken } from '../lib/saydou.js';
import { safeJsonParse, sendJson, sendRedirect, sendText } from './http-utils.js';

const CORE_KEY = (process.env.PAO_CAT_SECRET_KEY || '').trim();
const LINE_STORE_SS_ID = (process.env.LINE_STORE_SS_ID || '').trim();
const EXTERNAL_SS_ID = (process.env.EXTERNAL_SS_ID || '').trim(); // 請款單＿店家基本資訊表（若有）

const ODOO_URL = (process.env.ODOO_URL || '').trim();
const ODOO_DB = (process.env.ODOO_DB || '').trim();
const ODOO_USERNAME = (process.env.ODOO_USERNAME || '').trim();
const ODOO_PASSWORD = (process.env.ODOO_PASSWORD || '').trim();

const GIVEME_PROXY_URL = (process.env.GIVEME_PROXY_URL || '').trim(); // 選填，不設則直連 Giveme（需 Cloud Run 固定出口 IP 並填 Giveme 白名單）
const GIVEME_B2C_URL = 'https://www.giveme.com.tw/invoice.do?action=addB2C';
const GIVEME_UNCODE = (process.env.GIVEME_UNCODE || '').trim();
const GIVEME_IDNO = (process.env.GIVEME_IDNO || '').trim();
const GIVEME_PASSWORD = (process.env.GIVEME_PASSWORD || '').trim();

const NEAR_REDIRECT_URL = (process.env.NEAR_REDIRECT_URL || 'https://www.paopaomao.tw/near').trim();
const LEGACY_GAS_CORE_API_URL = (process.env.LEGACY_GAS_CORE_API_URL || process.env.PAO_CAT_CORE_API_URL || '').trim();

// In-memory cache (best-effort): Cloud Run may scale, so treat as optimization only.
let cachedStoreMap = { value: null, expiresAt: 0 };
let cachedBaseData = { value: null, expiresAt: 0, tokenPrefix: '' };
const reportTokenCache = new Map(); // token -> { payload, expiresAt }

function unauthorized(res) {
  sendJson(res, 401, { status: 'error', message: 'unauthorized' });
}

function requireKey(params, res) {
  const key = (params.get('key') || '').trim();
  if (!CORE_KEY || key !== CORE_KEY) {
    unauthorized(res);
    return false;
  }
  return true;
}

function md5Upper(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex').toUpperCase();
}

function normalizePhone9(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 9 && digits[0] === '9') return `0${digits}`;
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

export async function getLineSayDouInfoMap(auth) {
  const now = Date.now();
  if (cachedStoreMap.value && cachedStoreMap.expiresAt > now) return cachedStoreMap.value;
  if (!LINE_STORE_SS_ID) return {};
  const rows = await readSheet(auth, LINE_STORE_SS_ID, "'店家基本資料'!A:I");
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = String(row[1] || '').trim();
    const channelId = String(row[2] || '').trim();
    const channelSecret = String(row[3] || '').trim();
    const destinationId = String(row[4] || '').trim();
    const saydouId = String(row[5] || '').trim();
    const lineLink = String(row[6] || '').trim();
    const isDirect = row[7] === true || String(row[7]).toUpperCase() === 'TRUE';
    if (!saydouId) continue;
    map[saydouId] = { id: saydouId, name, channelId, channelSecret, destinationId, saydouId, lineLink, isDirect };
  }
  cachedStoreMap = { value: map, expiresAt: now + 6 * 60 * 60 * 1000 };
  return map;
}

async function saydouFetchJson(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  const json = safeJsonParse(text);
  if (!res.ok) {
    throw new Error(`SayDou HTTP ${res.status}: ${(text || '').slice(0, 120)}`);
  }
  return json;
}

/** @param {{ skipCache?: boolean }} opts - skipCache: true 時略過快取（線上預約查空位用，避免 6 小時舊資料導致誤判「都滿了」） */
async function fetchBaseData(auth, token, opts = {}) {
  const prefix = String(token || '').slice(0, 24);
  const now = Date.now();
  if (!opts.skipCache && cachedBaseData.value && cachedBaseData.expiresAt > now && cachedBaseData.tokenPrefix === prefix)
    return cachedBaseData.value;
  const url =
    'https://saywebdatafeed.saydou.com/api/management/baseData?kind%5B%5D=stores&kind%5B%5D=positions&kind%5B%5D=staffs';
  const json = await saydouFetchJson(url, token, { method: 'GET' });
  if (!opts.skipCache) cachedBaseData = { value: json, expiresAt: now + 6 * 60 * 60 * 1000, tokenPrefix: prefix };
  return json;
}

function isCounterStaffName(cod, nam) {
  return String(cod || '').includes('櫃檯') || String(nam || '').includes('櫃檯');
}

function hhmmToMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map((x) => Number.parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}

function isoToMinutes(iso) {
  // Accept ISO "yyyy-MM-ddTHH:mm:ss" and "yyyy-MM-dd HH:mm:ss"; take HH:mm only.
  // Prefer time part: API endtim often has space ("2026-02-21 13:00:00"); plain (\d{2}):(\d{2}) would match date "02:21" first.
  const s = String(iso || '').trim();
  let m = s.match(/T(\d{2}):(\d{2})/);
  if (m) return Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10);
  m = s.match(/\s(\d{2}):(\d{2})/);
  if (m) return Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10);
  m = s.match(/(\d{2}):(\d{2})/);
  if (!m) return 0;
  return Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10);
}

function addDays(date, d) {
  const x = new Date(date.getTime());
  x.setDate(x.getDate() + d);
  return x;
}

/** 與 GAS getSmartSlots 一致：依服務時長間隔取精選時段，單日最多 limit 個，避免密集列表。 */
function getSmartSlots(slots, durationMin, limit = 5) {
  if (!Array.isArray(slots) || slots.length === 0) return [];
  const result = [];
  let nextAvailableMin = -1;
  for (const timeStr of slots) {
    if (result.length >= limit) break;
    const currentMin = hhmmToMinutes(timeStr);
    if (nextAvailableMin === -1 || currentMin >= nextAvailableMin) {
      result.push(timeStr);
      nextAvailableMin = currentMin + durationMin;
    }
  }
  return result;
}

function formatYmdTz(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** 從 YYYY-MM-DD 取得星期幾（0=日…6=六），與伺服器時區無關。 */
function dayOfWeekFromYmd(dateStr) {
  const [y, m, d] = String(dateStr || '').split('-').map((n) => parseInt(n, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return 0;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

async function fetchReservationsAndDutyoffs(auth, sayId, startDate, endDate, token) {
  const base =
    'https://saywebdatafeed.saydou.com/api/management/calendar/events/full' +
    `?startDate=${encodeURIComponent(startDate)}` +
    `&endDate=${encodeURIComponent(endDate)}` +
    `&storid=${encodeURIComponent(sayId)}` +
    '&status%5B%5D=reservation&status%5B%5D=hasshow&status%5B%5D=confirm&status%5B%5D=checkout&holiday=1';
  const json = await saydouFetchJson(base, token, { method: 'GET' });
  const reservations =
    (Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : Array.isArray(json?.reservation) ? json.reservation : json?.data?.reservation) || [];
  const dutyoffs = (Array.isArray(json?.dutyoffs) ? json.dutyoffs : Array.isArray(json?.data?.dutyoffs) ? json.data.dutyoffs : []) || [];
  return { reservations, dutyoffs };
}

/** 與 GAS getStoreCapacityIds 一致：baseData.staffs 可能為 [ { role1: [staff,...], role2: [staff,...] } ]，需遍歷各 category；並支援 msstor/storid 比對。 */
function buildValidStaffSet(baseData, sayId) {
  const valid = new Set();
  const sayIdStr = String(sayId);
  const rawStaffs = baseData?.staffs;
  const first = rawStaffs?.[0];
  const staffList = [];
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    for (const key of Object.keys(first)) {
      const arr = first[key];
      if (Array.isArray(arr)) staffList.push(...arr);
    }
  } else if (Array.isArray(first)) {
    staffList.push(...first);
  } else if (Array.isArray(rawStaffs)) {
    staffList.push(...rawStaffs);
  }
  for (const s of staffList) {
    const storeMatch = (s?.msstor != null && String(s.msstor) === sayIdStr) || (s?.storid != null && String(s.storid) === sayIdStr);
    if (!storeMatch) continue;
    if (isCounterStaffName(s?.usrcod, s?.usrnam)) continue;
    const id = Number(s?.usrsid || 0);
    if (id > 0) valid.add(id);
  }
  return valid;
}

/** 與 GAS 一致：將預約/排休中出現的該店非櫃檯 usrsid 納入人力池（海每刻01/02 等若 baseData 未列仍算可預約人力）。 */
function augmentValidStaffSetFromEvents(validStaffSet, reservations, dutyoffs, sayId) {
  const sayIdStr = String(sayId);
  const add = (id) => { if (id != null && Number(id) > 0) validStaffSet.add(Number(id)); };
  for (const r of reservations || []) {
    if (r?.storid == null || String(r.storid) !== sayIdStr || !r?.usrsid) continue;
    const staffObj = r?.usrs || r;
    if (isCounterStaffName(staffObj?.usrcod, staffObj?.usrnam)) continue;
    add(r.usrsid);
  }
  for (const d of dutyoffs || []) {
    if (d?.storid == null || String(d.storid) !== sayIdStr || !d?.usrsid) continue;
    if (isCounterStaffName('', d?.usrnam)) continue;
    add(d.usrsid);
  }
}

export async function findAvailableSlotsAction(auth, params) {
  const sayId = String(params.sayId || '').trim();
  const startDate = String(params.startDate || '').trim();
  const endDate = String(params.endDate || '').trim();
  if (!sayId || !startDate || !endDate) throw new Error('缺少 sayId, startDate 或 endDate');
  const needPeople = params.needPeople != null && String(params.needPeople) !== '' ? Number(params.needPeople) : 1;
  const durationMin = params.durationMin != null && String(params.durationMin) !== '' ? Number(params.durationMin) : 90;
  const timeStart = String(params.timeStart || '11:00');
  const timeEnd = String(params.timeEnd || '21:00');

  const token = String(params.token || '') || (await getBearerToken(auth));
  const baseData = await fetchBaseData(auth, token, { skipCache: true });
  const validStaffSet = buildValidStaffSet(baseData, sayId);
  const { reservations, dutyoffs } = await fetchReservationsAndDutyoffs(auth, sayId, startDate, endDate, token);
  augmentValidStaffSetFromEvents(validStaffSet, reservations, dutyoffs, sayId);

  const weekDays = (() => {
    if (!params.weekDays) return [0, 1, 2, 3, 4, 5, 6];
    if (Array.isArray(params.weekDays)) return params.weekDays.map((n) => Number(n));
    const parsed = safeJsonParse(String(params.weekDays));
    return Array.isArray(parsed) ? parsed.map((n) => Number(n)) : [0, 1, 2, 3, 4, 5, 6];
  })();

  // 以台灣時區解讀日期，避免 Cloud Run (UTC) 等環境造成「今天」或星期錯一天
  const start = new Date(`${startDate}T00:00:00+08:00`);
  const end = new Date(`${endDate}T00:00:00+08:00`);
  const openMin = hhmmToMinutes(timeStart);
  const closeMin = hhmmToMinutes(timeEnd);
  const lastStartMin = closeMin - durationMin;

  const byDateReservations = {};
  const byDateDutyoffs = {};
  for (const r of reservations) {
    const d = String(r?.rsvtim || '').slice(0, 10);
    if (!d) continue;
    (byDateReservations[d] ||= []).push(r);
  }
  for (const d of dutyoffs) {
    const ds = String(d?.startm || '').slice(0, 10);
    if (!ds) continue;
    (byDateDutyoffs[ds] ||= []).push(d);
  }

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const data = [];
  for (let cur = new Date(start.getTime()); cur.getTime() <= end.getTime(); cur = new Date(cur.getTime() + ONE_DAY_MS)) {
    const dateStr = formatYmdTz(cur);
    const dayOfWeek = dayOfWeekFromYmd(dateStr);
    if (!weekDays.includes(dayOfWeek)) continue;
    const dayRes = byDateReservations[dateStr] || [];
    const dayOff = byDateDutyoffs[dateStr] || [];
    const times = [];
    for (let t = openMin; t <= lastStartMin; t += 30) {
      const checkStart = t;
      const checkEnd = t + durationMin;
      const busy = new Set();

      for (const r of dayRes) {
        const ru = Number(r?.usrsid || 0);
        if (validStaffSet.size && ru > 0 && !validStaffSet.has(ru)) continue;
        const rStart = isoToMinutes(r?.rsvtim);
        const rEnd = isoToMinutes(r?.endtim);
        if (rEnd > checkStart && rStart < checkEnd) {
          if (ru > 0) busy.add(ru);
        }
      }
      for (const o of dayOff) {
        if (isCounterStaffName('', o?.usrnam)) continue;
        const du = Number(o?.usrsid || 0);
        if (validStaffSet.size && du > 0 && !validStaffSet.has(du)) continue;
        const oStart = isoToMinutes(o?.startm);
        const oEnd = isoToMinutes(o?.endtim);
        if (oEnd > checkStart && oStart < checkEnd) {
          if (du > 0) busy.add(du);
        }
      }

      let available = 0;
      if (validStaffSet.size) {
        for (const id of validStaffSet) {
          if (!busy.has(id)) available += 1;
        }
      } else {
        // fallback capacity when baseData unavailable
        available = 4 - busy.size;
      }
      if (available >= needPeople) {
        const hh = String(Math.floor(checkStart / 60)).padStart(2, '0');
        const mm = String(checkStart % 60).padStart(2, '0');
        times.push(`${hh}:${mm}`);
      }
    }
    if (times.length) {
      const smartTimes = getSmartSlots(times, durationMin, 5);
      data.push({ date: dateStr, week: ['日', '一', '二', '三', '四', '五', '六'][dayOfWeek], times: smartTimes });
    }
  }
  return { status: true, data, totalStaff: validStaffSet.size || 4, validStaffSet: Array.from(validStaffSet) };
}

async function getUserDisplayNameAction(params) {
  const userId = String(params.userId || '').trim();
  const token = String(params.token || '').trim();
  const groupId = String(params.groupId || '').trim();
  const roomId = String(params.roomId || '').trim();
  if (!userId || !token) throw new Error('缺少 userId 或 token');
  let url = `https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`;
  if (groupId) url = `https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`;
  if (roomId) url = `https://api.line.me/v2/bot/room/${encodeURIComponent(roomId)}/member/${encodeURIComponent(userId)}`;
  try {
    const res = await fetch(url, { method: 'get', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    const json = safeJsonParse(text);
    const name = json?.displayName != null ? String(json.displayName).trim() : '';
    // Product requirement: return "" when missing
    return { status: 'ok', displayName: name || '' };
  } catch {
    return { status: 'ok', displayName: '' };
  }
}

async function getDirectStoreReplyStatusTextAction(auth) {
  return getDirectStoreReplyStatusText(auth, LINE_STORE_SS_ID);
}

async function executeRefundByPhoneAction(auth, phoneRaw) {
  const phone = String(phoneRaw || '').trim();
  const keyword = normalizePhone9(phone);
  if (!keyword) return { status: 'error', success: false, msg: '手機格式錯誤' };
  const token = await getBearerToken(auth);
  const memUrl =
    'https://saywebdatafeed.saydou.com/api/management/unearn/memberStorecash' +
    '?page=0&limit=20&sort=stcash&order=desc' +
    '&keyword=' +
    encodeURIComponent(keyword) +
    '&showGroup=0&tabIndex=0';
  const memJson = await saydouFetchJson(memUrl, token, { method: 'GET' });
  const member = memJson?.data?.items?.[0] || null;
  if (!member) return { status: 'error', success: false, msg: '找不到會員資料', phone };
  if (!member.stcash || Number(member.stcash) <= 0) return { status: 'error', success: false, msg: '儲值金為 0 或無儲值金', phone };

  const payload = { membid: member.membid, cdcode: member.cdcode };
  const refundUrl = 'https://saywebdatafeed.saydou.com/api/management/unearn/returnStorecash';
  const res = await fetch(refundUrl, {
    method: 'post',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  const json = safeJsonParse(text) || {};
  if (res.status === 200) return { status: 'ok', success: true, msg: '退費成功', data: json, amount: member.stcash };
  return { status: 'error', success: false, msg: 'API 錯誤', data: json };
}

function putReportToken(payload, ttlSec = 600) {
  const token = crypto.randomUUID().replace(/-/g, '');
  reportTokenCache.set(token, { payload, expiresAt: Date.now() + ttlSec * 1000 });
  return token;
}

async function callLegacyCore(action, params = {}, { method = 'get' } = {}) {
  if (!LEGACY_GAS_CORE_API_URL) throw new Error('LEGACY_GAS_CORE_API_URL 未設定');
  if (!CORE_KEY) throw new Error('PAO_CAT_SECRET_KEY 未設定');
  const url = new URL(LEGACY_GAS_CORE_API_URL);
  url.searchParams.set('key', CORE_KEY);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && String(v) !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { method, signal: AbortSignal.timeout(120000) });
  const text = await res.text();
  const json = safeJsonParse(text);
  if (json != null) return json;
  // Some legacy endpoints return plain text.
  return { status: res.ok ? 'ok' : 'error', text: text.slice(0, 5000) };
}

function consumeReportToken(token) {
  const key = String(token || '').trim();
  const x = reportTokenCache.get(key);
  if (!x) return null;
  reportTokenCache.delete(key);
  if (x.expiresAt < Date.now()) return null;
  return x.payload;
}

async function fetchReservationData(auth, startDate, endDate, storeId) {
  const token = await getBearerToken(auth);
  const url = 'https://saywebdatafeed.saydou.com/api/management/analytics/reservation';
  const payload = { timebase: 'reservation', start: startDate, end: endDate, 'store[]': [storeId] };
  const json = await saydouFetchJson(url, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return json?.source ?? [];
}

async function fetchTodayReservationData(auth, start, end, storeId) {
  const token = await getBearerToken(auth);
  const url = 'https://saywebdatafeed.saydou.com/api/management/analytics/reservation';
  const payload = { timebase: 'create', start, end, 'store[]': [storeId] };
  return saydouFetchJson(url, token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

async function oldNewA(auth, startDate, endDate, storeId) {
  const token = await getBearerToken(auth);
  const url =
    `https://saywebdatafeed.saydou.com/api/management/analytics/member/oldNewAnalyse/0/1?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}` +
    `&store%5B%5D=${encodeURIComponent(storeId)}&page=0&limit=100`;
  const json = await saydouFetchJson(url, token, { method: 'GET' });
  return json?.data?.ratio ?? [];
}

async function fetchDailyIncome(auth, dateStr, storeId) {
  const token = await getBearerToken(auth);
  const url = `https://saywebdatafeed.saydou.com/api/management/finance/dailyIncome?storid=${encodeURIComponent(storeId)}&date=${encodeURIComponent(dateStr)}&end_date=${encodeURIComponent(dateStr)}`;
  return saydouFetchJson(url, token, { method: 'GET' });
}

async function lineReply({ replyToken, text, token }) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: String(text || '') }] }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`LINE Reply failed: ${(body || res.status).toString().slice(0, 200)}`);
  return { ok: true };
}

async function getCustomerAIResult(auth, phone) {
  if (!LINE_STORE_SS_ID) return { status: 'error', message: 'Core 未設定 LINE_STORE_SS_ID' };
  const rows = await readSheet(auth, LINE_STORE_SS_ID, "'客人消費狀態'!A:K");
  if (!rows.length) return { status: 'error', message: `查無此客人（${phone}）。` };
  const header = rows[0] || [];
  let phoneCol = 1;
  let aiCol = 10;
  for (let c = 0; c < header.length; c++) {
    const h = String(header[c] || '').trim();
    if (h === '手機') phoneCol = c;
    if (h === 'AI分析結果') aiCol = c;
  }
  const needle = normalizePhone9(phone);
  for (let i = 1; i < rows.length; i++) {
    const rowPhone = rows[i][phoneCol];
    if (!rowPhone) continue;
    const rowNorm = normalizePhone9(rowPhone);
    if (rowNorm && rowNorm === needle) {
      const content = String(rows[i][aiCol] || '').trim() || '該客人尚無 AI 分析結果。';
      return { status: 'ok', phone, content };
    }
  }
  return { status: 'error', message: `查無此客人（${phone}）。請確認該手機是否已在「客人消費狀態」試算表。` };
}

async function getOdooInvoice(auth, id) {
  if (!ODOO_URL || !ODOO_DB || !ODOO_USERNAME || !ODOO_PASSWORD) {
    return { status: 'error', message: 'Odoo 設定未完成（ODOO_URL/DB/USERNAME/PASSWORD）' };
  }
  const url = `${ODOO_URL.replace(/\/$/, '')}/jsonrpc`;

  const authBody = {
    jsonrpc: '2.0',
    method: 'call',
    params: { service: 'common', method: 'authenticate', args: [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}] },
  };
  const authRes = await fetch(url, {
    method: 'post',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(authBody),
    signal: AbortSignal.timeout(20000),
  });
  const authJson = safeJsonParse(await authRes.text());
  const uid = authJson?.result;
  if (!uid) return { status: 'error', message: 'Odoo 登入失敗' };

  // Try product lines first
  const lineBody = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [ODOO_DB, uid, ODOO_PASSWORD, 'account.move.line', 'search_read', [[['move_id', '=', Number(id)], ['display_type', '=', 'product']]], { fields: ['name', 'quantity', 'price_subtotal'] }],
    },
  };
  const lineRes = await fetch(url, {
    method: 'post',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(lineBody),
    signal: AbortSignal.timeout(20000),
  });
  const lineJson = safeJsonParse(await lineRes.text());
  const lines = Array.isArray(lineJson?.result) ? lineJson.result : [];
  if (lines.length) {
    return {
      status: 'ok',
      data: lines.map((l) => ({
        name: l?.name ? String(l.name).split('\n')[0] : '無名稱',
        quantity: l?.quantity ?? 0,
        price_subtotal: l?.price_subtotal ?? 0,
      })),
    };
  }

  // fallback to header amount_total
  const hdrBody = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [ODOO_DB, uid, ODOO_PASSWORD, 'account.move', 'read', [Number(id)], ['name', 'ref', 'amount_total', 'payment_state']],
    },
  };
  const hdrRes = await fetch(url, {
    method: 'post',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(hdrBody),
    signal: AbortSignal.timeout(20000),
  });
  const hdrJson = safeJsonParse(await hdrRes.text());
  const docs = Array.isArray(hdrJson?.result) ? hdrJson.result : [];
  if (!docs.length) return { status: 'ok', data: [] };
  const doc = docs[0];
  return {
    status: 'ok',
    data: [{ name: `付款單/單據: ${doc?.ref || doc?.name || '無編號'}`, quantity: 1, price_subtotal: doc?.amount_total || 0 }],
  };
}

async function issueInvoice({ storeInfo, odooNumber, buyType, items }) {
  const odoo = String(odooNumber ?? '');
  const company = storeInfo?.companyName ?? '';
  const safeItems = Array.isArray(items) ? items : [];
  const itemCount = safeItems.length;
  console.log('[issueInvoice] 請求 odooNumber=%s buyType=%s company=%s items=%s', odoo, String(buyType || ''), company, itemCount);

  if (!GIVEME_IDNO || !GIVEME_PASSWORD || !GIVEME_UNCODE) {
    console.error('[issueInvoice] Giveme 設定未完成');
    return { status: 'error', message: 'Giveme 設定未完成（GIVEME_UNCODE/IDNO/PASSWORD）' };
  }
  const totalAmount = safeItems.reduce((sum, item) => sum + Number(item.money || 0) * Number(item.number || 0), 0);
  const sales = Math.round(totalAmount / 1.05);
  const taxAmount = totalAmount - sales;
  const timeStamp = Date.now().toString();
  const finalContent = odoo ? `${buyType} (單號:${odoo})` : String(buyType || '');
  const sign = md5Upper(timeStamp + GIVEME_IDNO + GIVEME_PASSWORD);

  const payload = {
    timeStamp,
    uncode: GIVEME_UNCODE,
    idno: GIVEME_IDNO,
    sign,
    customerName: storeInfo?.companyName || '',
    phone: String(storeInfo?.pinCode || '').trim(),
    datetime: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
    email: storeInfo?.email || '',
    taxState: '0',
    totalFee: String(totalAmount),
    amount: String(taxAmount),
    sales: String(sales),
    content: finalContent,
    items: safeItems.length ? JSON.stringify(safeItems) : undefined,
  };

  const targetUrl = GIVEME_PROXY_URL || GIVEME_B2C_URL;
  try {
    const res = await fetch(targetUrl, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    if (res.status !== 200) {
      console.error('[issueInvoice] Giveme HTTP %s odooNumber=%s body=%s', res.status, odoo, text ? text.slice(0, 500) : '');
    }
    const json = safeJsonParse(text) || { success: 'false', msg: text.slice(0, 200) };
    if (json.success === 'true') {
      console.log('[issueInvoice] 成功 odooNumber=%s code=%s', odoo, json.code || '');
    } else {
      console.warn('[issueInvoice] Giveme 回傳非成功 odooNumber=%s success=%s msg=%s', odoo, json.success || '', json.msg || text.slice(0, 300));
    }
    return { status: 'ok', data: json };
  } catch (e) {
    const errMsg = (e && e.message) ? e.message : String(e);
    console.error('[issueInvoice] Giveme 請求異常 odooNumber=%s error=%s', odoo, errMsg);
    return { status: 'ok', data: { success: 'false', msg: 'Giveme 連線異常: ' + errMsg } };
  }
}

async function storeList(auth) {
  const map = await getLineSayDouInfoMap(auth);
  const out = Object.values(map).map((s) => ({ id: s.saydouId, name: s.name, isDirect: s.isDirect === true }));
  return out;
}

export async function handleCore(req, res, { authClient, url, bodyJson }) {
  // Public shortcuts
  const action = (url.searchParams.get('action') || '').trim();
  if (action === 'near') {
    sendRedirect(res, NEAR_REDIRECT_URL);
    return;
  }
  if (action === 'storeList') {
    const data = await storeList(authClient);
    sendJson(res, 200, { status: 'ok', data });
    return;
  }

  const method = req.method || 'GET';
  const params = method === 'POST' && bodyJson && typeof bodyJson === 'object' ? bodyJson : Object.fromEntries(url.searchParams.entries());
  const keySource = method === 'POST' && params && typeof params.key === 'string' ? new URLSearchParams({ key: params.key }) : url.searchParams;
  if (!requireKey(keySource, res)) return;
  const finalAction = (params.action || action || 'token').trim();

  try {
    switch (finalAction) {
      case 'token': {
        const token = await getBearerToken(authClient);
        // Legacy: plain text response
        if (url.searchParams.get('format') === 'json') {
          sendJson(res, 200, { status: 'ok', token });
        } else {
          sendText(res, 200, token || '');
        }
        return;
      }
      case 'getCoreConfig': {
        sendJson(res, 200, {
          status: 'ok',
          data: {
            LINE_STORE_SS_ID: LINE_STORE_SS_ID || '',
            EXTERNAL_SS_ID: EXTERNAL_SS_ID || '',
          },
        });
        return;
      }
      case 'getLineSayDouInfoMap': {
        const map = await getLineSayDouInfoMap(authClient);
        sendJson(res, 200, { status: 'ok', data: map });
        return;
      }
      case 'getStoresInfo': {
        const map = await getLineSayDouInfoMap(authClient);
        const stores = Object.values(map).map((s) => ({ id: s.saydouId, name: s.name, isDirect: s.isDirect === true }));
        sendJson(res, 200, { status: 'ok', data: stores });
        return;
      }
      case 'fetchReservationData': {
        const { startDate, endDate, storeId } = params;
        const data = await fetchReservationData(authClient, String(startDate || ''), String(endDate || ''), String(storeId || ''));
        sendJson(res, 200, { status: 'ok', data });
        return;
      }
      case 'oldNewA': {
        const { startDate, endDate, storeId } = params;
        const data = await oldNewA(authClient, String(startDate || ''), String(endDate || ''), String(storeId || ''));
        sendJson(res, 200, { status: 'ok', data });
        return;
      }
      case 'fetchTodayReservationData': {
        const { start, end, storeId } = params;
        const data = await fetchTodayReservationData(authClient, String(start || ''), String(end || ''), String(storeId || ''));
        sendJson(res, 200, { status: 'ok', data });
        return;
      }
      case 'fetchDailyIncome': {
        const { date, storeId } = params;
        const data = await fetchDailyIncome(authClient, String(date || ''), String(storeId || ''));
        sendJson(res, 200, { status: 'ok', data });
        return;
      }
      case 'lineReply': {
        const { replyToken, text, token } = params;
        await lineReply({ replyToken, text, token });
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      case 'getCustomerAIResult': {
        const phone = params.phone;
        const out = await getCustomerAIResult(authClient, phone);
        sendJson(res, 200, out);
        return;
      }
      case 'getOdooInvoice': {
        const id = params.id;
        const out = await getOdooInvoice(authClient, id);
        sendJson(res, 200, out);
        return;
      }
      case 'issueInvoice': {
        const out = await issueInvoice(params);
        sendJson(res, 200, out);
        return;
      }
      case 'debugLineStoreMap': {
        const map = await getLineSayDouInfoMap(authClient);
        const keys = Object.keys(map);
        sendJson(res, 200, { status: 'ok', data: { total: keys.length, sample: keys.slice(0, 20) } });
        return;
      }
      case 'getDirectStoreReplyStatusText': {
        const directRes = await getDirectStoreReplyStatusTextAction(authClient);
        sendJson(res, 200, directRes.ok ? { status: 'ok', ok: true, text: directRes.text } : { status: 'error', ok: false, message: directRes.message });
        return;
      }
      case 'getUserDisplayName': {
        const out = await getUserDisplayNameAction(params);
        sendJson(res, 200, out);
        return;
      }
      case 'executeRefundByPhone': {
        const out = await executeRefundByPhoneAction(authClient, params.phone);
        sendJson(res, 200, out);
        return;
      }
      case 'findAvailableSlots': {
        const result = await findAvailableSlotsAction(authClient, params);
        sendJson(res, 200, { status: 'ok', result });
        return;
      }
      case 'createReportToken': {
        const role = String(params.role || 'employee').trim();
        const storeIds = String(params.storeIds || '')
          .split(/[,、，]/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (!storeIds.length) {
          sendJson(res, 200, { status: 'error', message: 'storeIds 必填' });
          return;
        }
        const dateStr = formatYmdTz(new Date());
        const payload = {
          role,
          storeIds,
          userId: String(params.userId || '').trim(),
          employeeCode: String(params.employeeCode || '').trim(),
          dateStr,
          createdAt: Date.now(),
        };
        const token = putReportToken(payload, 600);
        sendJson(res, 200, { status: 'ok', token, expiresIn: 600, dateStr });
        return;
      }
      case 'consumeReportToken': {
        // Temporary compatibility: delegate to legacy GAS Core until report payload is fully ported.
        const out = await callLegacyCore('consumeReportToken', { token: params.token }, { method: 'get' });
        sendJson(res, 200, out);
        return;
      }
      case 'getReportByDate': {
        const out = await callLegacyCore('getReportByDate', { sessionId: params.sessionId, date: params.date }, { method: 'get' });
        sendJson(res, 200, out);
        return;
      }
      case 'submitReportShare': {
        const out = await callLegacyCore('submitReportShare', { sessionId: params.sessionId, text: params.text }, { method: 'get' });
        sendJson(res, 200, out);
        return;
      }
      case 'lastMonthTipsReport': {
        const out = await callLegacyCore('lastMonthTipsReport', { userId: params.userId, managedStoreIds: params.managedStoreIds, employeeCode: params.employeeCode }, { method: 'get' });
        sendJson(res, 200, out);
        return;
      }
      case 'syncLastMonthTipsConsolidated': {
        const out = await callLegacyCore('syncLastMonthTipsConsolidated', {}, { method: 'get' });
        sendJson(res, 200, out);
        return;
      }
      case 'employeeMonthlyPerformanceReport': {
        const out = await callLegacyCore('employeeMonthlyPerformanceReport', params, { method: 'get' });
        sendJson(res, 200, out);
        return;
      }
      default:
        sendJson(res, 200, { status: 'error', message: `未知 action: ${finalAction}` });
    }
  } catch (e) {
    sendJson(res, 200, { status: 'error', message: e?.message || String(e) });
  }
}

export const __testables__ = { normalizePhone9, md5Upper };
export { consumeReportToken, callLegacyCore };

