import fetch from 'node-fetch';
import { readSheet } from './sheets.js';

const TOKEN_SHEET_NAME = '預約表單';
const TOKEN_CELL = 'C2';

/** 從試算表讀取的 Token 快取 TTL（5 分鐘），減少 Google Sheets Read 配額消耗（查空位等會多次呼叫 getBearerToken） */
const TOKEN_FROM_SHEET_CACHE_TTL_MS = 5 * 60 * 1000;
let tokenFromSheetCache = { value: '', expiresAt: 0 };

/** 從 env 或試算表取得 Bearer Token。若從試算表讀取會短期快取以降低 Sheets API Read 配額。 */
export async function getBearerToken(auth) {
  if (process.env.SAYDOU_BEARER_TOKEN?.trim()) return process.env.SAYDOU_BEARER_TOKEN.trim();
  const now = Date.now();
  if (tokenFromSheetCache.value && tokenFromSheetCache.expiresAt > now) return tokenFromSheetCache.value;
  const ssId = process.env.TOKEN_SHEET_SS_ID || '1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE';
  const vals = await readSheet(auth, ssId, `'${TOKEN_SHEET_NAME}'!${TOKEN_CELL}`);
  const token = (vals[0]?.[0] ?? '').toString().trim();
  tokenFromSheetCache = { value: token, expiresAt: now + TOKEN_FROM_SHEET_CACHE_TTL_MS };
  return token;
}

const TEST_URL = 'https://saywebdatafeed.saydou.com/api/management/unearn/memberStorecash?page=0&limit=1&sort=stcash&order=desc&keyword=0&showGroup=0&tabIndex=0';

/** 檢查 Token 是否有效，回傳 { ok, problem } */
export async function checkToken(bearerToken) {
  if (!bearerToken || String(bearerToken).trim() === '') {
    return { ok: false, problem: 'Token 為空或無法取得' };
  }
  try {
    const res = await fetch(TEST_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, problem: `Token 無效或已過期（HTTP ${res.status}）` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, problem: '驗證 Token 時發生錯誤: ' + (e?.message || e) };
  }
}
