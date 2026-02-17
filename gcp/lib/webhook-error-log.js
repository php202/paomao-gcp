/**
 * 將 /line-webhook、/store-line-webhook 的錯誤寫入統一試算表「錯誤紀錄」
 * 試算表：LINE_STORE_SS_ID（與 泡泡貓｜line@訊息回覆一覽表 同一份）
 * 工作表：錯誤紀錄；欄位 A=時間, B=來源, C=錯誤訊息, D=上下文
 */
import { appendSheet } from './sheets.js';
import { nowTaipeiStr } from './date-tz.js';
import { google } from 'googleapis';

// Default to the same integrated sheet used by GAS UnifiedErrorLog.js.
const DEFAULT_UNIFIED_ERROR_LOG_SS_ID = '1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0';

const ERROR_LOG_SS_ID = (
  process.env.WEBHOOK_ERROR_LOG_SS_ID
  || process.env.UNIFIED_ERROR_LOG_SS_ID
  || process.env.LINE_STORE_SS_ID
  || process.env.INTEGRATED_SHEET_SS_ID
  || DEFAULT_UNIFIED_ERROR_LOG_SS_ID
).trim();

const SHEET_NAME = (process.env.WEBHOOK_ERROR_LOG_SHEET_NAME || '錯誤紀錄').trim();
const MAX_MESSAGE_LENGTH = 45000;

async function ensureErrorLogSheet(auth) {
  if (!ERROR_LOG_SS_ID || !auth || !SHEET_NAME) return;
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: ERROR_LOG_SS_ID });
  const exists = (meta.data.sheets || []).some((s) => s.properties?.title === SHEET_NAME);
  if (exists) return;

  // Create the sheet and header row (same schema as GAS UnifiedErrorLog.js).
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ERROR_LOG_SS_ID,
    requestBody: {
      requests: [
        { addSheet: { properties: { title: SHEET_NAME } } },
      ],
    },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: ERROR_LOG_SS_ID,
    range: `'${SHEET_NAME}'!A1:D1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['時間', '來源', '錯誤訊息', '上下文']] },
  });
}

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
    // If the sheet doesn't exist yet, create it once and retry.
    try {
      const em = String(e?.message || e || '');
      if (em.includes('Unable to parse range') || em.includes('Requested entity was not found')) {
        await ensureErrorLogSheet(auth);
        await appendSheet(auth, ERROR_LOG_SS_ID, SHEET_NAME, row);
        return;
      }
    } catch (_) {
      // ignore retry failures
    }
    console.error('[webhook-error-log] append 錯誤紀錄 failed:', e?.message || e);
  }
}
