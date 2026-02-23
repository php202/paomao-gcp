/**
 * 泡泡貓拉廣告資料：取得今日預約（與 GAS todayReservation 邏輯一致）
 * 需環境變數：ADS_SS_ID（試算表 ID）
 * 試算表需分享給 GOOGLE_APPLICATION_CREDENTIALS 對應的服務帳號（編輯者）
 */
import { getAuth } from '../lib/auth.js';
import { getLineSayDouInfoMap, fetchTodayReservationData } from '../api/core-api.js';
import { writeSheet, clearSheetRange } from '../lib/sheets.js';

const ADS_SS_ID = (process.env.ADS_SS_ID || process.env.AD_SS_ID || '').trim();
const SHEET_NAME = '今日建立（動態）';

function formatDateYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function run() {
  if (!ADS_SS_ID) throw new Error('請設定 ADS_SS_ID 或 AD_SS_ID 環境變數（廣告試算表 ID）');
  const auth = await getAuth();
  const map = await getLineSayDouInfoMap(auth);
  const stores = Object.values(map).map((s) => ({ id: s.saydouId, name: s.name }));
  if (!stores.length) throw new Error('無法取得店家列表');

  const dateStr = formatDateYmd(new Date());
  const output = [];

  for (let i = 0; i < stores.length; i++) {
    const store = stores[i];
    let count = 0;
    try {
      const result = await fetchTodayReservationData(auth, dateStr, dateStr, store.id);
      count = result?.member && Array.isArray(result.member) ? result.member.length : 0;
    } catch (e) {
      console.warn(`[ads-today] 店家 ${store.name} 失敗:`, e?.message);
      count = '錯誤';
    }
    output.push([store.name || store.id, count]);
  }

  const clearRange = `'${SHEET_NAME}'!A4:B500`;
  await clearSheetRange(auth, ADS_SS_ID, clearRange);
  if (output.length > 0) {
    const writeRange = `'${SHEET_NAME}'!A4:B${3 + output.length}`;
    await writeSheet(auth, ADS_SS_ID, writeRange, output);
  }
  return { ok: true, rowCount: output.length };
}
