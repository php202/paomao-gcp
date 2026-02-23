import fetch from 'node-fetch';
import { verifyLineSignature } from '../lib/line-webhook.js';
import { appendSheet, readSheet, writeSheet, batchUpdateValues } from '../lib/sheets.js';
import { getDirectStoreReplyStatusText } from '../lib/store-reply-status.js';
import { sendAdminLinePush } from '../lib/line-push.js';
import { sendJson } from './http-utils.js';

/** 管理員級錯誤只推給 Robby，客戶只收到通用訊息 */
const CUSTOMER_FALLBACK_MSG = '暫時無法處理，請稍後再試。';

const PAOPAO_STORE_SS_ID = (process.env.PAOPAO_STORE_SS_ID || '').trim();
/** 店家回覆狀態報表用（各店訊息一覽表，含店家名、狀態欄）；與員工打卡同一份 */
const LINE_STORE_SS_ID = (process.env.LINE_STORE_SS_ID || '').trim();
const PAOPAO_CHANNEL_SECRET = (process.env.LINE_CHANNEL_SECRET_PAOPAO || '').trim();
const PAOPAO_TOKEN = (process.env.LINE_TOKEN_PAOPAO || '').trim();
/** 請款 ACH 紀錄試算表（與 GAS Config EXTERNAL_SS_ID 一致）；未設則不處理「正確」postback */
const EXTERNAL_SS_ID = (process.env.EXTERNAL_SS_ID || '').trim();
/** 工作表分頁名稱（須與試算表底部標籤完全一致，含斜線／繁簡體）；可設 ACH_SHEET_NAME 覆寫 */
const ACH_SHEET_NAME = (process.env.ACH_SHEET_NAME || '2026/ACH紀錄').trim() || '2026/ACH紀錄';

async function replyText(replyToken, text) {
  if (!replyToken || !PAOPAO_TOKEN) return;
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    headers: { Authorization: `Bearer ${PAOPAO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: String(text || '') }] }),
    signal: AbortSignal.timeout(15000),
  });
}

async function fetchDisplayName(userId) {
  if (!userId || !PAOPAO_TOKEN) return '';
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      method: 'get',
      headers: { Authorization: `Bearer ${PAOPAO_TOKEN}` },
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

/** 取得 LINE 群組顯示名稱（用於訊息一覽 C 欄顯示真實群組名而非 UUID） */
async function fetchGroupName(groupId) {
  if (!groupId || !PAOPAO_TOKEN) return '';
  try {
    const res = await fetch(`https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/summary`, {
      method: 'get',
      headers: { Authorization: `Bearer ${PAOPAO_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return '';
    const json = await res.json();
    return String(json?.groupName || '').trim();
  } catch {
    return '';
  }
}

/** 群組/聊天室內取得顯示名稱（與 GAS Core.getUserDisplayName 行為一致） */
async function fetchDisplayNameInSource(userId, source) {
  if (!userId || !PAOPAO_TOKEN) return '';
  let url;
  if (source?.groupId) {
    url = `https://api.line.me/v2/bot/group/${encodeURIComponent(source.groupId)}/member/${encodeURIComponent(userId)}`;
  } else if (source?.roomId) {
    url = `https://api.line.me/v2/bot/room/${encodeURIComponent(source.roomId)}/member/${encodeURIComponent(userId)}`;
  } else {
    return fetchDisplayName(userId);
  }
  try {
    const res = await fetch(url, {
      method: 'get',
      headers: { Authorization: `Bearer ${PAOPAO_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return await fetchDisplayName(userId);
    const json = JSON.parse(await res.text());
    const name = String(json?.displayName || '').trim();
    return name || (await fetchDisplayName(userId));
  } catch {
    return await fetchDisplayName(userId);
  }
}

function parsePostbackParams(data) {
  const params = {};
  if (!data || typeof data !== 'string') return params;
  data.split('&').forEach((p) => {
    const idx = p.indexOf('=');
    if (idx >= 0) {
      const k = p.substring(0, idx);
      let v = p.substring(idx + 1);
      try {
        v = decodeURIComponent(v);
      } catch {}
      params[k] = v;
    }
  });
  return params;
}

/** 台灣時間 yyyy/MM/dd HH:mm（與 GAS 一致） */
function formatTaiwanDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const s = d.toLocaleString('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const [datePart, timePart] = s.split(', ');
  const [y, m, day] = datePart.split('-');
  return `${y}/${m}/${day} ${timePart.slice(0, 5)}`;
}

/** 與 GAS LineBot.pushFlexReceipt 相同結構的收據 Push */
async function pushFlexReceipt(targetId, storeName, odooId, operatorName) {
  if (!targetId || !PAOPAO_TOKEN) return;
  const timestamp = formatTaiwanDateTime(new Date());
  const safeStoreName = storeName || '未知店家';
  const payload = {
    to: targetId,
    messages: [
      {
        type: 'flex',
        altText: '✅ 核銷完成憑證',
        contents: {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#d1d1d1',
            contents: [{ type: 'text', text: '已確認 / CONFIRMED', weight: 'bold', color: '#555555', size: 'sm', align: 'center' }],
          },
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'text', text: safeStoreName, weight: 'bold', size: 'lg', align: 'center', color: '#333333' },
              { type: 'separator', margin: 'md' },
              {
                type: 'box',
                layout: 'vertical',
                margin: 'md',
                spacing: 'sm',
                contents: [
                  { type: 'box', layout: 'baseline', contents: [{ type: 'text', text: 'Odoo 單號', color: '#aaaaaa', size: 'xs', flex: 2 }, { type: 'text', text: String(odooId), wrap: true, color: '#666666', size: 'xs', flex: 4 }] },
                  { type: 'box', layout: 'baseline', contents: [{ type: 'text', text: '操作人員', color: '#aaaaaa', size: 'xs', flex: 2 }, { type: 'text', text: operatorName || '操作者', wrap: true, color: '#666666', size: 'xs', flex: 4 }] },
                  { type: 'box', layout: 'baseline', contents: [{ type: 'text', text: '確認時間', color: '#aaaaaa', size: 'xs', flex: 2 }, { type: 'text', text: timestamp, wrap: true, color: '#666666', size: 'xs', flex: 4 }] },
                ],
              },
            ],
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [{ type: 'text', text: '此單據已結案，請勿重複操作', size: 'xxs', color: '#bbbbbb', align: 'center' }],
          },
        },
      },
    ],
  };
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    headers: { Authorization: `Bearer ${PAOPAO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
}

/** 請款「正確」按鈕 postback：寫入 ACH 試算表 G 欄並回覆＋推播收據（與 GAS handleConfirmPostback_ 對齊） */
async function handleConfirmPostback(authClient, event) {
  const params = parsePostbackParams(event?.postback?.data);
  if (params.action !== 'confirm') return;
  const odooId = params.odoo != null ? String(params.odoo).trim() : '';
  const storeNameFromPostback = params.storeName != null ? String(params.storeName).trim() : '';
  if (!odooId) {
    await replyText(event.replyToken, '⚠️ 無法取得單號，請重試。');
    return;
  }
  if (!EXTERNAL_SS_ID) {
    await sendAdminLinePush('[PAOPAO 請款] 伺服器未設定 ACH 試算表 (EXTERNAL_SS_ID)，請聯絡管理員設定。').catch(() => {});
    await replyText(event.replyToken, CUSTOMER_FALLBACK_MSG);
    return;
  }
  const source = event.source || {};
  const targetId = source.groupId || source.roomId || source.userId;
  const userId = source.userId;
  let userName = await fetchDisplayNameInSource(userId, source);
  if (!userName) userName = '操作者';

  let rows;
  try {
    rows = await readSheet(authClient, EXTERNAL_SS_ID, `'${ACH_SHEET_NAME}'!A:P`);
  } catch (err) {
    const errMsg = err?.message || String(err);
    console.error('[paopao-webhook] readSheet ACH 失敗:', errMsg, 'sheet=', ACH_SHEET_NAME);
    await sendAdminLinePush(`[PAOPAO 請款] 無法讀取工作表「${ACH_SHEET_NAME}」。請確認：\n1. 試算表底部是否有此名稱的分頁\n2. Cloud Run 服務帳號是否有編輯權限\n\n錯誤: ${errMsg}`).catch(() => {});
    await replyText(event.replyToken, CUSTOMER_FALLBACK_MSG);
    return;
  }
  const colP = 16;
  const colB = 2;
  const colG = 7;
  let rowIndex = -1;
  let resolvedStoreName = storeNameFromPostback;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const pVal = row[colP - 1] != null ? String(row[colP - 1]).trim() : '';
    const bVal = row[colB - 1] != null ? String(row[colB - 1]).trim() : '';
    if (pVal === odooId && (bVal === storeNameFromPostback || !storeNameFromPostback)) {
      rowIndex = i + 1;
      resolvedStoreName = bVal || storeNameFromPostback;
      break;
    }
  }
  if (rowIndex < 0) {
    await replyText(event.replyToken, `⚠️ 找不到符合的資料列（單號: ${odooId}${storeNameFromPostback ? '，店名: ' + storeNameFromPostback : ''}），請確認試算表內 P 欄與 B 欄。`);
    return;
  }
  const existingStatus = rows[rowIndex - 1][colG - 1];
  if (existingStatus != null && String(existingStatus).trim() !== '') {
    await replyText(event.replyToken, `⚠️ ${userName} 您好，\n這筆資料已經確認過囉！\n\n紀錄：\n${existingStatus}`);
    return;
  }
  const now = formatTaiwanDateTime(new Date());
  try {
    await batchUpdateValues(authClient, EXTERNAL_SS_ID, [
      { range: `'${ACH_SHEET_NAME}'!G${rowIndex}`, values: [[`${now} 由 ${userName} 確認`]] },
    ]);
  } catch (err) {
    await sendAdminLinePush(`[PAOPAO 請款] 寫入試算表失敗（單號: ${odooId}）\n\n${err?.message || err}`).catch(() => {});
    await replyText(event.replyToken, CUSTOMER_FALLBACK_MSG);
    return;
  }
  await replyText(event.replyToken, '✅ 已確認，請稍候收據。');
  try {
    await pushFlexReceipt(targetId, resolvedStoreName, odooId, userName);
  } catch (e) {
    console.error('[paopao-webhook] pushFlexReceipt failed:', e?.message || e);
  }
}

export async function handlePaopaoWebhook(req, res, { authClient, rawBody }) {
  if (!PAOPAO_STORE_SS_ID) {
    sendJson(res, 200, { status: 'error', message: 'PAOPAO_STORE_SS_ID missing' });
    return;
  }

  // If this is a non-LINE payload (cookie/token update), allow without signature.
  let body = null;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (body?.cookie) {
    await writeSheet(authClient, PAOPAO_STORE_SS_ID, "'安全庫存'!P1:Q1", [[String(body.cookie), new Date().toISOString()]]);
    sendJson(res, 200, { status: 'success', message: 'Cookie Updated' });
    return;
  }
  if (body?.token) {
    await writeSheet(authClient, PAOPAO_STORE_SS_ID, "'預約表單'!C2:D2", [[String(body.token), new Date().toISOString()]]);
    sendJson(res, 200, { status: 'success', message: 'Token Updated' });
    return;
  }

  const signature = String(req.headers['x-line-signature'] || '');
  if (!PAOPAO_CHANNEL_SECRET || !verifyLineSignature(rawBody, signature, PAOPAO_CHANNEL_SECRET)) {
    sendJson(res, 401, { status: 'unauthorized' });
    return;
  }

  const events = Array.isArray(body?.events) ? body.events : [];
  for (const event of events) {
    if (event?.type === 'postback' && event?.postback?.data) {
      const params = parsePostbackParams(event.postback.data);
      if (params.action === 'confirm') {
        await handleConfirmPostback(authClient, event);
      }
      continue;
    }
    if (event?.type === 'message' && event?.message?.type === 'text') {
      const text = String(event.message.text || '').trim();
      if (text.includes('店家回覆狀態')) {
        try {
          if (!LINE_STORE_SS_ID) {
            await replyText(event.replyToken, '店家回覆狀態需設定 LINE_STORE_SS_ID（各店訊息一覽表），請聯繫管理員。');
          } else {
            const result = await getDirectStoreReplyStatusText(authClient, LINE_STORE_SS_ID);
            const replyMsg = result.ok ? result.text : (result.message || '無法取得店家回覆狀態，請稍後再試。');
            await replyText(event.replyToken, replyMsg);
          }
        } catch (err) {
          const fallback = '查詢店家回覆狀態時發生錯誤，請稍後再試或聯繫管理員。';
          await replyText(event.replyToken, fallback).catch(() => {});
        }
      }
    }
  }

  // Log text messages into PAOPAO 試算表（PAOPAO_STORE_SS_ID）的工作表「訊息一覽」
  // 試算表範例：https://docs.google.com/spreadsheets/d/1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE/edit
  // 該試算表內必須有名為「訊息一覽」的工作表，且 Cloud Run 的 Service Account 需有編輯權限
  // C 欄「群組」寫入 LINE 群組真實名稱，不寫 UUID
  const PAOPAO_MESSAGE_SHEET_NAME = '訊息一覽';
  const logRows = [];
  for (const event of events) {
    if (event?.type !== 'message' || event?.message?.type !== 'text') continue;
    const userId = String(event?.source?.userId || '').trim();
    const msg = String(event?.message?.text || '');
    const replyToken = String(event?.replyToken || '').trim();
    const sourceType = String(event?.source?.type || 'user');
    let sourceName;
    if (sourceType === 'group') {
      const groupId = String(event?.source?.groupId || '');
      const groupName = await fetchGroupName(groupId);
      sourceName = groupName ? `[群] ${groupName}` : '[群] 未知群組';
    } else if (sourceType === 'room') {
      sourceName = `[聊天室] ${String(event?.source?.roomId || '')}`;
    } else {
      sourceName = '個人私訊';
    }
    const userName = await fetchDisplayName(userId);
    logRows.push([new Date().toISOString(), replyToken, sourceName, userName, msg, event?.source?.groupId || '', event?.source?.roomId || '']);
  }
  for (const row of logRows) {
    await appendSheet(authClient, PAOPAO_STORE_SS_ID, PAOPAO_MESSAGE_SHEET_NAME, row);
  }

  sendJson(res, 200, { status: 'ok' });
}

