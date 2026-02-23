/**
 * 神美日報開啟紀錄：寫入試算表「神美日報_開啟紀錄」（與 GAS ReportHelpers writeDailyReportAccessLog 對齊）
 * 試算表：LINE_HQ_SS_ID 或 REPORT_ACCESS_LOG_SS_ID（泡泡貓 門市資料 1-t4KPVK...）
 * 欄位：Timestamp, Date, Role, UserId, EmployeeCode, EmployeeName, StoreIds, GroupId, GroupName, UserName
 */

import { appendSheet } from './sheets.js';

const SHEET_NAME = '神美日報_開啟紀錄';

function formatYmdTaipei(date) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return '';
  }
}

function toSheetText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function nowStr() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * @param {object} auth - Google Auth client
 * @param {{ dateStr?: string, role?: string, userId?: string, employeeCode?: string, employeeName?: string, storeIds?: string[], groupId?: string, groupName?: string, userName?: string }} payload
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function writeDailyReportAccessLog(auth, payload) {
  const ssId =
    (process.env.REPORT_ACCESS_LOG_SS_ID || process.env.LINE_HQ_SS_ID || '').trim();
  if (!ssId) {
    return { ok: false, message: '未設定 REPORT_ACCESS_LOG_SS_ID 或 LINE_HQ_SS_ID' };
  }
  try {
    // Product requirement: leave column A empty (reserve for manual flags / formulas).
    // This means the sheet header should start from column B.
    const row = [
      '',
      toSheetText(nowStr()),
      payload?.dateStr instanceof Date ? formatYmdTaipei(payload.dateStr) : toSheetText(payload?.dateStr || ''),
      toSheetText(payload?.role || ''),
      toSheetText(payload?.userId || ''),
      toSheetText(payload?.employeeCode || ''),
      toSheetText(payload?.employeeName || ''),
      Array.isArray(payload?.storeIds) ? payload.storeIds.map((s) => String(s || '').trim()).filter(Boolean).join(',') : toSheetText(payload?.storeIds || ''),
      toSheetText(payload?.groupId || ''),
      toSheetText(payload?.groupName || ''),
      toSheetText(payload?.userName || ''),
    ];
    await appendSheet(auth, ssId, SHEET_NAME, row);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e?.message || String(e) };
  }
}
