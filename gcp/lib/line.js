/**
 * lib/line.js — 統一 LINE Messaging API 模組（ESM）
 *
 * 涵蓋 line-push.js 功能並新增 replyText、pushMessage、pushFlex
 * 讀 LINE Token 從環境變數
 *
 * exports: sendAdminLinePush, replyText, pushMessage, pushFlex
 */

/**
 * 發送純文字 push 給特定 userId 或 groupId
 * @param {string} to - LINE user/group/room ID
 * @param {string} text - 訊息內容
 * @param {string} token - LINE channel access token
 * @returns {Promise<boolean>}
 */
export async function pushMessage(to, text, token) {
  if (!to || !token) {
    console.warn('[line] pushMessage: missing to or token');
    return false;
  }
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, messages: [{ type: 'text', text: String(text || '') }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn('[line] pushMessage 失敗:', res.status, body?.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[line] pushMessage 錯誤:', e?.message || e);
    return false;
  }
}

/**
 * 發送 Flex Message push 給特定 userId 或 groupId
 * @param {string} to - LINE user/group/room ID
 * @param {object} flexContents - Flex Message container
 * @param {string} altText - 替代文字
 * @param {string} token - LINE channel access token
 * @returns {Promise<boolean>}
 */
export async function pushFlex(to, flexContents, altText, token) {
  if (!to || !token) {
    console.warn('[line] pushFlex: missing to or token');
    return false;
  }
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        messages: [{ type: 'flex', altText: altText || '訊息', contents: flexContents }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn('[line] pushFlex 失敗:', res.status, body?.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[line] pushFlex 錯誤:', e?.message || e);
    return false;
  }
}

/**
 * 回覆訊息（reply token）
 * @param {string} replyToken - LINE reply token
 * @param {string} text - 回覆文字
 * @param {string} token - LINE channel access token
 * @returns {Promise<boolean>}
 */
export async function replyText(replyToken, text, token) {
  if (!replyToken || !token) return false;
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: String(text || '') }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn('[line] replyText 失敗:', res.status, body?.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[line] replyText 錯誤:', e?.message || e);
    return false;
  }
}

/**
 * 發送純文字 push 給管理員（相容 line-push.js）
 * 使用 ADMIN_LINE_USER_ID + LINE_TOKEN_PAOSTAFF 環境變數
 * @param {string} text - 要推播的純文字內容
 * @returns {Promise<boolean>}
 */
export async function sendAdminLinePush(text) {
  const userId = process.env.ADMIN_LINE_USER_ID?.trim();
  const token = process.env.LINE_TOKEN_PAOSTAFF?.trim();
  if (!userId || !token) {
    console.warn('[line] 未設定 ADMIN_LINE_USER_ID 或 LINE_TOKEN_PAOSTAFF，無法發送 LINE 推播。');
    return false;
  }
  return pushMessage(userId, text, token);
}
