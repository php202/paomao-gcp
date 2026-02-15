function getAtt(replyToken, userId) {
  let msg = ''
  const { isAuthorized, identity } = isUserAuthorized(userId)
  if(!isAuthorized) { noAuthorized(replyToken) }
  // 取得身份
  // 員工 可以看自己 本月/ 上月 的出勤紀錄
  let quickReplyItems = []
  if (identity.includes('employee')) {
    msg += `想看自己出勤`
    quickReplyItems.push(
      createQuickReplyItem("本月出勤", "本月出勤"),
      createQuickReplyItem("上月出勤", "上月出勤")
    )
  }
  if (identity.includes('manager')) {
    if (identity.length > 1) {msg += `\n`}
    msg = msg + `想看店家狀況`
    quickReplyItems.push(
      createQuickReplyItem("店家今天出勤", "店家今天出勤"),
      createQuickReplyItem("店家本月出勤", "店家本月出勤"),
      createQuickReplyItem("店家上月出勤", "店家上月出勤"),
      createQuickReplyItem("店家可預約時間", "店家可預約時間"),
    )
  }
  const data = SpreadsheetApp.openById(LINE_STAFF_SS_ID).getSheetByName("公司流程")
  for (let i = 0; i < (data.length - 1); i++) {
    const name = data[i][0]
    quickReplyItems.push(createQuickReplyItem(name, name))
  }
  const obj = 
  {
  "type": "text",
  "text": msg,
  "quickReply": { "items": quickReplyItems }
  }
  
  reply(replyToken, obj)
}

// 取得 人員打卡記錄
function getUserAttendance(userIds, start, end) {
  const ss = SpreadsheetApp.openById(LINE_STAFF_SS_ID);
  const now = new Date();
  
  // 定義分界線：本月 1 號 00:00:00
  const cutoffDate = new Date(now.getFullYear(), now.getMonth(), 1);
  
  const startDate = new Date(start);
  const endDate = new Date(end);

  // 1. 決定要讀取哪些工作表 (跨月查詢支援)
  let sheetsToRead = [];
  if (startDate < cutoffDate) sheetsToRead.push("打卡紀錄封存");
  if (endDate >= cutoffDate) sheetsToRead.push("員工打卡紀錄");
  if (sheetsToRead.length === 0) sheetsToRead.push("員工打卡紀錄");

  let allData = [];

  // 2. 讀取並合併資料
  for (const sheetName of sheetsToRead) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) continue;

    const data = sheet.getDataRange().getValues();
    // 這裡使用 concat 合併陣列
    allData = allData.concat(data);
  }

  // 3. 統一過濾 (ID + 時間 + C 欄須為上下班)
  let filteredData = allData.filter((row) => {
    const uId = row[0];  // A欄: UserId
    const time = row[1]; // B欄: 打卡時間
    const type = row[2]; // C欄: 上班打卡/下班打卡

    if (!(time instanceof Date)) return false;
    if (!userIds.includes(uId) || time < startDate || time > endDate) return false;

    // C 欄沒有上下班就不顯示
    if (type == null || String(type).trim() === "") return false;
    const t = String(type).trim();
    if (!t.includes("上班") && !t.includes("下班")) return false;

    return true;
  });

  // 4. 排序 (讓時間由舊到新)
  filteredData.sort((a, b) => new Date(a[1]) - new Date(b[1]));

  // ==========================================
  // ★★★ 5. 關鍵修改：處理「補打卡」標記 ★★★
  // ==========================================
  const finalData = filteredData.map(row => {
    // 欄位對應：
    // Index 2 (C欄) = 類型 (上班打卡/下班打卡)
    // Index 6 (G欄) = 備註 (我們在 makeUpTime 裡寫入 "📝補打卡")
    
    const type = row[2];       // 原本的類型
    const note = row[6] || ""; // 備註欄 (如果沒資料就是空字串)

    // 檢查備註是否有 "補打卡" 關鍵字
    if (String(note).includes("補打卡")) {
      // 直接修改這一列的數據，加上 (補)
      // 例如： "上班打卡" -> "上班打卡(補)"
      row[2] = type + "(補)";
    }
    
    return row;
  });

  return finalData;
}
// 正規化 打卡記錄
function formatAtt(attendanceRecords) {
  if (attendanceRecords.length === 0) {
    return "⚠️ 查無打卡紀錄";
  }
  // 按日期分類
  const recordsByDate = {};
  attendanceRecords.forEach(([userId, timestamp, type]) => {
    timestamp = Utilities.formatDate(timestamp, "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
    const date = timestamp.slice(0, 10)
    const time = timestamp.slice(11)
    if (!recordsByDate[date]) {
      recordsByDate[date] = [];
    }
    recordsByDate[date].push({ userId, time, type });
  });
  const { employeesByLineId } = formatManagedStores()
  // 依照 userId 分類出勤紀錄
  const recordsByUser = {};
  attendanceRecords.forEach(([userId, timestamp, type]) => {
    if (!recordsByUser[userId]) {
      recordsByUser[userId] = [];
    }
    timestamp = Utilities.formatDate(timestamp, "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
    const date = timestamp.slice(0, 10)
    const time = timestamp.slice(11)
    recordsByUser[userId].push({ date, time, type });
  });
  // 格式化輸出
  let message = "";
  Object.keys(recordsByUser).forEach((userId) => {
    const employeeInfo = employeesByLineId.get(userId);
    if (!employeeInfo) { return; }
    message += `👤 員工: ${employeeInfo.name} (${employeeInfo.store})\n`;
    // 依照日期分類出勤紀錄
    const recordsByDate = {};
    recordsByUser[userId].forEach(({ date, time, type }) => {
      if (!recordsByDate[date]) { recordsByDate[date] = [];}
      recordsByDate[date].push({ time, type });
    });
    // 列出該員工的每日出勤紀錄
    Object.keys(recordsByDate).forEach((date) => {
      message += `🔹 ${date} 出勤紀錄\n`;
      // 優先列出「上班打卡」
      const workRecords = recordsByDate[date].filter(record => (record.type === '上班打卡' && record.type)).map((i)=> i.time);
      const leftRecords = recordsByDate[date].filter(record => (record.type !== '上班打卡' && record.type)).map((i)=> i.time);
      // 上班打卡集中顯示
      message += `✅ 上班: ${workRecords.join(" 、")}\n`;
      // 下班打卡時間
      message += `✅ 下班: ${leftRecords.join(" 、")}\n`;
    });
    message += "\n"; // 分隔不同人
  });
  return message.trim();
}

function getTodayAttendanceByStores(managedStores) {
  // 設定時間
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth(); 
  const day = today.getDate();
  const storeMap = Core.getLineSayDouInfoMap() || {};
  
  const { employeesByLineId, employeesByStore, employeesByStoreName } = formatManagedStores();
  
  // 顯示日期
  let msg = `📅 日期：${month + 1} 月 ${day} 日 的出勤紀錄\n\n`;
  let hasData = false;

  for (const ms of managedStores) {
    if(!ms) continue;
    const storeId = String(ms);
    const storeInfo = storeMap[storeId];
    if (!storeInfo) {
      console.log(`查無店家資料 ID: ${storeId}`);
      continue;
    }
    
    let members = employeesByStore.get(storeId) || [];
    if (members.length === 0 && storeInfo && storeInfo.name && employeesByStoreName) {
      members = employeesByStoreName.get(String(storeInfo.name)) || [];
    }
    if (members.length === 0) continue;
    
    let userIds = members.map(m => m.lineId).filter(id => id && id !== '#N/A');
    msg += `【${storeInfo.name}】\n`;
    hasData = true;
    
    // 取得時間範圍內的打卡紀錄
    const allAttes = getUserAttendance(userIds, new Date(year, month, day, 0, 0, 0), new Date(year, month, day + 1, 0));
    
    // 將紀錄依 userId 分組
    const allAttMaps = new Map();
    allAttes.forEach(([userId, time, type]) => {
      if (userId && type) {
        if (!allAttMaps.has(userId)) { allAttMaps.set(userId, []); }
        allAttMaps.get(userId).push({ type, time });
      }
    });

    const attendedList = [];
    const absentList = [];
    const unregisteredList = [];

    for (const m of members) {
      // 1. 檢查是否註冊 Line ID
      if (!m.lineId || m.lineId === "" || m.lineId === '#N/A') {
        unregisteredList.push(m.name);
        continue; // 跳過後續檢查
      } 
      
      // 2. 檢查是否有打卡紀錄
      if (allAttMaps.has(m.lineId)) {
        const records = allAttMaps.get(m.lineId).sort((a, b) => new Date(a.time) - new Date(b.time));
        
        // ★★★ 關鍵修改：檢查紀錄中是否包含「上班打卡」 ★★★
        // 只有當紀錄裡至少有一筆是 "上班打卡" 時，才算有上班
        const hasClockIn = records.some(att => att.type === "上班打卡");

        if (hasClockIn) {
          // 有上班打卡 -> 列入上班名單（type 與時間加空格；同 type+時間 只顯示一次，避免「上班打卡21:01、上班打卡21:01」）
          const seen = {};
          const uniqueParts = [];
          records.forEach(att => {
            const timeStr = Utilities.formatDate(new Date(att.time), "Asia/Taipei", "HH:mm");
            const key = att.type + " " + timeStr;
            if (!seen[key]) {
              seen[key] = true;
              uniqueParts.push(key);
            }
          });
          const formattedAttendance = uniqueParts.join("、");
          attendedList.push(`${m.name}: ${formattedAttendance}\n`);
        } else {
          // 有紀錄但沒有「上班打卡」 (例如只按了下班，或按錯) -> 視為沒上班
          absentList.push(m.name);
        }
      } 
      else {
        // 完全沒紀錄 -> 沒上班
        absentList.push(m.name);
      }
    }

    // 組合訊息
    msg += `✅ 有上班：\n${attendedList.join("") || "無\n"}`
            + `❌ 沒上班：${absentList.join("、") || "無"}\n`
            + `⚠️ 尚未註冊：${unregisteredList.join("、") || "無"}\n\n`;
  }
  
  console.log(msg);
  if (!hasData) return "查無負責店家的員工資料。";
  return msg;
}

// Debug helper: 檢查管理店家對應的員工名單
function debugAttendanceStores(userId) {
  var out = {
    time: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"),
    userIdSuffix: userId ? String(userId).slice(-6) : "",
    managedStores: [],
    storeMapSize: 0,
    storeMapSample: [],
    employeesByStoreSize: 0,
    employeesByStoreNameSize: 0,
    details: []
  };
  try {
    var auth = isUserAuthorized(userId);
    out.managedStores = auth && auth.managedStores ? auth.managedStores : [];
    var storeMap = Core.getLineSayDouInfoMap() || {};
    var storeKeys = Object.keys(storeMap);
    out.storeMapSize = storeKeys.length;
    out.storeMapSample = storeKeys.slice(0, 10);
    var maps = formatManagedStores();
    out.employeesByStoreSize = maps.employeesByStore ? maps.employeesByStore.size : 0;
    out.employeesByStoreNameSize = maps.employeesByStoreName ? maps.employeesByStoreName.size : 0;
    (out.managedStores || []).forEach(function (ms) {
      var storeId = String(ms || "").trim();
      var storeInfo = storeMap[storeId];
      var name = storeInfo && storeInfo.name ? storeInfo.name : "";
      var membersById = maps.employeesByStore.get(storeId) || [];
      var membersByName = name ? (maps.employeesByStoreName.get(name) || []) : [];
      out.details.push({
        storeId: storeId,
        storeName: name,
        membersById: membersById.length,
        membersByName: membersByName.length
      });
    });
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  }
  return out;
}