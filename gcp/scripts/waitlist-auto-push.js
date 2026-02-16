import fetch from 'node-fetch';
import { getAuth } from '../lib/auth.js';
import { batchUpdateValues, readSheet } from '../lib/sheets.js';

const INTEGRATED_SHEET_SS_ID = (process.env.INTEGRATED_SHEET_SS_ID || process.env.LINE_STORE_SS_ID || '').trim();

function todayYmd() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function getLineAccessToken(channelId, channelSecret) {
  const res = await fetch('https://api.line.me/v2/oauth/accessToken', {
    method: 'post',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: String(channelId || ''),
      client_secret: String(channelSecret || ''),
    }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LINE accessToken failed: HTTP ${res.status} ${(text || '').slice(0, 200)}`);
  const json = JSON.parse(text);
  return String(json?.access_token || '').trim();
}

async function sendPushMessage(token, userId, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: userId, messages: [{ type: 'text', text: String(text || '') }] }),
    signal: AbortSignal.timeout(15000),
  });
  return res.status === 200;
}

async function findStoreCredsBySayId(auth, sayId) {
  const rows = await readSheet(auth, INTEGRATED_SHEET_SS_ID, "'店家基本資料'!A:G");
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (String(row[5] || '').trim() === String(sayId || '').trim()) {
      return { channelId: row[2], channelSecret: row[3], storeName: String(row[1] || '').trim() };
    }
  }
  return null;
}

function getWaitlistPushPrefix(dateStr, timeStr) {
  const s = String(dateStr || '').trim().replace(/\//g, '-');
  const mmdd = s.length >= 10 ? `${s.slice(5, 7)}/${s.slice(8, 10)}` : s;
  const hhmm = /^\d{2}:\d{2}/.test(String(timeStr || '').trim()) ? String(timeStr).trim().slice(0, 5) : '';
  const part = hhmm ? `${mmdd} ${hhmm}` : mmdd;
  return `真是抱歉今天的候補（${part}）沒有補位上，請使用 LINE 選單查詢近期可預約時間：\n\n`;
}

export async function run() {
  if (!INTEGRATED_SHEET_SS_ID) throw new Error('missing INTEGRATED_SHEET_SS_ID/LINE_STORE_SS_ID');
  const auth = await getAuth();

  const today = todayYmd();
  const rows = await readSheet(auth, INTEGRATED_SHEET_SS_ID, "'候補清單'!A:K");
  if (rows.length < 2) return;

  const updates = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const storeId = String(row[0] || '').trim();
    const dateStr = String(row[1] || '').trim().replace(/\//g, '-').slice(0, 10);
    const userId = String(row[2] || '').trim();
    const status = String(row[3] || '').trim();
    const timeStr = String(row[5] || '').trim();

    if (status !== 'pending') continue;
    if (!storeId || !userId) continue;
    if (dateStr !== today) continue;

    const creds = await findStoreCredsBySayId(auth, storeId);
    if (!creds?.channelId || !creds?.channelSecret) continue;

    let token = '';
    try {
      token = await getLineAccessToken(creds.channelId, creds.channelSecret);
    } catch {
      token = '';
    }
    if (!token) continue;

    const msg = getWaitlistPushPrefix(dateStr, timeStr) + 'https://lin.ee/9n5g0aV';
    const ok = await sendPushMessage(token, userId, msg);
    if (ok) {
      updates.push({ range: `'候補清單'!D${i + 1}:D${i + 1}`, values: [['auto_pushed']] });
    }
  }

  if (updates.length) await batchUpdateValues(auth, INTEGRATED_SHEET_SS_ID, updates);
}

