/**
 * 店家回覆狀態：從指定試算表的「店家基本資料」「訊息一覽」計算直營店未回覆數與完成率。
 * 與 LINE 員工打卡回傳格式一致，可供 Core API 與 PAOPAO Webhook 共用。
 */
import { readSheet } from './sheets.js';

const STORE_REPLY_DRIVE_LINK = 'https://drive.google.com/drive/folders/14j3NL2pt9ISy66jN6TX2BxnaAquQZTKh?usp=drive_link';

/**
 * @param {object} auth - Google Auth client (e.g. authClient from Cloud Run)
 * @param {string} ssId - 試算表 ID（員工端用 LINE_STORE_SS_ID，PAOPAO 用 PAOPAO_STORE_SS_ID）
 * @returns {{ ok: boolean, text?: string, message?: string }}
 */
export async function getDirectStoreReplyStatusText(auth, ssId) {
  if (!ssId || !ssId.trim()) {
    return { ok: false, message: '無法取得店家回覆狀態，請稍後再試。' };
  }
  let stores;
  let msgs;
  try {
    stores = await readSheet(auth, ssId, "'店家基本資料'!A:L");
    msgs = await readSheet(auth, ssId, "'訊息一覽'!A:F");
  } catch (e) {
    return { ok: false, message: '讀取訊息一覽表失敗，請確認試算表已共用給此服務，或聯繫管理員。' };
  }
  const directStores = [];
  for (let i = 1; i < stores.length; i++) {
    const row = stores[i];
    const isDirect = row[7] === true || String(row[7]).toUpperCase() === 'TRUE';
    if (!isDirect) continue;
    const name = String(row[1] || '').trim();
    if (!name) continue;
    let total = 0;
    let unreplied = 0;
    for (let j = 1; j < msgs.length; j++) {
      const m = msgs[j];
      if (String(m[2] || '').trim() !== name) continue;
      total += 1;
      if (!String(m[5] || '').trim()) unreplied += 1;
    }
    const rateVal = total > 0 ? (total - unreplied) / total : null;
    directStores.push({ name, unreplied, rateVal });
  }
  if (!directStores.length) {
    return { ok: false, message: '目前無直營店資料或 H 欄皆為 false' };
  }
  directStores.sort((a, b) => b.unreplied - a.unreplied);
  let totalUnreplied = 0;
  let rateSum = 0;
  let rateCount = 0;
  const lines = ['【店家回覆狀態】'];
  for (const s of directStores) {
    totalUnreplied += s.unreplied;
    if (s.rateVal != null) {
      rateSum += s.rateVal * 100;
      rateCount += 1;
    }
    const rateText = s.rateVal == null ? '—' : `${(s.rateVal * 100).toFixed(1)}%`;
    lines.push(`${s.name}：未回覆 ${s.unreplied} 則 | 完成率 ${rateText}`);
  }
  if (rateCount > 0) {
    lines.push(`直營店總未回覆：${totalUnreplied} 則 | 平均完成率：${(rateSum / rateCount).toFixed(1)}%`);
  } else {
    lines.push(`直營店總未回覆：${totalUnreplied} 則`);
  }
  lines.push(STORE_REPLY_DRIVE_LINK);
  return { ok: true, text: lines.join('\n') };
}
