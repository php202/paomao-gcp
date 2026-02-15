/**
 * 取得員工資料結構
 * @return {Object} { byStore: Map, byLineId: Map }
 */
function formatManagedStores() {
  const ss = SpreadsheetApp.openById(LINE_STAFF_SS_ID);
  const sheet = ss.getSheetByName("員工清單");
  // 若 sheet 不存在，回傳空 Map 避免報錯
  if (!sheet) {
    console.error("找不到 '員工清單' 工作表");
    return { byStore: new Map(), byLineId: new Map() };
  }

  // 1. 取得所有資料 (假設第一列是標題，從第二列開始取會更穩，或在迴圈內過濾)
  const data = sheet.getDataRange().getValues();

  // 2. 定義有效職稱 (使用 Set 加速查詢)
  const VALID_ROLES = new Set(['員工', '組長', '店長', '工讀', '試用']);

  // 3. 初始化 Maps
  const byLineId = new Map(); // 原本的 employeeMap
  const byStore = new Map();  // 原本的 employeeMaps (key: saydouId)
  const byStoreName = new Map(); // key: 店名 (員工清單 B 欄)

  // 4. 單次迴圈處理 (從 index 1 開始跳過標題列，若無標題則從 0)
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    
    // 使用解構賦值清楚定義欄位 (依據你原本的 e[0]~e[4])
    const [code, store, name, lineId, role, saydouId] = row;

    // 基礎驗證：名字不得為空 且 職稱必須符合
    if (!name || !VALID_ROLES.has(role)) continue;

    const empData = { code, store, name, status: role, lineId, saydouId };

    // --- 分類 A: 依照 Line ID ---
    // 確保有 Line ID 才存入
    if (lineId) {
      byLineId.set(String(lineId), empData);
    }

    // --- 分類 B: 依照 Store ---
    // 依 saydouId
    if (saydouId != null && saydouId !== "") {
      const storeKey = String(saydouId);
      if (!byStore.has(storeKey)) {
        byStore.set(storeKey, []);
      }
      byStore.get(storeKey).push(empData);
    }
    // 依店名（備援）
    if (store) {
      const nameKey = String(store).trim();
      if (nameKey) {
        if (!byStoreName.has(nameKey)) {
          byStoreName.set(nameKey, []);
        }
        byStoreName.get(nameKey).push(empData);
      }
    }
  }
  // 5. 回傳結果 (建議改用更直觀的 Key 名稱)

  return { 
    employeesByStore: byStore,
    employeesByStoreName: byStoreName,
    employeesByLineId: byLineId
  };
}

// 取得 固定 key 
function getLinkKey() {
  const ss = SpreadsheetApp.openById(LINE_STAFF_SS_ID);
  const sheet = ss.getSheetByName("網頁列表");
  const linkKey = sheet.getDataRange().getValues();
  const linkMap = new Map();
  linkKey.slice(1).forEach(([name, link]) => {
    if (name) {
      linkMap.set(name, { link });
    }
  });
  return linkMap
}
// createQuickReplyItem
function createQuickReplyItem(label, text) {
  return {
    type: "action",
    action: {
      type: "message",
      label: label,
      text: text
    }
  }
}
function createQuickReplyItemUrl(label, url) {
  return {
      type: "uri",
      label: label,
      uri: url
  }
}


// 算距離
function checkLocation(lat, lon) {
  const ss = SpreadsheetApp.openById(LINE_STAFF_SS_ID);
  const sheet = ss.getSheetByName("公司列表");
  const stores = sheet.getDataRange().getValues();
  const storeMap = stores.slice(1).filter(i => i[3]).map((item) => {
    return {
      id: item[0],
      name: item[1],
      address: item[2],
      lat: parseFloat(item[3].split(',')[0]),
      lon: parseFloat(item[3].split(',')[1]),
    }
  })
  let data = []
  for (const store of storeMap) {
    var distance = getDistanceFromLatLonInKm(store.lat, store.lon, lat, lon);
    data.push({ 'name': store.name, distance })
  }
  return data.sort((a, b) => a.distance - b.distance);
}
// 算兩點距離
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  var R = 6371; // 地球半徑（公里）
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLon = (lon2 - lon1) * Math.PI / 180;
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
          Math.sin(dLon/2) * Math.sin(dLon/2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

async function cleanUpSheet(replyToken, userId) {
  const ss = SpreadsheetApp.openById(LINE_STAFF_SS_ID);
  const sheet = ss.getSheetByName("員工打卡紀錄");
  let = num = 0
  const data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 0; i--) {  // 倒序刪除，避免索引錯亂
    if (data[i][1] === "" && data[i][2] === "") {  // A欄為空
      sheet.deleteRow(i + 1);  // 刪除對應行
      num += 1
    }
  }
  // replyToUser(replyToken, `共刪除 ${num}筆空紀錄`)
}

// 事件去重：避免 LINE 重送同一 webhookEventId 時重複處理
function isDuplicatedEvent(eventId) {
  if (!eventId) return false;
  try {
    var cache = CacheService.getScriptCache();
    var key = "evt:" + eventId;
    if (cache.get(key)) return true;
    cache.put(key, "1", 10); // 10 秒內視為重複
    return false;
  } catch (e) {
    return false;
  }
}
// 📝 將錯誤寫入訊息一覽表統一錯誤紀錄表
function logErrorToSheet(userId, userMessage, error) {
  try {
    var config = typeof Core !== "undefined" && Core.getCoreConfig ? Core.getCoreConfig() : {};
    var ssId = config.LINE_STORE_SS_ID || "1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0"; // 訊息一覽表
    var sheetName = "錯誤紀錄";
    var source = "泡泡貓 員工打卡 Line@";
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.appendRow(["時間", "來源", "錯誤訊息", "上下文"]);
      sheet.setColumnWidth(1, 150);
      sheet.setColumnWidth(2, 120);
      sheet.setColumnWidth(3, 300);
      sheet.setColumnWidth(4, 250);
    }
    var timestamp = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
    var context = "User ID: " + String(userId || "").slice(0, 100) + "; 輸入: " + String(userMessage || "").slice(0, 200);
    var stackTrace = (error && error.stack) ? String(error.stack).slice(0, 300) : "";
    if (stackTrace) context += "; 堆疊: " + stackTrace;
    sheet.appendRow([timestamp, source, String((error && error.toString) ? error.toString() : String(error)).slice(0, 2000), context.slice(0, 500)]);
  } catch (loggingError) {
    console.error("❌ 無法寫入統一錯誤紀錄表:", loggingError);
  }
}
