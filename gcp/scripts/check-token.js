/**
 * 檢查 SayDou Bearer Token 是否有效；若無效則寄信至 ADMIN_EMAIL（預設 paopaomao.of@gmail.com）
 * 等同 GAS 的 checkSaydouTokenAndNotify
 *
 * 環境變數：SAYDOU_BEARER_TOKEN 或 TOKEN_SHEET_SS_ID、ADMIN_EMAIL、GMAIL_USER、GMAIL_APP_PASSWORD
 *
 * 執行：node index.js check-token
 */

import { getAuth } from '../lib/auth.js';
import { getBearerToken, checkToken } from '../lib/saydou.js';
import { sendNotification } from '../lib/email.js';

export async function run() {
  console.log('[GCP] SayDou Token 檢查...');

  const auth = await getAuth();
  const bearerToken = await getBearerToken(auth);
  const { ok, problem } = await checkToken(bearerToken);

  if (ok) {
    console.log('[GCP] Token 正常');
    return;
  }

  console.log('[GCP] Token 異常:', problem);
  await sendNotification(
    '[泡泡貓] SayDou Token 檢查異常',
    'SayDou Bearer Token 檢查結果：' + problem + '\n\n請檢查 Token 試算表或 Token Web App 設定。'
  );
}
