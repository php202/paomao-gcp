/**
 * [核心功能] 搜尋指定條件下的 SayDou 空位
 * @param {string} sayId - 店家 SayDou ID
 * @param {string} startDate - 開始日期 (yyyy-MM-dd)
 * @param {string} endDate - 結束日期 (yyyy-MM-dd)
 * @param {number} needPeople - 需要人數 (通常為 1)
 * @param {number} durationMin - 服務時長 (分鐘)
 * @param {Object} options - 選填 { weekDays: [0-6], timeStart: "11:00", timeEnd: "21:00", token: "..." }
 * @return {Object} { status: boolean, data: Array, totalStaff: number, validStaffSet: Array<number>, error: string }
 */
const token = getBearerTokenFromSheet();

function findAvailableSlots(sayId, startDate, endDate, needPeople, durationMin, options) {
  options = options || {};
  // 呼叫端可傳入 token（例如各店訊息一覽表 Web App 的 CoreApi.getBearerToken），否則用腳本載入時的 token
  console.log('[Core.findAvailableSlots] v20260205-1');
  const tokenToUse = (options.token != null && options.token !== "") ? options.token : token;

  // 1. 參數與時區設定
  const TZ = Session.getScriptTimeZone() || 'Asia/Taipei';
  const weekDays = options.weekDays || [0, 1, 2, 3, 4, 5, 6];
  const timeStartStr = options.timeStart || "11:00";
  const timeEndStr = options.timeEnd || "21:00";

  if (!tokenToUse) return { status: false, error: "Missing Token", data: [], validStaffSet: [] };

  try {
    // 2. 取得有效員工 (計算總產能)
    const validStaffSet = getStoreCapacityIds(sayId, tokenToUse);

    // 3. 取得預約與排休資料
    const { reservations, dutyoffs } = fetchReservationsAndOffs(sayId, startDate, endDate, tokenToUse);

    // 3.1 將「非櫃檯」的預約／排休員工也納入產能（例如每刻01/02 若 baseData 未回傳在職仍算可預約人力）
    const sayIdStr = String(sayId);
    const addStaffId = (set, id) => { if (id != null && Number(id) > 0) set.add(Number(id)); };
    (reservations || []).forEach(r => {
      if (r.storid == null || String(r.storid) !== sayIdStr || !r.usrsid) return;
      // 盡量從 r.usrs 判斷是否為櫃檯人員，若無 usrs 則用 r 本身的欄位（usrnam/usrcod）
      var staffObj = r.usrs || r;
      if (isCounterStaff(staffObj)) return; // 櫃檯不算產能
      addStaffId(validStaffSet, r.usrsid);
    });
    // dutyoffs 僅納入「非櫃檯」員工，櫃檯排休完全不影響產能
    (dutyoffs || []).forEach(d => {
      if (d.storid == null || String(d.storid) !== sayIdStr || !d.usrsid) return;
      if (isCounterStaffDutyoff(d)) return; // 櫃檯不算產能
      addStaffId(validStaffSet, d.usrsid);
    });
    const totalStaff = (validStaffSet && validStaffSet.size > 0) ? validStaffSet.size : 4; // 預設產能

    // 4. 準備計算
    const availableSlots = [];
    let currentDate = new Date(startDate);
    const endDateObj = new Date(endDate);
    
    // 設定最晚可預約時間 (例如 21:00 關門，90分鐘課程，最晚只能約 19:30)
    const storeCloseMin = hhmmToMinutes(timeEndStr);
    const lastBookingMin = storeCloseMin - durationMin; 

    // 5. 逐日計算
    while (currentDate <= endDateObj) {
      const dayOfWeek = currentDate.getDay(); // 0=週日

      if (weekDays.includes(dayOfWeek)) {
        const dateString = Utilities.formatDate(currentDate, TZ, "yyyy-MM-dd");
        
        // 取得當日需檢查的所有時段 (11:00, 11:30, ...)
        const dayTimeSlots = generateTimeSlots(timeStartStr, timeEndStr); 
        const validTimesForDay = [];

        // 預先過濾出「當天」相關的預約與排休，避免內層迴圈跑無關資料
        const dailyReservations = filterEventsByDate(reservations, dateString);
        const dailyDutyoffs = filterEventsByDate(dutyoffs, dateString);

        // 當日可預約人力 = validStaffSet（含 baseData 在職 + 預約/排休中出現的每刻01、每刻02 等），確保 01/02 身份也算可預約人力
        const totalStaffForDay = validStaffSet.size > 0 ? validStaffSet.size : 4;

        const timesWithCount = []; // { time, count } 供明日預約清單顯示「14:00×1、17:00×2」
        dayTimeSlots.forEach(timeStr => {
          const checkStartMin = hhmmToMinutes(timeStr);
          const checkEndMin = checkStartMin + durationMin; 
          
          // (A) 基本過濾: 超過最晚可預約時間 或 跨日
          if (checkStartMin > lastBookingMin) return;
          if (checkEndMin > 1440) return; // 24:00

          // (B) 過濾過去時間（僅限「今天」）
          const todayStr = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
          if (dateString === todayStr) { 
            const now = new Date();
            const nowMin = now.getHours() * 60 + now.getMinutes();
            // 緩衝: 現在時間 + 30分鐘後的時段才開放
            if (checkStartMin < (nowMin + 30)) return;
          }

          // (C) 計算「實際忙碌的員工」集合，改以人頭而非事件數量，確保與多人預約邏輯一致
          const busyStaffIds = new Set();

          // C-1. 檢查預約占用（含待確認皆算佔用，與後台「已滿」一致）
          for (const r of dailyReservations) {
            const ru = r.usrsid != null ? Number(r.usrsid) : 0;
            if (validStaffSet.size > 0 && ru > 0 && !validStaffSet.has(ru)) continue;
            if (!r.rsvtim || !r.endtim) continue;
            const rStart = isoToMinutes(r.rsvtim);
            const rEnd = isoToMinutes(r.endtim);
            
            // 重疊判定: !(End <= Start || Start >= End)
            if (rEnd > checkStartMin && rStart < checkEndMin) {
              if (ru > 0) busyStaffIds.add(ru);
            }
          }

          // C-2. 檢查排休占用（櫃檯的休息不計入，只算正規人力的排休）
          for (const d of dailyDutyoffs) {
            if (isCounterStaffDutyoff(d)) continue;
            const du = d.usrsid != null ? Number(d.usrsid) : 0;
            if (validStaffSet.size > 0 && du > 0 && !validStaffSet.has(du)) continue;
            
            const dStart = isoToMinutes(d.startm);
            const dEnd = isoToMinutes(d.endtim);
            
            if (dEnd > checkStartMin && dStart < checkEndMin) {
              if (du > 0) busyStaffIds.add(du);
            }
          }

          // (D) 判定：可用人頭數 = 當日人力（validStaffSet）扣掉忙碌員工數
          let availableCount = 0;
          validStaffSet.forEach(id => {
            if (!busyStaffIds.has(id)) availableCount++;
          });

          // 只有在「同時至少有 needPeople 位員工，且整個 duration 區間都沒有被預約/排休」時，才視為此起始時間可預約
          if (availableCount >= needPeople) {
            validTimesForDay.push(timeStr);
            timesWithCount.push({ time: timeStr, count: availableCount });
          }
        });

        // 6. 收集結果
        // 這裡不需要 filterSlotsByDuration，因為我們要顯示「所有」可預約的起始點
        if (validTimesForDay.length > 0) {
          // durationMin: 服務時長
          // 5: 限制一天最多顯示 5 個精選時段 (可自行調整)
          const smartTimes = getSmartSlots(validTimesForDay, durationMin, 5);
          const smartWithCount = smartTimes.map(t => {
            const found = timesWithCount.find(x => x.time === t);
            return found ? { time: t, count: found.count } : { time: t, count: 1 };
          });
          availableSlots.push({
            date: dateString,
            week: ["日","一","二","三","四","五","六"][dayOfWeek],
            times: smartTimes,
            timesWithCount: smartWithCount
          });
        }
      }
      
      // 下一天
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return {
      status: true,
      data: availableSlots,
      totalStaff: totalStaff,
      validStaffSet: Array.from(validStaffSet)
    };

  } catch (err) {
    console.error(`[Core] findAvailableSlots Error: ${err.toString()}`);
    return { status: false, error: err.toString(), data: [], validStaffSet: [] };
  }
}
/** baseData API 網址，供快取與取得店家／職位／員工用 */
var BASE_DATA_API_URL = "https://saywebdatafeed.saydou.com/api/management/baseData?kind%5B%5D=stores&kind%5B%5D=positions&kind%5B%5D=staffs";

/** 是否為「櫃檯」人力（店內櫃檯1、店內櫃檯2 等排除，只算正規人力） */
function isCounterStaff(s) {
  var cod = (s && s.usrcod) ? String(s.usrcod) : "";
  var nam = (s && s.usrnam) ? String(s.usrnam) : "";
  return cod.indexOf("櫃檯") >= 0 || nam.indexOf("櫃檯") >= 0;
}

/** 排休紀錄是否為櫃檯人員（API 回傳的 dutyoff 有 usrnam，用於查詢空位不計入櫃檯休息） */
function isCounterStaffDutyoff(d) {
  var nam = (d && d.usrnam) ? String(d.usrnam) : "";
  return nam.indexOf("櫃檯") >= 0;
}

/** baseData 快取 TTL（秒），6 小時，避免 urlfetch 每日配額耗盡 */
var BASE_DATA_CACHE_TTL_SEC = 6 * 60 * 60;

/**
 * 取得 baseData 完整回應（快取 6 小時，全專案共用，減少 urlfetch 呼叫）
 * @param {string} token - API Token
 * @return {{ status: boolean, positions: Array, stores: Array, staffs: Array }} 或 null
 */
function getBaseDataCached(token) {
  var tokenPart = (token && String(token).length > 0) ? String(token).substring(0, 24) : "default";
  var cacheKey = "baseData_" + tokenPart;
  try {
    var cache = CacheService.getDocumentCache();
    var cached = cache.get(cacheKey);
    if (cached) {
      var json = JSON.parse(cached);
      if (json && json.status === true) return json;
    }
  } catch (cacheErr) {
    // 快取讀取失敗（如逾時、容量）則直接打 API
  }
  try {
    var response = UrlFetchApp.fetch(BASE_DATA_API_URL, {
      method: "get",
      headers: { "Authorization": "Bearer " + token },
      muteHttpExceptions: true
    });
    var json = JSON.parse(response.getContentText());
    if (json && json.status === true) {
      try {
        CacheService.getDocumentCache().put(cacheKey, JSON.stringify(json), BASE_DATA_CACHE_TTL_SEC);
      } catch (putErr) {
        // 快取寫入失敗不影響回傳
      }
      return json;
    }
    return null;
  } catch (e) {
    console.error("[Core] getBaseDataCached Error: " + e);
    return null;
  }
}

/**
 * 取得指定店家的有效員工 ID（正規人力，排除櫃檯1/櫃檯2；先讀 baseData 快取再依店家篩選）
 * @param {string} sayId - 店家 SayDou ID
 * @param {string} [token] - API Token（可選，未傳則用 getBearerTokenFromSheet）
 * @return {Set<number>} 有效員工 ID 集合
 */
function getStoreCapacityIds(sayId, token) {
  // 先關閉人力池快取，每次直接根據最新 baseData 計算
  var t = (token != null && token !== "") ? token : getBearerTokenFromSheet();
  if (!t) return new Set();
  var json = getBaseDataCached(t);
  var validIds = [];
  var sayIdStr = String(sayId);

  // 額外補強：某些店家的「可接客員工」在 baseData 裡沒有正確標示 store，
  // 可以在這裡用手動表方式補上（非櫃檯人員的 usrsid）
  // 使用方式：把實際的 SayDou 店家 ID 當 key，value 放需要一併算入產能的 usrsid 陣列。
  // 例如： "4229": [11111, 22222]  // 內湖01、內湖02
  var EXTRA_STORE_STAFF = {
    // TODO: 請填入實際需要補強的店家與員工 ID
    "4229": [21617, 22569] // 內湖01, 內湖02
    // "1437": [/* 光明01 usrsid */, /* 光明02 usrsid */]
  };

  if (json && json.staffs && json.staffs[0]) {
    var categories = json.staffs[0];
    Object.keys(categories).forEach(function (role) {
      categories[role].forEach(function (s) {
        var storeMatch = (s.msstor != null && String(s.msstor) === sayIdStr) || (s.storid != null && String(s.storid) === sayIdStr);
        if (!storeMatch) return;
        if (s.status !== "on" || s.usrsid == null || Number(s.usrsid) <= 0) return;
        if (isCounterStaff(s)) return; // 排除櫃檯，只算正規人力
        validIds.push(Number(s.usrsid));
      });
    });
  }

  // 把手動補強的人員 ID 也併入 validIds（避免重複）
  var extra = EXTRA_STORE_STAFF[sayIdStr];
  if (Array.isArray(extra)) {
    extra.forEach(function (id) {
      var n = Number(id);
      if (n > 0 && validIds.indexOf(n) === -1) validIds.push(n);
    });
  }

  return new Set(validIds);
}

/**
 * Debug 用：在 GAS 後台直接執行，檢查某店家、某日期區間的可預約結果與人力。
 * 使用方式：打開指令碼編輯器，在函式列表選擇 runFindAvailableSlotsDebug 後執行，然後看日誌。
 */
function runFindAvailableSlotsDebug() {
  // 請依實際測試需求修改下列三個參數
  var sayId = "4229";              // 店家 SayDou ID，例如 內湖店 = 4229
  var startDate = "2026-02-24";    // 起始日期 (yyyy-MM-dd)
  var endDate = "2026-02-24";      // 結束日期 (yyyy-MM-dd)

  var result = findAvailableSlots(sayId, startDate, endDate, 1, 90, {
    weekDays: [0,1,2,3,4,5,6],
    timeStart: "11:00",
    timeEnd: "21:00"
  });

  Logger.log("[runFindAvailableSlotsDebug] result = %s", JSON.stringify(result, null, 2));
}
/**
 * 取得指定範圍內的預約與排休資料 (SayDou API)
 * @param {string} sayId 
 * @param {string} startDate (yyyy-MM-dd)
 * @param {string} endDate (yyyy-MM-dd)
 * @param {string} [token] - 選填；未傳則用腳本載入時的 getBearerTokenFromSheet()
 */
function fetchReservationsAndOffs(sayId, startDate, endDate, token) {
  const tokenToUse = (token != null && token !== "") ? token : (typeof getBearerTokenFromSheet === "function" ? getBearerTokenFromSheet() : "");
  const apiUrl = `https://saywebdatafeed.saydou.com/api/management/calendar/events/full?startDate=${startDate}&endDate=${endDate}&storid=${sayId}&status[]=reservation&status[]=hasshow&status[]=confirm&status[]=checkout&status[]=noshow&holiday=1`;
  try {
    const response = UrlFetchApp.fetch(apiUrl, {
      method: "get",
      headers: { "Authorization": "Bearer " + tokenToUse },
      muteHttpExceptions: true
    });
    const json = JSON.parse(response.getContentText());
    if (!json.status) throw new Error("API status false");
    
    // 只回傳需要的
    return {
      reservations: json.data.reservation || [],
      dutyoffs: json.data.dutyoffs || []
    };
  } catch (e) {
    console.error(`[Core] fetchReservationsAndOffs Error: ${e}`);
    return { reservations: [], dutyoffs: [] };
  }
}
/** 篩選特定日期的事件 (優化效能用) */
function filterEventsByDate(events, dateString) {
  if (!events || events.length === 0) return [];
  return events.filter(e => {
    // 預約用 rsvtim, 排休用 startm
    const start = e.rsvtim || e.startm;
    return start && start.startsWith(dateString);
  });
}

/**
 * 產生時間空檔 (例如 11:00, 11:30, 12:00...)
 * @param {string} startStr (HH:mm)
 * @param {string} endStr (HH:mm)
 * @return {string[]} 時間字串陣列
 */
function generateTimeSlots(startStr, endStr) {
  const slots = [];
  let current = hhmmToMinutes(startStr);
  const end = hhmmToMinutes(endStr);
  while (current <= end) {
    const h = Math.floor(current / 60).toString().padStart(2, '0');
    const m = (current % 60).toString().padStart(2, '0');
    slots.push(`${h}:${m}`);
    current += 30; 
  }
  return slots;
}

/**
 * 根據服務時長過濾連續空檔 (避免推薦 13:00, 13:30, 14:00 重複佔用)
 * @param {string[]} rawSlots 原始可用時段
 * @param {number} durationMin 服務時長(分鐘)
 */
function filterSlotsByDuration(rawSlots, durationMin) {
  if (!rawSlots || rawSlots.length === 0) return [];
  
  const result = [];
  let nextAvailableMin = -1;

  rawSlots.forEach(timeStr => {
    const currentMin = hhmmToMinutes(timeStr);
    
    // 如果是第一個時段，或者目前時間已經超過「上一個時段 + 施作時間」
    if (nextAvailableMin === -1 || currentMin >= nextAvailableMin) {
      result.push(timeStr);
      nextAvailableMin = currentMin + durationMin;
    }
  });

  return result;
}

// --- 時間轉換小工具 (不導出也可，視需求) ---

function hhmmToMinutes(timeStr) {
  const parts = timeStr.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function isoToMinutes(isoStr) {
  if (!isoStr) return -1;
  const parts = isoStr.split(/[\sT]/);
  if (parts.length < 2) return -1;
  const timePart = parts[1];
  if (!timePart) return -1;
  const timeParts = timePart.split(":");
  return parseInt(timeParts[0]) * 60 + parseInt(timeParts[1]);
}

// 導出函式供外部使用
// 注意：如果您的 Core 是用 Library 方式引用，上面的 function 直接寫就好，不一定要 global
// 但為了方便識別，可以把這些工具函式掛在一個物件下回傳
function getSmartSlots(slots, durationMin, limit = 5) {
  if (!slots || slots.length === 0) return [];
  
  const result = [];
  let nextAvailableMin = -1;

  for (const timeStr of slots) {
    // 如果已經收集夠了，就停止 (避免單日顯示太多讓版面太長)
    if (result.length >= limit) break;

    const currentMin = hhmmToMinutes(timeStr);
    
    // 邏輯：如果是第一個，或者目前時間已經 >= 上一個推薦時段 + 服務時長
    // 這樣可以確保推薦的時間是「做完一個客人後，馬上接下一個」的完美節奏
    if (nextAvailableMin === -1 || currentMin >= nextAvailableMin) {
      result.push(timeStr);
      // 下一個推薦時間 = 當前時間 + 服務時長
      // 如果你想讓選項多一點，可以把這裡改成 + 60 (固定一小時一跳)
      nextAvailableMin = currentMin + durationMin; 
    }
  }

  return result;
}