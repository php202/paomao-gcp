import fetch from 'node-fetch';
import { readFileSync } from 'fs';
import { join } from 'path';

/** Token 檔案路徑（唯一來源，不再依賴 Google Sheets） */
const TOKEN_FILE = join(process.env.HOME || '', '.openclaw/workspace/booking-site/.saydou-token');

/** Token 快取 TTL（5 分鐘） */
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
let tokenCache = { value: '', expiresAt: 0 };

/** 清除 Token 快取（例如收到 401 後讓下次請求重新讀取檔案） */
export function invalidateTokenCache() {
  tokenCache = { value: '', expiresAt: 0 };
}

/** 從 env 或 token 檔案取得 Bearer Token。不再依賴 Google Sheets。 */
export async function getBearerToken(_auth) {
  if (process.env.SAYDOU_BEARER_TOKEN?.trim()) return process.env.SAYDOU_BEARER_TOKEN.trim();
  const now = Date.now();
  if (tokenCache.value && tokenCache.expiresAt > now) return tokenCache.value;
  try {
    const token = readFileSync(TOKEN_FILE, 'utf8').trim();
    tokenCache = { value: token, expiresAt: now + TOKEN_CACHE_TTL_MS };
    return token;
  } catch (e) {
    console.error('[saydou] 無法讀取 token 檔案:', TOKEN_FILE, e.message);
    return '';
  }
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
