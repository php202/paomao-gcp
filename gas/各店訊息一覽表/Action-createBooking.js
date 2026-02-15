// ==========================================
// 測試專用：建立預約 (Debug Create Booking)
// ==========================================
// ==========================================
// [Main.gs] 測試區
// ==========================================

function debugCreateBooking() {
  // --- 1. 設定測試資料 ---
  const TEST_BOT_ID = "Uba2913d6dc16f15113df9f937af2ca21"; // ⚠️ 請換成真的 Bot ID
  const TEST_PHONE = "0975513172"; // 測試電話
  
  // 自動設為明天下午 3 點
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 3);
  const dateStr = Utilities.formatDate(tomorrow, Session.getScriptTimeZone(), "yyyy-MM-dd");
  
  // --- 2. 偽造 e 物件 (Mock Event) ---
  const mockEvent = {
    parameter: {
      action: "createBooking",
      botId: TEST_BOT_ID,
      phone: TEST_PHONE,
      date: dateStr,
      time: "13:00",
      duration: "1.5",
      people: "2",       // 測試 2 人
      remark: "Debug測試單"
    }
  };

  Logger.log(`🚀 開始測試預約: ${dateStr} 15:00 (2人)`);

  // --- 3. 把偽造的 e 丟進去執行 ---
  // 這裡我們直接呼叫 createBooking，就像 doGet 呼叫它一樣
  const result = createBooking(mockEvent);
  
  // --- 4. 查看結果 ---
  const json = JSON.parse(result.getContent()); // 因為回傳的是 TextOutput，要解開
  
  if (json.status === 'success') {
    Logger.log("✅ 測試成功！");
    Logger.log("詳細資料: " + JSON.stringify(json.data));
  } else {
    Logger.log("❌ 測試失敗: " + json.error);
    Logger.log("原因: " + json.details);
  }
}
// ==========================================
// [Main.gs] 資料拆解層
// ==========================================

function createBooking(e) {
  // 1. 從 e.parameter 拿出資料
  const p = e.parameter;
  
  const botId = p.botId;
  const phone = p.phone;
  const date = p.date;
  const time = p.time;
  const duration = parseFloat(p.duration); // 字串轉浮點數
  const remark = p.remark || "";
  const people = parseInt(p.people) || 1;  // 字串轉整數，預設 1
  
  // 2. 檢查必要參數 (簡單防呆)
  if (!botId || !phone || !date || !time || !duration) {
    return Core.jsonResponse({error: '缺少必要參數 (botId, phone, date, time, duration)'});
  }

  // 3. 取得店家設定 (SayId)
  const config = getStoreConfig(botId);
  if (!config) return Core.jsonResponse({error: '找不到店家設定'});

  try {
    // 4. ★★★ 呼叫核心邏輯 ★★★
    // 這裡傳進去的是乾淨的變數，不再是 e 了
    const result = createReservation(
      phone, 
      date, 
      time, 
      duration, 
      remark, 
      config.sayId, 
      people
    );
    
    // 5. 回傳成功結果
    return Core.jsonResponse({status: 'success', data: result});
    
  } catch (err) {
    // 6. 捕捉錯誤並回傳
    return Core.jsonResponse({error: '預約失敗', details: err.toString()});
  }
}

// ==========================================
// [Main.gs] 建立預約的主函式 (重構版)
// ==========================================

/**
 * 建立預約的主函式 (改用 Core 邏輯)
 */
function createReservation(phone, dateStr, timeStr, workhr, remark, sayId, peopleCount) {
  const token = Core.getBearerTokenFromSheet();
  if (!token) throw new Error("無法取得 Token");

  const storeMap = Core.getLineSayDouInfoMap() || {};
  let targetStoreName = "店家"; // 預設值

  // getLineSayDouInfoMap 回傳普通物件，用 Object.values 遍歷
  const storeList = Object.values(storeMap);
  for (const info of storeList) {
    // 轉成字串比對比較保險
    if (String(info.saydouId) === String(sayId)) {
      targetStoreName = info.name;
      break; // 找到了就跳出迴圈
    }
  }

  // 2. 查詢會員
  const member = Core.getMemApi(phone);
  if (!member) throw new Error(`找不到會員，手機: ${phone}`);

  // 3. [修正重點] 改用 Core.findAvailableSlots 來找空位和員工
  // 人力池 validStaffSet 用「當週」日期範圍計算，才能納入當天無排程但本週有排程的員工（如海每刻01/02）
  const durationMin = workhr * 60;
  const TZ = Session.getScriptTimeZone() || 'Asia/Taipei';
  const bookingDate = new Date(dateStr);
  const weekStart = new Date(bookingDate);
  weekStart.setDate(bookingDate.getDate() - 3);
  const weekEnd = new Date(bookingDate);
  weekEnd.setDate(bookingDate.getDate() + 3);
  const weekStartStr = Utilities.formatDate(weekStart, TZ, 'yyyy-MM-dd');
  const weekEndStr = Utilities.formatDate(weekEnd, TZ, 'yyyy-MM-dd');

  const result = Core.findAvailableSlots(
    sayId, 
    weekStartStr, // 當週範圍：讓 validStaffSet 包含本週有預約/排休的員工
    weekEndStr, 
    peopleCount, 
    durationMin,
    {
      timeStart: timeStr,
      timeEnd: timeStr,
      token: token,
      weekDays: [bookingDate.getDay()]
    }
  );

  // 4. 解析 Core 回傳的結果，找出是哪些員工有空
  // 注意：Core.findAvailableSlots 的原始設計是回傳「有空位的時段」，
  // 但為了預約，我們需要知道「具體是哪位員工有空」。
  
  // 使用 Core 回傳的 validStaffSet（與查詢空位同一套人力池），確保預約時人力計算一致
  const validStaffSet = (result.status && result.validStaffSet && result.validStaffSet.length > 0)
    ? result.validStaffSet
    : null;
  const availableStaffIds = getAvailableStaffIds_Reborn(dateStr, timeStr, durationMin, sayId, token, validStaffSet);

  // 檢查人數是否足夠
  if (availableStaffIds.length < peopleCount) {
    throw new Error(`該時段空位不足！需要 ${peopleCount} 位，但只剩 ${availableStaffIds.length} 位有空。`);
  }

  // 5. 開始批次建立預約 (邏輯維持原樣)
  const results = [];
  const rsvtim = `${dateStr} ${timeStr}`;
  const DEFAULT_SERVICE_ID = "gods_234550"; 

  for (let i = 0; i < peopleCount; i++) {
    const assignedUsrsid = availableStaffIds[i]; // 取出員工 ID

    const confirmMsg = [
      `親愛的 ${member.memnam} 您好，`,
      `我們已為您確認以下預約資訊：`,
      `📅 預約時間：${rsvtim}`,
      `⏳ 預約時長：${workhr} 小時`,
      `📝 預約說明：${remark}`,
      `請您於預約時間光臨`,
      `泡泡貓｜${targetStoreName}，謝謝。`
    ].join('\n');

    const payload = {
      "rsvtid": 0,
      "membid": member.membid,
      "rsname": member.memnam,
      "rsphon": member.phone_,
      "rsvtim": rsvtim,
      "workhr": workhr,
      "workbf": 0,
      "usrsid": parseInt(assignedUsrsid), 
      "storid": sayId,
      "people": 1,
      "time": timeStr,
      "remark": peopleCount > 1 ? `${remark} (多人預約 ${i+1}/${peopleCount})` : remark,
      "gender": member.gender,
      "services": [ DEFAULT_SERVICE_ID ],
      "assign": true,
      "fstbok": false,
      "pushConfirm": true,
      "confirmMessage": confirmMsg
    };

    // 發送 API
    const apiUrl = "https://saywebdatafeed.saydou.com/api/management/calendar/reservation";
    const options = {
      method: "post",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json"
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(apiUrl, options);
    const respText = response.getContentText();
    
    if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
      results.push(JSON.parse(respText));
    } else {
      throw new Error(`第 ${i+1} 筆預約失敗: ${respText}`);
    }
  }

  return { status: "success", count: results.length, details: results };
}


// ==========================================
// [輔助函式] 專門用來找「誰有空」 (建議放在 Main.gs 底下)
// ==========================================
/**
 * 找出指定時段內空閒的員工 ID 列表
 * 若傳入 validStaffSet（來自 Core.findAvailableSlots），則直接作為可預約人力池，與查詢空位邏輯一致
 * @param {Array<number>|null} validStaffSet - 可選，Core.findAvailableSlots 回傳的 validStaffSet
 */
function getAvailableStaffIds_Reborn(date, time, durationMin, sayId, token, validStaffSet) {
  let allStaffSet;
  if (validStaffSet && validStaffSet.length > 0) {
    // 使用與 Core.findAvailableSlots 相同的人力池，確保預約時不會少算（如海每刻01/02）
    allStaffSet = new Set(validStaffSet.map(function (id) { return Number(id); }).filter(function (n) { return n > 0; }));
  } else {
    // 相容舊呼叫：自行組建人力池
    const baseStaffSet = Core.getStoreCapacityIds(sayId, token);
    allStaffSet = new Set();
    if (baseStaffSet && baseStaffSet.size > 0) {
      baseStaffSet.forEach(function (id) {
        var n = Number(id);
        if (n > 0) allStaffSet.add(n);
      });
    }
    const { reservations, dutyoffs } = Core.fetchReservationsAndOffs(sayId, date, date, token);
    (reservations || []).forEach(function (r) {
      var n = r && r.usrsid != null ? Number(r.usrsid) : 0;
      if (n > 0) allStaffSet.add(n);
    });
    (dutyoffs || []).forEach(function (d) {
      var n = d && d.usrsid != null ? Number(d.usrsid) : 0;
      if (n > 0) allStaffSet.add(n);
    });
  }
  if (!allStaffSet || allStaffSet.size === 0) return [];

  // 3. 取得當日預約／排休以計算忙碌員工
  const { reservations: res, dutyoffs: offs } = Core.fetchReservationsAndOffs(sayId, date, date, token);
  const reservations = res || [];
  const dutyoffs = offs || [];

  // 4. 計算目標時段的分鐘數區間
  const startMin = Core.hhmmToMinutes(time);
  const endMin = startMin + durationMin;
  
  const busyStaffIds = new Set();

  // (A) 檢查預約（含待確認皆視為佔用，與空位顯示一致）
  reservations.forEach(r => {
    const rStart = Core.isoToMinutes(r.rsvtim);
    const rEnd = Core.isoToMinutes(r.endtim);
    const ru = r && r.usrsid != null ? Number(r.usrsid) : 0;
    
    // 時間重疊
    if (rEnd > startMin && rStart < endMin) {
      if (ru > 0 && allStaffSet.has(ru)) {
        busyStaffIds.add(ru);
      }
    }
  });

  // (B) 檢查排休
  dutyoffs.forEach(d => {
    if (d.close_ !== 1) return;
    if (!d.startm.startsWith(date)) return;

    const dStart = Core.isoToMinutes(d.startm);
    const dEnd = Core.isoToMinutes(d.endtim);
    const du = d && d.usrsid != null ? Number(d.usrsid) : 0;
    
    if (dEnd > startMin && dStart < endMin) {
      if (du > 0 && allStaffSet.has(du)) {
        busyStaffIds.add(du);
      }
    }
  });

  // 5. 排除忙碌員工，剩下的就是有空的
  const availableStaffs = [];
  allStaffSet.forEach(staffId => {
    if (!busyStaffIds.has(staffId)) {
      availableStaffs.push(staffId);
    }
  });

  return availableStaffs;
}