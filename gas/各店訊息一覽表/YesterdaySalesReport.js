/**
 * 各店昨日消費報告：昨日消費總額 + 誰做的收多少錢（依備註員工代碼分組）
 * 月報：當月消費總額 + 每位員工當月總額
 * 使用 Core.getTransactionsForStoreByDate(storeId, dateStr)、Core.getTransactionsForStoreByDateRange(storeId, start, end)、Core.getEmployeeCodeToNameMap()
 * 可 Push 給店家管理者（同明日預約報告的 pushTomorrowReportToManagers 邏輯）
 */

var YESTERDAY_SALES_CONFIG = {
  TZ: "Asia/Taipei",
  /** 報表寫入的試算表（與客人消費狀態同份；依賴 CustomerProfile 的 CONFIG.INTEGRATED_SHEET_SS_ID） */
  REPORT_SS_ID: null  // 不設則用 CONFIG.INTEGRATED_SHEET_SS_ID
};

/**
 * 依員工代碼（備註）彙總交易金額
 * @param {Array} transactions - Core.getTransactionsForStoreByDate 回傳的陣列
 * @returns {{ total: number, byRemark: Object }} total 總額, byRemark { "nk001": 1234, ... }
 */
function sumTransactionsByRemark(transactions) {
  var total = 0;
  var byRemark = {};
  if (!transactions || transactions.length === 0) return { total: 0, byRemark: {} };
  for (var i = 0; i < transactions.length; i++) {
    var t = transactions[i];
    var amt = t.price_ != null ? Number(t.price_) : (t.rprice != null ? Number(t.rprice) : 0);
    total += amt;
    var remark = (t.remark != null && String(t.remark).trim() !== "") ? String(t.remark).trim() : "（未填）";
    if (!byRemark[remark]) byRemark[remark] = 0;
    byRemark[remark] += amt;
  }
  return { total: total, byRemark: byRemark };
}

/**
 * 依員工代碼（備註）彙總交易筆數（供員工每月樣態用）
 * @param {Array} transactions
 * @returns {Object} byRemark { "nk001": 5, ... }
 */
function countTransactionsByRemark(transactions) {
  var byRemark = {};
  if (!transactions || transactions.length === 0) return {};
  for (var i = 0; i < transactions.length; i++) {
    var remark = (transactions[i].remark != null && String(transactions[i].remark).trim() !== "") ? String(transactions[i].remark).trim() : "（未填）";
    byRemark[remark] = (byRemark[remark] || 0) + 1;
  }
  return byRemark;
}

/**
 * 產出單店「昨日消費總額 + 誰做收多少」文字
 * @param {string} storeName
 * @param {string} dateStr - yyyy-MM-dd
 * @param {{ total: number, byRemark: Object }} summed
 * @returns {string}
 */
function formatStoreYesterdaySales(storeName, dateStr, summed) {
  var lines = ["【" + storeName + "】昨日消費 " + dateStr, "總額: $" + (summed.total || 0), "--- 依經手人 ---"];
  var empMap = (typeof Core !== "undefined" && typeof Core.getEmployeeCodeToNameMap === "function") ? Core.getEmployeeCodeToNameMap() : {};
  var remarks = Object.keys(summed.byRemark || {}).sort();
  for (var i = 0; i < remarks.length; i++) {
    var code = remarks[i];
    var amt = summed.byRemark[code];
    var name = empMap[code] || "";
    var label = name ? code + " (" + name + ")" : code;
    lines.push(label + ": $" + amt);
  }
  if (remarks.length === 0) lines.push("（無交易或無備註）");
  return lines.join("\n");
}

/**
 * 產出指定日期的「各店昨日消費報告」（總額 + 誰做收多少）
 * @param {string} [dateStr] - yyyy-MM-dd，不傳則用昨天
 * @returns {Object} { dateStr, byStore: [{ storeId, storeName, total, byRemark, reportText }] }
 */
function buildYesterdaySalesReport(dateStr) {
  if (!dateStr) {
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    dateStr = Utilities.formatDate(yesterday, YESTERDAY_SALES_CONFIG.TZ, "yyyy-MM-dd");
  }
  if (typeof Core === "undefined" || typeof Core.getStoresInfo !== "function" || typeof Core.getTransactionsForStoreByDate !== "function") {
    return { dateStr: dateStr, byStore: [] };
  }
  var stores = Core.getStoresInfo();
  var byStore = [];
  for (var i = 0; i < stores.length; i++) {
    var store = stores[i];
    var transactions = Core.getTransactionsForStoreByDate(store.id, dateStr);
    var summed = sumTransactionsByRemark(transactions);
    var reportText = formatStoreYesterdaySales(store.name || ("店" + store.id), dateStr, summed);
    byStore.push({
      storeId: store.id,
      storeName: store.name || ("店" + store.id),
      total: summed.total,
      byRemark: summed.byRemark,
      reportText: reportText
    });
  }
  return { dateStr: dateStr, byStore: byStore };
}

/**
 * 將昨日消費報告 Push 給各店管理者（依「管理者清單」對應的 LINE userId）
 * @param {Object} result - buildYesterdaySalesReport 的回傳值
 * @returns {{ pushed: number, errors: number }}
 */
function pushYesterdaySalesReportToManagers(result) {
  if (!result || !result.byStore) return { pushed: 0, errors: 0 };
  var config = typeof Core !== "undefined" && typeof Core.getCoreConfig === "function" ? Core.getCoreConfig() : null;
  if (!config || !config.LINE_TOKEN_PAOSTAFF) return { pushed: 0, errors: 0 };
  var token = config.LINE_TOKEN_PAOSTAFF;
  var pushed = 0;
  var errors = 0;
  for (var i = 0; i < result.byStore.length; i++) {
    var block = result.byStore[i];
    var userIds = typeof getManagerUserIdsForStore === "function" ? getManagerUserIdsForStore(block.storeId, block.storeName) : [];
    var body = "📊 昨日消費報告 " + result.dateStr + "\n\n" + (block.reportText || "");
    for (var j = 0; j < userIds.length; j++) {
      try {
        if (typeof Core.sendLinePushText === "function") {
          Core.sendLinePushText(userIds[j], body, token);
          pushed++;
        }
      } catch (e) {
        errors++;
      }
    }
  }
  return { pushed: pushed, errors: errors };
}

/**
 * 產出昨日消費報告並 Push 給店家管理者
 * 執行方式：Apps Script 選 runYesterdaySalesReportAndPush → 執行；可設每日觸發（例如每天早上）。
 */
function runYesterdaySalesReportAndPush() {
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  var dateStr = Utilities.formatDate(yesterday, YESTERDAY_SALES_CONFIG.TZ, "yyyy-MM-dd");
  var result = buildYesterdaySalesReport(dateStr);
  Logger.log("=== 昨日消費報告 " + result.dateStr + " ===");
  for (var i = 0; i < result.byStore.length; i++) {
    Logger.log("\n" + result.byStore[i].reportText);
  }
  var pushResult = pushYesterdaySalesReportToManagers(result);
  Logger.log("Push 給管理者：成功 " + pushResult.pushed + " 則，失敗 " + pushResult.errors + " 則");
  writeYesterdaySalesReportToSheet(result);
  return result;
}

// --- 月報：當月消費總額 + 每位員工當月總額 ---

/**
 * 取得某年某月的起訖日期 (yyyy-MM-dd)
 * @param {number} year
 * @param {number} month - 1~12
 * @returns {{ startDate: string, endDate: string, yearMonth: string }}
 */
function getMonthDateRange(year, month) {
  var start = new Date(year, month - 1, 1);
  var end = new Date(year, month, 0); // 當月最後一天
  var tz = YESTERDAY_SALES_CONFIG.TZ;
  return {
    startDate: Utilities.formatDate(start, tz, "yyyy-MM-dd"),
    endDate: Utilities.formatDate(end, tz, "yyyy-MM-dd"),
    yearMonth: year + "-" + (month < 10 ? "0" + month : String(month))
  };
}

/**
 * 產出單店「本月消費總額 + 每位員工當月總額」文字
 * @param {string} storeName
 * @param {string} startDate
 * @param {string} endDate
 * @param {string} yearMonth - 例 "2025-02"
 * @param {{ total: number, byRemark: Object }} summed
 * @returns {string}
 */
function formatStoreMonthlySales(storeName, startDate, endDate, yearMonth, summed) {
  var lines = ["【" + storeName + "】本月消費 " + yearMonth + " (" + startDate + " ~ " + endDate + ")", "總額: $" + (summed.total || 0), "--- 依經手人（當月總額）---"];
  var empMap = (typeof Core !== "undefined" && typeof Core.getEmployeeCodeToNameMap === "function") ? Core.getEmployeeCodeToNameMap() : {};
  var remarks = Object.keys(summed.byRemark || {}).sort();
  for (var i = 0; i < remarks.length; i++) {
    var code = remarks[i];
    var amt = summed.byRemark[code];
    var name = empMap[code] || "";
    var label = name ? code + " (" + name + ")" : code;
    lines.push(label + ": $" + amt);
  }
  if (remarks.length === 0) lines.push("（無交易或無備註）");
  return lines.join("\n");
}

/**
 * 產出指定年月的「各店本月消費報告」（總額 + 每位員工當月總額）
 * @param {number} [year] - 不傳則用當月
 * @param {number} [month] - 1~12，不傳則用當月
 * @returns {Object} { yearMonth, startDate, endDate, byStore: [{ storeId, storeName, total, byRemark, reportText }] }
 */
function buildMonthlySalesReport(year, month) {
  var now = new Date();
  var y = year != null ? year : now.getFullYear();
  var m = month != null ? month : (now.getMonth() + 1);
  var range = getMonthDateRange(y, m);
  if (typeof Core === "undefined" || typeof Core.getStoresInfo !== "function" || typeof Core.getTransactionsForStoreByDateRange !== "function") {
    return { yearMonth: range.yearMonth, startDate: range.startDate, endDate: range.endDate, byStore: [] };
  }
  var stores = Core.getStoresInfo();
  var byStore = [];
  for (var i = 0; i < stores.length; i++) {
    var store = stores[i];
    var transactions = Core.getTransactionsForStoreByDateRange(store.id, range.startDate, range.endDate);
    var summed = sumTransactionsByRemark(transactions);
    var byRemarkCount = countTransactionsByRemark(transactions);
    var reportText = formatStoreMonthlySales(store.name || ("店" + store.id), range.startDate, range.endDate, range.yearMonth, summed);
    byStore.push({
      storeId: store.id,
      storeName: store.name || ("店" + store.id),
      total: summed.total,
      byRemark: summed.byRemark,
      byRemarkCount: byRemarkCount,
      reportText: reportText
    });
  }
  return { yearMonth: range.yearMonth, startDate: range.startDate, endDate: range.endDate, byStore: byStore };
}

/**
 * 將本月消費報告 Push 給各店管理者
 * @param {Object} result - buildMonthlySalesReport 的回傳值
 * @returns {{ pushed: number, errors: number }}
 */
function pushMonthlySalesReportToManagers(result) {
  if (!result || !result.byStore) return { pushed: 0, errors: 0 };
  var config = typeof Core !== "undefined" && typeof Core.getCoreConfig === "function" ? Core.getCoreConfig() : null;
  if (!config || !config.LINE_TOKEN_PAOSTAFF) return { pushed: 0, errors: 0 };
  var token = config.LINE_TOKEN_PAOSTAFF;
  var pushed = 0;
  var errors = 0;
  for (var i = 0; i < result.byStore.length; i++) {
    var block = result.byStore[i];
    var userIds = typeof getManagerUserIdsForStore === "function" ? getManagerUserIdsForStore(block.storeId, block.storeName) : [];
    var body = "📊 本月消費報告 " + result.yearMonth + " (" + result.startDate + " ~ " + result.endDate + ")\n\n" + (block.reportText || "");
    for (var j = 0; j < userIds.length; j++) {
      try {
        if (typeof Core.sendLinePushText === "function") {
          Core.sendLinePushText(userIds[j], body, token);
          pushed++;
        }
      } catch (e) {
        errors++;
      }
    }
  }
  return { pushed: pushed, errors: errors };
}

/**
 * 產出本月消費報告並 Push 給店家管理者
 * 執行方式：Apps Script 選 runMonthlySalesReportAndPush → 執行；可設每月觸發（例如每月 1 號早上）。
 * 若要報「上個月」可呼叫 runMonthlySalesReportAndPush(上年年, 上個月)。
 */
function runMonthlySalesReportAndPush(year, month) {
  var result = buildMonthlySalesReport(year, month);
  Logger.log("=== 本月消費報告 " + result.yearMonth + " (" + result.startDate + " ~ " + result.endDate + ") ===");
  for (var i = 0; i < result.byStore.length; i++) {
    Logger.log("\n" + result.byStore[i].reportText);
  }
  var pushResult = pushMonthlySalesReportToManagers(result);
  Logger.log("Push 給管理者：成功 " + pushResult.pushed + " 則，失敗 " + pushResult.errors + " 則");
  writeMonthlySalesReportToSheet(result);
  writeEmployeeMonthlySummaryToSheet(result);
  return result;
}

// --- 報表寫入試算表（可見報表）---

function getReportSpreadsheet() {
  var id = YESTERDAY_SALES_CONFIG.REPORT_SS_ID || (typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID) || null;
  if (!id) return null;
  try {
    return SpreadsheetApp.openById(id);
  } catch (e) {
    console.warn("getReportSpreadsheet:", e);
    return null;
  }
}

function getOrCreateSheet(ss, sheetName, headers) {
  if (!ss) return null;
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    if (headers && headers.length) sheet.appendRow(headers);
  }
  return sheet;
}

/**
 * 昨日消費報告寫入試算表「昨日消費報告」，方便看報表
 */
function writeYesterdaySalesReportToSheet(result) {
  if (!result || !result.byStore) return;
  var ss = getReportSpreadsheet();
  if (!ss) return;
  var sheet = getOrCreateSheet(ss, "昨日消費報告", ["日期", "店名", "總額", "依經手人摘要"]);
  if (!sheet) return;
  for (var i = 0; i < result.byStore.length; i++) {
    var b = result.byStore[i];
    var empLines = [];
    var keys = Object.keys(b.byRemark || {}).sort();
    for (var k = 0; k < keys.length; k++) {
      empLines.push(keys[k] + ": $" + (b.byRemark[keys[k]] || 0));
    }
    sheet.appendRow([result.dateStr, b.storeName, b.total || 0, empLines.join(" | ")]);
  }
  Logger.log("昨日消費報告已寫入試算表「昨日消費報告」");
}

/**
 * 本月消費報告寫入試算表「本月消費報告」
 */
function writeMonthlySalesReportToSheet(result) {
  if (!result || !result.byStore) return;
  var ss = getReportSpreadsheet();
  if (!ss) return;
  var sheet = getOrCreateSheet(ss, "本月消費報告", ["年月", "起訖", "店名", "總額", "依經手人摘要"]);
  if (!sheet) return;
  var rangeStr = (result.startDate || "") + " ~ " + (result.endDate || "");
  for (var i = 0; i < result.byStore.length; i++) {
    var b = result.byStore[i];
    var empLines = [];
    var keys = Object.keys(b.byRemark || {}).sort();
    for (var k = 0; k < keys.length; k++) {
      empLines.push(keys[k] + ": $" + (b.byRemark[keys[k]] || 0));
    }
    sheet.appendRow([result.yearMonth, rangeStr, b.storeName, b.total || 0, empLines.join(" | ")]);
  }
  Logger.log("本月消費報告已寫入試算表「本月消費報告」");
}

/**
 * 員工每月樣態寫入試算表「員工每月樣態」：年月、店名、員工代碼、員工姓名、當月總額、筆數
 */
function writeEmployeeMonthlySummaryToSheet(result) {
  if (!result || !result.byStore) return;
  var ss = getReportSpreadsheet();
  if (!ss) return;
  var sheet = getOrCreateSheet(ss, "員工每月樣態", ["年月", "店名", "員工代碼", "員工姓名", "當月總額", "筆數"]);
  if (!sheet) return;
  var empMap = (typeof Core !== "undefined" && typeof Core.getEmployeeCodeToNameMap === "function") ? Core.getEmployeeCodeToNameMap() : {};
  for (var i = 0; i < result.byStore.length; i++) {
    var b = result.byStore[i];
    var codes = Object.keys(b.byRemark || {}).sort();
    for (var j = 0; j < codes.length; j++) {
      var code = codes[j];
      var amt = b.byRemark[code] || 0;
      var cnt = (b.byRemarkCount && b.byRemarkCount[code]) ? b.byRemarkCount[code] : 0;
      var name = empMap[code] || "";
      sheet.appendRow([result.yearMonth, b.storeName, code, name, amt, cnt]);
    }
  }
  Logger.log("員工每月樣態已寫入試算表「員工每月樣態」");
}
