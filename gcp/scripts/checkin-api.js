/**
 * GCP 打卡 API：bind / check_in，與 GAS BE-HandleCheckIn.js 邏輯對齊
 * 試算表：LINE_STAFF_SS_ID，工作表「員工打卡紀錄」A=userId,B=時間,C=類型,D=店名,E=uuid,F=frontUuid,G=失敗位置
 * 公司列表：id,name,address,經緯度(欄位4為 "lat,lon")
 */

import { readSheet, writeSheet, batchUpdateValues, findRowByColumnValue } from '../lib/sheets.js';
import { isUserAuthorized } from './line-checkin-handler.js';

const LINE_STAFF_SS_ID = process.env.LINE_STAFF_SS_ID;
const LOG_SHEET = '員工打卡紀錄';
const COMPANY_SHEET = '公司列表';
const MAX_DISTANCE_KM = 0.1; // 100 公尺
const COOLDOWN_MINUTES = 10;

function toTaipeiDateStr(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

function toTaipeiTimeStr(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit' });
}

/** 回傳 JSON 給前端 */
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

/** 在員工打卡紀錄 E 欄搜尋 uuid，回傳 1-based 列號 */
async function findRowByUuid(auth, uuid) {
  if (!LINE_STAFF_SS_ID || !uuid) return null;
  return findRowByColumnValue(auth, LINE_STAFF_SS_ID, `'${LOG_SHEET}'!E2:E`, String(uuid).trim());
}

/** 取得該 uuid 列資料：userId, action, frontUuid */
async function getUuidRowData(auth, uuid) {
  const row = await findRowByUuid(auth, uuid);
  if (!row) return null;
  const rows = await readSheet(auth, LINE_STAFF_SS_ID, `'${LOG_SHEET}'!A${row}:F${row}`);
  if (!rows || !rows[0]) return null;
  const r = rows[0];
  return {
    row,
    userId: r[0],
    action: r[2],
    frontUuid: r[5],
  };
}

/** 寫入 frontUuid 到 F 欄 */
async function bindFrontUuidToSheet(auth, uuid, frontUuid) {
  const row = await findRowByUuid(auth, uuid);
  if (!row) return false;
  await writeSheet(auth, LINE_STAFF_SS_ID, `'${LOG_SHEET}'!F${row}`, [[String(frontUuid).trim()]]);
  return true;
}

/** 更新該列 A~D：userId, timestamp, punchType, storeName */
async function updateRowData(auth, uuid, valuesArray) {
  const row = await findRowByUuid(auth, uuid);
  if (!row) return;
  await writeSheet(auth, LINE_STAFF_SS_ID, `'${LOG_SHEET}'!A${row}:D${row}`, [valuesArray]);
}

/** 寫入失敗位置到 A、G */
async function updateWrongByUuid(auth, uuid, userId, lat, lon) {
  const row = await findRowByUuid(auth, uuid);
  if (!row) return;
  await batchUpdateValues(auth, LINE_STAFF_SS_ID, [
    { range: `'${LOG_SHEET}'!A${row}`, values: [[userId]] },
    { range: `'${LOG_SHEET}'!G${row}`, values: [[`失敗位置: ${lat}, ${lon}`]] },
  ]);
}

/** 公司列表：讀取經緯度，計算距離 (km)，回傳 [{ name, distance }] 由近到遠 */
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function checkLocation(auth, lat, lon) {
  if (!LINE_STAFF_SS_ID) return [];
  const rows = await readSheet(auth, LINE_STAFF_SS_ID, `'${COMPANY_SHEET}'!A:D`);
  if (!rows || rows.length < 2) return [];
  const storeMap = [];
  for (let i = 1; i < rows.length; i++) {
    const item = rows[i];
    if (!item[3]) continue;
    const parts = String(item[3]).split(',');
    const latS = parseFloat(parts[0]);
    const lonS = parseFloat(parts[1]);
    if (Number.isFinite(latS) && Number.isFinite(lonS)) {
      storeMap.push({
        id: item[0],
        name: item[1] || '',
        lat: latS,
        lon: lonS,
      });
    }
  }
  const data = storeMap.map((s) => ({
    name: s.name,
    distance: getDistanceFromLatLonInKm(s.lat, s.lon, lat, lon),
  }));
  return data.sort((a, b) => a.distance - b.distance);
}

/**
 * 今日該員工「依時間排序」的最後一筆打卡（用於判斷下一筆是上班或下班）。
 * 依 B 欄時間取最後一筆，避免多人交錯打卡時依列順序取到錯列，導致下班被誤寫成上班。
 */
async function getEmployeeHistoryToday(auth, userId) {
  if (!LINE_STAFF_SS_ID) return { hasRecord: false };
  const lastRow = await getLastRowNum(auth, LOG_SHEET, 'A');
  if (lastRow < 2) return { hasRecord: false };
  const startRow = Math.max(2, lastRow - 200);
  const range = `'${LOG_SHEET}'!A${startRow}:C${lastRow}`;
  const data = await readSheet(auth, LINE_STAFF_SS_ID, range);
  if (!data || !data.length) return { hasRecord: false };
  const todayStr = toTaipeiDateStr(new Date());
  const todayRows = [];
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (String(row[0] || '').trim() !== String(userId).trim() || !row[1] || !row[2]) continue;
    const rowDate = toTaipeiDateStr(row[1]);
    if (rowDate === todayStr) todayRows.push({ time: row[1], type: String(row[2]).trim() });
  }
  if (todayRows.length === 0) return { hasRecord: false };
  todayRows.sort((a, b) => new Date(a.time) - new Date(b.time));
  const last = todayRows[todayRows.length - 1];
  return { hasRecord: true, lastTime: last.time, lastType: last.type };
}

async function getLastRowNum(auth, sheetName, columnLetter = 'A') {
  const rows = await readSheet(auth, LINE_STAFF_SS_ID, `'${sheetName}'!${columnLetter}:${columnLetter}`);
  if (!rows || !rows.length) return 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][0] != null && String(rows[i][0]).trim() !== '') return i + 1;
  }
  return 0;
}

// --- Bind ---
async function handleBind(req, res, auth, body) {
  const uuid = body.uuid;
  const frontUuid = body.frontUuid;
  if (!uuid || !frontUuid) {
    sendJson(res, 200, { status: 'failed', text: '無效的連結 (參數缺失)' });
    return;
  }
  console.log('[checkin-api] Bind uuid=%s frontUuid=%s', String(uuid).slice(-8), String(frontUuid).slice(-8));
  const ticket = await getUuidRowData(auth, uuid);
  if (!ticket) {
    sendJson(res, 200, { status: 'failed', text: '無效的連結 (找不到 UUID)' });
    return;
  }
  if (ticket.action && String(ticket.action).trim() !== '') {
    sendJson(res, 200, { status: 'failed', text: '此連結已打卡完成' });
    return;
  }
  const sheetFront = String(ticket.frontUuid || '').trim();
  const reqFront = String(frontUuid).trim();
  if (sheetFront === '') {
    const ok = await bindFrontUuidToSheet(auth, uuid, frontUuid);
    if (ok) {
      sendJson(res, 200, { status: 'success', text: '連線建立成功' });
    } else {
      sendJson(res, 200, { status: 'failed', text: '系統錯誤 (寫入失敗)' });
    }
    return;
  }
  if (sheetFront === reqFront) {
    sendJson(res, 200, { status: 'success', text: '連線恢復' });
    return;
  }
  sendJson(res, 200, { status: 'failed', text: '此連結已失效 (已被其他裝置開啟)' });
}

// --- Check_in ---
async function handleCheckIn(req, res, auth, body) {
  const lat = parseFloat(body.latitude);
  const lon = parseFloat(body.longitude);
  const userId = body.userId;
  const uuid = body.uuid;
  const frontUuid = body.frontUuid;
  if (!userId || !uuid || !frontUuid || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    sendJson(res, 200, { status: 'failed', text: '資料不完整，無法打卡' });
    return;
  }
  const authResult = await isUserAuthorized(auth, LINE_STAFF_SS_ID, userId);
  if (!authResult.isAuthorized) {
    await updateWrongByUuid(auth, uuid, userId, lat, lon);
    sendJson(res, 200, { status: 'failed', text: '⚠️ 你的帳號尚未開通，麻煩通知泡泡貓負責顧問！' });
    return;
  }
  const ticket = await getUuidRowData(auth, uuid);
  if (!ticket) {
    sendJson(res, 200, { status: 'failed', text: '連結無效 (找不到 UUID)' });
    return;
  }
  const sheetFrontUuid = String(ticket.frontUuid || '').trim();
  const reqFrontUuid = String(frontUuid).trim();
  if (sheetFrontUuid === '') {
    sendJson(res, 200, { status: 'failed', text: '驗證失敗：請重新整理網頁 (未完成連線綁定)' });
    return;
  }
  if (sheetFrontUuid !== reqFrontUuid) {
    sendJson(res, 200, { status: 'failed', text: '驗證失敗：此連結已被其他裝置綁定！' });
    return;
  }
  if (ticket.action && String(ticket.action).trim() !== '') {
    sendJson(res, 200, { status: 'failed', text: '⚠️ 此連結已使用過，請重新申請！' });
    return;
  }
  const checkResult = await checkLocation(auth, lat, lon);
  if (!checkResult.length || checkResult[0].distance > MAX_DISTANCE_KM) {
    await updateWrongByUuid(auth, uuid, userId, lat, lon);
    const distMsg = checkResult.length
      ? `(距離 ${checkResult[0].name} ${(checkResult[0].distance * 1000).toFixed(0)}公尺)`
      : '(附近無店家)';
    sendJson(res, 200, { status: 'failed', text: `📍 距離太遠 \n${distMsg}` });
    return;
  }
  const history = await getEmployeeHistoryToday(auth, userId);
  const timestamp = new Date();
  let punchType = '上班打卡';
  if (history.hasRecord) {
    const lastPunchTime = new Date(history.lastTime);
    const timeDiff = (timestamp - lastPunchTime) / 1000 / 60;
    if (timeDiff < COOLDOWN_MINUTES) {
      sendJson(res, 200, { status: 'failed', text: '⚠️ 你已於 10分鐘內打卡，請稍後再試！' });
      return;
    }
    const lastTypeStr = String(history.lastType || '').trim();
    const lastWasClockIn = lastTypeStr.indexOf('上班') !== -1;
    punchType = lastWasClockIn ? '下班打卡' : '上班打卡';
  }
  const resultValues = [userId, timestamp.toISOString(), punchType, checkResult[0].name];
  await updateRowData(auth, uuid, resultValues);
  const dateStr = toTaipeiDateStr(timestamp);
  const timeStr = toTaipeiTimeStr(timestamp);
  sendJson(res, 200, {
    status: 'success',
    text: `📌 ${checkResult[0].name}\n${punchType} 成功！\n\n📅 日期：${dateStr}\n⏰ 時間：${timeStr}`,
  });
}

/**
 * 處理 POST /checkin：bodyJson 為 { action: "bind"|"check_in", ... }
 */
export async function handleCheckinApi(req, res, { auth, bodyJson }) {
  if (!LINE_STAFF_SS_ID) {
    sendJson(res, 500, { status: 'failed', text: '伺服器未設定試算表' });
    return;
  }
  const body = bodyJson || {};
  const action = body.action;
  if (action === 'bind') {
    await handleBind(req, res, auth, body);
    return;
  }
  if (action === 'check_in') {
    await handleCheckIn(req, res, auth, body);
    return;
  }
  sendJson(res, 400, { status: 'failed', text: '不支援的 action' });
}
