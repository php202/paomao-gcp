/**
 * 接收篡改猴（Tampermonkey）從 m.saydou.com 攔截的 Authorization Token，
 * 寫入 Token 試算表「預約表單」C2，供 getBearerToken() 讀取。
 * 可選：設 SAYDOU_TOKEN_SYNC_KEY 時，請求須帶 key（query 或 header X-Saydou-Token-Sync-Key）。
 */

import { getAuth } from '../lib/auth.js';
import { writeSheet } from '../lib/sheets.js';

const TOKEN_SHEET_NAME = '預約表單';
const TOKEN_CELL = 'C2';
const TOKEN_SHEET_SS_ID = (process.env.TOKEN_SHEET_SS_ID || '1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE').trim();
const SYNC_KEY = (process.env.SAYDOU_TOKEN_SYNC_KEY || '').trim();

function send(res, statusCode, body) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(data);
}

function unauthorized(res) {
  send(res, 401, { status: 'unauthorized', message: 'Invalid or missing key' });
}

export async function handleSaydouTokenSync(req, res, { rawBody }) {
  if (SYNC_KEY) {
    const keyQuery = new URL(req.url || '/', 'http://localhost').searchParams.get('key');
    const keyHeader = req.headers['x-saydou-token-sync-key'];
    const key = (keyQuery || keyHeader || '').trim();
    if (key !== SYNC_KEY) {
      unauthorized(res);
      return;
    }
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    send(res, 400, { status: 'error', message: 'Invalid JSON body' });
    return;
  }

  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!token) {
    send(res, 400, { status: 'error', message: 'Missing token in body' });
    return;
  }

  try {
    const auth = await getAuth();
    await writeSheet(auth, TOKEN_SHEET_SS_ID, `'${TOKEN_SHEET_NAME}'!${TOKEN_CELL}`, [[token]]);
    send(res, 200, { status: 'ok', message: 'Token synced' });
  } catch (e) {
    console.error('[saydou-token-sync] writeSheet failed:', e?.message || e);
    send(res, 500, { status: 'error', message: 'Failed to write token' });
  }
}
