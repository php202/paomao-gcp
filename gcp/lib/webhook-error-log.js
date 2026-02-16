/**
 * 將 /line-webhook、/store-line-webhook 的錯誤寫入統一試算表「錯誤紀錄」
 * 試算表：LINE_STORE_SS_ID（與 泡泡貓｜line@訊息回覆一覽表 同一份）
 * 工作表：錯誤紀錄；欄位 A=時間, B=來源, C=錯誤訊息, D=上下文
 */
import { appendSheet } from './sheets.js';
import { nowTaipeiStr } from './date-tz.js';

const ERROR_LOG_SS_ID = (process.env.LINE_STORE_SS_ID || process.env.INTEGRATED_SHEET_SS_ID || '').trim();
const SHEET_NAME = '錯誤紀錄';
const MAX_MESSAGE_LENGTH = 45000;

/**
 * 寫入一筆 webhook 錯誤到試算表「錯誤紀錄」（不拋錯，失敗只 console.error）
 * @param {object} auth - Google Auth client
 * @param {string} source - 'line-webhook' | 'store-line-webhook'
 * @param {string} message - 錯誤內容
 * @param {string} [context] - 選填，額外上下文（如 storeName, userId）
 */
export async function appendWebhookError(auth, source, message, context = '') {
  if (!ERROR_LOG_SS_ID || !auth) return;
  const time = nowTaipeiStr();
  const msg = String(message || '').slice(0, MAX_MESSAGE_LENGTH);
  const ctx = String(context || '').slice(0, MAX_MESSAGE_LENGTH);
  const row = [time, source, msg, ctx];
  try {
    await appendSheet(auth, ERROR_LOG_SS_ID, SHEET_NAME, row);
  } catch (e) {
    console.error('[webhook-error-log] append 錯誤紀錄 failed:', e?.message || e);
  }
}
