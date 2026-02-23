/**
 * 泡泡貓拉廣告資料：產出動態預約（與 GAS appointmentLists 邏輯一致）
 * 需環境變數：ADS_SS_ID（試算表 ID）、PAO_CAT_CORE_API_URL、PAO_CAT_SECRET_KEY（或透過 GCP /core 的 auth）
 * 試算表需分享給 GOOGLE_APPLICATION_CREDENTIALS 對應的服務帳號（編輯者）
 */
import { getAuth } from '../lib/auth.js';
import { getLineSayDouInfoMap, fetchReservationData, oldNewA } from '../api/core-api.js';
import { readSheet, writeSheet, clearSheetRange } from '../lib/sheets.js';

const ADS_SS_ID = (process.env.ADS_SS_ID || process.env.AD_SS_ID || '').trim();
const SHEET_NAME = '預約清單（動態）';

function buildRow(storeName, data) {
  const getTotal = (source) => {
    if (!data.a || !Array.isArray(data.a)) return 0;
    const match = data.a.find((i) => i.source === source);
    return match ? parseInt(match.total, 10) || 0 : 0;
  };
  const line = getTotal('line');
  const web2 = getTotal('web2');
  const phone = getTotal('phone');
  const google = getTotal('google');
  const pad = getTotal('pad');
  const ig = getTotal('instagram');
  const total = line + web2 + phone + google + pad + ig;

  let newCount = 0;
  let oldCount = 0;
  if (data.b && typeof data.b === 'object') {
    if (Array.isArray(data.b) && data.b[0]) {
      newCount = data.b[0].new != null ? Number(data.b[0].new) : 0;
      oldCount = data.b[0].old != null ? Number(data.b[0].old) : 0;
    } else {
      newCount = data.b.new != null ? Number(data.b.new) : 0;
      oldCount = data.b.old != null ? Number(data.b.old) : 0;
    }
  }
  const totalMemberOps = newCount + oldCount > 0 ? newCount + oldCount : 1;
  const newRate = newCount + oldCount > 0 ? ((newCount / totalMemberOps) * 100).toFixed(1) + '%' : '0%';
  const oldRate = newCount + oldCount > 0 ? ((oldCount / totalMemberOps) * 100).toFixed(1) + '%' : '0%';

  return [storeName, line, web2, phone, google, pad, ig, total, newCount, oldCount, newRate, oldRate];
}

export async function run() {
  if (!ADS_SS_ID) throw new Error('請設定 ADS_SS_ID 或 AD_SS_ID 環境變數（廣告試算表 ID）');
  const auth = await getAuth();
  const map = await getLineSayDouInfoMap(auth);
  const stores = Object.values(map).map((s) => ({ id: s.saydouId, name: s.name }));
  if (!stores.length) throw new Error('無法取得店家列表');

  const rangeA2B2 = `'${SHEET_NAME}'!A2:B2`;
  const rowsA2B2 = await readSheet(auth, ADS_SS_ID, rangeA2B2);
  const startDate = rowsA2B2[0]?.[0] ? String(rowsA2B2[0][0]).trim() : '';
  const endDate = rowsA2B2[0]?.[1] ? String(rowsA2B2[0][1]).trim() : '';
  if (!startDate || !endDate) throw new Error('請在試算表「預約清單（動態）」A2、B2 填入開始與結束日期（例如 2026-02-01）');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const allOutputRows = [];

  for (let i = 0; i < stores.length; i++) {
    const store = stores[i];
    let data = { a: null, b: { old: 0, new: 0 } };
    try {
      data.a = await fetchReservationData(auth, startDate, endDate, store.id);
      if (new Date(startDate) <= today) {
        data.b = await oldNewA(auth, startDate, endDate, store.id);
        if (Array.isArray(data.b) && data.b[0]) data.b = data.b[0];
      }
      allOutputRows.push(buildRow(store.name, data));
    } catch (e) {
      console.warn(`[ads-appointment] 店家 ${store.name} 處理失敗:`, e?.message);
      allOutputRows.push([store.name, '讀取失敗', '', '', '', '', 0, 0, '', '', '0%', '0%']);
    }
  }

  const clearRange = `'${SHEET_NAME}'!A5:L500`;
  await clearSheetRange(auth, ADS_SS_ID, clearRange);
  if (allOutputRows.length > 0) {
    const writeRange = `'${SHEET_NAME}'!A5:L${4 + allOutputRows.length}`;
    await writeSheet(auth, ADS_SS_ID, writeRange, allOutputRows);
  }
  return { ok: true, rowCount: allOutputRows.length };
}
