import fetch from 'node-fetch';
import { getAuth } from '../lib/auth.js';
import { batchUpdateValues, readSheet } from '../lib/sheets.js';

const INTEGRATED_SHEET_SS_ID = (process.env.INTEGRATED_SHEET_SS_ID || process.env.LINE_STORE_SS_ID || '').trim();
const TIMEOUT_MINUTES = Number.parseInt(process.env.PENDING_TIMEOUT_MINUTES || '3', 10);

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

async function sendReplyMessage(token, replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: String(text || '') }] }),
    signal: AbortSignal.timeout(15000),
  });
  return res.status === 200;
}

async function findStoreCredsByDestination(auth, destinationId) {
  const rows = await readSheet(auth, INTEGRATED_SHEET_SS_ID, "'店家基本資料'!A:E");
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (String(row[4] || '').trim() === destinationId) {
      return { channelId: row[2], channelSecret: row[3] };
    }
  }
  return null;
}

function parseDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function run() {
  if (!INTEGRATED_SHEET_SS_ID) throw new Error('missing INTEGRATED_SHEET_SS_ID/LINE_STORE_SS_ID');
  const auth = await getAuth();

  const rows = await readSheet(auth, INTEGRATED_SHEET_SS_ID, "'準客挽留清單'!A:H");
  if (rows.length < 2) return;

  const now = new Date();
  const updates = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const timeVal = row[2];
    const status = String(row[3] || '').trim();
    const intentType = String(row[4] || '').trim();
    const aiText = String(row[5] || '').trim();
    const replyToken = String(row[6] || '').trim();
    const destinationId = String(row[7] || '').trim();

    if (status !== 'Pending' || !replyToken || !destinationId) continue;

    if (intentType !== '查詢空位') {
      updates.push({ range: `'準客挽留清單'!D${i + 1}:D${i + 1}`, values: [['Skipped']] });
      continue;
    }

    const triggerTime = parseDate(timeVal);
    if (!triggerTime) continue;
    const diffMins = (now.getTime() - triggerTime.getTime()) / (1000 * 60);
    if (diffMins < TIMEOUT_MINUTES) continue;

    const creds = await findStoreCredsByDestination(auth, destinationId);
    if (!creds?.channelId || !creds?.channelSecret) continue;

    let token = '';
    try {
      token = await getLineAccessToken(creds.channelId, creds.channelSecret);
    } catch {
      token = '';
    }
    if (!token) continue;

    const ok = await sendReplyMessage(token, replyToken, aiText);
    updates.push({ range: `'準客挽留清單'!D${i + 1}:D${i + 1}`, values: [[ok ? 'AutoReplied' : 'SendFailed']] });
  }

  if (updates.length) await batchUpdateValues(auth, INTEGRATED_SHEET_SS_ID, updates);
}

