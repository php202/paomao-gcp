/**
 * 神美日報對外 API（報告頁面用）：無需 key，依 token/session 驗證。
 * - consumeReportToken: 若 token 在 GCP 快取則寫入「神美日報_開啟紀錄」後轉 GAS 取資料
 * - getReportByDate / submitReportShare: 轉 GAS
 * - 允許官網 (paopaomao.tw) 跨域呼叫，回應帶 CORS 標頭
 */

import { getAuth } from '../lib/auth.js';
import { consumeReportToken, callLegacyCore } from './core-api.js';
import { writeDailyReportAccessLog } from '../lib/report-access-log.js';
import { sendJson } from './http-utils.js';

const LEGACY_GAS_CORE_API_URL = (process.env.LEGACY_GAS_CORE_API_URL || process.env.PAO_CAT_CORE_API_URL || '').trim();
const CORE_KEY = (process.env.PAO_CAT_SECRET_KEY || '').trim();

/** CORS：官網嵌入報告頁時瀏覽器會跨域請求，需回傳此標頭 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function sendJsonCors(res, statusCode, obj) {
  sendJson(res, statusCode, obj, CORS_HEADERS);
}

/**
 * 處理 GET /report-api?action=...&token=... 等
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ url: URL }} opts
 */
export async function handleReportApi(req, res, opts) {
  const url = opts?.url || new URL(req.url || '/', 'http://localhost');
  const action = (url.searchParams.get('action') || '').trim();
  const token = (url.searchParams.get('token') || '').trim();
  const sessionId = (url.searchParams.get('sessionId') || '').trim();
  const date = (url.searchParams.get('date') || '').trim();
  const content = (url.searchParams.get('content') || '').trim();
  const text = (url.searchParams.get('text') || '').trim();

  if (!action) {
    sendJsonCors(res, 200, { status: 'error', message: '缺少 action' });
    return;
  }

  if (action === 'consumeReportToken') {
    if (!token) {
      sendJsonCors(res, 200, { status: 'error', message: '缺少 token' });
      return;
    }
    const payload = consumeReportToken(token);
    if (payload) {
      try {
        const auth = await getAuth();
        const logResult = await writeDailyReportAccessLog(auth, {
          dateStr: payload.dateStr,
          role: payload.role,
          userId: payload.userId,
          employeeCode: payload.employeeCode,
          employeeName: payload.employeeName ?? '',
          storeIds: payload.storeIds ?? [],
          groupId: payload.groupId ?? '',
          groupName: payload.groupName ?? '',
          userName: payload.userName ?? '',
        });
        if (!logResult.ok) {
          console.warn('[report-api] writeDailyReportAccessLog:', logResult.message);
        }
      } catch (e) {
        console.warn('[report-api] writeDailyReportAccessLog error:', e?.message);
      }
      if (!LEGACY_GAS_CORE_API_URL || !CORE_KEY) {
        sendJsonCors(res, 200, { status: 'error', message: '日報後端未設定，請聯絡管理員。' });
        return;
      }
      const createRes = await callLegacyCore('createReportToken', {
        role: payload.role,
        storeIds: (payload.storeIds || []).join(','),
        userId: payload.userId,
        employeeCode: payload.employeeCode,
      });
      const t2 = createRes?.token;
      if (!t2) {
        sendJsonCors(res, 200, { status: 'error', message: createRes?.message || '取得報表失敗' });
        return;
      }
      const out = await callLegacyCore('consumeReportToken', { token: t2 }, { method: 'get' });
      sendJsonCors(res, 200, out);
      return;
    }
    const out = await callLegacyCore('consumeReportToken', { token }, { method: 'get' });
    sendJsonCors(res, 200, out);
    return;
  }

  if (action === 'getReportByDate') {
    if (!sessionId || !date) {
      sendJsonCors(res, 200, { status: 'error', message: '缺少 sessionId 或 date' });
      return;
    }
    const out = await callLegacyCore('getReportByDate', { sessionId, date }, { method: 'get' });
    sendJsonCors(res, 200, out);
    return;
  }

  if (action === 'submitReportShare') {
    const textToUse = content || text;
    if (!sessionId || !textToUse) {
      sendJsonCors(res, 200, { status: 'error', message: '缺少 sessionId 或 content' });
      return;
    }
    const out = await callLegacyCore('submitReportShare', { sessionId, content: textToUse }, { method: 'get' });
    sendJsonCors(res, 200, out);
    return;
  }

  sendJsonCors(res, 200, { status: 'error', message: `未知 action: ${action}` });
}
