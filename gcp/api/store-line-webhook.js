import fetch from 'node-fetch';
import { findAvailableSlotsAction } from './core-api.js';
import { nowTaipeiStr } from '../lib/date-tz.js';
import { verifyLineSignature } from '../lib/line-webhook.js';
import { appendSheet, readSheet, batchUpdateValues } from '../lib/sheets.js';
import { appendWebhookError } from '../lib/webhook-error-log.js';
import { sendJson } from './http-utils.js';

const INTEGRATED_SHEET_SS_ID = (process.env.INTEGRATED_SHEET_SS_ID || process.env.LINE_STORE_SS_ID || '').trim();
const RETENTION_SHEET_NAME = '準客挽留清單';
/** 與客服小幫手同一來源：各店訊息一覽表 GAS searchAvailability。設為空則用 GCP findAvailableSlotsAction。 */
const LEGACY_GAS_STORES_API_URL = (process.env.LEGACY_GAS_STORES_API_URL || '').trim();

/** 從訊息文字擷取台灣手機號碼（09 開頭），正規化 10 碼；無則 null（與 GAS extractPhoneFromText 一致） */
function extractPhoneFromText(text) {
  if (text == null || String(text).trim() === '') return null;
  const match = String(text).match(/09[\d\s\-]{8,}/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, '');
  if (digits.length < 9) return null;
  if (digits.length === 9 && digits[0] === '9') return `0${digits}`;
  if (digits.length >= 10) return `0${digits.slice(-9)}`;
  return null;
}

/** 客人發送真實訊息時，將該 userId 在準客挽留清單中 Pending 改為 Replied（與 GAS markAsReplied 一致） */
async function markAsReplied(auth, userId) {
  if (!userId || !auth) return;
  const rows = await readSheet(auth, INTEGRATED_SHEET_SS_ID, `'${RETENTION_SHEET_NAME}'!A:D`);
  const updates = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() === userId && String(rows[i][3] || '').trim() === 'Pending') {
      updates.push({ range: `'${RETENTION_SHEET_NAME}'!D${i + 1}`, values: [['Replied']] });
      break;
    }
  }
  if (updates.length) await batchUpdateValues(auth, INTEGRATED_SHEET_SS_ID, updates);
}

/** 與 GAS messFilter 一致：依關鍵字分類選單/ postback，回傳 { type, desc, useAI, template, prompt } 或 null */
const MESS_FILTER_RULES = [
  { keyword: '我的會員', type: 'MEMBER', desc: '會員權益', useAI: false, template: '${name} 您好！想查詢點數嗎？請點擊選單下方的「會員中心」即可查看喔！' },
  { keyword: '課程介紹', type: 'INTRO', desc: '了解課程', useAI: false, template: '${name} 您好，我們的熱門課程都在選單裡囉！如果需要專人解說，請直接留言，我們稍後回覆您。' },
  { keyword: '送出預約', type: 'IGNORE', desc: '系統操作', useAI: false, template: null },
  { keyword: '線上預約', type: 'BOOKING', desc: '查詢空位', useAI: false, template: 'Hi ${name}，想預約嗎？系統查到最近還有空位：\n${slots}\n\n有哪一個時段對妳來說比較方便嗎？\n如果想預約的話，再麻煩留下你的【姓名、電話】，稍後為妳登記保留喔。' },
  { keyword: '您已取消預約', type: 'BOOKING', desc: '取消挽回', useAI: true, prompt: '客人剛取消了預約。請產生一段貼心、不給壓力的文案，表示遺憾，並主動列出系統查到的最近空位(${slots})，詢問是否改約。' },
];

function messFilter(msg) {
  if (!msg || typeof msg !== 'string') return null;
  return MESS_FILTER_RULES.find((r) => msg.includes(r.keyword)) || null;
}

async function findStoreByDestinationId(auth, destinationId) {
  const rows = await readSheet(auth, INTEGRATED_SHEET_SS_ID, "'店家基本資料'!A:L");
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const dest = String(row[4] || '').trim();
    if (dest && dest === destinationId) {
      const isReply = row[8] !== false && String(row[8]).toUpperCase() !== 'FALSE';
      return {
        storeName: String(row[1] || '').trim(),
        channelId: String(row[2] || '').trim(),
        channelSecret: String(row[3] || '').trim(),
        destinationId: dest,
        sayId: String(row[5] || '').trim(),
        botId: String(row[6] || '').trim(),
        isReply: isReply !== false,
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
  if (!res.ok) throw new Error(`LINE accessToken failed: HTTP ${res.status} ${(text || '').slice(0, 200)}`);
  const json = JSON.parse(text);
  return String(json?.access_token || '').trim();
}

async function fetchDisplayName(userId, token) {
  if (!userId || !token) return '';
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      method: 'get',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    if (!res.ok) return '';
    const json = JSON.parse(text);
    return String(json?.displayName || '').trim();
  } catch {
    return '';
  }
}

/** 將 findAvailableSlotsAction 回傳的 data 轉成「近期空位:\nMM-DD (週x)：時段」字串；days 可為部分篩選後的陣列。 */
function formatSlotsLines(data) {
  if (!Array.isArray(data) || data.length === 0) return null;
  const lines = data.map((day) => {
    const datePart = (day.date && String(day.date).length >= 10) ? String(day.date).slice(5, 10) : (day.date || '');
    const weekPart = day.week || '';
    const slotsStr = Array.isArray(day.times) ? day.times.join('、') : String(day.times || '');
    return datePart + (weekPart ? ` (${weekPart})` : '') + '：' + slotsStr;
  });
  return lines.length > 0 ? '近期空位:\n' + lines.join(',\n') : null;
}

/** 呼叫與客服小幫手同一支 GAS searchAvailability（同 Action-getSlots cleanData），參數對齊：1 人、1.5hr、全天 11:00~21:00、全星期。回傳 { text, debug } 供除錯。 */
async function fetchSlotsFromGasSearchAvailability(botId, startDate, endDate) {
  if (!LEGACY_GAS_STORES_API_URL || !botId) {
    return { text: null, debug: !LEGACY_GAS_STORES_API_URL ? 'GAS_URL未設定' : 'botId空' };
  }
  const params = new URLSearchParams({
    action: 'searchAvailability',
    botId: String(botId),
    startDate,
    endDate,
    people: '1',
    duration: '1.5',
    weekDays: '0,1,2,3,4,5,6',
    timeStart: '11:00',
    timeEnd: '21:00',
  });
  const baseUrl = LEGACY_GAS_STORES_API_URL.replace(/\?.*$/, '');
  const url = `${baseUrl}?${params.toString()}`;
  try {
    const res = await fetch(url, { method: 'get', signal: AbortSignal.timeout(25000) });
    const text = await res.text();
    const json = (() => { try { return JSON.parse(text); } catch { return {}; } })();
    if (res.ok && json.status === 'success' && json.text != null && String(json.text).trim() !== '') {
      const gasText = String(json.text).trim();
      const out = gasText.indexOf('近期空位') === 0 ? gasText : '近期空位:\n' + gasText;
      console.log('[store-line-webhook] GAS searchAvailability OK botId=%s start=%s end=%s len=%s', (botId || '').slice(-8), startDate, endDate, out.length);
      return { text: out, debug: null };
    }
    const debug = !res.ok
      ? `GAS_HTTP${res.status}`
      : json.status !== 'success'
        ? `GAS_status=${json.status || 'n/a'}`
        : 'GAS_text空';
    console.warn('[store-line-webhook] GAS searchAvailability 無可用空位或失敗 botId=%s start=%s end=%s %s resOk=%s body=%s', (botId || '').slice(-8), startDate, endDate, debug, res.ok, (text || '').slice(0, 200));
    return { text: null, debug };
  } catch (err) {
    console.warn('[store-line-webhook] fetchSlotsFromGasSearchAvailability 失敗 botId=%s', (botId || '').slice(-8), err?.message || err);
    return { text: null, debug: `GAS_錯誤:${(err?.message || String(err)).slice(0, 50)}` };
  }
}

/** 四天內有空位就回傳；若四天內都沒有，往後查至多 MAX_DAYS_AHEAD 天，取「至少 MIN_DAYS_WITH_SLOTS 天」有空位的時段。優先使用與客服小幫手同一支 GAS searchAvailability。回傳 { slotsStr, debug }，無空位時 debug 供除錯或顯示在訊息。 */
const FIRST_RANGE_DAYS = 4;
const MIN_DAYS_WITH_SLOTS = 3;
const MAX_DAYS_AHEAD = 30;
const SLOTS_DEBUG = (process.env.SLOTS_DEBUG || '').trim().toLowerCase() === '1' || (process.env.SLOTS_DEBUG || '').trim().toLowerCase() === 'true';

async function getUpcomingSlotsText(auth, sayId, store = null) {
  if (!sayId || !auth) return { slotsStr: null, debug: 'sayId或auth空' };
  const today = new Date();
  const toYmd = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const startDate = toYmd(today);
  const endFirst = new Date(today);
  endFirst.setDate(endFirst.getDate() + FIRST_RANGE_DAYS - 1);
  const endDateFirst = toYmd(endFirst);

  if (LEGACY_GAS_STORES_API_URL && store?.botId) {
    console.log('[store-line-webhook] getUpcomingSlotsText 使用 GAS searchAvailability botId=%s sayId=%s start=%s end=%s', (store.botId || '').slice(-8), sayId, startDate, endDateFirst);
    let gas = await fetchSlotsFromGasSearchAvailability(store.botId, startDate, endDateFirst);
    if (gas.text) return { slotsStr: gas.text, debug: null };
    const endExtended = new Date(today);
    endExtended.setDate(endExtended.getDate() + MAX_DAYS_AHEAD);
    gas = await fetchSlotsFromGasSearchAvailability(store.botId, startDate, toYmd(endExtended));
    if (gas.text) return { slotsStr: gas.text, debug: null };
    console.warn('[store-line-webhook] getUpcomingSlotsText GAS 兩次皆無空位 改走 GCP sayId=%s debug=%s', sayId, gas.debug);
  } else {
    console.log('[store-line-webhook] getUpcomingSlotsText 使用 GCP findAvailableSlotsAction（GAS_URL=%s botId=%s）sayId=%s', LEGACY_GAS_STORES_API_URL ? '已設定' : '未設定', store?.botId ? '有' : '無', sayId);
  }

  try {
    let result = await findAvailableSlotsAction(auth, {
      sayId,
      startDate,
      endDate: endDateFirst,
      needPeople: 1,
      durationMin: 90,
    });
    if (!result?.status || !Array.isArray(result.data)) {
      console.warn('[store-line-webhook] getUpcomingSlotsText GCP API 無資料 sayId=%s', sayId);
      return { slotsStr: null, debug: 'GCP_無資料' };
    }
    const daysWithSlots = (result.data || []).filter((d) => d?.times && (Array.isArray(d.times) ? d.times.length : 1));
    if (daysWithSlots.length > 0) {
      return { slotsStr: formatSlotsLines(result.data), debug: null };
    }
    const endExtended = new Date(today);
    endExtended.setDate(endExtended.getDate() + MAX_DAYS_AHEAD);
    const endDateExtended = toYmd(endExtended);
    result = await findAvailableSlotsAction(auth, {
      sayId,
      startDate,
      endDate: endDateExtended,
      needPeople: 1,
      durationMin: 90,
    });
    if (!result?.status || !Array.isArray(result.data)) {
      return { slotsStr: null, debug: 'GCP_延伸無資料' };
    }
    const extendedWithSlots = (result.data || []).filter((d) => d?.times && (Array.isArray(d.times) ? d.times.length : 1));
    const take = Math.min(MIN_DAYS_WITH_SLOTS, extendedWithSlots.length);
    if (take === 0) {
      console.warn('[store-line-webhook] getUpcomingSlotsText GCP 延伸查詢仍無空位 sayId=%s start=%s end=%s', sayId, startDate, endDateExtended);
      return { slotsStr: null, debug: 'GCP_延伸無空位' };
    }
    return { slotsStr: formatSlotsLines(extendedWithSlots.slice(0, take)), debug: null };
  } catch (err) {
    console.error('[store-line-webhook] getUpcomingSlotsText 查空位失敗 sayId=%s', sayId, err);
    return { slotsStr: null, debug: `GCP_錯誤:${(err?.message || String(err)).slice(0, 50)}` };
  }
}

/** 僅「線上預約」時：查空位、組文案、回傳訊息給客人。回傳 { finalContent, replied } 供寫入準客挽留清單。拉不到 token 或 token 失效時不傳訊息給客戶。SLOTS_DEBUG=1 時「都滿了」訊息會多一行除錯資訊可貼給管理員。 */
async function replyOnlineBookingOnly(auth, { displayName, replyToken, store, accessToken }) {
  let name = (displayName && String(displayName).trim()) ? String(displayName).trim() : ' ';
  if (['未知用戶', '未知(未加好友)', '未知用户'].includes(name) || name.startsWith('未知/ID:')) name = ' ';
  let slotsStr = '';
  let slotsDebug = '';
  if (store?.sayId) {
    const out = await getUpcomingSlotsText(auth, store.sayId, store);
    slotsStr = (out?.slotsStr && String(out.slotsStr).trim()) || '';
    slotsDebug = out?.debug || '';
  }
  const template = 'Hi ${name}，想預約嗎？系統查到最近還有空位：\n${slots}\n\n有哪一個時段對妳來說比較方便嗎？\n如果想預約的話，再麻煩留下你的【姓名、電話】，稍後為妳登記保留喔。';
  let finalContent = slotsStr
    ? template.replace(/\$\{name\}/g, name).replace(/\$\{slots\}/g, slotsStr.trim())
    : `Hi ${name}，近幾天都滿了，可以呼叫貓小編協助看預約時間唷～`;
  if (!slotsStr && slotsDebug && SLOTS_DEBUG) {
    finalContent += `\n（除錯：${slotsDebug}；請將此訊息貼給管理員或看 Cloud Run Logs）`;
  }
  const token = (accessToken && String(accessToken).trim()) ? String(accessToken).trim() : '';
  let replied = false;
  if (token && replyToken && store?.isReply !== false) {
    try {
      const res = await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'post',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: finalContent }] }),
        signal: AbortSignal.timeout(10000),
      });
      replied = res.ok;
      if (!res.ok && res.status === 401) {
        console.warn('[store-line-webhook] LINE reply 401 token 可能失效，未傳訊息給客戶');
      }
    } catch {
      // 傳訊失敗不重試
    }
  } else if (!token && replyToken) {
    console.warn('[store-line-webhook] replyOnlineBookingOnly 無 token，不傳訊息給客戶');
  }
  return { finalContent, replied };
}

export async function handleStoreLineWebhook(req, res, { authClient, rawBody }) {
  if (!INTEGRATED_SHEET_SS_ID) {
    const msg = 'missing INTEGRATED_SHEET_SS_ID/LINE_STORE_SS_ID';
    await appendWebhookError(authClient, 'store-line-webhook', msg, 'env 未設定');
    sendJson(res, 200, { status: 'error', message: msg });
    return;
  }

  let payload = null;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  const destinationId = String(payload?.destination || '').trim();
  if (!destinationId) {
    console.warn('[store-line-webhook] missing destination in payload');
    sendJson(res, 200, { status: 'error', message: 'missing destination' });
    return;
  }

  const store = await findStoreByDestinationId(authClient, destinationId);
  if (!store?.channelSecret) {
    console.warn('[store-line-webhook] unknown destination, no match in 店家基本資料 E 欄:', destinationId);
    sendJson(res, 200, { status: 'error', message: `unknown destination ${destinationId}` });
    return;
  }
  const eventCount = Array.isArray(payload?.events) ? payload.events.length : 0;
  if (eventCount > 0) {
    console.log('[store-line-webhook] destination=%s store=%s events=%d', destinationId.slice(0, 12), store.storeName, eventCount);
  }

  const signature = String(req.headers['x-line-signature'] || '');
  if (!verifyLineSignature(rawBody, signature, store.channelSecret)) {
    sendJson(res, 401, { status: 'unauthorized' });
    return;
  }

  const events = Array.isArray(payload?.events) ? payload.events : [];
  if (!events.length) {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  // Best-effort: fetch profile name. If it fails, still log message.
  let accessToken = '';
  try {
    accessToken = await getLineAccessToken(store.channelId, store.channelSecret);
  } catch {
    accessToken = '';
  }

  for (const event of events) {
    // postback（例：一鍵預約 action=book_reengagement）尚未遷移，需 Core/試算表 支援後實作
    if (event?.type === 'postback' && event?.postback?.data) {
      continue;
    }
    if (event?.type !== 'message') continue;
    const userId = String(event?.source?.userId || '').trim();
    const replyToken = String(event?.replyToken || '').trim();
    const msgType = String(event?.message?.type || '');
    let msg = '';
    if (msgType === 'text') msg = String(event?.message?.text || '');
    else msg = `[${msgType || 'unknown'}]`;

    const displayName = accessToken ? await fetchDisplayName(userId, accessToken) : '';
    const filterResult = messFilter(msg);

    if (filterResult) {
      // 與 GAS 一致：會員權益、了解課程不寫入挽留清單；其餘（查詢空位、系統操作、取消挽回）寫入準客挽留清單
      const skipRetentionList = filterResult.desc === '會員權益' || filterResult.desc === '了解課程';
      let finalContent = '';
      let rowStatus = 'Pending';

      if (filterResult.desc === '查詢空位') {
        const result = await replyOnlineBookingOnly(authClient, {
          displayName,
          replyToken,
          store,
          accessToken,
        });
        finalContent = result?.finalContent ?? '';
        rowStatus = result?.replied ? 'Replied' : 'Pending';
      } else if (filterResult.type === 'IGNORE' || filterResult.desc === '系統操作') {
        finalContent = '(系統指令，無需挽留)';
      } else if (filterResult.desc === '取消挽回') {
        finalContent = '(系統紀錄，無須回覆)';
      } else {
        // 會員權益、了解課程：仍產出文案供紀錄，但 skipRetentionList 時不寫入
        const name = (displayName && String(displayName).trim()) ? String(displayName).trim() : ' ';
        const rule = MESS_FILTER_RULES.find((r) => r.desc === filterResult.desc);
        finalContent = rule?.template ? rule.template.replace(/\$\{name\}/g, name) : '';
      }

      if (!skipRetentionList && finalContent !== undefined) {
        let nameForSheet = (displayName && String(displayName).trim()) ? String(displayName).trim() : ' ';
        if (['未知用戶', '未知(未加好友)', '未知用户'].includes(nameForSheet) || nameForSheet.startsWith('未知/ID:')) nameForSheet = ' ';
        const retentionRow = [
          userId,
          nameForSheet,
          nowTaipeiStr(),
          rowStatus,
          filterResult.desc,
          finalContent,
          replyToken,
          store?.botId ?? '',
        ];
        await appendSheet(authClient, INTEGRATED_SHEET_SS_ID, RETENTION_SHEET_NAME, retentionRow);
      }
      continue;
    }

    // 真實訊息：標記挽留清單已互動（Pending→Replied）、寫入訊息一覽（含擷取手機 H 欄、名字未知寫 " "）
    await markAsReplied(authClient, userId);
    const extractedPhone = extractPhoneFromText(msg) || '';
    let nameForSheet = (displayName && String(displayName).trim()) ? String(displayName).trim() : ' ';
    if (['未知用戶', '未知(未加好友)', '未知用户'].includes(nameForSheet) || nameForSheet.startsWith('未知/ID:')) nameForSheet = ' ';
    const row = [
      nowTaipeiStr(),
      userId,
      store.storeName,
      nameForSheet,
      msg,
      '',
      '',
      extractedPhone,
      replyToken,
    ];
    try {
      await appendSheet(authClient, INTEGRATED_SHEET_SS_ID, '訊息一覽', row);
    } catch (err) {
      const errMsg = err?.message || String(err);
      console.error('[store-line-webhook] append 訊息一覽 failed:', errMsg, 'store=', store.storeName, 'userId=', userId?.slice(0, 8));
      await appendWebhookError(authClient, 'store-line-webhook', errMsg, `store=${store?.storeName || '-'} userId=${userId?.slice(0, 12) || '-'} append 訊息一覽`);
    }
  }

  sendJson(res, 200, { status: 'ok' });
}

