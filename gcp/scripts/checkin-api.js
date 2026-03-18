/**
 * GCP 打卡 API：bind / check_in — PostgreSQL 版
 * 完全脫離 Google Sheets，使用本機 DB (paomao)
 */

import pool, { isUserAuthorizedDB, logCheckInDB, saveBindingDB } from '../lib/db.js';

const MAX_DISTANCE_KM = 0.1; // 100 公尺
const COOLDOWN_MINUTES = 10;

// ─── In-memory UUID ticket store (取代 Sheet 的 uuid row) ───
// Map<uuid, { userId, frontUuid, action, createdAt }>
const uuidTickets = new Map();

// 每小時清理過期 ticket（超過 24h）
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of uuidTickets) {
    if (v.createdAt < cutoff) uuidTickets.delete(k);
  }
}, 60 * 60 * 1000);

/** 建立 ticket（從 line-checkin-handler 呼叫） */
export function createCheckinTicket(uuid, userId) {
  uuidTickets.set(uuid, { userId, frontUuid: '', action: '', createdAt: Date.now() });
}

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

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

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

// ─── 公司列表：從 DB 讀取（需要建 stores 表，暫時先用記憶體 + 一次性從 Sheet 載入或硬編碼） ───
let storeLocations = null;

async function loadStoreLocations() {
  // 先試 DB
  try {
    const { rows } = await pool.query(
      "SELECT store_name, latitude, longitude FROM store_locations WHERE latitude IS NOT NULL"
    );
    if (rows.length > 0) {
      storeLocations = rows.map(r => ({ name: r.store_name, lat: parseFloat(r.latitude), lon: parseFloat(r.longitude) }));
      return;
    }
  } catch (e) {
    // store_locations 表可能還沒建，fallback
  }

  // Fallback: 從 Sheet 的公司列表讀取一次（如果可以的話）
  try {
    const { readSheet } = await import('../lib/sheets.js');
    const { getAuth } = await import('../lib/auth.js');
    const auth = await getAuth();
    const LINE_STAFF_SS_ID = process.env.LINE_STAFF_SS_ID;
    if (LINE_STAFF_SS_ID) {
      const rows = await readSheet(auth, LINE_STAFF_SS_ID, "'公司列表'!A:D");
      storeLocations = [];
      for (let i = 1; i < rows.length; i++) {
        const item = rows[i];
        if (!item[3]) continue;
        const parts = String(item[3]).split(',');
        const lat = parseFloat(parts[0]);
        const lon = parseFloat(parts[1]);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          storeLocations.push({ name: item[1] || '', lat, lon });
        }
      }
      console.log('[checkin-api] Loaded', storeLocations.length, 'store locations from Sheet');

      // 同時寫入 DB 以便下次不用再讀 Sheet
      try {
        await pool.query(`CREATE TABLE IF NOT EXISTS store_locations (
          id SERIAL PRIMARY KEY, store_name VARCHAR(100), latitude DECIMAL(10,7), longitude DECIMAL(10,7)
        )`);
        for (const s of storeLocations) {
          await pool.query(
            'INSERT INTO store_locations (store_name, latitude, longitude) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [s.name, s.lat, s.lon]
          );
        }
        console.log('[checkin-api] Cached store locations to DB');
      } catch (e) {
        console.warn('[checkin-api] Failed to cache store locations:', e.message);
      }
    }
  } catch (e) {
    console.warn('[checkin-api] Cannot load store locations from Sheet:', e.message);
    storeLocations = [];
  }
}

async function checkLocation(lat, lon) {
  if (!storeLocations) await loadStoreLocations();
  if (!storeLocations || !storeLocations.length) return [];
  const data = storeLocations.map((s) => ({
    name: s.name,
    distance: getDistanceFromLatLonInKm(s.lat, s.lon, lat, lon),
  }));
  return data.sort((a, b) => a.distance - b.distance);
}

/** 今日該員工最後一筆「實際」打卡（從 DB 查，排除 attempt） */
async function getEmployeeHistoryToday(userId) {
  // 用 AT TIME ZONE 確保日期比對以台北時區為準，不依賴 Node.js TZ 設定
  try {
    const { rows } = await pool.query(
      `SELECT checked_at, check_type FROM checkin_records
       WHERE line_user_id = $1
         AND check_type IN ('in', 'out')
         AND (checked_at AT TIME ZONE 'Asia/Taipei')::date = (NOW() AT TIME ZONE 'Asia/Taipei')::date
       ORDER BY checked_at DESC LIMIT 1`,
      [userId]
    );
    if (rows.length === 0) return { hasRecord: false };
    return {
      hasRecord: true,
      lastTime: rows[0].checked_at,
      lastType: rows[0].check_type === 'in' ? '上班打卡' : '下班打卡',
    };
  } catch (e) {
    console.error('[checkin-api] getEmployeeHistoryToday error:', e.message);
    return { hasRecord: false };
  }
}

// --- Bind ---
async function handleBind(req, res, body) {
  const uuid = body.uuid;
  const frontUuid = body.frontUuid;
  if (!uuid || !frontUuid) {
    sendJson(res, 200, { status: 'failed', text: '無效的連結 (參數缺失)' });
    return;
  }
  console.log('[checkin-api] Bind uuid=%s frontUuid=%s', String(uuid).slice(-8), String(frontUuid).slice(-8));

  const ticket = uuidTickets.get(uuid);
  if (!ticket) {
    sendJson(res, 200, { status: 'failed', text: '無效的連結 (找不到 UUID)' });
    return;
  }
  if (ticket.action && ticket.action !== '') {
    sendJson(res, 200, { status: 'failed', text: '此連結已打卡完成' });
    return;
  }
  if (ticket.frontUuid === '') {
    ticket.frontUuid = frontUuid;
    await saveBindingDB(ticket.userId, uuid, frontUuid);
    sendJson(res, 200, { status: 'success', text: '連線建立成功' });
    return;
  }
  if (ticket.frontUuid === frontUuid) {
    sendJson(res, 200, { status: 'success', text: '連線恢復' });
    return;
  }
  sendJson(res, 200, { status: 'failed', text: '此連結已失效 (已被其他裝置開啟)' });
}

// --- Check_in ---
async function handleCheckIn(req, res, body) {
  const lat = parseFloat(body.latitude);
  const lon = parseFloat(body.longitude);
  const userId = body.userId;
  const uuid = body.uuid;
  const frontUuid = body.frontUuid;

  if (!userId || !uuid || !frontUuid || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    sendJson(res, 200, { status: 'failed', text: '資料不完整，無法打卡' });
    return;
  }

  // 驗證員工權限 — 從 DB
  const authResult = await isUserAuthorizedDB(userId);
  if (!authResult.isAuthorized) {
    await updateWrongByUuid(auth, uuid, userId, lat, lon);
    const text = authResult.sheetError
      ? '⚠️ 系統暫時無法驗證權限，請稍後再試。若持續出現請通知泡泡貓負責顧問。'
      : '⚠️ 你的帳號尚未開通，麻煩通知泡泡貓負責顧問！';
    sendJson(res, 200, { status: 'failed', text });
    return;
  }

  // 驗證 ticket
  const ticket = uuidTickets.get(uuid);
  if (!ticket) {
    sendJson(res, 200, { status: 'failed', text: '連結無效 (找不到 UUID)' });
    return;
  }
  if (ticket.frontUuid === '') {
    sendJson(res, 200, { status: 'failed', text: '驗證失敗：請重新整理網頁 (未完成連線綁定)' });
    return;
  }
  if (ticket.frontUuid !== frontUuid) {
    sendJson(res, 200, { status: 'failed', text: '驗證失敗：此連結已被其他裝置綁定！' });
    return;
  }
  if (ticket.action && ticket.action !== '') {
    sendJson(res, 200, { status: 'failed', text: '⚠️ 此連結已使用過，請重新申請！' });
    return;
  }

  // 檢查位置
  const checkResult = await checkLocation(lat, lon);
  if (!checkResult.length || checkResult[0].distance > MAX_DISTANCE_KM) {
    const distMsg = checkResult.length
      ? `(距離 ${checkResult[0].name} ${(checkResult[0].distance * 1000).toFixed(0)}公尺)`
      : '(附近無店家)';
    sendJson(res, 200, { status: 'failed', text: `📍 距離太遠 \n${distMsg}` });
    return;
  }

  // 冷卻 + 上下班判斷 — 從 DB
  const history = await getEmployeeHistoryToday(userId);
  const timestamp = new Date();
  let punchType = '上班打卡';
  let checkType = 'in';

  // 智慧判定：當天第一次打卡，但時間很晚（>=17:00）→ 可能是下班
  if (!history.hasRecord) {
    const hourTW = new Date(timestamp.toLocaleString('en-US', { timeZone: 'Asia/Taipei' })).getHours();
    if (hourTW >= 17) {
      checkType = 'out';
      punchType = '下班打卡';
      console.log(`[checkin-api] smart detect: first punch at ${hourTW}:xx (>=17) → treat as clock-out`);
    }
  }

  if (history.hasRecord) {
    const lastPunchTime = new Date(history.lastTime);
    // 用 DB 的 timestamptz 和 JS Date 比較，兩邊都是 UTC epoch，不受 TZ 影響
    const timeDiffMs = timestamp.getTime() - lastPunchTime.getTime();
    const timeDiffMin = timeDiffMs / 1000 / 60;
    console.log(`[checkin-api] cooldown check: last=${lastPunchTime.toISOString()} now=${timestamp.toISOString()} diff=${timeDiffMin.toFixed(1)}min`);
    if (timeDiffMin < COOLDOWN_MINUTES) {
      const remainMin = Math.ceil(COOLDOWN_MINUTES - timeDiffMin);
      sendJson(res, 200, { status: 'failed', text: `⚠️ 你已於 10分鐘內打卡，請 ${remainMin} 分鐘後再試！` });
      return;
    }
    const lastWasClockIn = history.lastType.indexOf('上班') !== -1;
    punchType = lastWasClockIn ? '下班打卡' : '上班打卡';
    checkType = lastWasClockIn ? 'out' : 'in';
  }

  // 寫入 DB
  await logCheckInDB(userId, uuid, frontUuid, checkType, lat, lon);
  ticket.action = punchType; // 標記已使用

  const dateStr = toTaipeiDateStr(timestamp);
  const timeStr = toTaipeiTimeStr(timestamp);
  sendJson(res, 200, {
    status: 'success',
    text: `📌 ${checkResult[0].name}\n${punchType} 成功！\n\n📅 日期：${dateStr}\n⏰ 時間：${timeStr}`,
  });
}

/**
 * 處理 POST /checkin
 */
export async function handleCheckinApi(req, res, { auth, bodyJson }) {
  const body = bodyJson || {};
  const action = body.action;
  if (action === 'bind') {
    await handleBind(req, res, body);
    return;
  }
  if (action === 'check_in') {
    await handleCheckIn(req, res, body);
    return;
  }
  sendJson(res, 400, { status: 'failed', text: '不支援的 action' });
}
