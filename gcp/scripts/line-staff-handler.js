import fetch from 'node-fetch';
import { readSheet } from '../lib/sheets.js';
import { isUserAuthorized } from './line-checkin-handler.js';

const REPORT_PAGE_URL = process.env.REPORT_PAGE_URL || 'https://www.paopaomao.tw/report';
const TOMORROW_BRIEFING_WEB_APP_URL = process.env.TOMORROW_BRIEFING_WEB_APP_URL || '';
const PAO_CAT_CORE_API_URL = process.env.PAO_CAT_CORE_API_URL || '';
const PAO_CAT_SECRET_KEY = process.env.PAO_CAT_SECRET_KEY || '';
const LINE_STAFF_SS_ID = process.env.LINE_STAFF_SS_ID || '';
const LINE_HQ_SS_ID = process.env.LINE_HQ_SS_ID || '';
const LINE_STORE_SS_ID = process.env.LINE_STORE_SS_ID || '';

const ATT_KEYWORDS = new Set([
  '店家今天出勤',
  '店家本月出勤',
  '店家上月出勤',
  '本月出勤',
  '上月出勤',
  '店家可預約時間',
]);

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

function normalizeDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
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

function extractPhoneFromCustomerKeyword(text) {
  if (!text || typeof text !== 'string') return null;
  const s = text.replace(/我要了解客人\s*/i, '').trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length === 9 && digits[0] === '9') return `0${digits}`;
  if (digits.length >= 10 && digits[0] === '0') return digits.slice(0, 10);
  if (digits.length >= 9 && digits[0] === '9') return `0${digits.slice(0, 9)}`;
  const m = text.match(/09[\d\s-]{8,}/);
  if (!m) return null;
  const d = m[0].replace(/\D/g, '');
  return d.length >= 10 ? d.slice(0, 10) : null;
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

function buildAttendanceMessage(records, employeeMap) {
  if (!records.length) return '⚠️ 查無打卡紀錄';
  const byUser = new Map();
  for (const r of records) {
    const arr = byUser.get(r.userId) || [];
    arr.push(r);
    byUser.set(r.userId, arr);
  }
  const lines = [];
  for (const [userId, items] of byUser.entries()) {
    const emp = employeeMap.get(userId);
    if (!emp) continue;
    lines.push(`👤 員工: ${emp.name} (${emp.store || '未設定門市'})`);
    const byDate = new Map();
    for (const it of items) {
      const key = it.time.toISOString().slice(0, 10);
      const a = byDate.get(key) || [];
      a.push(it);
      byDate.set(key, a);
    }
    for (const [date, dayItems] of byDate.entries()) {
      const on = dayItems.filter((x) => String(x.type).includes('上班')).map((x) => fmtDateTime(x.time).slice(11, 19));
      const off = dayItems.filter((x) => String(x.type).includes('下班')).map((x) => fmtDateTime(x.time).slice(11, 19));
      lines.push(`🔹 ${date} 出勤紀錄`);
      lines.push(`✅ 上班: ${on.join(' 、') || '無'}`);
      lines.push(`✅ 下班: ${off.join(' 、') || '無'}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim() || '⚠️ 查無打卡紀錄';
}

async function readEmployeeMaps(auth, sheetReader) {
  const rows = await sheetReader(auth, LINE_STAFF_SS_ID, "'員工清單'!A:L");
  const byLineId = new Map();
  const byStore = new Map();
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
  }
  return { byLineId, byStore };
}

async function readAttendance(auth, userIds, startDate, endDate, sheetReader) {
  const sources = ["'員工打卡紀錄'!A:G", "'打卡紀錄封存'!A:G"];
  const rows = [];
  for (const src of sources) {
    try {
      const data = await sheetReader(auth, LINE_STAFF_SS_ID, src);
      rows.push(...data.slice(1));
    } catch {
      // ignore missing sheet
    }
  }
  const userSet = new Set(userIds);
  return rows
    .map((row) => {
      const userId = String(row[0] || '').trim();
      const time = normalizeDate(row[1]);
      const type = String(row[2] || '').trim();
      const note = String(row[6] || '');
      const tagType = note.includes('補打卡') && type ? `${type}(補)` : type;
      return { userId, time, type: tagType };
    })
    .filter((x) => x.userId && userSet.has(x.userId) && x.time && x.time >= startDate && x.time <= endDate)
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
  if (text === '查詢打卡記錄') {
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

  if (!ATT_KEYWORDS.has(text)) return false;

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const maps = await readEmployeeMaps(authClient, sheetReader);

  if (text === '本月出勤' || text === '上月出勤') {
    if (!authResult.identity.includes('employee') && !authResult.identity.includes('manager')) {
      await replyText('您尚無本行動權限');
      return true;
    }
    const start = text === '本月出勤' ? new Date(y, m, 1) : new Date(y, m - 1, 1);
    const end = text === '本月出勤' ? new Date(y, m + 1, 0, 23, 59, 59, 999) : new Date(y, m, 0, 23, 59, 59, 999);
    const records = await readAttendance(authClient, [userId], start, end, sheetReader);
    await replyText(buildAttendanceMessage(records, maps.byLineId));
    return true;
  }

  const managedStores = splitStoreIds(authResult.managedStores);
  if (!managedStores.length) {
    await replyText('您目前尚未有管理的店家');
    return true;
  }

  if (text === '店家可預約時間') {
    const startDate = now.toISOString().slice(0, 10);
    const endDate = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const lines = [];
    for (const storeId of managedStores) {
      const r = await callCoreApiGet('findAvailableSlots', { sayId: storeId, startDate, endDate }, fetch);
      lines.push(`【${storeId}】`);
      if (!r || r.status !== 'ok' || !Array.isArray(r.data) || r.data.length === 0) {
        lines.push('(無可預約時段)');
      } else {
        for (const day of r.data.slice(0, 7)) {
          lines.push(`${String(day.date || '').slice(5)} (${day.week || '-'})：${(day.times || []).join('、')}`);
        }
      }
      lines.push('');
    }
    await replyText(lines.join('\n').trim() || '查無可預約時間。');
    return true;
  }

  const dayStart = new Date(y, m, now.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(y, m, now.getDate(), 23, 59, 59, 999);
  const lines = [`📅 日期：${m + 1} 月 ${now.getDate()} 日 的出勤紀錄`, ''];
  for (const storeId of managedStores) {
    const members = maps.byStore.get(storeId) || [];
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
    lines.push(`【${storeId}】`);
    lines.push(`✅ 有上班：\n${attended.join('\n') || '無'}`);
    lines.push(`❌ 沒上班：${absent.join('、') || '無'}`);
    lines.push(`⚠️ 尚未註冊：${unregistered.join('、') || '無'}`);
    lines.push('');
  }
  await replyText(lines.join('\n').trim() || '查無負責店家的員工資料。');
  return true;
}

async function handleLineQuestion(replyText, authClient, sheetReader) {
  if (!LINE_HQ_SS_ID) {
    await replyText('系統尚未設定 LINE_HQ_SS_ID。');
    return true;
  }
  const rows = await sheetReader(authClient, LINE_HQ_SS_ID, "'問題集'!A:H");
  const pending = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const returnDate = String(row[7] || '').trim();
    if (returnDate) continue;
    pending.push({
      date: row[1] ? fmtDateTime(normalizeDate(row[1]) || new Date()).slice(5, 10) : '--/--',
      store: String(row[2] || ''),
      content: String(row[3] || '').replace(/[\n\r]/g, ' ').slice(0, 24),
      owner: String(row[4] || ''),
    });
  }
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
}

async function handleStoreReplyStatus(replyText, authClient, sheetReader) {
  if (!LINE_STORE_SS_ID) {
    await replyText('系統尚未設定 LINE_STORE_SS_ID。');
    return true;
  }
  const stores = await sheetReader(authClient, LINE_STORE_SS_ID, "'店家基本資料'!A:L");
  const msgs = await sheetReader(authClient, LINE_STORE_SS_ID, "'訊息一覽'!A:F");
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

async function handleTomorrowList(text, authResult, replyText, fetcher) {
  if (!(text === '明天預約清單' || text === '明日預約清單')) return false;
  if (!TOMORROW_BRIEFING_WEB_APP_URL) {
    await replyText('未設定明日預約 API（TOMORROW_BRIEFING_WEB_APP_URL）。');
    return true;
  }
  const ids = splitStoreIds(authResult.identity.includes('manager') ? authResult.managedStores : authResult.workStores);
  if (!ids.length) {
    await replyText('無法判斷您所屬的門市，請管理者補上店家代碼。');
    return true;
  }
  const url = new URL(TOMORROW_BRIEFING_WEB_APP_URL);
  url.searchParams.set('action', 'getTomorrowReservationList');
  url.searchParams.set('storeIds', ids.join(','));
  const res = await fetcher(url.toString(), { method: 'get' });
  if (!res.ok) {
    await replyText('取得明日預約清單失敗，請稍後再試。');
    return true;
  }
  const data = await res.json().catch(() => null);
  if (!data) {
    await replyText('明日預約清單回傳格式異常，請稍後再試。');
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
  const lines = [`📅 明日預約清單 ${data.dateStr || ''}`];
  for (const s of stores.slice(0, 8)) {
    lines.push(`\n【${s.storeName || s.storeId || '-'}】`);
    const items = Array.isArray(s.items) ? s.items : [];
    if (!items.length) {
      lines.push('（無預約）');
      continue;
    }
    for (const it of items.slice(0, 8)) {
      lines.push(`- ${it.rsvtim || '--:--'} ${it.name || ''} ${it.phone || ''}`.trim());
    }
  }
  await replyText(lines.join('\n').slice(0, 4500));
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

  const authResult = await authorizeFn(authClient, LINE_STAFF_SS_ID, userId);
  if (!authResult.isAuthorized) {
    await replyText('⚠️ 你的帳號尚未開通，麻煩通知泡泡貓負責顧問！');
    return true;
  }

  if (text === '最新活動') {
    await replyText('📅 【最新活動資訊】\n\n請點擊下方連結查看所有活動檔案：\nhttps://drive.google.com/drive/folders/1Y2hoU5nhM2-lJxHbm0KwfBPznFDQThmg?usp=drive_link');
    return true;
  }
  if (text === '特約商店') {
    await replyText('📅 【線上課程】\n\n請點擊下方連結查看所有課程：\nhttps://www.paopaomao.tw/slides');
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
  if (text.includes('Line問題集')) {
    return handleLineQuestion(replyText, authClient, sheetReader);
  }
  if (text.includes('店家回覆狀態')) {
    if (!authResult.identity.includes('manager')) {
      await replyText('此功能僅限管理者使用。');
      return true;
    }
    return handleStoreReplyStatus(replyText, authClient, sheetReader);
  }
  if (await handleAttendanceCommand({ authClient, authResult, text, userId, replyText, replyMessages, sheetReader })) {
    return true;
  }
  if (await handleTomorrowList(text, authResult, replyText, fetcher)) {
    return true;
  }
  if (text.includes('我要了解客人')) {
    const phone = extractPhoneFromCustomerKeyword(text);
    if (!phone) {
      await replyText('請輸入「我要了解客人」後面接手機號碼，例如：我要了解客人0925810424');
      return true;
    }
    const r = await callCoreApiPost('getCustomerAIResult', { phone }, fetcher);
    if (!r || r.status !== 'ok') {
      await replyText((r && r.message) || '查詢時發生錯誤，請稍後再試。');
      return true;
    }
    await replyText(`【客人 ${phone} AI分析結果】\n\n${String(r.content || '該客人尚無 AI 分析結果。')}`);
    return true;
  }
  if (text.includes('上月小費')) {
    const managedStoreIds = splitStoreIds(authResult.managedStores);
    const params = { userId };
    if (managedStoreIds.length) params.managedStoreIds = managedStoreIds.join(',');
    if (!managedStoreIds.length && authResult.employeeCode) params.employeeCode = authResult.employeeCode;
    const r = await callCoreApiGet('lastMonthTipsReport', params, fetcher);
    if (!r || !r.ok || !r.url) {
      await replyText(`上月小費報告失敗：${(r && r.message) || '未知錯誤'}`);
      return true;
    }
    await replyText(`✅ 上月小費\n\n開啟報表：\n${r.url}`);
    return true;
  }
  if (text.trim() === '神美日報') {
    const isManager = authResult.identity.includes('manager');
    const storeIds = splitStoreIds(isManager ? authResult.managedStores : authResult.workStores);
    if (!storeIds.length) {
      await replyText('無法判斷您所屬的門市，請管理者補上店家代碼。');
      return true;
    }
    const r = await callCoreApiPost(
      'createReportToken',
      {
        role: isManager ? 'manager' : 'employee',
        storeIds: storeIds.join(','),
        userId,
        employeeCode: authResult.employeeCode || '',
      },
      fetcher,
    );
    if (!r || r.status !== 'ok' || !r.token) {
      await replyText('神美日報產出失敗，請稍後再試。');
      return true;
    }
    const uri = `${REPORT_PAGE_URL}${REPORT_PAGE_URL.includes('?') ? '&' : '?'}token=${encodeURIComponent(r.token)}`;
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

  return false;
}

export const __testables__ = {
  extractPhoneFromCustomerKeyword,
  formatDirectStoreCompletionRate,
  splitStoreIds,
  buildAttendanceMessage,
};
