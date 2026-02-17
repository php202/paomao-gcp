/**
 * 除錯：用目前環境的憑證（本機 .env 的 GOOGLE_APPLICATION_CREDENTIALS 或 ADC）
 * 呼叫 Sheets API spreadsheets.create，確認是否為權限問題。
 * 執行：cd gcp && node --env-file=.env scripts/debug-sheets-create.js
 *   或：cd gcp && node -e "require('dotenv').config(); import('./scripts/debug-sheets-create.js')"  (若無 --env-file)
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { getAuth } from '../lib/auth.js';
import { google } from 'googleapis';

async function main() {
  console.log('[debug] GOOGLE_APPLICATION_CREDENTIALS:', process.env.GOOGLE_APPLICATION_CREDENTIALS || '(not set, will use ADC)');
  const auth = await getAuth();
  const creds = await auth.getCredentials?.().catch(() => null);
  const email = creds?.client_email ?? '(no client_email)';
  console.log('[debug] caller (client_email):', email);

  const sheets = google.sheets({ version: 'v4', auth });
  const title = `Debug_Test_${Date.now()}`;
  console.log('[debug] calling spreadsheets.create, title=', title);
  try {
    const res = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: [{ properties: { title: 'Sheet1' } }],
      },
    });
    const id = res.data.spreadsheetId;
    console.log('[debug] OK spreadsheetId=', id, 'url=https://docs.google.com/spreadsheets/d/' + id + '/edit');
    return;
  } catch (e) {
    const err = e?.response?.data?.error;
    console.error('[debug] spreadsheets.create FAILED');
    console.error('  message:', err?.message ?? e?.message);
    console.error('  code:', err?.code ?? e?.code);
    console.error('  status:', err?.status);
    console.error('  errors:', err?.errors ? JSON.stringify(err.errors) : '');
    console.error('  full response:', JSON.stringify(e?.response?.data ?? {}));
    process.exit(1);
  }
}
main();
