// Utils.gs
function getBankInfoMap() {
  const ss = SpreadsheetApp.openById(EXTERNAL_SS_ID);
  const sheet = ss.getSheetByName('店家基本資訊');
  if (!sheet) return new Map();
  const data = sheet.getRange('A2:K' + sheet.getLastRow()).getValues();
  const map = new Map();
  data.forEach(row => {
    const [no, code, bankAccount, branch, name, store, companyName, pinCode, email, groupId, pin] = row;
    if (code) {
      map.set(String(code).trim(), { 
        no: no,
        bankAccount: String(bankAccount).trim(),
        branch: String(branch).trim(),
        name: String(name).trim(),
        pinCode: String(pinCode).trim().padStart(8, "0"),
        companyName: String(companyName).trim(),
        email: String(email).trim(),
        groupId: String(groupId).trim(),
        pin: String(pin).trim(),
        name, store, companyName, pinCode, email, 
        groupId: String(groupId).trim() , pin,
      });
    }
  });
  return map;
}

// get Line & Saydou
function getLineSayDouInfoMap() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("MAP_SAYDOU_INFO");
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && Object.keys(parsed).length > 0) return parsed;
      // 若快取是空物件，改為重建
    } catch (e) {
      // ignore cache parse error, rebuild below
    }
  }

  const map = {};
  const ss = SpreadsheetApp.openById(LINE_STORE_SS_ID);
  const sheetId = 72760104;
  const sheet = ss.getSheetById(sheetId) || ss.getSheetByName('店家基本資料');
  if (!sheet) return map;

  // 注意：這裡取到 I 欄，確保欄位數量足夠
  const data = sheet.getRange('A2:I' + sheet.getLastRow()).getValues();

  data.forEach(row => {
    // 確保這裡的解構順序與 Excel 欄位 A, B, C... 一致
    const [no, name, channelId, channelSecret, destinationId, saydouId, lineLink, isDirect] = row;

    if (saydouId) {
      const sId = String(saydouId).trim();
      map[sId] = {
        id: sId,
        name: String(name).trim(),
        channelId: String(channelId).trim(),
        channelSecret: String(channelSecret).trim(),
        destinationId: String(destinationId).trim(),
        saydouId: sId, // 這是你定義的名稱
        lineLink: String(lineLink).trim(),
        isDirect: Boolean(isDirect),
      };
    }
  });
  // 只有有資料時才快取，避免空值卡住
  if (Object.keys(map).length > 0) {
    cache.put("MAP_SAYDOU_INFO", JSON.stringify(map), 21600);
  }
  return map;
}

// Debug helper: 檢查 LINE_STORE_SS_ID 與店家基本資料分頁
function debugLineStoreSheet() {
  var out = {
    time: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"),
    lineStoreSsId: LINE_STORE_SS_ID || "",
    sheetId: 72760104,
    sheetById: false,
    sheetByName: false,
    sheetName: "",
    lastRow: 0,
    error: ""
  };
  try {
    var ss = SpreadsheetApp.openById(LINE_STORE_SS_ID);
    var byId = ss.getSheetById(72760104);
    var byName = ss.getSheetByName("店家基本資料");
    out.sheetById = !!byId;
    out.sheetByName = !!byName;
    var sheet = byId || byName;
    if (sheet) {
      out.sheetName = sheet.getName();
      out.lastRow = sheet.getLastRow();
    }
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  }
  return out;
}

// Debug helper: 清除店家對照表快取
function clearLineStoreMapCache() {
  try {
    CacheService.getScriptCache().remove("MAP_SAYDOU_INFO");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}
function getStoresInfo() {
  const storeMap = getLineSayDouInfoMap();
  let stores = [];
  // 2. 修正遍歷方式：普通物件不能用 .values()，要改用 Object.values() 轉成陣列
  const allStoreData = Object.values(storeMap);
  for (const info of allStoreData) {
    if (info.saydouId) {
      // 順便先取得該店的「總員工數」，計算空位需要用到
      // 這裡會用到 Core 的快取，所以不會每次都打 API
      const staffSet = getStoreCapacityIds(info.saydouId);
      
      // 預設產能 (若抓不到員工或為空，預設 4 人)
      const totalStaff = (staffSet && staffSet.size > 0) ? staffSet.size : 4; 
      
      stores.push({ 
        id: info.saydouId, // 統一用 saydouId
        name: info.name,
        totalStaff: totalStaff,
        validStaffSet: staffSet, // 把名單也存下來，過濾用
        isDirect: info.isDirect, // 確保這是一個 Boolean
      });
    }
  }

  // 3. 排序邏輯
  stores.sort((a, b) => {
    // 第一順位：直營優先 (isDirect: true 排在 false 前面)
    // 轉換 boolean 為 number: true->1, false->0
    const directDiff = Number(b.isDirect) - Number(a.isDirect);
    
    // 如果直營狀態不同，直接回傳結果
    if (directDiff !== 0) {
      return directDiff;
    }
    
    // 第二順位：ID 小到大 (Ascending)
    // 確保轉成數字比較，避免字串排序 ("10" 排在 "2" 前面的問題)
    return Number(a.id) - Number(b.id);
  });

  return stores;
}

/**
 * 從「員工清單」（泡泡貓 員工打卡 Line@ 試算表）取得 員工代碼 → 姓名 對照。
 * 依需求改用 L 欄作為員工代碼，C 欄為姓名。
 * @returns {Object} { "gm008": "王小明", ... }
 */
function getEmployeeCodeToNameMap() {
  try {
    var ss = SpreadsheetApp.openById(LINE_STAFF_SS_ID);
    var sheet = ss.getSheetByName("員工清單");
    if (!sheet || sheet.getLastRow() < 2) return {};
    var data = sheet.getRange(2, 1, sheet.getLastRow(), 12).getValues(); // A~L
    var map = {};
    for (var i = 0; i < data.length; i++) {
      var code = data[i][11] != null ? String(data[i][11]).trim() : "";
      var name = data[i][2] != null ? String(data[i][2]).trim() : "";
      if (code) map[code] = name || code;
    }
    return map;
  } catch (e) {
    console.warn("[Core] getEmployeeCodeToNameMap:", e);
    return {};
  }
}

function getTransferDate(rowTransferDate) {
  const timeZone = 'Asia/Taipei';
  let now = new Date(); // 取得當前時間和日期
  const nowHourMinute = parseInt(Utilities.formatDate(now, timeZone, 'HHmm'));
  const literalTodayYMD = Utilities.formatDate(now, timeZone, 'yyyyMMdd');
  let rowDateObj = new Date(rowTransferDate);
  if (isNaN(rowDateObj.getTime())) {
    rowDateObj = now; // 避免程式因無效日期而中斷
  }
  const rowTransferDateYMD = Utilities.formatDate(rowDateObj, timeZone, 'yyyyMMdd');
  let newTransferDate;

  // 關鍵修改：將日期比較從 '<' (早於今天) 改為 '<=' (早於或等於今天)
  if (rowTransferDateYMD <= literalTodayYMD) {
    if (nowHourMinute > 1510) {
      let tomorrow = new Date(now.getTime());
      tomorrow.setDate(tomorrow.getDate() + 1);
      newTransferDate = tomorrow;
    } else {
      newTransferDate = now;
    }
  } else {
    // 只有當 rowTransferDateYMD > literalTodayYMD (即輸入日期是未來日期) 時，才會執行這裡
    newTransferDate = rowDateObj;
  }

  const TODAY_YMD = Utilities.formatDate(newTransferDate, timeZone, 'yyyyMMdd');
  return TODAY_YMD
} 

function cleanupTempSheets(id, del_name) {
  const ss = SpreadsheetApp.openById(id);
  const sheets = ss.getSheets();
  let count = 0;

  sheets.forEach(sheet => {
    const name = sheet.getName();
    // 檢查工作表名稱是否以 TEMP_EXPORT_ 開頭/銀行匯款格式_
    if (name.indexOf('TEMP_EXPORT_') === 0 || name.indexOf(del_name) === 0) {
      ss.deleteSheet(sheet);
      count++;
    }
  });

  if (count > 0) {
    SpreadsheetApp.getUi().alert(`已成功刪除 ${count} 個暫存工作表。`);
  } else {
    SpreadsheetApp.getUi().alert('沒有找到任何暫存工作表（名稱需包含 Export）。');
  }
}
// 正規化手機
function normalizePhone(raw) {
  if (!raw) return '';

  // 轉字串 & 去掉非數字（例如 '-'、空格）
  let digits = String(raw).replace(/\D/g, '');

  // 處理 +886 開頭的狀況：+8869xxxxxxxx → 09xxxxxxxx
  // 這裡 digits 會變成 '8869xxxxxxxx' 之類
  if (digits.startsWith('886') && digits.length >= 11) {
    digits = '0' + digits.slice(3); // 拿掉 886，加上前導 0
  }

  // 如果是 9 碼，且開頭是 9（例如：917676891）→ 自動補 0 變 10 碼
  if (digits.length === 9 && digits.startsWith('9')) {
    digits = '0' + digits;
  }

  // 最後只接受 10 碼
  if (digits.length !== 10) {
    return '';
  }

  return digits;
}

