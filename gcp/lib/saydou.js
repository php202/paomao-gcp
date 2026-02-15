import fetch from 'node-fetch';
import { readSheet } from './sheets.js';

const TOKEN_SHEET_NAME = '預約表單';
const TOKEN_CELL = 'C2';

/** 從 env 或試算表取得 Bearer Token */
export async function getBearerToken(auth) {
  if (process.env.SAYDOU_BEARER_TOKEN?.trim()) return process.env.SAYDOU_BEARER_TOKEN.trim();
  const ssId = process.env.TOKEN_SHEET_SS_ID || '1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE';
  const vals = await readSheet(auth, ssId, `'${TOKEN_SHEET_NAME}'!${TOKEN_CELL}`);
  return (vals[0]?.[0] ?? '').toString().trim();
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
