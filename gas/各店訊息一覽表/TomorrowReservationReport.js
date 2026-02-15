/**
 * 明日預約客人報告：從 SayDou 日曆 API 拉取指定日期的預約，
 * 依店整理客人手機／姓名／時間／課程，產出「給 AI 過水」用的文字與每店報告，
 * 並可 Push 給店家管理者（參考泡泡貓 員工打卡 Line@ 的「管理者清單」）。
 *
 * API：calendar/events/full?startDate=&endDate=&storid=&status[]=...
 * 使用 Core.fetchReservationsAndOffs(storid, startDate, endDate)。
 */

var TOMORROW_REPORT_CONFIG = {
  TZ: "Asia/Taipei",
  /** 給 AI 過水用：每筆預約一行，欄位以 tab 分隔，方便 AI 解析 */
  AI_ROW_HEADER: "姓名\t手機\t預約時間\t潔顏師\t課程／服務\t備註",
  /** 管理者清單工作表（與泡泡貓 員工打卡 Line@ 同試算表 LINE_STAFF_SS_ID）A=userId, C=管理的店家 id 或名稱 */
  MANAGER_SHEET_NAME: "管理者清單",
  MANAGER_USERID_COL: 0,
  MANAGER_STORE_COL: 2,
  /** ⚠️ 測試用：目前固定 Push 給此 userId。上線前請改回！改為 [] 即改由「管理者清單」對應各店管理者推送。 */
  PUSH_USER_IDS: ["Ud77845386e2e6b3ceb79331978289809"]
};

/**
 * 取得指定日期、單一店家的預約與排休（使用 Core）
 * @param {string} storeId - SayDou 店家 ID (storid)
 * @param {string} dateStr - yyyy-MM-dd
 * @param {string} [token] - 選填；Web App 呼叫時傳入 CoreApi.getBearerToken() 以確保同一 token
 * @returns {{ reservations: Array, dutyoffs: Array }}
 */
function fetchStoreReservationsForDate(storeId, dateStr, token) {
  if (typeof Core === "undefined" || typeof Core.fetchReservationsAndOffs !== "function") {
    return { reservations: [], dutyoffs: [] };
  }
  try {
    return Core.fetchReservationsAndOffs(storeId, dateStr, dateStr, token);
  } catch (e) {
    console.warn("fetchStoreReservationsForDate " + storeId + " " + dateStr + ":", e);
    return { reservations: [], dutyoffs: [] };
  }
}

/**
 * 從一筆 API 預約物件抽出：手機、姓名、時間、潔顏師、課程、備註
 * @param {Object} r - data.reservation[] 的一筆
 * @returns {Object} { phone, name, rsvtim, staffName, services, remark }
 */
function normalizeReservationRow(r) {
  if (!r) return null;
  var phone = (r.rsphon != null && r.rsphon !== "") ? String(r.rsphon).trim() : (r.memb && r.memb.phone_) ? String(r.memb.phone_).trim() : "";
  var name = (r.rsname != null && r.rsname !== "") ? String(r.rsname).trim() : (r.memb && r.memb.memnam) ? String(r.memb.memnam).trim() : "";
  // 預約時間：API 可能回傳 rsvtim、start_time、startTime、start 等
  var rsvtimRaw = r.rsvtim || r.start_time || r.startTime || r.start || "";
  var rsvtim = rsvtimRaw ? String(rsvtimRaw).replace("T", " ").trim().slice(0, 19) : "";
  var timeText = "";
  if (rsvtim) {
    var tPart = rsvtim.split(/[T\s]/)[1] || "";
    timeText = tPart.slice(0, 5); // HH:mm
  }
  if (!timeText && rsvtimRaw) {
    var m = String(rsvtimRaw).match(/(\d{1,2}):(\d{2})/);
    if (m) timeText = m[1].padStart(2, "0") + ":" + m[2];
  }
  var staffName = (r.usrs && r.usrs.usrnam) ? String(r.usrs.usrnam) : "";
  var services = (r.services != null) ? String(r.services) : "";
  var remark = (r.remark != null) ? String(r.remark) : "";
  return { phone: phone, name: name, rsvtim: rsvtim, timeText: timeText, staffName: staffName, services: services, remark: remark };
}

/**
 * 依店彙整：取得某日所有店家的預約，並抽出客人手機／姓名等，依時間排序
 * 依賴 Core.getStoresInfo、Core.fetchReservationsAndOffs（PaoMao_Core 程式庫）。
 * @param {string} dateStr - yyyy-MM-dd
 * @param {{ token?: string }} [options] - 選填；token 為 Web App 取得的 Bearer，傳入時用於 fetchReservationsAndOffs
 * @returns {Array<{ storeId: string, storeName: string, items: Array<Object> }>}
 */
function getTomorrowReservationsByStore(dateStr, options) {
  options = options || {};
  var token = (options.token != null && options.token !== "") ? options.token : undefined;
  try {
    if (typeof Core === "undefined") {
      console.warn("getTomorrowReservationsByStore: Core 未定義，請確認已連結 PaoMao_Core 程式庫（userSymbol: Core）");
      return [];
    }
    if (typeof Core.getStoresInfo !== "function") {
      console.warn("getTomorrowReservationsByStore: Core.getStoresInfo 不存在");
      return [];
    }
    var stores = Core.getStoresInfo();
    if (!stores || stores.length === 0) {
      console.warn("getTomorrowReservationsByStore: 無店家資料（請檢查 Core 的店家基本資料試算表）");
      return [];
    }
    var out = [];
    for (var i = 0; i < stores.length; i++) {
      var store = stores[i];
      var res = fetchStoreReservationsForDate(store.id, dateStr, token);
      var reservations = (res && res.reservations) ? res.reservations : [];
      var items = [];
      for (var j = 0; j < reservations.length; j++) {
        var row = normalizeReservationRow(reservations[j]);
        if (row) items.push(row);
      }
      items.sort(function (a, b) {
        return (a.rsvtim || "").localeCompare(b.rsvtim || "");
      });
      out.push({
        storeId: store.id,
        storeName: store.name || ("店" + store.id),
        items: items
      });
    }
    return out;
  } catch (e) {
    console.warn("getTomorrowReservationsByStore 錯誤: " + (e && e.message));
    return [];
  }
}

/**
 * 將單一店的預約清單格式化成「給 AI 過水」用的一段文字（姓名 手機 時間 潔顏師 課程 備註）
 * @param {string} storeName
 * @param {Array<Object>} items - normalizeReservationRow 的陣列
 * @returns {string}
 */
function formatStoreReportForAI(storeName, items) {
  var lines = ["【" + storeName + "】明日預約客人（給 AI 過水用）", TOMORROW_REPORT_CONFIG.AI_ROW_HEADER];
  for (var i = 0; i < items.length; i++) {
    var o = items[i];
    lines.push([o.name || "—", o.phone || "—", o.rsvtim || "—", o.staffName || "—", (o.services || "—").replace(/\t/g, " "), (o.remark || "—").replace(/\n/g, " ")].join("\t"));
  }
  if (items.length === 0) lines.push("（無預約）");
  return lines.join("\n");
}

/**
 * 產出指定日期的「明日預約客人報告」：依店整理，並產出給 AI 過水的文字
 * @param {string} [dateStr] - yyyy-MM-dd，不傳則用明天
 * @returns {Object} { dateStr, byStore: [{ storeId, storeName, items, reportText }], fullTextForAI: string }
 */
function buildTomorrowReservationReport(dateStr) {
  if (!dateStr) {
    var tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    dateStr = Utilities.formatDate(tomorrow, TOMORROW_REPORT_CONFIG.TZ, "yyyy-MM-dd");
  }
  var byStore = getTomorrowReservationsByStore(dateStr);
  var allBlocks = [];
  for (var i = 0; i < byStore.length; i++) {
    var block = byStore[i];
    block.reportText = formatStoreReportForAI(block.storeName, block.items);
    allBlocks.push(block.reportText);
  }
  var fullTextForAI = "日期：" + dateStr + "\n\n" + allBlocks.join("\n\n---\n\n");
  return { dateStr: dateStr, byStore: byStore, fullTextForAI: fullTextForAI };
}

/**
 * 執行明日預約報告並寫入 Logger（可改為寫入試算表或傳給 AI）
 * 執行方式：Apps Script 選 runTomorrowReservationReport → 執行，到「檢視 → 紀錄」看每店報告與給 AI 的全文
 */
function runTomorrowReservationReport() {
  var dateStr = Utilities.formatDate(new Date(), TOMORROW_REPORT_CONFIG.TZ, "yyyy-MM-dd");
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  var tomorrowStr = Utilities.formatDate(tomorrow, TOMORROW_REPORT_CONFIG.TZ, "yyyy-MM-dd");
  var result = buildTomorrowReservationReport(tomorrowStr);
  Logger.log("=== 明日預約客人報告 " + result.dateStr + " ===");
  for (var i = 0; i < result.byStore.length; i++) {
    var b = result.byStore[i];
    Logger.log("\n" + b.reportText);
  }
  Logger.log("\n=== 給 AI 過水用（全文）===\n" + result.fullTextForAI);
  return result;
}

/**
 * 從「管理者清單」取得管理該店家的 LINE userId 列表（參考泡泡貓 員工打卡 Line@）
 * 管理者清單：A 欄 = userId，C 欄 = 管理的店家（storid 或店名，可多筆逗號分隔）
 * @param {string} storeId - SayDou 店家 ID (storid)
 * @param {string} storeName - 店家名稱
 * @returns {string[]} userId 陣列
 */
function getManagerUserIdsForStore(storeId, storeName) {
  if (typeof Core === "undefined" || typeof Core.getCoreConfig !== "function") return [];
  var config = Core.getCoreConfig();
  var ssId = config.LINE_STAFF_SS_ID;
  if (!ssId) return [];
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName(TOMORROW_REPORT_CONFIG.MANAGER_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return [];
    var data = sheet.getRange(2, 1, sheet.getLastRow(), Math.max(TOMORROW_REPORT_CONFIG.MANAGER_STORE_COL, 1) + 1).getValues();
    var userIds = [];
    var storeIdStr = String(storeId || "").trim();
    var storeNameStr = String(storeName || "").trim();
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var uid = row[TOMORROW_REPORT_CONFIG.MANAGER_USERID_COL];
      if (uid == null || String(uid).trim() === "") continue;
      var managed = row[TOMORROW_REPORT_CONFIG.MANAGER_STORE_COL];
      if (managed == null) continue;
      var managedStr = String(managed).trim();
      if (managedStr === "") continue;
      var parts = managedStr.split(/[,、，]/).map(function (s) { return s.trim(); });
      for (var j = 0; j < parts.length; j++) {
        if (parts[j] === storeIdStr || parts[j] === storeNameStr) {
          userIds.push(String(uid).trim());
          break;
        }
      }
    }
    return userIds;
  } catch (e) {
    console.warn("getManagerUserIdsForStore", storeId, e);
    return [];
  }
}

/**
 * 將明日預約報告 Push 給各店管理者（依「管理者清單」對應的 LINE userId）
 * 使用 Core.sendLinePushText 與 LINE_TOKEN_PAOSTAFF（員工打卡 Line@ 的 Token）
 * @param {Object} result - buildTomorrowReservationReport 的回傳值
 * @returns {{ pushed: number, errors: number }}
 */
function pushTomorrowReportToManagers(result) {
  if (!result || !result.byStore) return { pushed: 0, errors: 0 };
  var config = typeof Core !== "undefined" && typeof Core.getCoreConfig === "function" ? Core.getCoreConfig() : null;
  if (!config || !config.LINE_TOKEN_PAOSTAFF) {
    console.warn("pushTomorrowReportToManagers: 無 LINE_TOKEN_PAOSTAFF");
    return { pushed: 0, errors: 0 };
  }
  var token = config.LINE_TOKEN_PAOSTAFF;
  var pushed = 0;
  var errors = 0;
  var defaultIds = (TOMORROW_REPORT_CONFIG.PUSH_USER_IDS && TOMORROW_REPORT_CONFIG.PUSH_USER_IDS.length) ? TOMORROW_REPORT_CONFIG.PUSH_USER_IDS : [];
  for (var i = 0; i < result.byStore.length; i++) {
    var block = result.byStore[i];
    var userIds = getManagerUserIdsForStore(block.storeId, block.storeName);
    for (var k = 0; k < defaultIds.length; k++) {
      if (defaultIds[k] && userIds.indexOf(defaultIds[k]) === -1) userIds.push(defaultIds[k]);
    }
    var title = "📅 明日預約 " + result.dateStr + " " + block.storeName;
    var body = title + "\n\n" + (block.reportText || "（無預約）");
    for (var j = 0; j < userIds.length; j++) {
      try {
        if (typeof Core.sendLinePushText === "function") {
          Core.sendLinePushText(userIds[j], body, token);
          pushed++;
        }
      } catch (e) {
        console.warn("Push 失敗 " + block.storeName + " → " + userIds[j], e);
        errors++;
      }
    }
  }
  return { pushed: pushed, errors: errors };
}

/**
 * 明日預約報告寫入試算表「明日預約報告」，方便看報表
 */
function writeTomorrowReportToSheet(result) {
  if (!result || !result.byStore) return;
  var id = (typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID) ? CONFIG.INTEGRATED_SHEET_SS_ID : null;
  if (!id) return;
  try {
    var ss = SpreadsheetApp.openById(id);
    var sheet = ss.getSheetByName("明日預約報告");
    if (!sheet) {
      sheet = ss.insertSheet("明日預約報告");
      sheet.appendRow(["日期", "店名", "報告全文"]);
    }
    for (var i = 0; i < result.byStore.length; i++) {
      var b = result.byStore[i];
      sheet.appendRow([result.dateStr, b.storeName, (b.reportText || "").replace(/\n/g, " ")]);
    }
    Logger.log("明日預約報告已寫入試算表「明日預約報告」");
  } catch (e) {
    console.warn("writeTomorrowReportToSheet:", e);
  }
}

/** 明日預約報告關閉日（當日不 Push、不寫入），格式 yyyy-MM-dd，與 AiReception 的 TOMORROW_REPORT_CLOSED_DATES 一致 */
var TOMORROW_REPORT_CLOSED_DATES = ["2026-02-04"];

/**
 * 產出明日預約報告並 Push 給店家管理者（Logger + LINE），並寫入試算表
 * 執行方式：Apps Script 選 runTomorrowReservationReportAndPush → 執行；可設每日觸發。
 */
function runTomorrowReservationReportAndPush() {
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  var tomorrowStr = Utilities.formatDate(tomorrow, TOMORROW_REPORT_CONFIG.TZ, "yyyy-MM-dd");
  if (TOMORROW_REPORT_CLOSED_DATES.indexOf(tomorrowStr) >= 0) {
    Logger.log("明日預約報告 " + tomorrowStr + " 已關閉，略過 Push 與寫入。");
    return null;
  }
  var result = buildTomorrowReservationReport(tomorrowStr);
  Logger.log("=== 明日預約客人報告 " + result.dateStr + " ===");
  for (var i = 0; i < result.byStore.length; i++) {
    Logger.log("\n" + result.byStore[i].reportText);
  }
  var pushResult = pushTomorrowReportToManagers(result);
  Logger.log("Push 給管理者：成功 " + pushResult.pushed + " 則，失敗 " + pushResult.errors + " 則");
  writeTomorrowReportToSheet(result);
  return result;
}
