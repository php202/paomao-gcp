import { sendJson } from './http-utils.js';
import { writeSheet } from '../lib/sheets.js';
import { verifyCustomerInfoToken } from '../lib/customer-token.js';
import { INTEGRATED_HEADERS, readCustomerStateRow, refreshCustomerByPhone } from '../lib/customer-profile.js';

const LINE_STORE_SS_ID = (process.env.LINE_STORE_SS_ID || process.env.INTEGRATED_SHEET_SS_ID || '').trim();

function fmtTaipeiMinute() {
  // yyyy-MM-dd HH:mm in Taipei
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16);
}

function colToA1Letter(col1Based) {
  let n = Number(col1Based);
  if (!Number.isFinite(n) || n < 1) return 'A';
  let s = '';
  while (n > 0) {
    const mod = (n - 1) % 26;
    s = String.fromCharCode(65 + mod) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function jsonCors(res, obj) {
  sendJson(res, 200, obj, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
  });
}

function error(res, message) {
  jsonCors(res, { status: 'error', message: String(message || 'error') });
}

export async function handleCustomerApi(req, res, { authClient, url }) {
  if (!LINE_STORE_SS_ID) {
    error(res, 'LINE_STORE_SS_ID 未設定');
    return;
  }
  const action = String(url.searchParams.get('action') || '').trim();

  if (action === 'getCustomerInfo') {
    const token = String(url.searchParams.get('token') || '').trim();
    if (!token) {
      error(res, '請提供 token 參數');
      return;
    }
    const v = verifyCustomerInfoToken(token);
    if (!v.ok) {
      error(res, '此連結已失效或 token 不存在，請從「明天預約清單」取得連結。');
      return;
    }

    // 1) Try read existing row
    let createdNow = false;
    let readRes = await readCustomerStateRow(authClient, v.phone);
    if (!readRes.rowIndex) {
      // 2) Auto-create/refresh if missing (align GAS behavior)
      try {
        const r = await refreshCustomerByPhone(authClient, v.phone, { leaveEmployeeEmpty: true });
        createdNow = r?.created === true;
      } catch (e) {
        // Continue to re-read; if still missing, return a clear error.
        console.warn('[customer-api] refreshCustomerByPhone failed:', e?.message || e);
      }
      readRes = await readCustomerStateRow(authClient, v.phone);
    }

    if (!readRes.rowIndex || !readRes.row) {
      error(res, `查無此客人（${v.phone}）。已嘗試產出資料，若仍無列請確認該手機是否曾出現在問卷／員工填寫／明日預約中。`);
      return;
    }

    const data = {};
    for (let i = 0; i < INTEGRATED_HEADERS.length; i++) {
      const key = INTEGRATED_HEADERS[i];
      const val = readRes.row[i];
      data[key] = val != null ? String(val).trim() : '';
    }
    const quest = String(data['客人問卷'] || '').trim();
    const hasQuestionnaire = !!(quest && quest !== '—');

    jsonCors(res, {
      status: 'ok',
      data,
      flags: { hasQuestionnaire, createdNow },
    });
    return;
  }

  if (action === 'updateAiAdjustmentSuggestion') {
    const token = String(url.searchParams.get('token') || '').trim();
    const suggestion = String(url.searchParams.get('suggestion') || '').trim();
    const userId = String(url.searchParams.get('userId') || '').trim();
    if (!token) {
      error(res, '請提供 token 參數');
      return;
    }
    if (!suggestion) {
      error(res, '請提供 suggestion 參數');
      return;
    }
    const v = verifyCustomerInfoToken(token);
    if (!v.ok) {
      error(res, '此連結已失效或 token 不存在');
      return;
    }

    const readRes = await readCustomerStateRow(authClient, v.phone);
    if (!readRes.rowIndex || !readRes.row) {
      error(res, `查無此客人（${v.phone}）`);
      return;
    }

    const idx0 = INTEGRATED_HEADERS.indexOf('ai調整建議');
    if (idx0 < 0) {
      error(res, '表頭缺少 ai調整建議 欄位');
      return;
    }

    const currentVal = readRes.row[idx0] != null ? String(readRes.row[idx0]).trim() : '';
    const who = userId || '—';
    const entry = `[${fmtTaipeiMinute()}, ${who}, ${suggestion}]`;
    const newVal = currentVal ? `${currentVal}\n\n${entry}` : entry;

    const colLetter = colToA1Letter(idx0 + 1);
    await writeSheet(authClient, LINE_STORE_SS_ID, `'客人消費狀態'!${colLetter}${readRes.rowIndex}:${colLetter}${readRes.rowIndex}`, [[newVal]]);
    jsonCors(res, { status: 'ok', message: '已寫入建議' });
    return;
  }

  error(res, `未知 action: ${action || '(empty)'}`);
}

