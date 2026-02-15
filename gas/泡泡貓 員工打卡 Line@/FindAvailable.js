const COURSE_MINUTES = 90; // 服務時長
const SEARCH_DAYS = 7;     // 查詢天數

/**
 * 查詢管理店家的可預約時段 (使用 Core)
 * @param {string[]} managedStores - 店家名稱陣列
 */
function findAvailableList(managedStores) {
  if (!managedStores || !Array.isArray(managedStores) || managedStores.length === 0) {
    console.log("無指定店家，結束查詢");
    return "無指定店家";
  }

  // 1. 正規化店家清單（支援同格逗號/頓號分隔）
  const normalizedStores = [];
  managedStores.forEach((s) => {
    String(s || "")
      .split(/[,、，]/)
      .forEach((id) => {
        const t = String(id || "").trim();
        if (t) normalizedStores.push(t);
      });
  });
  if (normalizedStores.length === 0) {
    console.log("無有效店家，結束查詢");
    return "無指定店家";
  }

  // 2. 取得店家對照表 (如果是在同一個檔案，直接呼叫即可；若在 Library 才加 Core)
  const storeMap = Core.getLineSayDouInfoMap(); 

  // 3. 準備日期範圍
  const today = new Date();
  const startDate = Utilities.formatDate(today, Session.getScriptTimeZone(), "yyyy-MM-dd");
  
  const endObj = new Date(today);
  // 注意：需確保 SEARCH_DAYS 變數已定義
  endObj.setDate(today.getDate() + (typeof SEARCH_DAYS !== 'undefined' ? SEARCH_DAYS : 14)); 
  const endDate = Utilities.formatDate(endObj, Session.getScriptTimeZone(), "yyyy-MM-dd");

  const lines = [];

  // 4. 逐店查詢
  normalizedStores.forEach((rawId) => {
    if (!rawId) return; // 略過空值
    
    const id = String(rawId).trim(); // 轉字串並去空白，避免對應不到 key
    if (id === '0001') return;
    let store = storeMap[id];
    // 若用名稱當作 storeId，嘗試以名稱比對
    if (!store) {
      const allStores = Object.values(storeMap || {});
      store = allStores.find((s) => s && s.name === id);
    }

    // 若找不到對照表，仍嘗試用原始 ID 查詢
    const storeId = store && store.saydouId ? store.saydouId : id;
    const storeName = store && store.name ? store.name : ("店家 " + id);
    if (!store) {
      console.log(`找不到店家對照資料，改用原始 ID 查詢: ${id}`);
    }

    console.log(`正在查詢: ${storeName}`);
    lines.push(`【${storeName}】`);
    // ★ 呼叫 Core 取得結果 (確保 Core 存在且有此函式)
    // 注意：需確保 COURSE_MINUTES 變數已定義
    const result = Core.findAvailableSlots(
      storeId,
      startDate, 
      endDate, 
      1, 
      (typeof COURSE_MINUTES !== 'undefined' ? COURSE_MINUTES : 60), 
      {},
    );

    if (!result.status) {
      lines.push(`(查詢失敗: ${result.error || '未知錯誤'})`);
    } else if (!result.data || result.data.length === 0) {
      lines.push(`(無可預約時段)`);
    } else {
      // 顯示結果
      result.data.forEach(day => {
        const slotsStr = day.times.join("、");
        lines.push(`${day.date.substring(5)} (${day.week})：${slotsStr}`);
      });
    }
    lines.push(""); // 空行
  });

  const output = lines.join("\n");
  return output;
}

// Debug helper: 顯示「負責店家」對照結果（不查空位）
function debugManagedStores(userId) {
  var out = {
    time: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"),
    userIdSuffix: userId ? String(userId).slice(-6) : "",
    managedStoresRaw: [],
    normalizedStores: [],
    matched: [],
    unmatched: []
  };
  try {
    var auth = isUserAuthorized(userId);
    out.managedStoresRaw = auth && auth.managedStores ? auth.managedStores : [];
  } catch (eAuth) {
    out.unmatched.push({ id: "auth", error: eAuth && eAuth.message ? eAuth.message : String(eAuth) });
    return out;
  }
  // 正規化
  (out.managedStoresRaw || []).forEach(function (s) {
    String(s || "")
      .split(/[,、，]/)
      .forEach(function (id) {
        var t = String(id || "").trim();
        if (t) out.normalizedStores.push(t);
      });
  });
  var storeMap = Core.getLineSayDouInfoMap();
  var allStores = Object.values(storeMap || {});
  out.normalizedStores.forEach(function (id) {
    var store = storeMap[id];
    if (!store) {
      store = allStores.find(function (s) { return s && s.name === id; });
    }
    if (store) {
      out.matched.push({ id: id, name: store.name, saydouId: store.saydouId });
    } else {
      out.unmatched.push({ id: id });
    }
  });
  return out;
}

// Debug helper: 檢查 Core.getLineSayDouInfoMap 是否含指定店家
function debugStoreMapLookup(storeIds) {
  var ids = Array.isArray(storeIds) ? storeIds : [storeIds];
  var out = {
    time: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"),
    input: ids,
    matched: [],
    unmatched: [],
    sampleKeys: []
  };
  var storeMap = Core.getLineSayDouInfoMap();
  var allKeys = Object.keys(storeMap || {});
  out.sampleKeys = allKeys.slice(0, 20);
  ids.forEach(function (rawId) {
    var id = String(rawId || "").trim();
    if (!id) return;
    var store = storeMap[id];
    if (store) {
      out.matched.push({ id: id, name: store.name, saydouId: store.saydouId });
    } else {
      out.unmatched.push({ id: id });
    }
  });
  return out;
}

// Debug helper: 列出 Core 店家對照表資訊（數量 + 部分 key）
function debugAllStoreKeys(limit) {
  var storeMap = Core.getLineSayDouInfoMap();
  var keys = Object.keys(storeMap || {});
  var n = (typeof limit === "number" && limit > 0) ? limit : 50;
  return {
    time: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"),
    total: keys.length,
    sampleKeys: keys.slice(0, n)
  };
}