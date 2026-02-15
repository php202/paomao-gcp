/**
 * 員工業績月報表
 * 使用 transactionStatistic API：keyword=員工代碼 + start/end → realTotal
 * 業績 = realTotal - 小費 realTotal（godsid=小費品項ID）
 */

var EMPLOYEE_MONTHLY_REPORT_SHEET_NAME = "員工業績月報";
var EMPLOYEE_MONTHLY_REPORT_SHEET_GID = 833948053;
var EMPLOYEE_MONTHLY_REPORT_HEADERS = ["月份", "員工編號", "員工姓名", "所屬店家", "業績金額"];
var BATCH_MONTHS = 3;
/** 平行批次每批請求數（降低可避免 SayDou API 限流或逾時） */
var FETCH_BATCH_SIZE = 20;
/** 小費品項的 godsid（SayDou 商品 ID），用於扣除小費。可於指令碼屬性設 TIPS_GODSID 覆寫 */
function getTipsGodsid_() {
  try {
    var v = PropertiesService.getScriptProperties().getProperty("TIPS_GODSID");
    if (v != null && String(v).trim() !== "") return parseInt(v, 10) || 201969;
  } catch (e) {}
  return 201969;
}

/**
 * 取得指定月份的起迄日期
 */
function getMonthDateRange_(yearMonth) {
  if (!yearMonth || typeof yearMonth !== "string") return null;
  var parts = yearMonth.trim().split("-");
  if (parts.length < 2) return null;
  var y = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  if (isNaN(y) || isNaN(m) || m < 1 || m > 12) return null;
  var start = new Date(y, m - 1, 1);
  var end = new Date(y, m, 0);
  var tz = "Asia/Taipei";
  return {
    startDate: Utilities.formatDate(start, tz, "yyyy-MM-dd"),
    endDate: Utilities.formatDate(end, tz, "yyyy-MM-dd")
  };
}

/**
 * 產生 2025-01 至 endYearMonth 的月份陣列
 */
function listMonthsFrom2025_(endYearMonth) {
  var out = [];
  var endParts = (endYearMonth || "").trim().split("-");
  var endY = endParts.length >= 1 ? parseInt(endParts[0], 10) : new Date().getFullYear();
  var endM = endParts.length >= 2 ? parseInt(endParts[1], 10) : new Date().getMonth() + 1;
  if (isNaN(endY) || isNaN(endM)) return out;
  var y = 2025;
  var m = 1;
  while (y < endY || (y === endY && m <= endM)) {
    out.push(y + "-" + (m < 10 ? "0" : "") + m);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * 從員工清單取得員工業績月報使用的員工代碼（排除 H 欄為「離職」者）
 * 員工清單：L 欄 (index 11) 為員工代碼，H 欄 (index 7) 為狀態（離職者不跑 API）
 * @returns {string[]} 員工代碼陣列
 */
function getEmployeeCodesExcludingResigned_() {
  var codes = [];
  try {
    var ss = SpreadsheetApp.openById(typeof LINE_STAFF_SS_ID !== "undefined" ? LINE_STAFF_SS_ID : "");
    if (!ss) return codes;
    var sheet = ss.getSheetByName("員工清單");
    if (!sheet || sheet.getLastRow() < 2) return codes;
    var data = sheet.getRange(2, 1, sheet.getLastRow(), 12).getValues();
    var excluded = 0;
    for (var i = 0; i < data.length; i++) {
      var code = data[i][11] != null ? String(data[i][11]).trim() : "";
      var statusH = data[i][7] != null ? String(data[i][7]).trim() : "";
      if (!code) continue;
      if (statusH.indexOf("離職") >= 0) { excluded++; continue; }
      codes.push(code);
    }
    if (excluded > 0) Logger.log("[EmployeeMonthlyReport] H 欄離職已排除 " + excluded + " 人");
  } catch (e) {
    Logger.log("[EmployeeMonthlyReport] getEmployeeCodesExcludingResigned_: " + (e && e.message ? e.message : e));
  }
  return codes;
}

/**
 * 從員工清單取得 員工代碼 → 所屬店家名稱
 * 員工清單 F 欄 (index 5) 為 storeId，以 getStoresInfo 解析為店名
 */
function getEmployeeCodeToStoreMap_() {
  var map = {};
  try {
    var ss = SpreadsheetApp.openById(typeof LINE_STAFF_SS_ID !== "undefined" ? LINE_STAFF_SS_ID : "");
    if (!ss) return map;
    var sheet = ss.getSheetByName("員工清單");
    if (!sheet || sheet.getLastRow() < 2) return map;
    var data = sheet.getRange(2, 1, sheet.getLastRow(), 12).getValues();
    var storeIdToName = {};
    if (typeof getStoresInfo === "function") {
      var stores = getStoresInfo() || [];
      for (var s = 0; s < stores.length; s++) {
        var id = String(stores[s].id || "").trim();
        var name = String(stores[s].name || "").trim();
        if (id === "2862") name = "左營海軍"; // 特殊對應
        if (id) storeIdToName[id] = name || ("店" + id);
      }
    }
    for (var i = 0; i < data.length; i++) {
      var code = data[i][11] != null ? String(data[i][11]).trim() : "";
      var storeId = data[i][5] != null ? String(data[i][5]).trim() : "";
      if (!code) continue;
      var storeName = (storeId && storeIdToName[storeId]) ? storeIdToName[storeId] : (storeId || "");
      map[code] = storeName;
    }
  } catch (e) {
    Logger.log("[EmployeeMonthlyReport] getEmployeeCodeToStoreMap: " + (e && e.message ? e.message : e));
  }
  return map;
}

/**
 * 建立 transactionStatistic API 的 request 物件
 */
function buildTransactionStatisticRequest_(keyword, startDate, endDate, opts, bearerToken) {
  opts = opts || {};
  var godsid = opts.godsid != null ? opts.godsid : 0;
  var godnam = opts.godnam != null ? encodeURIComponent(opts.godnam) : "";
  var base = "https://saywebdatafeed.saydou.com/api/management/finance/transactionStatistic";
  var q = "?page=0&limit=20&sort=ordrsn&order=desc" +
    "&keyword=" + encodeURIComponent(keyword || "") +
    "&start=" + encodeURIComponent(startDate) +
    "&end=" + encodeURIComponent(endDate) +
    "&searchMemberCtrl=null&searchProductCtrl=null&searchStaffCtrl=null" +
    "&membid=0&godsid=" + godsid +
    "&usrsid=0&memnam=&godnam=" + godnam +
    "&usrnam=&assign=all&licnum=&goctString=";
  return {
    url: base + q,
    method: "get",
    headers: { Authorization: "Bearer " + bearerToken },
    muteHttpExceptions: true,
    timeout: 60
  };
}

/**
 * 從 transactionStatistic 回應解析 realTotal
 * 支援多種回傳格式：data.realTotal、data.summary、data.items 加總
 * @param {Object} response - UrlFetchApp 回應
 * @param {Object} opts - { logIfZero: boolean, label: string } 當回傳 0 時記錄原始結構（除錯用）
 */
function parseRealTotal_(response, opts) {
  opts = opts || {};
  try {
    var text = response.getContentText ? response.getContentText() : "";
    var json = JSON.parse(text || "{}");
    if (!json || json.status !== true || !json.data) {
      if (opts.logIfZero) Logger.log("[EmployeeMonthlyReport] parseRealTotal 0: " + (opts.label || "") + " status=" + (json ? json.status : "null") + " data=" + (json && json.data ? "有" : "無"));
      return 0;
    }
    var d = json.data;
    if (d.realTotal != null) return Number(d.realTotal) || 0;
    if (d.total != null) return Number(d.total) || 0;
    if (d.summary && d.summary.realTotal != null) return Number(d.summary.realTotal) || 0;
    if (d.summary && d.summary.total != null) return Number(d.summary.total) || 0;
    if (d.items && Array.isArray(d.items)) {
      var sum = 0;
      for (var i = 0; i < d.items.length; i++) {
        var t = d.items[i];
        if (!t) continue;
        var v = t.realTotal != null ? t.realTotal : (t.total != null ? t.total : (t.ordamt != null ? t.ordamt : (t.price_ != null ? t.price_ : (t.rprice != null ? t.rprice : null))));
        if (v != null) sum += Number(v) || 0;
      }
      return sum;
    }
    if (opts.logIfZero) Logger.log("[EmployeeMonthlyReport] parseRealTotal 0: " + (opts.label || "") + " data keys=" + Object.keys(d).join(",") + " sample=" + JSON.stringify(d).substring(0, 300));
  } catch (e) {
    if (opts.logIfZero) Logger.log("[EmployeeMonthlyReport] parseRealTotal error: " + (e && e.message ? e.message : e));
  }
  return 0;
}

/**
 * 從交易明細彙總員工業績（transaction API，請求數少、速度快）
 * @param {string} startYearMonth - "2025-01"
 * @param {string} endYearMonth - "2026-02"
 * @returns {Object} { "2025-01": { "gm001": 50000, ... }, ... } 或 null（無法使用時）
 */
function buildEmployeeMonthlyPerformanceReportFromTransactions_(startYearMonth, endYearMonth) {
  Logger.log("[EmployeeMonthlyReport] 開始 buildEmployeeMonthlyPerformanceReportFromTransactions_ " + startYearMonth + "~" + endYearMonth);
  if (typeof getStoresInfo !== "function") { Logger.log("[EmployeeMonthlyReport] ✗ 缺少 getStoresInfo"); return null; }
  if (typeof fetchTransactions !== "function") { Logger.log("[EmployeeMonthlyReport] ✗ 缺少 fetchTransactions"); return null; }
  if (typeof parseEmployeeFromRemark !== "function") { Logger.log("[EmployeeMonthlyReport] ✗ 缺少 parseEmployeeFromRemark"); return null; }
  var stores = getStoresInfo();
  if (!stores || stores.length === 0) { Logger.log("[EmployeeMonthlyReport] ✗ getStoresInfo 回傳空"); return null; }
  Logger.log("[EmployeeMonthlyReport] ★ 快速版：transaction API，店家數=" + stores.length);
  var storeIds = stores.map(function (s) { return String(s.id || "").trim(); }).filter(function (id) { return id; });
  if (storeIds.length === 0) { Logger.log("[EmployeeMonthlyReport] ✗ storeIds 為空"); return null; }
  var empMap = (typeof getEmployeeCodeToNameMap === "function") ? getEmployeeCodeToNameMap() : {};
  var empCodeSet = {};
  for (var c in empMap) if (c && String(c).trim()) empCodeSet[c] = true;
  var empCount = Object.keys(empCodeSet).length;
  Logger.log("[EmployeeMonthlyReport] 員工清單數=" + empCount + " (" + (empCount > 0 ? Object.keys(empCodeSet).slice(0, 3).join(",") + (empCount > 3 ? "..." : "") : "無") + ")");
  var tipsGodsid = getTipsGodsid_();
  Logger.log("[EmployeeMonthlyReport] 小費 godsid=" + tipsGodsid);
  var result = {};
  var months = listMonthsFrom2025_(endYearMonth || "");
  var startIdx = 0;
  if (startYearMonth) {
    var idx = months.indexOf(startYearMonth);
    if (idx >= 0) startIdx = idx;
  }
  var toProcess = months.slice(startIdx);
  Logger.log("[EmployeeMonthlyReport] 待處理月份=" + toProcess.length + " " + toProcess.join(","));
  for (var k = 0; k < toProcess.length; k++) {
    var ym = toProcess[k];
    Logger.log("[EmployeeMonthlyReport] --- 處理 " + ym + " (" + (k + 1) + "/" + toProcess.length + ") ---");
    var range = getMonthDateRange_(ym);
    if (!range) { Logger.log("[EmployeeMonthlyReport] ✗ " + ym + " 無法取得日期區間"); continue; }
    Logger.log("[EmployeeMonthlyReport] " + ym + " 日期區間 " + range.startDate + "~" + range.endDate);
    result[ym] = {};
    var allItems = [];
    var page = 0;
    var limit = 100;
    var res, items;
    do {
      res = fetchTransactions(range.startDate, range.endDate, storeIds, page, limit);
      items = (res && res.data && res.data.items) ? res.data.items : [];
      if (page === 0 && (!res || !res.data)) Logger.log("[EmployeeMonthlyReport] ✗ " + ym + " fetchTransactions 回傳異常: " + (res ? "無 data" : "res 為空"));
      for (var i = 0; i < items.length; i++) {
        var t = items[i];
        var recDate = (t.rectim || t.cretim || "").slice(0, 10);
        if (recDate >= range.startDate && recDate <= range.endDate) allItems.push(t);
      }
      if (page === 0) Logger.log("[EmployeeMonthlyReport] " + ym + " 第1頁拉回 " + items.length + " 筆" + (items.length === 0 ? "（若預期有資料請檢查 Core 執行紀錄）" : ""));
      if (page > 0 && items.length > 0) Logger.log("[EmployeeMonthlyReport] " + ym + " 第" + (page + 1) + "頁 +" + items.length + " 筆，累計 " + allItems.length);
      page++;
    } while (items.length >= limit);
    Logger.log("[EmployeeMonthlyReport] " + ym + " 共拉取 " + allItems.length + " 筆交易，開始彙總");
    for (var i = 0; i < allItems.length; i++) {
      var t = allItems[i];
      var totalAmt = t.price_ != null ? Number(t.price_) : (t.rprice != null ? Number(t.rprice) : 0);
      var tipsAmt = 0;
      if (t.ordds && t.ordds.length) {
        for (var j = 0; j < t.ordds.length; j++) {
          var o = t.ordds[j];
          var godnam = (o && o.godnam) ? String(o.godnam) : "";
          if (godnam.indexOf("小費") >= 0 || (o && o.godsid != null && Number(o.godsid) === tipsGodsid)) {
            tipsAmt += Number(o.rprice != null ? o.rprice : (o.price_ != null ? o.price_ : 0)) || 0;
          }
        }
      }
      var mainAmt = Math.max(0, totalAmt - tipsAmt);
      if (mainAmt <= 0) continue;
      var rawRemark = (t.remark != null && String(t.remark).trim() !== "") ? String(t.remark).trim() : "";
      var code = parseEmployeeFromRemark(rawRemark, empMap);
      if (!code || !empCodeSet[code]) continue;
      if (!result[ym][code]) result[ym][code] = 0;
      result[ym][code] += mainAmt;
    }
    var empWithData = Object.keys(result[ym]).length;
    Logger.log("[EmployeeMonthlyReport] ✓ " + ym + " 完成：交易 " + allItems.length + " 筆 → 有業績員工 " + empWithData + " 人");
  }
  Logger.log("[EmployeeMonthlyReport] buildEmployeeMonthlyPerformanceReportFromTransactions_ 完成，月份=" + Object.keys(result).join(","));
  return result;
}

/**
 * 彙總指定月份區間的員工業績（使用 transactionStatistic API）
 * @param {string} startYearMonth - "2025-01"
 * @param {string} endYearMonth - "2026-02"
 * @returns {Object} { "2025-01": { "gm001": 50000, ... }, ... }
 */
function buildEmployeeMonthlyPerformanceReport(startYearMonth, endYearMonth) {
  Logger.log("[EmployeeMonthlyReport] buildEmployeeMonthlyPerformanceReport 進入 " + startYearMonth + "~" + endYearMonth + "（transactionStatistic API）");
  return buildEmployeeMonthlyPerformanceReportStatistic_(startYearMonth, endYearMonth);
}

/**
 * 彙總指定月份區間的員工業績（transactionStatistic API）
 */
function buildEmployeeMonthlyPerformanceReportStatistic_(startYearMonth, endYearMonth) {
  Logger.log("[EmployeeMonthlyReport] ★ 使用 transactionStatistic API（keyword=員工代碼）");
  var result = {};
  var bearerToken = (typeof getBearerTokenFromSheet === "function") ? getBearerTokenFromSheet() : "";
  if (!bearerToken) {
    Logger.log("[EmployeeMonthlyReport] 無 Bearer Token");
    return result;
  }
  var empMap = (typeof getEmployeeCodeToNameMap === "function") ? getEmployeeCodeToNameMap() : {};
  var empCodes = getEmployeeCodesExcludingResigned_();
  if (empCodes.length === 0) {
    Logger.log("[EmployeeMonthlyReport] 員工清單為空（或全為離職）");
    return result;
  }
  var months = listMonthsFrom2025_(endYearMonth || "");
  var startIdx = 0;
  if (startYearMonth) {
    var idx = months.indexOf(startYearMonth);
    if (idx >= 0) startIdx = idx;
  }
  var toProcess = months.slice(startIdx);
  var tipsGodsid = getTipsGodsid_();

  // 建立所有請求：每個 (empCode, ym) 需 2 個請求（總業績 + 小費）
  var requests = [];
  var meta = []; // 對應 metadata: { empCode, ym, isTips }
  for (var k = 0; k < toProcess.length; k++) {
    var ym = toProcess[k];
    var range = getMonthDateRange_(ym);
    if (!range) continue;
    for (var e = 0; e < empCodes.length; e++) {
      var code = empCodes[e];
      requests.push(buildTransactionStatisticRequest_(code, range.startDate, range.endDate, {}, bearerToken));
      meta.push({ empCode: code, ym: ym, isTips: false });
      requests.push(buildTransactionStatisticRequest_(code, range.startDate, range.endDate, { godsid: tipsGodsid, godnam: "小費" }, bearerToken));
      meta.push({ empCode: code, ym: ym, isTips: true });
    }
  }

  Logger.log("[EmployeeMonthlyReport] 共 " + requests.length + " 個 API 請求，每批 " + FETCH_BATCH_SIZE + " 個");

  // 平行批次執行
  var totalMap = {}; // totalMap[ym][empCode] = amount
  var tipsMap = {};  // tipsMap[ym][empCode] = amount
  for (var i = 0; i < requests.length; i += FETCH_BATCH_SIZE) {
    var chunk = requests.slice(i, i + FETCH_BATCH_SIZE);
    var chunkMeta = meta.slice(i, i + FETCH_BATCH_SIZE);
    try {
      var responses = UrlFetchApp.fetchAll(chunk);
      for (var j = 0; j < responses.length; j++) {
        var m = chunkMeta[j];
        if (!m) continue;
        var resp = responses[j];
        var logIfZero = (i === 0 && j === 0);
        var label = logIfZero ? (m.ym + " " + m.empCode + (m.isTips ? " 小費" : "")) : "";
        var val = (resp && resp.getContentText) ? parseRealTotal_(resp, logIfZero ? { logIfZero: true, label: label } : {}) : 0;
        if (m.isTips) {
          if (!tipsMap[m.ym]) tipsMap[m.ym] = {};
          tipsMap[m.ym][m.empCode] = val;
        } else {
          if (!totalMap[m.ym]) totalMap[m.ym] = {};
          totalMap[m.ym][m.empCode] = val;
        }
      }
      Logger.log("[EmployeeMonthlyReport] 已完成 " + Math.min(i + FETCH_BATCH_SIZE, requests.length) + "/" + requests.length);
      if (i + FETCH_BATCH_SIZE < requests.length) Utilities.sleep(500); // 批次間稍歇，避免 SayDou 限流
    } catch (err) {
      Logger.log("[EmployeeMonthlyReport] fetchAll 錯誤: " + (err && err.message ? err.message : err));
      break;
    }
  }

  // 彙總：業績 = 總額 - 小費
  for (var ym = 0; ym < toProcess.length; ym++) {
    var ymKey = toProcess[ym];
    result[ymKey] = {};
    for (var e = 0; e < empCodes.length; e++) {
      var code = empCodes[e];
      var total = (totalMap[ymKey] && totalMap[ymKey][code] != null) ? totalMap[ymKey][code] : 0;
      var tips = (tipsMap[ymKey] && tipsMap[ymKey][code] != null) ? tipsMap[ymKey][code] : 0;
      var amt = Math.max(0, total - tips);
      if (amt > 0) result[ymKey][code] = amt;
    }
    // 第一個月 log 員工 breakdown 樣貌（realTotal - 小費 realTotal = 業績）
    if (ym === 0) {
      Logger.log("[EmployeeMonthlyReport] --- " + ymKey + " 員工 breakdown（realTotal - 小費 realTotal = 業績）---");
      var logged = 0;
      var maxLog = 15;
      for (var e2 = 0; e2 < empCodes.length && logged < maxLog; e2++) {
        var c = empCodes[e2];
        var t = (totalMap[ymKey] && totalMap[ymKey][c] != null) ? totalMap[ymKey][c] : 0;
        var tip = (tipsMap[ymKey] && tipsMap[ymKey][c] != null) ? tipsMap[ymKey][c] : 0;
        var a = Math.max(0, t - tip);
        Logger.log("[EmployeeMonthlyReport]   " + c + " | realTotal=" + t + " | 小費 realTotal(godsid=" + tipsGodsid + ")=" + tip + " | 業績=" + a);
        logged++;
      }
      if (empCodes.length > maxLog) Logger.log("[EmployeeMonthlyReport]   ... 其餘 " + (empCodes.length - maxLog) + " 人省略");
    }
  }
  return result;
}

/**
 * 取得或建立「員工業績月報」工作表
 */
function getOrCreateEmployeeMonthlyReportSheet_(ssId) {
  if (!ssId) return null;
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetById(EMPLOYEE_MONTHLY_REPORT_SHEET_GID) || ss.getSheetByName(EMPLOYEE_MONTHLY_REPORT_SHEET_NAME);
    if (sheet) return sheet;
    sheet = ss.insertSheet(EMPLOYEE_MONTHLY_REPORT_SHEET_NAME);
    sheet.getRange(1, 1, 1, EMPLOYEE_MONTHLY_REPORT_HEADERS.length).setValues([EMPLOYEE_MONTHLY_REPORT_HEADERS]);
    sheet.getRange(1, 1, 1, EMPLOYEE_MONTHLY_REPORT_HEADERS.length).setFontWeight("bold");
    return sheet;
  } catch (e) {
    Logger.log("[EmployeeMonthlyReport] getOrCreateSheet: " + (e && e.message ? e.message : e));
    return null;
  }
}

/**
 * 將 buildEmployeeMonthlyPerformanceReport 的資料轉成可寫入試算表的列陣列
 * @param {Object} data - { "2025-01": { "gm001": 50000, ... }, ... }
 * @returns {{ rows: Array, months: Array }} rows 為 [月份, 員工編號, 員工姓名, 所屬店家, 業績金額]
 */
function buildEmployeeMonthlyReportRows(data) {
  var empMap = (typeof getEmployeeCodeToNameMap === "function") ? getEmployeeCodeToNameMap() : {};
  var storeMap = getEmployeeCodeToStoreMap_();
  var rows = [];
  var yearMonths = Object.keys(data || {}).sort();
  for (var ym = 0; ym < yearMonths.length; ym++) {
    var ymKey = yearMonths[ym];
    var byEmp = data[ymKey] || {};
    var empCodes = Object.keys(byEmp).sort();
    for (var e = 0; e < empCodes.length; e++) {
      var code = empCodes[e];
      var amt = byEmp[code];
      if (amt == null || amt <= 0) continue;
      var name = (empMap && empMap[code]) ? empMap[code] : "";
      var store = (storeMap && storeMap[code]) ? storeMap[code] : "";
      rows.push([ymKey, code, name, store, amt]);
    }
  }
  return { rows: rows, months: yearMonths };
}

/**
 * 將彙總資料寫入「員工業績月報」工作表
 * 若 月份+員工編號 已存在則更新該列，否則新增
 */
function writeEmployeeMonthlyReportToSheet(ssId, data, options) {
  if (!ssId) ssId = (typeof DAILY_ACCOUNT_REPORT_SS_ID !== "undefined") ? DAILY_ACCOUNT_REPORT_SS_ID : "";
  if (!ssId) return { ok: false, message: "未指定試算表 ID" };
  var sheet = getOrCreateEmployeeMonthlyReportSheet_(ssId);
  if (!sheet) return { ok: false, message: "無法取得或建立工作表" };
  var empMap = (typeof getEmployeeCodeToNameMap === "function") ? getEmployeeCodeToNameMap() : {};
  var storeMap = getEmployeeCodeToStoreMap_();
  var replaceMonths = (options && options.replaceMonths && Array.isArray(options.replaceMonths)) ? options.replaceMonths : [];
  var numCols = EMPLOYEE_MONTHLY_REPORT_HEADERS.length;

  var existingKeyToRow = {};
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var numDataRows = lastRow - 1;
    var values = sheet.getRange(2, 1, numDataRows, numCols).getValues();
    for (var i = 0; i < values.length; i++) {
      var m = values[i][0] ? String(values[i][0]).trim() : "";
      var code = values[i][1] != null ? String(values[i][1]).trim() : "";
      var name = values[i][2] != null ? String(values[i][2]).trim() : "";
      var key = m + "|" + code;
      var keyByName = m + "|" + name;
      var rowIndex = i + 2;
      existingKeyToRow[key] = rowIndex;
      if (key !== keyByName) existingKeyToRow[keyByName] = rowIndex;
    }
  }

  if (replaceMonths.length > 0) {
    var toKeep = [];
    if (lastRow >= 2) {
      var numDataRows = lastRow - 1;
      var values = sheet.getRange(2, 1, numDataRows, numCols).getValues();
      for (var i = 0; i < values.length; i++) {
        var rowMonth = values[i][0] ? String(values[i][0]).trim() : "";
        if (replaceMonths.indexOf(rowMonth) === -1) toKeep.push(values[i]);
      }
      if (toKeep.length < values.length) {
        sheet.deleteRows(2, lastRow - 1);
        if (toKeep.length > 0) {
          sheet.getRange(2, 1, toKeep.length, numCols).setValues(toKeep);
        }
        existingKeyToRow = {};
        lastRow = toKeep.length ? toKeep.length + 1 : 1;
        if (lastRow >= 2) {
          for (var k = 0; k < toKeep.length; k++) {
            var m = toKeep[k][0] ? String(toKeep[k][0]).trim() : "";
            var code = toKeep[k][1] != null ? String(toKeep[k][1]).trim() : "";
            var name = toKeep[k][2] != null ? String(toKeep[k][2]).trim() : "";
            existingKeyToRow[m + "|" + code] = k + 2;
            if (name) existingKeyToRow[m + "|" + name] = k + 2;
          }
        }
      }
    }
  }

  var rows = [];
  var yearMonths = Object.keys(data || {}).sort();
  for (var ym = 0; ym < yearMonths.length; ym++) {
    var ymKey = yearMonths[ym];
    var byEmp = data[ymKey] || {};
    var empCodes = Object.keys(byEmp).sort();
    for (var e = 0; e < empCodes.length; e++) {
      var code = empCodes[e];
      var amt = byEmp[code];
      if (amt == null || amt <= 0) continue;
      var name = (empMap && empMap[code]) ? empMap[code] : "";
      var store = (storeMap && storeMap[code]) ? storeMap[code] : "";
      rows.push([ymKey, code, name, store, amt]);
    }
  }

  var toAppend = [];
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var keyByCode = row[0] + "|" + row[1];
    var keyByName = row[0] + "|" + (row[2] || "");
    var rowIndex = existingKeyToRow[keyByCode] || existingKeyToRow[keyByName];
    if (rowIndex) {
      sheet.getRange(rowIndex, 1, 1, numCols).setValues([row]);
      delete existingKeyToRow[keyByCode];
      delete existingKeyToRow[keyByName];
    } else {
      toAppend.push(row);
    }
  }
  if (toAppend.length > 0) {
    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, toAppend.length, numCols).setValues(toAppend);
  }

  return { ok: true, rowCount: rows.length, updated: rows.length - toAppend.length, appended: toAppend.length, months: yearMonths };
}
