import fetch from 'node-fetch';
import { verifyLineSignature } from '../lib/line-webhook.js';
import { appendSheet, writeSheet } from '../lib/sheets.js';
import { getDirectStoreReplyStatusText } from '../lib/store-reply-status.js';
import { sendJson } from './http-utils.js';

const PAOPAO_STORE_SS_ID = (process.env.PAOPAO_STORE_SS_ID || '').trim();
/** 店家回覆狀態報表用（各店訊息一覽表，含店家名、狀態欄）；與員工打卡同一份 */
const LINE_STORE_SS_ID = (process.env.LINE_STORE_SS_ID || '').trim();
const PAOPAO_CHANNEL_SECRET = (process.env.LINE_CHANNEL_SECRET_PAOPAO || '').trim();
const PAOPAO_TOKEN = (process.env.LINE_TOKEN_PAOPAO || '').trim();

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
    if (event?.type === 'message' && event?.message?.type === 'text') {
      const text = String(event.message.text || '').trim();
      if (text.includes('店家回覆狀態')) {
        if (!LINE_STORE_SS_ID) {
          await replyText(event.replyToken, '店家回覆狀態需設定 LINE_STORE_SS_ID（各店訊息一覽表），請聯繫管理員。');
        } else {
          const result = await getDirectStoreReplyStatusText(authClient, LINE_STORE_SS_ID);
          await replyText(event.replyToken, result.ok ? result.text : (result.message || '無法取得店家回覆狀態，請稍後再試。'));
        }
      }
    }
  }

  // Log text messages into PAOPAO sheet: '訊息一覽'
  const logRows = [];
  for (const event of events) {
    if (event?.type !== 'message' || event?.message?.type !== 'text') continue;
    const userId = String(event?.source?.userId || '').trim();
    const msg = String(event?.message?.text || '');
    const replyToken = String(event?.replyToken || '').trim();
    const sourceType = String(event?.source?.type || 'user');
    const sourceName = sourceType === 'group' ? `[群] ${String(event?.source?.groupId || '')}` : sourceType === 'room' ? `[聊天室] ${String(event?.source?.roomId || '')}` : '個人私訊';
    const userName = await fetchDisplayName(userId);
    logRows.push([new Date().toISOString(), replyToken, sourceName, userName, msg, event?.source?.groupId || '', event?.source?.roomId || '']);
  }
  for (const row of logRows) {
    await appendSheet(authClient, PAOPAO_STORE_SS_ID, '訊息一覽', row);
  }

  sendJson(res, 200, { status: 'ok' });
}

