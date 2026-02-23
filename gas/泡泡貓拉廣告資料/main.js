/**
 * 選單「產出動態預約 / 取得今日預約（改由 GCP 執行）」會呼叫 GCP /admin。
 * 請在「專案設定」→「指令碼屬性」新增：
 * - GCP_ADMIN_URL = Cloud Run 服務網址 + /admin（例：https://pao-checkin-api-vkffbzouva-de.a.run.app/admin）
 * - GCP_ADMIN_KEY = 與 PAO_CAT_SECRET_KEY / ADMIN_KEY 相同
 * 若未設定，選單會提示「尚未設定 GCP_ADMIN_URL / GCP_ADMIN_KEY」。
 * 目前 ads_appointmentLists / ads_todayReservation 尚未在 GCP 實作，設定後會回傳「請在 Apps Script 直接執行 appointmentLists / todayReservation」。
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🛠 分析幫手')
      .addItem('🚀 產出動態預約（改由 GCP 執行）', 'gcp_appointmentLists')
      .addItem('🚀 取得今日預約（改由 GCP 執行）', 'gcp_todayReservation')
      // .addSeparator()
      // .addItem('🗑️ 刪除暫存工作表', 'cleanupTempSheets')
      .addToUi();
}

function getGcpAdminParams_() {
  const p = PropertiesService.getScriptProperties();
  const url = (p.getProperty('GCP_ADMIN_URL') || '').trim();
  const key = (p.getProperty('GCP_ADMIN_KEY') || p.getProperty('PAO_CAT_SECRET_KEY') || '').trim();
  return { url, key, useAdmin: url.length > 0 && key.length > 0 };
}

function callGcpAdmin_(action, extraParams) {
  const { url, key, useAdmin } = getGcpAdminParams_();
  if (!useAdmin) return null;
  const payload = Object.assign({ key: key, action: action }, extraParams || {});
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    followRedirects: true,
  });
  try {
    return JSON.parse(res.getContentText() || '{}');
  } catch (e) {
    return { status: 'error', message: res.getContentText() };
  }
}

function gcp_appointmentLists() {
  const ui = SpreadsheetApp.getUi();
  const res = callGcpAdmin_('ads_appointmentLists', {});
  if (!res) return ui.alert('尚未設定 GCP_ADMIN_URL / GCP_ADMIN_KEY，或 GCP 尚未提供此 action。');
  ui.alert(res.status === 'ok' ? '已送出 GCP 工作（請至 Cloud Run Logs/Jobs 查看進度）' : ('GCP 執行失敗：' + (res.message || 'unknown')));
}

function gcp_todayReservation() {
  const ui = SpreadsheetApp.getUi();
  const res = callGcpAdmin_('ads_todayReservation', {});
  if (!res) return ui.alert('尚未設定 GCP_ADMIN_URL / GCP_ADMIN_KEY，或 GCP 尚未提供此 action。');
  ui.alert(res.status === 'ok' ? '已送出 GCP 工作（請至 Cloud Run Logs/Jobs 查看進度）' : ('GCP 執行失敗：' + (res.message || 'unknown')));
}
