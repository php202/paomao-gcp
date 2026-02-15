/**
 * GCP 備援：LINE「我要打卡」處理（當 GAS urlfetch 額度用盡時，可改由 GCP 接收 Webhook）
 * 環境變數：LINE_STAFF_SS_ID, LINE_TOKEN_PAOSTAFF, CHECK_IN_LINK（可選，預設 https://www.paopaomao.tw/checkin）, LINE_CHANNEL_SECRET（在 server 驗證用）
 */

import crypto from 'crypto';
import fetch from 'node-fetch';
import { readSheet, appendSheet } from '../lib/sheets.js';

const CHECK_IN_LINK = process.env.CHECK_IN_LINK || 'https://www.paopaomao.tw/checkin';
const LINE_STAFF_SS_ID = process.env.LINE_STAFF_SS_ID;
const LINE_TOKEN_PAOSTAFF = process.env.LINE_TOKEN_PAOSTAFF;
const STAFF_SHEET = '員工清單';
const MANAGER_SHEET = '管理者清單';
const LOG_SHEET = '員工打卡紀錄';

/** 與 GAS IsUserAuthorized 一致：員工清單 D 欄 (index 3)= userId，管理者清單 A 欄 (index 0)= userId */
export async function isUserAuthorized(auth, spreadsheetId, userId) {
  const result = {
    isAuthorized: false,
    identity: [],
    managedStores: [],
    workStores: [],
    employeeCode: '',
  };
  if (!userId || !spreadsheetId) return result;
  try {
    const emData = await readSheet(auth, spreadsheetId, `'${STAFF_SHEET}'!A:L`);
    for (let i = 1; i < emData.length; i++) {
      const row = emData[i];
      if (String(row[3] || '').trim() === userId) {
        result.isAuthorized = true;
        result.identity.push('employee');
        if (row[11] != null && String(row[11]).trim() !== '') result.employeeCode = String(row[11]).trim();
        if (row[5] != null && String(row[5]).trim() !== '') result.workStores.push(String(row[5]).trim());
      }
    }
    const maData = await readSheet(auth, spreadsheetId, `'${MANAGER_SHEET}'!A:C`);
    for (let i = 1; i < maData.length; i++) {
      const row = maData[i];
      if (String(row[0] || '').trim() === userId) {
        result.isAuthorized = true;
        result.identity.push('manager');
        if (row[2] && row[2] !== '') result.managedStores.push(row[2]);
      }
    }
    result.identity = [...new Set(result.identity)];
    result.workStores = [...new Set(result.workStores)];
    result.managedStores = [...new Set(result.managedStores)];
  } catch (e) {
    console.error('[line-checkin] isUserAuthorized error:', e.message);
  }
  return result;
}

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

/** 送出物件訊息（template 等）到 LINE */
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

/** 無權限時回覆 */
async function noAuthorized(replyToken) {
  const msg = '⚠️ 你的帳號尚未開通，麻煩通知泡泡貓負責顧問！';
  await sendLineReplyText(replyToken, msg, LINE_TOKEN_PAOSTAFF);
}

/** 寫入員工打卡紀錄：與 GAS logCheckInAttempt 一致 [userId, date, '', '', uuid] */
async function logCheckInAttempt(auth, spreadsheetId, userId, uuid) {
  try {
    await appendSheet(auth, spreadsheetId, LOG_SHEET, [
      userId,
      new Date().toISOString(),
      '',
      '',
      uuid,
    ]);
  } catch (e) {
    console.error('[line-checkin] logCheckInAttempt error:', e.message);
  }
}

/**
 * 處理「我要打卡」：權限檢查 → 產生 uuid 與連結 → 回傳按鈕模板 → 寫入打卡紀錄
 */
export async function handleCheckInRequest(auth, replyToken, userId) {
  if (!LINE_STAFF_SS_ID || !LINE_TOKEN_PAOSTAFF) {
    await sendLineReplyText(replyToken, '🚧 系統設定不完整，請聯繫管理員。', LINE_TOKEN_PAOSTAFF);
    return;
  }
  const authResult = await isUserAuthorized(auth, LINE_STAFF_SS_ID, userId);
  if (!authResult.isAuthorized) {
    await noAuthorized(replyToken);
    return;
  }
  const uuid = crypto.randomUUID();
  const uri = `${CHECK_IN_LINK}?userId=${encodeURIComponent(userId)}&uuid=${encodeURIComponent(uuid)}`;
  const dayOfMonth = new Date().getDate();
  const actions = [{ type: 'uri', label: '📍 點擊開啟打卡', uri }];
  if (dayOfMonth >= 1 && dayOfMonth <= 7) {
    actions.push({ type: 'message', label: '上月小費', text: '上月小費' });
  }
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
  await logCheckInAttempt(auth, LINE_STAFF_SS_ID, userId, uuid);
}
