/**
 * [優化] 取得公司流程連結 (含快取)
 * @param {string} keyword 關鍵字
 * @return {string|null} 連結網址 或 null
 */
function getWorkflowLink(keyword) {
  if (!keyword) return null;

  // 1. 嘗試從快取讀取整個 Map
  const cache = CacheService.getScriptCache();
  const cacheKey = "WORKFLOW_MAP";
  let mapData = cache.get(cacheKey);
  let workflowMap;

  if (mapData) {
    // 如果有快取，直接轉回物件
    workflowMap = JSON.parse(mapData);
  } else {
    // 2. 沒快取，讀取 Google Sheet
    // console.log("[Core] Reading Workflow Sheet..."); // Debug用
    try {
      const ss = SpreadsheetApp.openById('1GH2XbihFIY0AX8SMF9Tk6igrVKPpA_vMJVlkDkJjpe4'); // 或指定 ID
      const sheet = ss.getSheetByName("公司流程");
      if (!sheet) return null;

      // 讀取所有資料 (假設 A欄=關鍵字, B欄=連結)
      const data = sheet.getDataRange().getValues(); 
      
      workflowMap = {};
      // 從第 0 列開始 (如果有標題請改 i=1)
      for (let i = 0; i < data.length; i++) {
        const key = String(data[i][0]).trim();
        const link = data[i][1];
        if (key) workflowMap[key] = link;
        console.log(key, link)
      }

      // 3. 寫入快取 (存 6 小時)
      cache.put(cacheKey, JSON.stringify(workflowMap), 21600);
      
    } catch (e) {
      console.error("[Core] Workflow Sheet Error:", e);
      return null;
    }
  }
  // 4. 比對關鍵字 (回傳連結或 undefined)
  return workflowMap[keyword] || null;
}
// 檢查是否為重複事件 (簡單版)
function isDuplicatedEvent(eventId) {
  const cache = CacheService.getScriptCache();
  if (cache.get(eventId)) return true;
  cache.put(eventId, "1", 60); // 存 60 秒
  return false;
}

/**
 * 依 LINE userId 取得是否為管理者與所屬店家（讀取員工打卡試算表「管理者清單」）
 * 供 PAOPAO 等專案處理「上月小費」等報告關鍵字時使用。
 * @param {string} userId - LINE 使用者 ID
 * @returns {{ isManager: boolean, managedStores: string[] }}
 */
function getManagerManagedStores(userId) {
  var out = { isManager: false, managedStores: [] };
  if (!userId || typeof userId !== "string") return out;
  var ssId = typeof LINE_STAFF_SS_ID !== "undefined" ? LINE_STAFF_SS_ID : "";
  if (!ssId) return out;
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName("管理者清單");
    if (!sheet || sheet.getLastRow() < 2) return out;
    var data = sheet.getRange(2, 1, sheet.getLastRow(), 3).getValues();
    var uid = String(userId).trim();
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      if (String(row[0]).trim() !== uid) continue;
      out.isManager = true;
      var colC = row[2] != null ? String(row[2]).trim() : "";
      if (colC) {
        colC.split(/[,、，]/).forEach(function (s) {
          var t = s.trim();
          if (t) out.managedStores.push(t);
        });
      }
      break;
    }
  } catch (e) {
    console.warn("[Core] getManagerManagedStores:", e);
  }
  return out;
}