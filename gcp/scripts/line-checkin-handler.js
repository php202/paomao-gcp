/**
 * GCP：LINE「我要打卡」處理 — PostgreSQL 版
 * 完全脫離 Google Sheets，使用本機 DB
 */

import crypto from 'crypto';
import fetch from 'node-fetch';
import { nowTaipeiStr } from '../lib/date-tz.js';
import { isUserAuthorizedDB, saveRegisterRequest } from '../lib/db.js';
import pool from '../lib/db.js';
import { createCheckinTicket } from './checkin-api.js';

const CHECK_IN_LINK = process.env.CHECK_IN_LINK || 'https://www.paopaomao.tw/checkin';
const LINE_TOKEN_PAOSTAFF = process.env.LINE_TOKEN_PAOSTAFF;

// Debounce：防止同一員工短時間內重複觸發「我要打卡」
// Map<userId, timestamp>
const lastCheckinRequest = new Map();
const CHECKIN_REQUEST_COOLDOWN_MS = 30 * 1000; // 30 秒內不重複產生 ticket

/** 送出一則文字回覆到 LINE */
async function sendLineReplyText(replyToken, text, token) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LINE Reply 失敗: ${(body || res.status).toString().slice(0, 200)}`);
  }
}

async function sendLineReplyObj(replyToken, messages, token) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LINE Reply 失敗: ${(body || res.status).toString().slice(0, 200)}`);
  }
}

async function noAuthorized(replyToken) {
  await sendLineReplyText(replyToken, '⚠️ 你的帳號尚未開通，麻煩通知泡泡貓負責顧問！', LINE_TOKEN_PAOSTAFF);
}

/**
 * 舊版相容：isUserAuthorized(auth, spreadsheetId, userId) 介面
 * 內部改用 DB，忽略 auth 和 spreadsheetId
 */
export async function isUserAuthorized(auth, spreadsheetId, userId) {
  return isUserAuthorizedDB(userId);
}

/**
 * 處理「我要打卡」：權限檢查 → 產生 uuid 與連結 → 回傳按鈕模板
 */
export async function handleCheckInRequest(auth, replyToken, userId) {
  if (!LINE_TOKEN_PAOSTAFF) {
    await sendLineReplyText(replyToken, '🚧 系統設定不完整，請聯繫管理員。', LINE_TOKEN_PAOSTAFF);
    return;
  }

  const authResult = await isUserAuthorizedDB(userId);
  if (!authResult.isAuthorized) {
    const msg = authResult.sheetError
      ? '⚠️ 系統暫時無法驗證權限，請稍後再試。若持續出現請通知泡泡貓負責顧問。'
      : '⚠️ 你的帳號尚未開通，麻煩通知泡泡貓負責顧問！';
    await sendLineReplyText(replyToken, msg, LINE_TOKEN_PAOSTAFF);
    return;
  }

  // Debounce：30 秒內重複「我要打卡」直接提醒，不產新 ticket
  const lastReq = lastCheckinRequest.get(userId);
  if (lastReq && (Date.now() - lastReq) < CHECKIN_REQUEST_COOLDOWN_MS) {
    await sendLineReplyText(replyToken, '⏳ 你剛剛已申請打卡，請直接點擊上方連結開啟打卡頁面。', LINE_TOKEN_PAOSTAFF);
    return;
  }
  lastCheckinRequest.set(userId, Date.now());

  const uuid = crypto.randomUUID();
  // 在 checkin-api 的記憶體 ticket store 建立 ticket
  createCheckinTicket(uuid, userId);

  const uri = `${CHECK_IN_LINK}?userId=${encodeURIComponent(userId)}&uuid=${encodeURIComponent(uuid)}`;
  const dayOfMonth = new Date().getDate();
  const actions = [{ type: 'uri', label: '📍 點擊開啟打卡', uri }];
  if (dayOfMonth >= 1 && dayOfMonth <= 7) {
    actions.push({ type: 'message', label: '上月小費', text: '上月小費' });
  }
  actions.push({ type: 'uri', label: '📊 員工系統', uri: 'https://dashboard.paopaomao.tw/employee-guide.html' });
  const message = {
    type: 'template',
    altText: '請進行打卡驗證',
    template: {
      type: 'buttons',
      title: '打卡驗證',
      text: '請點擊下方按鈕開啟打卡頁面。',
      actions,
    },
  };
  await sendLineReplyObj(replyToken, [message], LINE_TOKEN_PAOSTAFF);

  // 記錄到 DB
  try {
    await pool.query(
      'INSERT INTO checkin_records (line_user_id, employee_name, store_name, check_type, source, note) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, authResult.name || '', '', 'attempt', 'line', `uuid:${uuid}`]
    );
  } catch (e) {
    console.error('[line-checkin] logCheckInAttempt DB error:', e.message);
  }
}

/** 從訊息中解析姓名 */
function extractNameFromMessage(msg) {
  if (!msg) return null;
  const text = String(msg).trim();
  const namePattern = /(?:姓名|Name)[:：\s]*([^\n\r]+)/i;
  const match = text.match(namePattern);
  if (match && match[1]) return cleanString(match[1]);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  const invalid = (line) =>
    line.includes('我要註冊') || line.includes('===') || line.includes('訊息留下') || /^\d+$/.test(line);
  const potentialNames = lines.filter((l) => !invalid(l));
  if (potentialNames.length > 0 && potentialNames[0].length < 10) return cleanString(potentialNames[0]);
  return null;
}

function cleanString(str) {
  return str.replace(/[^\u4e00-\u9fa5a-zA-Z\s]/g, '').trim();
}

async function fetchLineDisplayName(userId, token) {
  if (!userId || !token) return '';
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      method: 'get',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return '';
    const json = await res.json();
    return String(json?.displayName || '').trim();
  } catch {
    return '';
  }
}

/**
 * 處理「我要註冊」— DB 版
 */
export async function handleRegisterRequest(auth, replyToken, userId, message) {
  if (!LINE_TOKEN_PAOSTAFF) {
    await sendLineReplyText(replyToken, '🚧 系統設定不完整，請聯繫管理員。', LINE_TOKEN_PAOSTAFF);
    return;
  }

  const authResult = await isUserAuthorizedDB(userId);
  if (authResult.isAuthorized) {
    await sendLineReplyText(replyToken, '您已是正式員工/管理員，無須再次註冊。', LINE_TOKEN_PAOSTAFF);
    return;
  }

  // 檢查是否已申請過
  try {
    const { rows } = await pool.query(
      "SELECT id FROM employees WHERE line_user_id = $1 AND title = '待審核'",
      [userId]
    );
    if (rows.length > 0) {
      await sendLineReplyText(replyToken, '您的申請正在審核中，請勿重複傳送。', LINE_TOKEN_PAOSTAFF);
      return;
    }
  } catch (e) {
    // continue
  }

  const extractedName = extractNameFromMessage(message);
  if (!extractedName) {
    await sendLineReplyText(
      replyToken,
      '⚠️ 系統無法辨識您的名字。\n\n請依照格式輸入，例如：\n【我要註冊】\n姓名：王小明\n電話：0912345678',
      LINE_TOKEN_PAOSTAFF,
    );
    return;
  }

  // 比對員工清單（從 DB）
  let matchName = null;
  try {
    const { rows } = await pool.query(
      "SELECT name FROM employees WHERE REPLACE(name, ' ', '') = $1 AND is_active = TRUE LIMIT 1",
      [extractedName.replace(/\s/g, '')]
    );
    if (rows.length > 0) matchName = rows[0].name;
  } catch (e) {
    // continue
  }

  const isExternal = !matchName;
  const displayName = isExternal ? extractedName : matchName;
  const lineProfileName = await fetchLineDisplayName(userId, LINE_TOKEN_PAOSTAFF);

  // 寫入 DB
  await saveRegisterRequest(userId, displayName);

  if (isExternal) {
    await sendLineReplyText(
      replyToken,
      `✅ 申請已送出！\n\n系統未在員工清單中找到「${extractedName}」，已改由內部審核。\n請等待管理員開通權限。`,
      LINE_TOKEN_PAOSTAFF,
    );
  } else {
    await sendLineReplyText(
      replyToken,
      `✅ 申請已送出！\n\n系統已確認您的身分：${matchName}\n請等待管理員開通權限。`,
      LINE_TOKEN_PAOSTAFF,
    );
  }
}
