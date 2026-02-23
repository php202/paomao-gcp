import fetch from 'node-fetch';
import { readSheet, writeSheet } from '../lib/sheets.js';
import { sendJson } from './http-utils.js';
import { findAvailableSlotsAction, getLineSayDouInfoMap } from './core-api.js';
import { getBearerToken } from '../lib/saydou.js';
import { createCustomerInfoToken } from '../lib/customer-token.js';

const INTEGRATED_SHEET_SS_ID = (process.env.INTEGRATED_SHEET_SS_ID || process.env.LINE_STORE_SS_ID || '').trim();
const LEGACY_GAS_STORES_API_URL = (process.env.LEGACY_GAS_STORES_API_URL || '').trim();
/** 若設定，GET /stores 需帶 X-Store-Api-Key 與此值相同（供 GAS 代轉查詢空位等） */
const STORE_API_KEY = (process.env.STORE_API_KEY || process.env.GCP_CORE_SECRET_KEY || '').trim();
const TOMORROW_REPORT_CLOSED_DATES = String(process.env.TOMORROW_REPORT_CLOSED_DATES || '')
  .split(/[,、，]/)
  .map((s) => s.trim())
  .filter(Boolean);

function fmtYmdTaipei(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function normalizeReservations(resp) {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.data)) return resp.data;
  if (Array.isArray(resp.reservation)) return resp.reservation;
  if (resp.data && Array.isArray(resp.data.reservation)) return resp.data.reservation;
  if (resp.data && resp.data.data && Array.isArray(resp.data.data.reservation)) return resp.data.data.reservation;
  return [];
}

function normalizeReservationRow(r) {
  if (!r) return null;
  const phone =
    (r.rsphon != null && r.rsphon !== '') ? String(r.rsphon).trim() : (r.memb && r.memb.phone_) ? String(r.memb.phone_).trim() : '';
  const name =
    (r.rsname != null && r.rsname !== '') ? String(r.rsname).trim() : (r.memb && r.memb.memnam) ? String(r.memb.memnam).trim() : '';
  const rsvtimRaw = r.rsvtim || r.start_time || r.startTime || r.start || '';
  const rsvtim = rsvtimRaw ? String(rsvtimRaw).replace('T', ' ').trim().slice(0, 19) : '';
  const tPart = rsvtim ? (rsvtim.split(/[T\s]/)[1] || '') : '';
  const timeText = tPart ? tPart.slice(0, 5) : '';
  const staffName = r.usrs && r.usrs.usrnam ? String(r.usrs.usrnam) : '';
  const services = r.services != null ? String(r.services) : '';
  const remark = r.remark != null ? String(r.remark) : '';
  return { phone, name, rsvtim, timeText, staffName, services, remark };
}

async function fetchStoreReservationsForDate(bearerToken, storeId, dateStr) {
  const url =
    'https://saywebdatafeed.saydou.com/api/management/calendar/events/full' +
    `?startDate=${encodeURIComponent(dateStr)}` +
    `&endDate=${encodeURIComponent(dateStr)}` +
    `&storid=${encodeURIComponent(storeId)}` +
    '&status%5B%5D=reservation&status%5B%5D=hasshow&status%5B%5D=confirm&status%5B%5D=checkout';
  const res = await fetch(url, {
    method: 'get',
    headers: { Authorization: `Bearer ${bearerToken}` },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SayDou calendar HTTP ${res.status}: ${(text || '').slice(0, 120)}`);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return normalizeReservations(json);
}

function resolveStoreIds(inputIds, storeMap) {
  const nameToId = new Map();
  for (const info of Object.values(storeMap || {})) {
    const id = info?.saydouId != null ? String(info.saydouId).trim() : '';
    const name = info?.name != null ? String(info.name).trim() : '';
    if (id) nameToId.set(id, id);
    if (name) nameToId.set(name, id);
  }
  const out = [];
  for (const raw of inputIds || []) {
    const s = String(raw || '').trim();
    if (!s) continue;
    out.push(nameToId.get(s) || s);
  }
  return [...new Set(out)];
}

async function buildTomorrowReservations(auth, storeIds, { includeSlots }) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = fmtYmdTaipei(tomorrow);

  if (TOMORROW_REPORT_CLOSED_DATES.includes(dateStr)) {
    return {
      dateStr,
      byStore: [],
      closed: true,
      message: `明日預約報告 ${dateStr} 已關閉，當日不提供預約清單。`,
    };
  }

  const storeMap = await getLineSayDouInfoMap(auth);
  const ids = resolveStoreIds(storeIds, storeMap);
  const bearerToken = await getBearerToken(auth);

  const byStore = [];
  for (const id of ids) {
    const storeName = storeMap?.[String(id)]?.name || String(id);
    let reservations = [];
    try {
      reservations = await fetchStoreReservationsForDate(bearerToken, id, dateStr);
    } catch {
      reservations = [];
    }
    const items = reservations
      .map(normalizeReservationRow)
      .filter(Boolean)
      .map((it) => {
        // Token is used by LINE clickable phone → /customer-info?token=...
        if (!includeSlots) return it;
        const phone = String(it.phone || '').trim();
        if (!phone) return it;
        try {
          const expMs = Date.now() + 24 * 60 * 60 * 1000;
          const token = createCustomerInfoToken({ phone, expMs });
          return { ...it, token };
        } catch {
          return it;
        }
      });
    items.sort((a, b) => String(a.rsvtim || '').localeCompare(String(b.rsvtim || '')));

    let availableSlotsText = '—';
    if (includeSlots) {
      try {
        const slotResult = await findAvailableSlotsAction(auth, {
          sayId: id,
          startDate: dateStr,
          endDate: dateStr,
        });
        if (slotResult?.status && Array.isArray(slotResult.data) && slotResult.data.length > 0) {
          const times = slotResult.data[0].times || [];
          const n = times.length;
          availableSlotsText = n > 0 ? `1.5hr 還有 ${n} 個空位` : '—';
        }
      } catch {
        availableSlotsText = '—';
      }
    }

    byStore.push(
      includeSlots
        ? { storeId: String(id), storeName, items, availableSlotsText }
        : { storeId: String(id), storeName, items },
    );
  }

  return { dateStr, byStore };
}

// On-demand usage (LINE command): includes available slots calculation (slower).
export async function getTomorrowReservationList(auth, storeIds) {
  return buildTomorrowReservations(auth, storeIds, { includeSlots: true });
}

// Batch usage (22:00 job): reservations only (fast), avoids calling findAvailableSlotsAction.
export async function getTomorrowReservationsOnly(auth, storeIds) {
  return buildTomorrowReservations(auth, storeIds, { includeSlots: false });
}

function fmtTaipeiDateTime(value) {
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return String(value ?? '');
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  } catch {
    return String(value ?? '');
  }
}

async function loadStoreByBotId(auth, botId) {
  const rows = await readSheet(auth, INTEGRATED_SHEET_SS_ID, "'店家基本資料'!A:L");
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowBotId = String(row[6] || '').trim();
    if (rowBotId && rowBotId === botId) {
      return {
        name: String(row[1] || '').trim(),
        channelId: String(row[2] || '').trim(),
        channelSecret: String(row[3] || '').trim(),
        destinationId: String(row[4] || '').trim(),
        sayId: String(row[5] || '').trim(),
        isDirect: row[7] === true || String(row[7]).toUpperCase() === 'TRUE',
        isReply: (() => {
          const raw = row[8];
          if (raw == null || raw === '') return true;
          if (raw === 0) return false;
          const s = String(raw).trim().toLowerCase();
          return !(s === 'false' || s === '0');
        })(),
      };
    }
  }
  return null;
}

async function getLineAccessToken(channelId, channelSecret) {
  const res = await fetch('https://api.line.me/v2/oauth/accessToken', {
    method: 'post',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: channelId,
      client_secret: channelSecret,
    }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  const json = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  if (!res.ok) throw new Error(`LINE accessToken failed: HTTP ${res.status} ${(text || '').slice(0, 200)}`);
  const token = String(json?.access_token || '').trim();
  if (!token) throw new Error('LINE accessToken empty');
  return token;
}

async function getList(auth, botId) {
  if (!INTEGRATED_SHEET_SS_ID) return { status: 'error', message: '無法取得試算表' };
  const store = await loadStoreByBotId(auth, botId);
  if (!store?.name) return { error: '找不到此 Bot ID 對應的店家', botId };

  const logs = await readSheet(auth, INTEGRATED_SHEET_SS_ID, "'訊息一覽'!A:I");
  const out = [];
  for (let i = 1; i < logs.length; i++) {
    const row = logs[i];
    const storeName = String(row[2] || '').trim();
    const status = String(row[5] || '').trim(); // F
    if (storeName === store.name && !status) {
      out.push({
        row: i + 1,
        time: fmtTaipeiDateTime(row[0]),
        name: row[3],
        msg: row[4],
        userId: row[1],
        replyToken: row.length > 8 && row[8] ? String(row[8]).trim() : '',
      });
    }
  }
  out.reverse();
  return { status: 'success', storeName: store.name, data: out };
}

async function replyMessage(auth, botId, replyToken, text) {
  if (!botId) return { status: 'error', message: '請提供 botId' };
  if (!replyToken) return { status: 'error', message: '請提供 replyToken（此則訊息可能已過期）' };
  const store = await loadStoreByBotId(auth, botId);
  if (!store?.channelId || !store?.channelSecret) return { status: 'error', message: '無法取得該店 LINE 憑證' };

  const token = await getLineAccessToken(store.channelId, store.channelSecret);
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: String(text ?? '') }] }),
    signal: AbortSignal.timeout(15000),
  });

  return { status: 'success', message: '已回覆' };
}

function parseDateRangeParams(q) {
  const startDate = (q.get('startDate') || '').trim().replace(/\//g, '-');
  const endDate = (q.get('endDate') || '').trim().replace(/\//g, '-');
  const people = q.get('people') != null ? Number.parseInt(q.get('people'), 10) : 1;
  const durationHr = q.get('duration') != null ? Number.parseFloat(String(q.get('duration')).replace(',', '.')) : 1.5;
  const durationMin = Math.round((Number.isFinite(durationHr) ? durationHr : 1.5) * 60);
  const weekDays = (q.get('weekDays') || '').trim(); // comma numbers
  const timeStart = (q.get('timeStart') || '').trim();
  const timeEnd = (q.get('timeEnd') || '').trim();
  const options = { startDate, endDate, people: Number.isFinite(people) ? people : 1, durationMin, weekDays, timeStart, timeEnd };
  return options;
}

async function getSlots(auth, botId, q) {
  const store = await loadStoreByBotId(auth, botId);
  if (!store?.sayId) return { error: '找不到此 Bot ID 對應的「神美ID」', botId };
  if (store.isReply === false) return { status: 'success', text: '此店家未開放查詢可預約時間，請直接聯繫店家。' };

  const opts = parseDateRangeParams(q);
  let { startDate, endDate } = opts;

  // GAS 行為：未給起迄時預設今天起 8 天
  const today = new Date();
  if (!startDate || !endDate) {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const end = new Date(start.getTime());
    end.setDate(end.getDate() + 7);
    startDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(start);
    endDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(end);
  }

  const weekDaysArr = (() => {
    if (!opts.weekDays) return [0, 1, 2, 3, 4, 5, 6];
    const arr = opts.weekDays
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 6);
    return arr.length ? arr : [0, 1, 2, 3, 4, 5, 6];
  })();

  const result = await findAvailableSlotsAction(auth, {
    sayId: store.sayId,
    startDate,
    endDate,
    needPeople: opts.people,
    durationMin: opts.durationMin,
    weekDays: weekDaysArr,
    timeStart: opts.timeStart || '11:00',
    timeEnd: opts.timeEnd || '21:00',
  });
  if (!result?.status) return { error: '查詢失敗', details: result?.error || 'Core.findAvailableSlots 失敗' };

  const lines = [];
  const byDate = {};
  for (const d of result.data || []) byDate[String(d.date)] = d;
  // list dates in range
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  for (let cur = new Date(start.getTime()); cur.getTime() <= end.getTime(); cur.setDate(cur.getDate() + 1)) {
    if (!weekDaysArr.includes(cur.getDay())) continue;
    const dayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(cur);
    const weekdayZh = `星期${'日一二三四五六'.charAt(cur.getDay())}`;
    const dayData = byDate[dayStr];
    const prettySlots = dayData?.times?.length ? dayData.times.join('、') : '（無）';
    const display = dayStr.slice(5);
    lines.push(`${display}（${weekdayZh}）：${prettySlots}`);
  }
  return { status: 'success', text: lines.join('\n') };
}

async function delegateToLegacy(action, q) {
  if (!LEGACY_GAS_STORES_API_URL) return { status: 'error', message: `action ${action} 尚未搬遷，且未設定 LEGACY_GAS_STORES_API_URL` };
  const url = new URL(LEGACY_GAS_STORES_API_URL);
  for (const [k, v] of q.entries()) url.searchParams.set(k, v);
  url.searchParams.set('action', action);
  const res = await fetch(url.toString(), { method: 'get', signal: AbortSignal.timeout(120000) });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: res.ok ? 'success' : 'error', text: text.slice(0, 5000) };
  }
}

export async function handleStores(req, res, { authClient, url, bodyJson }) {
  const method = req.method || 'GET';

  // POST routing: webhook and write actions
  if (method === 'POST') {
    const action = bodyJson?.action ? String(bodyJson.action).trim() : '';
    if (bodyJson?.events && Array.isArray(bodyJson.events)) {
      // Store LINE webhook logic is ported in Phase 4; keep as no-op for now.
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (action === 'updateAiAdjustmentSuggestion') {
      // Temporary delegation: keep behavior while we port AI suggestions pipeline.
      if (!LEGACY_GAS_STORES_API_URL) {
        sendJson(res, 200, { status: 'error', message: 'LEGACY_GAS_STORES_API_URL 未設定' });
        return;
      }
      const legacyRes = await fetch(LEGACY_GAS_STORES_API_URL, {
        method: 'post',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyJson),
        signal: AbortSignal.timeout(120000),
      });
      const text = await legacyRes.text();
      try {
        sendJson(res, 200, JSON.parse(text));
      } catch {
        sendJson(res, 200, { status: legacyRes.ok ? 'success' : 'error', text: text.slice(0, 5000) });
      }
      return;
    }
    sendJson(res, 200, { status: 'error', message: '未知的請求格式' });
    return;
  }

  // GET routing: Chrome extension APIs（GAS 代轉時帶 X-Store-Api-Key）
  if (STORE_API_KEY) {
    const key = (req.headers['x-store-api-key'] || req.headers['X-Store-Api-Key'] || '').trim();
    if (key !== STORE_API_KEY) {
      sendJson(res, 401, { status: 'error', message: 'Unauthorized' });
      return;
    }
  }
  const action = String(url.searchParams.get('action') || '').trim();
  try {
    switch (action) {
      case 'getList': {
        const botId = String(url.searchParams.get('botId') || '').trim();
        const out = await getList(authClient, botId);
        sendJson(res, 200, out);
        return;
      }
      case 'replyMessage': {
        const botId = String(url.searchParams.get('botId') || '').trim();
        const replyToken = String(url.searchParams.get('replyToken') || '').trim();
        const text = url.searchParams.get('text') ?? '';
        const out = await replyMessage(authClient, botId, replyToken, text);
        sendJson(res, 200, out);
        return;
      }
      case 'getSlots':
      case 'searchAvailability': {
        const botId = String(url.searchParams.get('botId') || '').trim();
        const out = await getSlots(authClient, botId, url.searchParams);
        sendJson(res, 200, out);
        return;
      }
      case 'getTomorrowReservationList': {
        const storeIdsParam = String(url.searchParams.get('storeIds') || '').trim();
        const storeIds = storeIdsParam ? storeIdsParam.split(/[,、，]/).map((s) => s.trim()).filter(Boolean) : [];
        const out = await getTomorrowReservationList(authClient, storeIds);
        sendJson(res, 200, out);
        return;
      }
      default: {
        // For remaining actions, delegate to legacy GAS until fully ported.
        if (!action) {
          sendJson(res, 200, { status: 'error', message: 'No action provided' });
          return;
        }
        const out = await delegateToLegacy(action, url.searchParams);
        sendJson(res, 200, out);
        return;
      }
    }
  } catch (e) {
    sendJson(res, 200, { status: 'error', message: e?.message || String(e) });
  }
}

