/**
 * 目前時間字串（Asia/Taipei），格式 YYYY-MM-DD HH:mm:ss。
 * 供試算表、log 顯示用，避免 Cloud Run (UTC) 造成凌晨時顯示為前一天。
 */
export function nowTaipeiStr() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
  return s.slice(0, 19);
}
