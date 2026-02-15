// ==========================================
// [Report.gs] 預約表單報表 (防爆 API 安全版)
// ==========================================
const REPORT_CONFIG = {
  SHEET_NAME: "預約表單",
  // 固定檢測這些時段
  SLOT_TIMES: ["11:00", "12:30", "14:00", "15:30", "17:00", "18:00", "19:30"],
  COURSE_MINUTES: 90, // 1.5 hr
  SEARCH_DAYS: 5,     // 搜尋未來 7 天
  TZ: Session.getScriptTimeZone() || 'Asia/Taipei',
  
  // ★ 安全設定：一次平行請求的數量 (建議 5~10)
  BATCH_SIZE: 10,
  // ★ 安全設定：每批請求後的休息時間 (毫秒)
  SLEEP_MS: 500 
};

function runReservationReport() {
  const ss = SpreadsheetApp.openById(PAOPAO_STORE_SS_ID);
  const sheet = ss.getSheetByName(REPORT_CONFIG.SHEET_NAME);
  if (!sheet) throw new Error(`找不到工作表「${REPORT_CONFIG.SHEET_NAME}」`);

  // 1. 初始化與清空舊資料
  const lastRow = sheet.getLastRow();
  if (lastRow >= 4) {
    sheet.getRange(4, 1, lastRow - 3, 3).clearContent();
  }
  
  // 2. [Core API] 取得 token 與店家列表
  const token = CoreApi.getBearerToken();
  let stores = CoreApi.getStoresInfo();
  stores = stores.map(function (s) {
    s.validStaffSet = (s.validStaffSet && Array.isArray(s.validStaffSet)) ? new Set(s.validStaffSet) : (s.validStaffSet || new Set());
    return s;
  });
    
  console.log(`取得店家數: ${stores.length}，準備分批執行...`);

  // 3. 準備所有的 API 請求 (Requests) 與 對應資訊 (Meta)
  let allRequests = [];
  let allMeta = [];

  stores.forEach(store => {
    // 標記：店家標題列
    allMeta.push({ type: 'HEADER', name: store.name });

    for (let d = 0; d <= REPORT_CONFIG.SEARCH_DAYS; d++) {
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + d);
      const dateStr = Utilities.formatDate(targetDate, REPORT_CONFIG.TZ, "yyyy-MM-dd");
      
      const url = `https://saywebdatafeed.saydou.com/api/management/calendar/events/full?startDate=${dateStr}&endDate=${dateStr}&storid=${store.id}&status[]=reservation&status[]=hasshow&status[]=confirm&status[]=checkout&status[]=noshow&holiday=1`;
      
      allRequests.push({
        url: url,
        method: 'get',
        headers: { 'Authorization': 'Bearer ' + token },
        muteHttpExceptions: true
      });

      // 標記：資料列 (把計算需要的參數都先打包好)
      allMeta.push({ 
        type: 'DATA', 
        storeId: store.id,
        totalStaff: store.totalStaff,
        validStaffSet: store.validStaffSet,
        dateStr: dateStr,
        dateObj: targetDate
      });
    }
  });

  // 4. ★ 分批平行處理 (Batch Processing) ★
  // 這就是防爆的關鍵：每次只處理 BATCH_SIZE 個請求，然後休息一下
  let outputValues = [];
  let requestCursor = 0; // 用來記錄現在 request 拿到了沒
  
  // Meta 的數量會比 Request 多 (因為包含 HEADER)，所以我們分開處理
  // 我們要遍歷 Meta，如果是 DATA 類型，就去拿一個 Request 的結果
  
  // 為了方便分批，我們先把「真正的 API 請求」執行完存起來，或者邊執行邊存
  // 但因為 meta 和 request 的索引不對齊 (meta 有 header)，我們改用以下策略：
  // 先把 allRequests 分批執行完，存入一個大的 responses 陣列
  
  let allResponses = [];
  const totalReqs = allRequests.length;
  
  console.log(`共有 ${totalReqs} 個 API 請求，每批 ${REPORT_CONFIG.BATCH_SIZE} 個...`);

  for (let i = 0; i < totalReqs; i += REPORT_CONFIG.BATCH_SIZE) {
    const chunk = allRequests.slice(i, i + REPORT_CONFIG.BATCH_SIZE);
    
    try {
      // 平行發送這一小批
      const chunkResponses = UrlFetchApp.fetchAll(chunk);
      allResponses = allResponses.concat(chunkResponses);
      
      console.log(`已完成 ${Math.min(i + REPORT_CONFIG.BATCH_SIZE, totalReqs)} / ${totalReqs}`);
      
      // ★ 休息一下，避免 API Rate Limit
      Utilities.sleep(REPORT_CONFIG.SLEEP_MS);
      
    } catch (e) {
      console.error(`Batch Error at index ${i}:`, e);
      // 簡單錯誤處理：塞入 null 避免陣列錯位
      for (let k=0; k<chunk.length; k++) allResponses.push(null);
    }
  }

  // 5. 組裝資料 (Mapping)
  let respIndex = 0;

  for (let i = 0; i < allMeta.length; i++) {
    const meta = allMeta[i];

    if (meta.type === 'HEADER') {
      outputValues.push([meta.name, "", ""]);
    } else {
      // 這是一筆資料，取出對應的 response
      const res = allResponses[respIndex++];
      const weekdayZh = "星期" + "日一二三四五六".charAt(meta.dateObj.getDay());
      const dateDisplay = `${meta.dateStr}（${weekdayZh}）`;
      
      let resultText = "（讀取失敗）";

      if (res && res.getResponseCode() === 200) {
        try {
          const json = JSON.parse(res.getContentText());
          const reservations = (json.data && json.data.reservation) ? json.data.reservation : [];
          const dutyoffs = (json.data && json.data.dutyoffs) ? json.data.dutyoffs : [];
          
          if (reservations.length === 0 && dutyoffs.length === 0) {
             // 完全沒單，空位 = 總人數
             resultText = `全時段(${meta.totalStaff})`; 
             // 或是您想要列出所有時段也可以，看需求
             // resultText = generateFullOpenSlots(meta.totalStaff); 
          } else {
            // ★ 呼叫容量計算邏輯
            const slots = calculateCapacitySlots_(
              reservations, 
              dutyoffs,
              meta.dateStr,
              meta.totalStaff, 
              meta.validStaffSet,
              REPORT_CONFIG.SLOT_TIMES, 
              REPORT_CONFIG.COURSE_MINUTES
            );
            resultText = (slots.length > 0) ? slots.join("、") : "（無）";
          }
        } catch (e) {
          console.error("Parse Error", e);
        }
      }
      
      outputValues.push(['', dateDisplay, resultText]);
    }
  }

  // 6. 寫入 Sheet
  if (outputValues.length > 0) {
    sheet.getRange(4, 1, outputValues.length, 3).setValues(outputValues);
  }
  console.log('報表完成');
}


// ==========================================
// 邏輯計算區 (類似 Core.findAvailableSlots)，時間工具本機實作
// ==========================================

function hhmmToMinutes_(timeStr) {
  const parts = (timeStr || "").split(":");
  return parseInt(parts[0], 10) * 60 + (parseInt(parts[1], 10) || 0);
}

function isoToMinutes_(isoStr) {
  if (!isoStr) return -1;
  const parts = isoStr.split(/[\sT]/);
  if (parts.length < 2) return -1;
  const timePart = parts[1];
  if (!timePart) return -1;
  const timeParts = timePart.split(":");
  return parseInt(timeParts[0], 10) * 60 + (parseInt(timeParts[1], 10) || 0);
}

function calculateCapacitySlots_(reservations, dutyoffs, dateStr, totalStaff, validStaffSet, slotTimes, durationMin) {
  const results = [];
  const getMin = isoToMinutes_;
  const getHmmMin = hhmmToMinutes_;

  slotTimes.forEach(timeStr => {
    const checkStart = getHmmMin(timeStr);
    const checkEnd = checkStart + durationMin;

    // 基本檢查: 跨日不顯示
    if (checkEnd > 1440) return;

    // 過濾: 過去時間 (若是今天)
    // const todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
    // if (dateStr === todayStr) {
    //    const now = new Date();
    //    const currentMin = now.getHours() * 60 + now.getMinutes() + 30;
    //    if (checkStart < currentMin) return;
    // }

    let busyCount = 0;

    // (A) 預約占用
    reservations.forEach(r => {
      if (r.aprove !== "Y") return;
      if (!r.rsvtim.startsWith(dateStr)) return;
      if (validStaffSet && validStaffSet.size > 0 && !validStaffSet.has(r.usrsid)) return;
      
      const rStart = getMin(r.rsvtim);
      const rEnd = getMin(r.endtim);
      
      if (rEnd > checkStart && rStart < checkEnd) busyCount++;
    });

    // (B) 排休占用
    dutyoffs.forEach(d => {
      if (d.close_ !== 1) return;
      if (!d.startm.startsWith(dateStr)) return;
      if (validStaffSet && validStaffSet.size > 0 && !validStaffSet.has(d.usrsid)) return;
      
      const dStart = getMin(d.startm);
      const dEnd = getMin(d.endtim);
      
      if (dEnd > checkStart && dStart < checkEnd) busyCount++;
    });

    // ★ 計算剩餘空位
    const freeCount = totalStaff - busyCount;

    if (freeCount > 0) {
      // 如果剩餘超過 1 人，加上括號顯示 (e.g., "11:00(2)")
      // 如果只剩 1 人，就顯示 "11:00" 即可，保持版面乾淨 (或者您想改成 (1) 也可以)
      const label = (freeCount > 1) ? `${timeStr}(${freeCount})` : timeStr;
      results.push(label);
    }
  });

  return results;
}