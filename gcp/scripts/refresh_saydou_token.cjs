#!/usr/bin/env node
/**
 * SayDou Token 自動刷新
 * 每天自動登入 SayDou API 取得新 JWT token，寫回 Sheet
 */

const { google } = require('googleapis');
const fs = require('fs');

const SHEET_ID = '1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE';
const TOKEN_CELL = "'預約表單'!C2:D2";

async function main() {
  // 1. Read credentials
  const creds = JSON.parse(fs.readFileSync('/Users/paopaomao/.openclaw/secrets/saydou-credentials.json', 'utf8'));

  // 2. Login to SayDou
  console.log('🔄 登入 SayDou...');
  const res = await fetch('https://saywebdatafeed.saydou.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...creds, captcha: '' }),
  });

  const data = await res.json();
  if (!data.token) {
    console.error('❌ 登入失敗:', data.message || 'no token');
    process.exit(1);
  }

  const newToken = data.token;
  console.log('✅ 取得新 token (前20字):', newToken.substring(0, 20) + '...');

  // 3. Verify token works
  const testRes = await fetch('https://saywebdatafeed.saydou.com/api/management/baseData?kind%5B%5D=stores', {
    headers: { Authorization: 'Bearer ' + newToken },
  });
  if (testRes.status !== 200) {
    console.error('❌ Token 驗證失敗, status:', testRes.status);
    process.exit(1);
  }
  console.log('✅ Token 驗證通過');

  // 4. Write to Sheet
  const auth = new google.auth.GoogleAuth({
    keyFile: '/Users/paopaomao/.openclaw/secrets/gcp-service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: TOKEN_CELL,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[newToken, new Date().toISOString()]] },
  });

  console.log('✅ Token 已寫入 Sheet');

  // 5. Calculate expiry
  try {
    const payload = JSON.parse(Buffer.from(newToken.split('.')[1], 'base64').toString());
    const expDate = new Date(payload.exp * 1000);
    console.log(`📅 Token 到期: ${expDate.toISOString()} (${Math.round((payload.exp * 1000 - Date.now()) / 3600000)}h)`);
  } catch (e) {}

  console.log('✅ Done');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
