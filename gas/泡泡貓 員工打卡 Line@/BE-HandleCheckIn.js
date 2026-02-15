// ==========================================
// 1. 打卡 API (嚴格驗證版)
// ==========================================
function handleCheckInAPI(jsonData) {
    const lat = parseFloat(jsonData.latitude);
    const lon = parseFloat(jsonData.longitude);
    const userId = jsonData.userId;
    const uuid = jsonData.uuid;
    const frontUuid = jsonData.frontUuid;
    // #region agent log
    try {
      console.log("[handleCheckInAPI entry]", {
        userIdSuffix: userId ? String(userId).slice(-6) : "",
        uuidTail: uuid ? String(uuid).slice(-8) : "",
        frontUuidTail: frontUuid ? String(frontUuid).slice(-8) : "",
        latRound: isNaN(lat) ? null : Math.round(lat * 100) / 100,
        lonRound: isNaN(lon) ? null : Math.round(lon * 100) / 100
      });
    } catch (e) {}
    // #endregion
    
    // 1. 基礎資料驗證
    if (!userId || !uuid || !frontUuid) {
      return responseJSON({ status: "failed", text: "資料不完整，無法打卡" });
    }

    // 2. 權限驗證
    const auth = isUserAuthorized(userId); // 假設此函式在外部定義
    if (!auth.isAuthorized) {
      updateWrongByUuid(uuid, userId, lat, lon);
      return responseJSON({ status: "failed", text: "⚠️ 你的帳號尚未開通，麻煩通知泡泡貓負責顧問！" });
    }

    // 3. 取得 Sheet 資料
    const ticket = getUuidRowData(uuid);
    // #region agent log
    try {
      console.log("[ticket lookup result]", {
        uuidTail: uuid ? String(uuid).slice(-8) : "",
        found: !!ticket,
        hasAction: !!(ticket && ticket.action),
        hasFrontUuid: !!(ticket && ticket.frontUuid)
      });
    } catch (e) {}
    // #endregion
    if (!ticket) return responseJSON({ status: "failed", text: "連結無效 (找不到 UUID)" });

    // ==========================================
    // ★★★ 嚴格檢查 (Strict Check) ★★★
    // ==========================================
    
    // 邏輯：Sheet 裡的 frontUuid 必須「存在」且「等於」前端傳來的
    // 如果 Sheet 裡是空的 -> 代表沒有經過 bind 階段 -> 失敗
    // 如果不相等 -> 代表被別人綁走了 -> 失敗
    const sheetFrontUuid = String(ticket.frontUuid || "").trim();
    const reqFrontUuid = String(frontUuid).trim();

    if (sheetFrontUuid === "") {
       return responseJSON({ status: "failed", text: "驗證失敗：請重新整理網頁 (未完成連線綁定)" });
    }

    if (sheetFrontUuid !== reqFrontUuid) {
       return responseJSON({ status: "failed", text: "驗證失敗：此連結已被其他裝置綁定！" });
    }

    // ==========================================

    // 4. 檢查是否已打卡 (Action 欄位是否有值)
    if (ticket.action && ticket.action !== "") {
       return responseJSON({ status: "failed", text: "⚠️ 此連結已使用過，請重新申請！" });
    }

    // 5. 距離驗證
    const checkResult = checkLocation(lat, lon); // 假設此函式在外部定義
    // #region agent log
    try {
      console.log("[distance check result]", {
        uuidTail: uuid ? String(uuid).slice(-8) : "",
        hasResult: Array.isArray(checkResult) && checkResult.length > 0,
        nearestDistance: checkResult && checkResult.length > 0 ? checkResult[0].distance : null,
        pass: checkResult && checkResult.length > 0 ? checkResult[0].distance <= 0.1 : false
      });
    } catch (e) {}
    // #endregion
    // 距離容許值 (0.1 = 100公尺)
    if (checkResult.length === 0 || checkResult[0].distance > 0.1) { 
      updateWrongByUuid(uuid, userId, lat, lon);
      const distMsg = checkResult.length > 0 ? `(距離 ${checkResult[0].name} ${(checkResult[0].distance*1000).toFixed(0)}公尺)` : "(附近無店家)";
      return responseJSON({ status: "failed", text: `📍 距離太遠 \n${distMsg}` });
    }

    // 6. 判斷上下班邏輯
    const sheet = getSheet_();
    const history = getEmployeeHistoryToday(sheet, userId); 
    const timestamp = new Date();
    const dateStr = Utilities.formatDate(timestamp, "Asia/Taipei", "yyyy-MM-dd");
    const timeStr = Utilities.formatDate(timestamp, "Asia/Taipei", "HH:mm");
    
    let punchType = "上班打卡";

    if (history.hasRecord) {
      const lastPunchTime = new Date(history.lastTime);
      const timeDiff = (timestamp - lastPunchTime) / 1000 / 60; // 分鐘

      // 10分鐘冷卻時間
      if (timeDiff < 10) {
         return responseJSON({ status: "failed", text: `⚠️ 你已於 10分鐘內打卡，請稍後再試！` });
      }

      // 上一筆是上班還是下班？含補打卡：上班打卡(補)、下班打卡(補) 也要正確辨識
      const lastTypeStr = String(history.lastType || "").trim();
      const lastWasClockIn = lastTypeStr.indexOf("上班") !== -1;
      if (lastWasClockIn) {
        punchType = "下班打卡";
      } else {
        punchType = "上班打卡";
      }
    }

    // 7. 寫入資料庫
    const resultValues = [userId, timestamp, punchType, checkResult[0].name];
    updateRowData(uuid, resultValues);
    // #region agent log
    try {
      console.log("[check-in success write]", {
        uuidTail: uuid ? String(uuid).slice(-8) : "",
        punchType: punchType,
        store: checkResult && checkResult.length > 0 ? checkResult[0].name : ""
      });
    } catch (e) {}
    // #endregion

    return responseJSON({ 
      status: "success", 
      text: `📌 ${checkResult[0].name}\n${punchType} 成功！\n\n📅 日期：${dateStr}\n⏰ 時間：${timeStr}` 
    });
}

// ==========================================
// 2. 綁定 Session API (佔位邏輯)
// ==========================================
function handleBindSession(json) {
  const uuid = json.uuid;
  const frontUuid = json.frontUuid;
  
  console.log(`[Bind] 收到綁定請求: UUID=${uuid}, Front=${frontUuid}`);
  // #region agent log
  try {
    console.log("[handleBindSession entry]", {
      uuidTail: uuid ? String(uuid).slice(-8) : "",
      frontUuidTail: frontUuid ? String(frontUuid).slice(-8) : "",
      hasUuid: !!uuid,
      hasFrontUuid: !!frontUuid
    });
  } catch (e) {}
  // #endregion

  // 1. 取得票券資料
  const ticket = getUuidRowData(uuid);
  
  if (!ticket) {
    console.error(`[Bind] 找不到 UUID: ${uuid}`);
    return responseJSON({ status: "failed", text: "無效的連結 (找不到 UUID)" });
  }

  // 2. 檢查是否已被使用 (已打卡)
  if (ticket.action && ticket.action !== "") {
    console.warn(`[Bind] 此連結已打卡: ${ticket.action}`);
    return responseJSON({ status: "failed", text: "此連結已打卡完成" });
  }

  // 3. 搶票機制
  // 如果 Sheet 裡的 frontUuid 是空的 -> 允許綁定
  if (!ticket.frontUuid || ticket.frontUuid === "") {
    const success = bindFrontUuidToSheet(uuid, frontUuid);
    if (success) {
      console.log(`[Bind] 綁定成功！`);
      return responseJSON({ status: "success", text: "連線建立成功" });
    } else {
      console.error(`[Bind] 寫入 Sheet 失敗`);
      return responseJSON({ status: "failed", text: "系統錯誤 (寫入失敗)" });
    }
  }

  // 如果 Sheet 裡已經有值，檢查是否跟現在的一樣
  if (String(ticket.frontUuid).trim() === String(frontUuid).trim()) {
     console.log(`[Bind] 重複連線 (視為成功)`);
     return responseJSON({ status: "success", text: "連線恢復" });
  }

  // 不一樣 -> 代表被別人搶走了
  console.warn(`[Bind] 綁定衝突。Sheet: ${ticket.frontUuid}, Req: ${frontUuid}`);
  return responseJSON({ status: "failed", text: "此連結已失效 (已被其他裝置開啟)" });
}


// ==========================================
// 3. 輔助函式與資料庫操作
// ==========================================

// 與 Core 對齊：使用 Core.jsonResponse
function responseJSON(data) {
  return Core.jsonResponse(data);
}

const SHEET_NAME = '員工打卡紀錄';
// ⚠️ 請確保 LINE_STAFF_SS_ID 是一個全域變數，或者在這裡定義它
// const LINE_STAFF_SS_ID = '您的試算表ID'; 

function getSheet_() {
  return SpreadsheetApp.openById(LINE_STAFF_SS_ID).getSheetByName(SHEET_NAME);
}

function getUuidRowData(uuid) {
  const row = findRowByUuid_(uuid);
  if (!row) return null;

  const sheet = getSheet_();
  // A~F (1~6)
  const data = sheet.getRange(row, 1, 1, 6).getValues()[0];
  
  return {
    row: row,
    userId: data[0],     
    action: data[2],     
    frontUuid: data[5]   
  };
}

// 搜尋 UUID (去除空白版)
function findRowByUuid_(uuid) {
  const sheet = getSheet_();
  
  // 1. 為了確保不漏找，我們直接搜尋整個 "E" 欄
  // 不使用 getLastRow() 計算範圍，避免因空白列導致算錯
  const range = sheet.getRange("E:E"); 
  
  // 2. 使用 TextFinder 進行搜尋
  // String(uuid).trim() -> 去除前後空白，防止複製貼上時多餘的空格導致找不到
  const finder = range.createTextFinder(String(uuid).trim());
  
  // 3. 設定搜尋條件
  // matchEntireCell(true) -> 必須完全符合 (避免找到相似的 UUID)
  const found = finder.matchEntireCell(true).findNext();
  
  if (found) {
    console.log(`🔍 [搜尋成功] UUID: ${uuid} 位於第 ${found.getRow()} 列`);
    return found.getRow();
  } else {
    console.warn(`❌ [搜尋失敗] 在 E 欄找不到 UUID: ${uuid}`);
    
    // --- 二次確認 (如果上面失敗，嘗試模糊搜尋) ---
    // 有時候是因為 Excel 格式問題，試試看 matchEntireCell(false)
    const fuzzyFinder = range.createTextFinder(String(uuid).trim());
    const fuzzyFound = fuzzyFinder.matchEntireCell(false).findNext();
    
    if (fuzzyFound) {
       console.log(`⚠️ [模糊搜尋成功] UUID: ${uuid} 位於第 ${fuzzyFound.getRow()} 列 (可能有隱藏字元)`);
       return fuzzyFound.getRow();
    }
    
    return null;
  }
}
function updateRowData(uuid, valuesArray) {
  const row = findRowByUuid_(uuid);
  if (!row) return;
  const sheet = getSheet_();
  sheet.getRange(row, 1, 1, 4).setValues([valuesArray]);
  SpreadsheetApp.flush();
}

function updateWrongByUuid(uuid, userId, lat, lon) {
  const row = findRowByUuid_(uuid);
  if (!row) return;
  const sheet = getSheet_();
  sheet.getRange(row, 1).setValue(userId); 
  sheet.getRange(row, 7).setValue(`失敗位置: ${lat}, ${lon}`); 
  SpreadsheetApp.flush();
}

function bindFrontUuidToSheet(uuid, frontUuid) {
  const row = findRowByUuid_(uuid);
  if (!row) return false;
  
  const sheet = getSheet_();
  sheet.getRange(row, 6).setValue(frontUuid);
  SpreadsheetApp.flush(); 
  return true;
}

function getEmployeeHistoryToday(sheet, userId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { hasRecord: false };

  const startRow = Math.max(2, lastRow - 200);
  const data = sheet.getRange(startRow, 1, lastRow - startRow + 1, 3).getValues();
  
  const todayStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd");
  let result = { hasRecord: false, lastTime: null, lastType: "" };

  for (let i = data.length - 1; i >= 0; i--) {
    const row = data[i];
    if (String(row[0]) === String(userId) && row[1]) {
      const rowDate = Utilities.formatDate(new Date(row[1]), "Asia/Taipei", "yyyy-MM-dd");
      if (rowDate === todayStr && row[2]) {
        result.hasRecord = true;
        result.lastTime = row[1];
        result.lastType = row[2];
        break; 
      }
    }
  }
  return result;
}