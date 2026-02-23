/**
 * Core 報表產出：供「員工打卡 Line@」等專案跨專案取得昨日／明日／本月／員工樣態報告。
 * 各店訊息一覽表（客人 LINE）維持讀客人、回客人；Staff 在員工打卡打關鍵字取報表。
 */

var REPORT_HELPERS_TZ = "Asia/Taipei";
var REPORT_AI_ROW_HEADER = "姓名\t手機\t預約時間\t潔顏師\t課程／服務\t備註";

/**
 * 從 SayDou 備註文字解析出經手人（員工代碼）。
 * 備註沒有專屬員工編號欄，需從文字中比對：先比對員工代碼、再比對員工姓名，取最長符合者。
 * @param {string} remarkText - 備註全文
 * @param {Object} empMap - 員工代碼→姓名 { "nk001": "王小明", ... }
 * @returns {string|null} 員工代碼，無法解析時回傳 null
 */
function parseEmployeeFromRemark(remarkText, empMap) {
  if (!remarkText || String(remarkText).trim() === "") return null;
  var text = String(remarkText).trim();
  if (!empMap || typeof empMap !== "object") return null;
  var bestCode = null;
  var bestLen = 0;
  var codes = Object.keys(empMap);
  for (var i = 0; i < codes.length; i++) {
    var code = codes[i];
    if (!code || code.length <= bestLen) continue;
    if (text.indexOf(code) !== -1) {
      bestCode = code;
      bestLen = code.length;
    }
  }
  var names = Object.keys(empMap).map(function (c) { return { code: c, name: empMap[c] }; }).filter(function (x) { return x.name && String(x.name).trim(); });
  names.sort(function (a, b) { return (b.name.length - a.name.length); });
  for (var j = 0; j < names.length; j++) {
    var name = String(names[j].name).trim();
    if (name.length <= bestLen) continue;
    if (text.indexOf(name) !== -1) {
      bestCode = names[j].code;
      bestLen = name.length;
    }
  }
  return bestCode;
}

function sumTransactionsByRemark(transactions) {
  var total = 0;
  var byRemark = {};
  if (!transactions || transactions.length === 0) return { total: 0, byRemark: {} };
  var empMap = (typeof getEmployeeCodeToNameMap === "function") ? getEmployeeCodeToNameMap() : {};
  for (var i = 0; i < transactions.length; i++) {
    var t = transactions[i];
    var amt = t.price_ != null ? Number(t.price_) : (t.rprice != null ? Number(t.rprice) : 0);
    total += amt;
    var rawRemark = (t.remark != null && String(t.remark).trim() !== "") ? String(t.remark).trim() : "";
    var key = parseEmployeeFromRemark(rawRemark, empMap);
    if (key == null) key = rawRemark || "（未填）";
    if (!byRemark[key]) byRemark[key] = 0;
    byRemark[key] += amt;
  }
  return { total: total, byRemark: byRemark };
}

function countTransactionsByRemark(transactions) {
  var byRemark = {};
  if (!transactions || transactions.length === 0) return {};
  var empMap = (typeof getEmployeeCodeToNameMap === "function") ? getEmployeeCodeToNameMap() : {};
  for (var i = 0; i < transactions.length; i++) {
    var rawRemark = (transactions[i].remark != null && String(transactions[i].remark).trim() !== "") ? String(transactions[i].remark).trim() : "";
    var key = parseEmployeeFromRemark(rawRemark, empMap);
    if (key == null) key = rawRemark || "（未填）";
    byRemark[key] = (byRemark[key] || 0) + 1;
  }
  return byRemark;
}

function formatStoreYesterdaySales(storeName, dateStr, summed) {
  var lines = ["【" + storeName + "】昨日消費 " + dateStr, "總額: $" + (summed.total || 0), "--- 依經手人 ---"];
  var empMap = (typeof getEmployeeCodeToNameMap === "function") ? getEmployeeCodeToNameMap() : {};
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
 * 依「日報表 產出」同一來源：fetchDailyIncome 的 totalRow 格式化成昨日營收文字
 */
function formatStoreYesterdayFromDailyIncome(storeName, dateStr, runData) {
  if (!runData) return "【" + storeName + "】昨日 " + dateStr + "\n（無營收資料）";
  var cashTotal = runData.sum_paymentMethod && runData.sum_paymentMethod[0] ? (runData.sum_paymentMethod[0].total || 0) : 0;
  var cashBusiness = runData.cashpay && runData.cashpay.business != null ? runData.cashpay.business : 0;
  var cashUnearn = runData.cashpay && runData.cashpay.unearn != null ? runData.cashpay.unearn : 0;
  var lineTotal = runData.sum_paymentMethod && runData.sum_paymentMethod[2] ? (runData.sum_paymentMethod[2].total || 0) : 0;
  var transferTotal = runData.sum_paymentMethod && runData.sum_paymentMethod[9] ? (runData.sum_paymentMethod[9].total || 0) : 0;
  var lineRecord = runData.paymentMethod && runData.paymentMethod[2] ? (runData.paymentMethod[2].total || 0) : 0;
  var transferRecord = runData.paymentMethod && runData.paymentMethod[9] ? (runData.paymentMethod[9].total || 0) : 0;
  var transferUnearn = transferTotal - transferRecord;
  var lineUnearn = lineTotal - lineRecord;
  var total = cashTotal + lineTotal + transferTotal;
  var out = [
    "【" + storeName + "】昨日營收 " + dateStr,
    "總額: $" + total,
    "--- 昨日營收（與日報表產出同源）---",
    "現金總額: $" + cashTotal + "（營收: $" + cashBusiness + "、未入帳: $" + cashUnearn + "）",
    "LINE: $" + lineTotal + (lineUnearn !== 0 ? "（未入帳: $" + lineUnearn + "）" : ""),
    "轉帳: $" + transferTotal + (transferUnearn !== 0 ? "（未入帳: $" + transferUnearn + "）" : "")
  ];
  return out.join("\n");
}

function getMonthDateRange(year, month) {
  var start = new Date(year, month - 1, 1);
  var end = new Date(year, month, 0);
  return {
    startDate: Utilities.formatDate(start, REPORT_HELPERS_TZ, "yyyy-MM-dd"),
    endDate: Utilities.formatDate(end, REPORT_HELPERS_TZ, "yyyy-MM-dd"),
    yearMonth: year + "-" + (month < 10 ? "0" + month : String(month))
  };
}

function formatStoreMonthlySales(storeName, startDate, endDate, yearMonth, summed) {
  var lines = ["【" + storeName + "】本月消費 " + yearMonth + " (" + startDate + " ~ " + endDate + ")", "總額: $" + (summed.total || 0), "--- 依經手人（當月總額）---"];
  var empMap = (typeof getEmployeeCodeToNameMap === "function") ? getEmployeeCodeToNameMap() : {};
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
 * 產出昨日消費報告（Core 跨專案用）
 * 優先使用「日報表 產出」同源：fetchDailyIncome 取得今日營收；無資料時改以交易明細依經手人彙總
 */
function buildYesterdaySalesReport(dateStr) {
  if (!dateStr) {
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    dateStr = Utilities.formatDate(yesterday, REPORT_HELPERS_TZ, "yyyy-MM-dd");
  }
  if (typeof getStoresInfo !== "function") {
    return { dateStr: dateStr, byStore: [] };
  }
  var stores = getStoresInfo();
  var byStore = [];
  var hasFetchDailyIncome = typeof fetchDailyIncome === "function";
  for (var i = 0; i < stores.length; i++) {
    var store = stores[i];
    var reportText = "";
    var total = 0;
    var byRemark = {};
    if (hasFetchDailyIncome) {
      try {
        var apiResponse = fetchDailyIncome(dateStr, store.id);
        if (apiResponse && apiResponse.data && apiResponse.data.totalRow) {
          var runData = apiResponse.data.totalRow;
          reportText = formatStoreYesterdayFromDailyIncome(store.name || ("店" + store.id), dateStr, runData);
          var cashTotal = (runData.sum_paymentMethod && runData.sum_paymentMethod[0] ? runData.sum_paymentMethod[0].total : 0) || 0;
          var lineTotal = (runData.sum_paymentMethod && runData.sum_paymentMethod[2] ? runData.sum_paymentMethod[2].total : 0) || 0;
          var transferTotal = (runData.sum_paymentMethod && runData.sum_paymentMethod[9] ? runData.sum_paymentMethod[9].total : 0) || 0;
          total = cashTotal + lineTotal + transferTotal;
        }
      } catch (e) {}
    }
    if (!reportText && typeof getTransactionsForStoreByDate === "function") {
      var transactions = getTransactionsForStoreByDate(store.id, dateStr);
      var summed = sumTransactionsByRemark(transactions);
      total = summed.total;
      byRemark = summed.byRemark;
      reportText = formatStoreYesterdaySales(store.name || ("店" + store.id), dateStr, summed);
    }
    if (!reportText) {
      reportText = "【" + (store.name || ("店" + store.id)) + "】昨日 " + dateStr + "\n（無營收資料）";
    }
    byStore.push({ storeId: store.id, storeName: store.name || ("店" + store.id), total: total, byRemark: byRemark, reportText: reportText });
  }
  return { dateStr: dateStr, byStore: byStore };
}

/**
 * 產出本月消費報告（Core 跨專案用）
 */
function buildMonthlySalesReport(year, month) {
  var now = new Date();
  var y = year != null ? year : now.getFullYear();
  var m = month != null ? month : (now.getMonth() + 1);
  var range = getMonthDateRange(y, m);
  if (typeof getStoresInfo !== "function" || typeof getTransactionsForStoreByDateRange !== "function") {
    return { yearMonth: range.yearMonth, startDate: range.startDate, endDate: range.endDate, byStore: [] };
  }
  var stores = getStoresInfo();
  var byStore = [];
  for (var i = 0; i < stores.length; i++) {
    var store = stores[i];
    var transactions = getTransactionsForStoreByDateRange(store.id, range.startDate, range.endDate);
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

function normalizeReservationRow(r) {
  if (!r) return null;
  var phone = (r.rsphon != null && r.rsphon !== "") ? String(r.rsphon).trim() : (r.memb && r.memb.phone_) ? String(r.memb.phone_).trim() : "";
  var name = (r.rsname != null && r.rsname !== "") ? String(r.rsname).trim() : (r.memb && r.memb.memnam) ? String(r.memb.memnam).trim() : "";
  var rsvtim = r.rsvtim ? String(r.rsvtim).replace("T", " ").slice(0, 16) : "";
  var timeText = "";
  if (rsvtim) {
    var tPart = rsvtim.split(/[T\s]/)[1] || "";
    timeText = tPart.slice(0, 5); // HH:mm
  }
  var staffName = (r.usrs && r.usrs.usrnam) ? String(r.usrs.usrnam) : "";
  var services = (r.services != null) ? String(r.services) : "";
  var remark = (r.remark != null) ? String(r.remark) : "";
  return { phone: phone, name: name, rsvtim: rsvtim, timeText: timeText, staffName: staffName, services: services, remark: remark };
}

function formatStoreReportForAI(storeName, items) {
  var lines = ["【" + storeName + "】明日預約客人（給 AI 過水用）", REPORT_AI_ROW_HEADER];
  for (var i = 0; i < items.length; i++) {
    var o = items[i];
    lines.push([o.name || "—", o.phone || "—", o.rsvtim || "—", o.staffName || "—", (o.services || "—").replace(/\t/g, " "), (o.remark || "—").replace(/\n/g, " ")].join("\t"));
  }
  if (items.length === 0) lines.push("（無預約）");
  return lines.join("\n");
}

function getTomorrowReservationsByStore(dateStr) {
  if (typeof getStoresInfo !== "function" || typeof fetchReservationsAndOffs !== "function") return [];
  var stores = getStoresInfo();
  var out = [];
  for (var i = 0; i < stores.length; i++) {
    var store = stores[i];
    var res = fetchReservationsAndOffs(store.id, dateStr, dateStr);
    var reservations = res.reservations || [];
    var items = [];
    for (var j = 0; j < reservations.length; j++) {
      var row = normalizeReservationRow(reservations[j]);
      if (row) items.push(row);
    }
    items.sort(function (a, b) { return (a.rsvtim || "").localeCompare(b.rsvtim || ""); });
    out.push({ storeId: store.id, storeName: store.name || ("店" + store.id), items: items });
  }
  return out;
}

/**
 * 產出明日預約報告（Core 跨專案用）
 */
function buildTomorrowReservationReport(dateStr) {
  if (!dateStr) {
    var tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    dateStr = Utilities.formatDate(tomorrow, REPORT_HELPERS_TZ, "yyyy-MM-dd");
  }
  var byStore = getTomorrowReservationsByStore(dateStr);
  for (var i = 0; i < byStore.length; i++) {
    byStore[i].reportText = formatStoreReportForAI(byStore[i].storeName, byStore[i].items);
  }
  return { dateStr: dateStr, byStore: byStore };
}

/**
 * 寫入員工每月樣態到試算表並回傳連結
 */
function writeEmployeeMonthlySummaryToSheet(ssId, result) {
  if (!result || !result.byStore || !ssId) return null;
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName("員工每月樣態");
    if (!sheet) {
      sheet = ss.insertSheet("員工每月樣態");
      sheet.appendRow(["年月", "店名", "員工代碼", "員工姓名", "當月總額", "筆數"]);
    }
    var empMap = (typeof getEmployeeCodeToNameMap === "function") ? getEmployeeCodeToNameMap() : {};
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
    return ss.getUrl() + "#gid=" + sheet.getSheetId();
  } catch (e) {
    console.warn("[Core] writeEmployeeMonthlySummaryToSheet:", e);
    return null;
  }
}

/**
 * 僅寫入篩選後的門市到員工每月樣態（依管理者清單）
 * 資料來源：SayDou 消費交易 API，依每筆交易的「備註／經手人」欄彙總；無交易或未填經手人時仍寫一列說明，避免試算表全空。
 */
function writeEmployeeMonthlySummaryToSheetFromFiltered(ssId, result, filteredByStore) {
  if (!result || !filteredByStore || filteredByStore.length === 0 || !ssId) return null;
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName("員工每月樣態");
    if (!sheet) {
      sheet = ss.insertSheet("員工每月樣態");
      sheet.appendRow(["年月", "店名", "員工代碼", "員工姓名", "當月總額", "筆數"]);
    }
    var empMap = (typeof getEmployeeCodeToNameMap === "function") ? getEmployeeCodeToNameMap() : {};
    for (var i = 0; i < filteredByStore.length; i++) {
      var b = filteredByStore[i];
      var codes = Object.keys(b.byRemark || {}).sort();
      if (codes.length > 0) {
        for (var j = 0; j < codes.length; j++) {
          var code = codes[j];
          var amt = b.byRemark[code] || 0;
          var cnt = (b.byRemarkCount && b.byRemarkCount[code]) ? b.byRemarkCount[code] : 0;
          var name = empMap[code] || "";
          sheet.appendRow([result.yearMonth, b.storeName, code, name, amt, cnt]);
        }
      } else {
        sheet.appendRow([result.yearMonth, b.storeName, "—", "（當月無交易或無經手人備註）", 0, 0]);
      }
    }
    return ss.getUrl() + "#gid=" + sheet.getSheetId();
  } catch (e) {
    console.warn("[Core] writeEmployeeMonthlySummaryToSheetFromFiltered:", e);
    return null;
  }
}

var REPORT_MAX_REPLY_LEN = 4500;
var REPORT_TEMP_SHEET_NAME = "關鍵字報告暫存";

/** 關鍵字對應報告類型（與各店訊息一覽表 KEYWORD_LIST 對齊，供員工打卡等專案用） */
var REPORT_KEYWORD_RULES = [
  { keywords: ["昨日報告", "昨日消費", "昨日"], handler: "yesterday", label: "昨日消費報告" },
  { keywords: ["明日預約", "明日預約報告", "明日"], handler: "tomorrow", label: "明日預約報告" },
  { keywords: ["本月報告", "本月消費", "月報"], handler: "monthly", label: "本月消費報告" },
  { keywords: ["員工樣態", "員工月報", "員工每月"], handler: "employee", label: "員工每月樣態" },
  { keywords: ["上月小費"], handler: "lastMonthTips", label: "上月小費" },
  { keywords: ["店家回覆狀態"], handler: "directStoreReply", label: "店家回覆狀態" }
];

/**
 * 店家回覆狀態：從「訊息一覽」動態計算各直營店未回覆數與完成率。
 * 直營店由 店家基本資料 H 欄 (row[7]===true) 判定。
 * @returns {{ ok: boolean, text?: string, message?: string }}
 */
function getDirectStoreReplyStatusText() {
  var config = (typeof getCoreConfig === "function") ? getCoreConfig() : {};
  var ssId = config && config.LINE_STORE_SS_ID ? config.LINE_STORE_SS_ID : "";
  if (!ssId) return { ok: false, message: "無法取得店家回覆狀態，請稍後再試。" };
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var storeSheet = ss.getSheetById(72760104) || ss.getSheetByName("店家基本資料");
    if (!storeSheet) return { ok: false, message: "無法取得店家回覆狀態，請稍後再試。" };
    var msgSheet = ss.getSheetByName("訊息一覽");
    if (!msgSheet) return { ok: false, message: "找不到「訊息一覽」工作表。" };

    var lastRow = storeSheet.getLastRow();
    if (lastRow < 2) return { ok: false, message: "目前無直營店資料或 H 欄皆為 false" };

    var storeData = storeSheet.getRange(2, 1, lastRow, 12).getValues();
    var msgData = msgSheet.getDataRange().getValues();
    var MSG_STORE_COL = 2;   // C 欄：店家
    var MSG_STATUS_COL = 5;   // F 欄：狀態（空=未回覆）

    var directStores = [];
    for (var i = 0; i < storeData.length; i++) {
      var row = storeData[i];
      if (row[7] !== true) continue;
      var name = row[1] != null ? String(row[1]).trim() : "";
      if (!name) continue;

      var unreplied = 0, total = 0;
      for (var j = 1; j < msgData.length; j++) {
        var m = msgData[j];
        var msgStore = (m[MSG_STORE_COL] != null) ? String(m[MSG_STORE_COL]).trim() : "";
        if (msgStore !== name) continue;
        total++;
        var status = m[MSG_STATUS_COL];
        if (status == null || String(status).trim() === "") unreplied++;
      }

      var rateVal = (total > 0) ? ((total - unreplied) / total) : null;
      directStores.push({ name: name, unreplied: unreplied, rateVal: rateVal });
    }

    if (directStores.length === 0) return { ok: false, message: "目前無直營店資料或 H 欄皆為 false" };
    directStores.sort(function (a, b) { return b.unreplied - a.unreplied; });

    var totalUnreplied = 0, rateSum = 0, rateCount = 0;
    var lines = ["【店家回覆狀態】"];
    for (var k = 0; k < directStores.length; k++) {
      var s = directStores[k];
      totalUnreplied += s.unreplied;
      var n = s.rateVal != null ? parseFloat(s.rateVal) : NaN;
      if (!isNaN(n)) {
        rateSum += n > 1 ? n : n * 100;
        rateCount++;
      }
      lines.push(s.name + "：未回覆 " + s.unreplied + " 則 | 完成率 " + formatDirectStoreCompletionRate(s.rateVal));
    }
    if (rateCount > 0) {
      lines.push("直營店總未回覆：" + totalUnreplied + " 則 | 平均完成率：" + (rateSum / rateCount).toFixed(1) + "%");
    } else {
      lines.push("直營店總未回覆：" + totalUnreplied + " 則");
    }
    lines.push("https://drive.google.com/drive/folders/14j3NL2pt9ISy66jN6TX2BxnaAquQZTKh?usp=drive_link");
    return { ok: true, text: lines.join("\n") };
  } catch (e) {
    console.warn("[店家回覆狀態] 讀表失敗:", e);
    return { ok: false, message: "無法取得店家回覆狀態，請稍後再試。" };
  }
}

function formatDirectStoreCompletionRate(val) {
  var n = val != null ? parseFloat(val) : NaN;
  if (isNaN(n)) return "—";
  if (n > 1) return n.toFixed(1) + "%";
  return (n * 100).toFixed(1) + "%";
}

/**
 * 依使用者輸入取得報告 handler（供員工打卡等專案呼叫）
 * @param {string} msg - 使用者輸入（會 trim）
 * @returns {string|null} "yesterday" | "tomorrow" | "monthly" | "employee" 或 null
 */
function getReportHandlerFromKeyword(msg) {
  if (!msg || typeof msg !== "string") return null;
  var text = String(msg).trim();
  if (!text) return null;
  for (var i = 0; i < REPORT_KEYWORD_RULES.length; i++) {
    var rule = REPORT_KEYWORD_RULES[i];
    for (var j = 0; j < rule.keywords.length; j++) {
      if (text.indexOf(rule.keywords[j]) !== -1) return rule.handler;
    }
  }
  return null;
}

function writeReportToSheetAndGetLink(ssId, keywordLabel, reportText) {
  if (!ssId) return null;
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName(REPORT_TEMP_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(REPORT_TEMP_SHEET_NAME);
      sheet.appendRow(["時間", "關鍵字", "報告內容"]);
    }
    var timeStr = Utilities.formatDate(new Date(), REPORT_HELPERS_TZ, "yyyy-MM-dd HH:mm:ss");
    sheet.appendRow([timeStr, keywordLabel, reportText]);
    return ss.getUrl() + "#gid=" + sheet.getSheetId();
  } catch (e) {
    console.warn("[Core] writeReportToSheetAndGetLink:", e);
    return null;
  }
}

/**
 * 依關鍵字類型產出報告文字或試算表連結（供員工打卡等專案呼叫）
 * 報告過長（> REPORT_MAX_REPLY_LEN）時會寫入試算表並回傳連結
 * @param {string} handler - "yesterday" | "tomorrow" | "monthly" | "employee"
 * @param {Object} [options] - { reportSsId: "試算表ID" } 不傳則用 getCoreConfig().LINE_STORE_SS_ID
 * @returns {{ text: string, sheetLink?: string }}
 */
function filterByStoreIds(byStore, managedStoreIds) {
  if (!managedStoreIds || managedStoreIds.length === 0) return [];
  var ids = managedStoreIds.map(function (id) { return String(id).trim(); });
  return byStore.filter(function (b) {
    var sid = String(b.storeId || "").trim();
    var sname = (b.storeName || "").trim();
    for (var j = 0; j < ids.length; j++) {
      if (ids[j] === sid || ids[j] === sname) return true;
    }
    return false;
  });
}

function getReportTextForKeyword(handler, options) {
  // 暫時關閉：報告關鍵字功能（昨日報告、本月報告、上月小費文字版等）不產出內容
  return;

  options = options || {};
  var config = (typeof getCoreConfig === "function") ? getCoreConfig() : {};
  var reportSsId = options.reportSsId || config.LINE_STORE_SS_ID || null;
  var maxLen = options.maxReplyLen != null ? options.maxReplyLen : REPORT_MAX_REPLY_LEN;
  var managedStoreIds = options.managedStoreIds || [];
  var label = "";
  var text = "";

  if (managedStoreIds.length === 0) {
    return { text: "您無管理門市，無法顯示此報告。請於「管理者清單」設定您的管理門市，或聯繫管理員。" };
  }

  try {
  if (handler === "yesterday") {
    label = "昨日消費報告";
    var res = buildYesterdaySalesReport();
    var byStore = filterByStoreIds(res.byStore || [], managedStoreIds);
    var lines = ["📊 昨日消費報告 " + res.dateStr];
    if (byStore.length > 0) {
      for (var i = 0; i < byStore.length; i++) {
        lines.push("\n" + (byStore[i].reportText || ""));
      }
    } else {
      lines.push("\n（您管理的門市無資料）");
    }
    text = lines.join("\n");
  } else if (handler === "tomorrow") {
    label = "明日預約報告";
    var tmr = buildTomorrowReservationReport();
    var tmrByStore = filterByStoreIds(tmr.byStore || [], managedStoreIds);
    var tmrLines = ["📅 明日預約報告 " + tmr.dateStr];
    if (tmrByStore.length > 0) {
      for (var k = 0; k < tmrByStore.length; k++) {
        tmrLines.push("\n" + (tmrByStore[k].reportText || ""));
      }
    } else {
      tmrLines.push("\n（您管理的門市無資料）");
    }
    text = tmrLines.join("\n");
  } else if (handler === "monthly") {
    label = "本月消費報告";
    var mon = buildMonthlySalesReport();
    var monByStore = filterByStoreIds(mon.byStore || [], managedStoreIds);
    var monLines = ["📊 本月消費報告 " + mon.yearMonth + " (" + mon.startDate + " ~ " + mon.endDate + ")"];
    if (monByStore.length > 0) {
      for (var m = 0; m < monByStore.length; m++) {
        monLines.push("\n" + (monByStore[m].reportText || ""));
      }
    } else {
      monLines.push("\n（您管理的門市無資料）");
    }
    text = monLines.join("\n");
  } else if (handler === "employee") {
    label = "員工每月樣態";
    var empRes = buildMonthlySalesReport();
    var empByStore = filterByStoreIds(empRes.byStore || [], managedStoreIds);
    var link = writeEmployeeMonthlySummaryToSheetFromFiltered(reportSsId, empRes, empByStore);
    var empNote = "\n\n※ 資料來源：SayDou 消費交易「備註／經手人」欄。若某店顯示「當月無交易或無經手人備註」，表示當月無消費或消費單未填經手人。";
    if (link) {
      return { text: "📊 員工每月樣態已產出（僅您管理的門市）。\n請至試算表查看：\n" + link + empNote, sheetLink: link };
    }
    return { text: "📊 員工每月樣態已寫入試算表「員工每月樣態」，請開啟試算表查看。" + empNote };
  } else if (handler === "lastMonthTips") {
    label = "上月小費";
    if (typeof buildLastMonthTipsReport !== "function") {
      text = "上月小費報告功能未就緒（請確認 TipsReport.js 已加入專案）。";
    } else {
      var tipsReport = buildLastMonthTipsReport();
      var tipsRows = tipsReport.rows || [];
      var ids = managedStoreIds.map(function (id) { return String(id).trim(); });
      var filtered = tipsRows.filter(function (r) {
        var sid = (r.門店SayDouId != null && r.門店SayDouId !== "") ? String(r.門店SayDouId).trim() : "";
        if (!sid) return false;
        for (var ki = 0; ki < ids.length; ki++) {
          if (ids[ki] === sid) return true;
        }
        return false;
      });
      var tipLines = ["📋 上月小費 " + (tipsReport.startDate || "") + " ~ " + (tipsReport.endDate || "") + "（您管理的門市）"];
      if (filtered.length > 0) {
        var byStoreName = {};
        for (var fi = 0; fi < filtered.length; fi++) {
          var r = filtered[fi];
          var sn = (r.門店 && String(r.門店).trim()) ? r.門店 : "其他";
          if (!byStoreName[sn]) byStoreName[sn] = [];
          byStoreName[sn].push(r);
        }
        for (var storeKey in byStoreName) {
          tipLines.push("\n【" + storeKey + "】");
          var list = byStoreName[storeKey];
          for (var li = 0; li < list.length; li++) {
            var x = list[li];
            tipLines.push("  " + (x.建立時間 || "") + " " + (x.會員 || "") + " " + (x.手機 || "") + " 小費:" + (x.小費 || "") + " 星數:" + (x.星數 || "") + (x.意見 ? " " + (x.意見.length > 20 ? x.意見.slice(0, 20) + "…" : x.意見) : ""));
          }
        }
      } else {
        tipLines.push("\n（您管理的門市當月無小費／五星好評紀錄）");
      }
      text = tipLines.join("\n");
    }
  } else {
    return { text: "（未知報告類型）" };
  }

  if (text.length > maxLen && reportSsId) {
    var url = writeReportToSheetAndGetLink(reportSsId, label, text);
    if (url) {
      return { text: "📊 " + label + " 資料較多，已寫入試算表：\n" + url, sheetLink: url };
    }
  }
  return { text: text };
  } catch (e) {
    console.warn("[Core] getReportTextForKeyword:", e);
    return { text: "報告產出時發生錯誤（" + (e && e.message ? e.message : String(e)) + "），請稍後再試或聯繫管理員。" };
  }
}

// =============================================================================
// 神美日報：交易明細快取 + 進階課程統計 + 平均客單價
// =============================================================================

var DAILY_REPORT_TX_SHEET_NAME = "神美日報_交易明細";
var DAILY_REPORT_SHARE_SHEET_NAME = "神美日報_心得分享";
var DAILY_REPORT_ACCESS_SHEET_NAME = "神美日報_開啟紀錄";
var DAILY_REPORT_TX_HEADERS = [
  "Key", "Date", "StoreId", "StoreName", "OrderSn", "OrderId", "DetailId",
  "ItemName", "ItemPrice", "EmployeeCode", "EmployeeName", "Remark", "CreatedTime"
];
var DAILY_REPORT_SHARE_HEADERS = [
  "Timestamp", "Date", "EmployeeCode", "EmployeeName", "StoreId", "StoreName",
  "AvgTicket", "OrderCount", "Content", "Approved", "ApprovedBy", "ApprovedAt"
];
var DAILY_REPORT_ACCESS_HEADERS = [
  "Timestamp", "Date", "Role", "UserId", "EmployeeCode", "EmployeeName", "StoreIds", "GroupId", "GroupName", "UserName"
];
var DAILY_REPORT_ADVANCED_KEYS = ["活氧", "逆齡", "頸緻", "嘟唇", "晶淨"];

function getDailyReportSpreadsheet_() {
  var config = (typeof getCoreConfig === "function") ? getCoreConfig() : {};
  var ssId = config.DAILY_ACCOUNT_REPORT_SS_ID || config.LINE_STORE_SS_ID || "";
  if (!ssId) return null;
  try {
    return SpreadsheetApp.openById(ssId);
  } catch (e) {
    console.warn("[Core] getDailyReportSpreadsheet_:", e);
    return null;
  }
}

function getOrCreateReportSheet_(ss, name, headers) {
  if (!ss) return null;
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length) sheet.appendRow(headers);
  }
  return sheet;
}

function getDailyIncomeSheet_() {
  var config = (typeof getCoreConfig === "function") ? getCoreConfig() : {};
  var ssId = config.DAILY_ACCOUNT_REPORT_SS_ID || "";
  if (!ssId) return null;
  try {
    var ss = SpreadsheetApp.openById(ssId);
    return ss.getSheetByName("營收報表");
  } catch (e) {
    console.warn("[Core] getDailyIncomeSheet_:", e);
    return null;
  }
}

function toReportDateStr_(dateStr) {
  if (dateStr && typeof dateStr === "string") return dateStr.trim();
  var tz = REPORT_HELPERS_TZ || "Asia/Taipei";
  return Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
}

function isTipItem_(itemName) {
  if (!itemName) return false;
  var name = String(itemName);
  return name.indexOf("小費") >= 0 || name.indexOf("儲值金調整") >= 0;
}

function getAdvancedCourseKey_(itemName) {
  if (!itemName) return null;
  var name = String(itemName);
  for (var i = 0; i < DAILY_REPORT_ADVANCED_KEYS.length; i++) {
    if (name.indexOf(DAILY_REPORT_ADVANCED_KEYS[i]) >= 0) return DAILY_REPORT_ADVANCED_KEYS[i];
  }
  return null;
}

function getItemPrice_(ordd, t) {
  if (ordd && ordd.rprice != null) return Number(ordd.rprice) || 0;
  if (ordd && ordd.price_ != null) return Number(ordd.price_) || 0;
  if (t && t.rprice != null) return Number(t.rprice) || 0;
  if (t && t.price_ != null) return Number(t.price_) || 0;
  return 0;
}

function buildReportKey_(detailId) {
  return String(detailId || "");
}

function normalizeDateCell_(value) {
  if (!value) return "";
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return Utilities.formatDate(value, REPORT_HELPERS_TZ || "Asia/Taipei", "yyyy-MM-dd");
  }
  var s = String(value).trim();
  if (!s) return "";
  s = s.replace(/\//g, "-");
  if (s.length >= 10) return s.slice(0, 10);
  return s;
}

function getExistingRowMap_(sheet) {
  var map = {};
  if (!sheet) return keys;
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return map;
  var values = sheet.getRange(2, 1, lastRow - 1, DAILY_REPORT_TX_HEADERS.length).getValues();
  for (var i = 0; i < values.length; i++) {
    var key = values[i][0];
    if (!key) continue;
    map[String(key)] = { rowIndex: i + 2, values: values[i] };
  }
  return map;
}

function splitEmployeeNames_(nameText) {
  if (!nameText) return [];
  var raw = String(nameText).trim();
  if (!raw) return [];
  return raw.split(/[\/、，,]/).map(function (s) { return String(s).trim(); }).filter(Boolean);
}

function matchEmployeeCodeFromRemark_(remarkText, empMap) {
  if (!remarkText) return "";
  if (!empMap || typeof empMap !== "object") return "";
  var text = String(remarkText).trim().toLowerCase();
  if (!text) return "";
  var codes = Object.keys(empMap);
  codes.sort(function (a, b) { return b.length - a.length; });
  for (var i = 0; i < codes.length; i++) {
    var code = codes[i];
    var needle = code ? String(code).toLowerCase() : "";
    if (needle && text.indexOf(needle) !== -1) return code;
  }
  return "";
}

function normalizeEmployeeFromTransaction_(t, empMap) {
  var rawRemark = (t && t.remark != null) ? String(t.remark).trim() : "";
  var code = matchEmployeeCodeFromRemark_(rawRemark, empMap);
  var name = "";
  if (code && empMap && empMap[code]) name = empMap[code];
  return { code: code || "", name: name || "", remark: rawRemark };
}

function getWorkNames_(ordd) {
  if (!ordd || !ordd.work || !ordd.work.length) return [];
  var out = [];
  for (var i = 0; i < ordd.work.length; i++) {
    var n = ordd.work[i] && ordd.work[i].usrnam ? String(ordd.work[i].usrnam).trim() : "";
    if (n) out.push(n);
  }
  return out;
}

function buildRowsFromTransaction_(dateStr, store, t, empMap) {
  var rows = [];
  if (!t) return rows;
  var orderId = (t.ordcid != null) ? String(t.ordcid) : "";
  var orderSn = (t.ordrsn != null) ? String(t.ordrsn) : "";
  var created = (t.rectim || t.cretim || "");
  var emp = normalizeEmployeeFromTransaction_(t, empMap);
  var details = (t.ordds && t.ordds.length) ? t.ordds : [];
  for (var i = 0; i < details.length; i++) {
    var d = details[i];
    var detailId = (d.orddid != null) ? String(d.orddid) : "";
    var itemName = (d.godnam != null) ? String(d.godnam) : "";
    var itemPrice = getItemPrice_(d, t);
    var key = buildReportKey_(detailId);
    rows.push([
      key,
      dateStr,
      String(store.id || ""),
      normalizeStoreName_(store.id, store.name || ("店" + store.id)),
      orderSn,
      orderId,
      detailId,
      itemName,
      itemPrice,
      emp.code || "",
      emp.name || "",
      (t.remark != null ? String(t.remark) : ""),
      created
    ]);
  }
  return rows;
}

/**
 * 每 30 分鐘同步一次：寫入當天交易明細（避免重複）
 */
function rowsEqual_(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (String(a[i]) !== String(b[i])) return false;
  }
  return true;
}

function syncDailyReportTransactions(dateStr) {
  dateStr = toReportDateStr_(dateStr);
  var ss = getDailyReportSpreadsheet_();
  if (!ss) return { ok: false, message: "無法開啟日報試算表" };
  var sheet = getOrCreateReportSheet_(ss, DAILY_REPORT_TX_SHEET_NAME, DAILY_REPORT_TX_HEADERS);
  if (!sheet) return { ok: false, message: "無法取得交易明細工作表" };
  if (typeof getStoresInfo !== "function" || typeof getTransactionsForStoreByDate !== "function") {
    return { ok: false, message: "缺少 getStoresInfo 或 getTransactionsForStoreByDate" };
  }
  var stores = getStoresInfo();
  var empMap = (typeof getEmployeeCodeToNameMap === "function") ? getEmployeeCodeToNameMap() : {};
  var existingMap = getExistingRowMap_(sheet);
  var appendRows = [];
  var updateRows = [];
  for (var i = 0; i < stores.length; i++) {
    var store = stores[i];
    var transactions = getTransactionsForStoreByDate(store.id, dateStr);
    for (var j = 0; j < transactions.length; j++) {
      var rows = buildRowsFromTransaction_(dateStr, store, transactions[j], empMap);
      for (var k = 0; k < rows.length; k++) {
        var key = rows[k][0];
        var existing = existingMap[key];
        if (!existing) {
          existingMap[key] = { rowIndex: -1, values: rows[k] };
          appendRows.push(rows[k]);
          continue;
        }
        if (!rowsEqual_(existing.values, rows[k])) {
          updateRows.push({ rowIndex: existing.rowIndex, values: rows[k] });
          existing.values = rows[k];
        }
      }
    }
  }
  if (appendRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, appendRows.length, DAILY_REPORT_TX_HEADERS.length).setValues(appendRows);
  }
  for (var u = 0; u < updateRows.length; u++) {
    var row = updateRows[u];
    if (row.rowIndex > 0) {
      sheet.getRange(row.rowIndex, 1, 1, DAILY_REPORT_TX_HEADERS.length).setValues([row.values]);
    }
  }
  return { ok: true, dateStr: dateStr, added: appendRows.length, updated: updateRows.length };
}

function readDailyReportRows_(dateStr) {
  dateStr = toReportDateStr_(dateStr);
  var ss = getDailyReportSpreadsheet_();
  if (!ss) return [];
  var sheet = getOrCreateReportSheet_(ss, DAILY_REPORT_TX_SHEET_NAME, DAILY_REPORT_TX_HEADERS);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, DAILY_REPORT_TX_HEADERS.length).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var rowDate = normalizeDateCell_(values[i][1]);
    if (rowDate !== dateStr) continue;
    rows.push(values[i]);
  }
  return rows;
}

function readDailyReportRowsByDateRange_(startDate, endDate) {
  var ss = getDailyReportSpreadsheet_();
  if (!ss) return [];
  var sheet = getOrCreateReportSheet_(ss, DAILY_REPORT_TX_SHEET_NAME, DAILY_REPORT_TX_HEADERS);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, DAILY_REPORT_TX_HEADERS.length).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var d = normalizeDateCell_(values[i][1]);
    if (d && d >= startDate && d <= endDate) rows.push(values[i]);
  }
  return rows;
}

function loadDailyIncomeMapForDate_(dateStr) {
  var sheet = getDailyIncomeSheet_();
  if (!sheet) return {};
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return {};
  var values = sheet.getRange(2, 2, lastRow - 1, 11).getValues();
  var map = {};
  for (var i = 0; i < values.length; i++) {
    var rowDate = normalizeDateCell_(values[i][0]);
    if (rowDate !== dateStr) continue;
    var storeName = String(values[i][1] || "").trim();
    if (!storeName) continue;
    var summary = {
      cashTotal: Number(values[i][2] || 0),
      cashBusiness: Number(values[i][3] || 0),
      cashUnearn: Number(values[i][4] || 0),
      thirdPayTotal: Number(values[i][5] || 0),
      transferRecord: Number(values[i][6] || 0),
      lineRecord: Number(values[i][7] || 0),
      transferUnearn: Number(values[i][8] || 0),
      lineUnearn: Number(values[i][9] || 0),
      todayService: Number(values[i][10] || 0)
    };
    map[storeName] = summary;
  }
  return map;
}

function buildStoreNameToIdMap_() {
  if (typeof getStoresInfo !== "function") return {};
  var stores = getStoresInfo() || [];
  var map = {};
  for (var i = 0; i < stores.length; i++) {
    var name = String(stores[i].name || "").trim();
    if (String(stores[i].id || "") === "2862") name = "左營海軍";
    if (name) map[name] = String(stores[i].id || "");
  }
  return map;
}

function normalizeStoreName_(storeId, storeName) {
  if (String(storeId || "") === "2862") return "左營海軍";
  return storeName || "";
}

function resolveIncomeSummary_(incomeMap, storeName) {
  if (!incomeMap || !storeName) return null;
  if (incomeMap[storeName]) return incomeMap[storeName];
  var keys = Object.keys(incomeMap);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!k) continue;
    if (k.indexOf(storeName) >= 0 || storeName.indexOf(k) >= 0) return incomeMap[k];
  }
  return null;
}

function computeAggregatesFromRows_(rows, storeIds) {
  var storeSet = null;
  if (storeIds && storeIds.length) {
    storeSet = {};
    for (var i = 0; i < storeIds.length; i++) {
      var key = String(storeIds[i]).trim();
      if (key) storeSet[key] = true;
    }
  }
  var empMap = (typeof getEmployeeCodeToNameMap === "function") ? getEmployeeCodeToNameMap() : {};
  var storeMap = {};
  var orderTotals = {};
  var orderEmployees = {};
  var orderIdSetByStore = {};
  var orderTotalsByStore = {};
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var storeId = String(row[2] || "");
    var storeName = String(row[3] || ("店" + storeId));
    if (storeSet && !storeSet[storeId] && !storeSet[storeName]) continue;
    var orderId = String(row[5] || "");
    var itemName = String(row[7] || "");
    var itemPrice = Number(row[8] || 0);
    var empCode = String(row[9] || "");
    var advKey = getAdvancedCourseKey_(itemName);
    if (!storeMap[storeId]) {
      storeMap[storeId] = {
        storeId: storeId,
        storeName: storeName,
        advancedCounts: {},
        employeeAdvancedCounts: {},
        totalNoTip: 0,
        orderCount: 0
      };
    }
    var storeBlock = storeMap[storeId];

    var orderKey = storeId + "|" + orderId;
    if (!orderTotals[orderKey]) orderTotals[orderKey] = 0;
    if (!orderEmployees[orderKey]) orderEmployees[orderKey] = {};
    if (!orderIdSetByStore[storeId]) orderIdSetByStore[storeId] = {};
    if (orderId) orderIdSetByStore[storeId][orderId] = true;
    if (!orderTotalsByStore[storeId]) orderTotalsByStore[storeId] = {};
    if (!orderTotalsByStore[storeId][orderId]) orderTotalsByStore[storeId][orderId] = 0;

    if (!isTipItem_(itemName)) {
      orderTotals[orderKey] += itemPrice;
      orderTotalsByStore[storeId][orderId] += itemPrice;
    }
    var empKeys = [];
    if (empCode) empKeys.push(empCode);
    for (var e = 0; e < empKeys.length; e++) {
      orderEmployees[orderKey][empKeys[e]] = true;
    }

    if (advKey) {
      storeBlock.advancedCounts[advKey] = (storeBlock.advancedCounts[advKey] || 0) + 1;
      if (empKeys.length) {
        for (var k = 0; k < empKeys.length; k++) {
          var empId = empKeys[k];
          var displayName = (empMap && empMap[empId]) ? empMap[empId] : empId;
          if (!storeBlock.employeeAdvancedCounts[displayName]) storeBlock.employeeAdvancedCounts[displayName] = {};
          storeBlock.employeeAdvancedCounts[displayName][advKey] = (storeBlock.employeeAdvancedCounts[displayName][advKey] || 0) + 1;
        }
      }
    }
  }

  // 計算平均客單
  var storeIdsList = Object.keys(storeMap);
  for (var s = 0; s < storeIdsList.length; s++) {
    var sid = storeIdsList[s];
    var block = storeMap[sid];
    var total = 0;
    var count = 0;
    var storeOrders = orderTotalsByStore[sid] || {};
    var orderKeys = Object.keys(storeOrders);
    for (var i = 0; i < orderKeys.length; i++) {
      var amt = storeOrders[orderKeys[i]] || 0;
      total += amt;
      if (amt > 0) count++;
    }
    block.totalNoTip = total;
    block.orderCount = count;
    block.avgTicket = count > 0 ? Math.round((total / count) * 100) / 100 : 0;
  }

  return { storeMap: storeMap, orderTotals: orderTotals, orderEmployees: orderEmployees };
}

function computeTopCoursesByStore_(storeMap, limit) {
  var max = limit != null ? limit : 5;
  var result = {};
  for (var i = 0; i < DAILY_REPORT_ADVANCED_KEYS.length; i++) {
    var key = DAILY_REPORT_ADVANCED_KEYS[i];
    result[key] = [];
  }
  for (var storeId in storeMap) {
    var block = storeMap[storeId];
    for (var j = 0; j < DAILY_REPORT_ADVANCED_KEYS.length; j++) {
      var k = DAILY_REPORT_ADVANCED_KEYS[j];
      var cnt = block.advancedCounts[k] || 0;
      if (cnt > 0) {
        result[k].push({ storeId: storeId, storeName: normalizeStoreName_(storeId, block.storeName), count: cnt });
      }
    }
  }
  for (var key2 in result) {
    result[key2].sort(function (a, b) { return b.count - a.count; });
    result[key2] = result[key2].slice(0, max);
  }
  return result;
}

function computeTopAvgTicketEmployees_(rows) {
  var empMap = (typeof getEmployeeCodeToNameMap === "function") ? getEmployeeCodeToNameMap() : {};
  var orderTotals = {};
  var orderEmployees = {};
  var orderStore = {};
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var storeId = String(row[2] || "");
    var storeName = String(row[3] || ("店" + storeId));
    var orderId = String(row[5] || "");
    var itemName = String(row[7] || "");
    var itemPrice = Number(row[8] || 0);
    var remark = String(row[11] || "");
    var empCode = matchEmployeeCodeFromRemark_(remark, empMap);
    var orderKey = storeId + "|" + orderId;
    if (!orderTotals[orderKey]) orderTotals[orderKey] = 0;
    if (!orderEmployees[orderKey]) orderEmployees[orderKey] = {};
    orderStore[orderKey] = { storeId: storeId, storeName: storeName };
    if (!isTipItem_(itemName)) {
      orderTotals[orderKey] += itemPrice;
    }
    if (empCode) orderEmployees[orderKey][empCode] = true;
  }

  var empTotals = {};
  var empCounts = {};
  var empStores = {};
  for (var orderKey in orderTotals) {
    var total = orderTotals[orderKey] || 0;
    if (total <= 0) continue;
    var employees = orderEmployees[orderKey] || {};
    for (var empKey in employees) {
      if (!empTotals[empKey]) empTotals[empKey] = 0;
      if (!empCounts[empKey]) empCounts[empKey] = 0;
      if (!empStores[empKey]) empStores[empKey] = {};
      empTotals[empKey] += total;
      empCounts[empKey] += 1;
      var storeInfo = orderStore[orderKey];
      if (storeInfo && storeInfo.storeName) empStores[empKey][storeInfo.storeName] = true;
    }
  }

  var out = [];
  for (var emp in empTotals) {
    var avg = empCounts[emp] ? (empTotals[emp] / empCounts[emp]) : 0;
    out.push({
      employeeCode: emp,
      employeeName: empMap && empMap[emp] ? empMap[emp] : "",
      avgTicket: Math.round(avg * 100) / 100,
      orderCount: empCounts[emp] || 0,
      stores: Object.keys(empStores[emp] || {})
    });
  }
  out.sort(function (a, b) { return b.avgTicket - a.avgTicket; });
  return out.slice(0, 5);
}

function computeGlobalTicketFromRows_(rows) {
  var orderTotals = {};
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var storeId = String(row[2] || "");
    var orderId = String(row[5] || "");
    var itemName = String(row[7] || "");
    var itemPrice = Number(row[8] || 0);
    if (isTipItem_(itemName)) continue;
    var orderKey = storeId + "|" + orderId;
    if (!orderTotals[orderKey]) orderTotals[orderKey] = 0;
    orderTotals[orderKey] += itemPrice;
  }
  var total = 0;
  var count = 0;
  for (var key in orderTotals) {
    var amt = orderTotals[key] || 0;
    total += amt;
    if (amt > 0) count++;
  }
  var avg = count > 0 ? Math.round((total / count) * 100) / 100 : 0;
  return { total: total, orderCount: count, avgTicket: avg };
}

function buildDailyReportPayload(dateStr, storeIds) {
  dateStr = toReportDateStr_(dateStr);
  var rows = readDailyReportRows_(dateStr);
  var agg = computeAggregatesFromRows_(rows, storeIds);
  var aggAll = computeAggregatesFromRows_(rows, null);
  var incomeMap = loadDailyIncomeMapForDate_(dateStr);
  var storeNameToId = buildStoreNameToIdMap_();
  var storeList = [];
  for (var sid in agg.storeMap) {
    var b = agg.storeMap[sid];
    storeList.push({
      storeId: b.storeId,
      storeName: normalizeStoreName_(b.storeId, b.storeName),
      advancedCounts: b.advancedCounts,
      avgTicket: b.avgTicket || 0,
      orderCount: b.orderCount || 0,
      employeeAdvancedCounts: b.employeeAdvancedCounts,
      paymentSummary: resolveIncomeSummary_(incomeMap, normalizeStoreName_(b.storeId, b.storeName))
    });
  }
  if (incomeMap && storeNameToId) {
    for (var storeName in incomeMap) {
      var mappedId = storeNameToId[storeName] || "";
      var exists = false;
      for (var i = 0; i < storeList.length; i++) {
        if (storeList[i].storeName === storeName || (mappedId && storeList[i].storeId === mappedId)) {
          if (!storeList[i].paymentSummary) storeList[i].paymentSummary = incomeMap[storeName];
          exists = true;
          break;
        }
      }
      if (!exists) {
        storeList.push({
          storeId: mappedId,
          storeName: normalizeStoreName_(mappedId, storeName),
          advancedCounts: {},
          avgTicket: 0,
          orderCount: 0,
          employeeAdvancedCounts: {},
          paymentSummary: incomeMap[storeName]
        });
      }
    }
  }
  var global = computeGlobalTicketFromRows_(rows);
  return {
    dateStr: dateStr,
    stores: storeList,
    topCourses: computeTopCoursesByStore_(aggAll.storeMap),
    topAvgTicketEmployees: computeTopAvgTicketEmployees_(rows),
    globalAvgTicket: global.avgTicket
  };
}

function buildMonthlyDailyReportPayload(year, month, storeIds) {
  var now = new Date();
  var y = year != null ? year : now.getFullYear();
  var m = month != null ? month : (now.getMonth() + 1);
  var range = getMonthDateRange(y, m);
  var rows = readDailyReportRowsByDateRange_(range.startDate, range.endDate);
  var byDate = {};
  for (var i = 0; i < rows.length; i++) {
    var d = String(rows[i][1] || "");
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(rows[i]);
  }
  var dates = Object.keys(byDate).sort();
  var list = [];
  for (var k = 0; k < dates.length; k++) {
    var dateStr = dates[k];
    var agg = computeAggregatesFromRows_(byDate[dateStr], storeIds);
    var aggAll = computeAggregatesFromRows_(byDate[dateStr], null);
    var incomeMap = loadDailyIncomeMapForDate_(dateStr);
    var storeNameToId = buildStoreNameToIdMap_();
    var storeList = [];
    for (var sid in agg.storeMap) {
      var b = agg.storeMap[sid];
      storeList.push({
        storeId: b.storeId,
        storeName: normalizeStoreName_(b.storeId, b.storeName),
        advancedCounts: b.advancedCounts,
        avgTicket: b.avgTicket || 0,
        orderCount: b.orderCount || 0,
        employeeAdvancedCounts: b.employeeAdvancedCounts,
        paymentSummary: resolveIncomeSummary_(incomeMap, normalizeStoreName_(b.storeId, b.storeName))
      });
    }
    if (incomeMap && storeNameToId) {
      for (var storeName in incomeMap) {
        var mappedId = storeNameToId[storeName] || "";
        var exists = false;
        for (var i = 0; i < storeList.length; i++) {
          if (storeList[i].storeName === storeName || (mappedId && storeList[i].storeId === mappedId)) {
            if (!storeList[i].paymentSummary) storeList[i].paymentSummary = incomeMap[storeName];
            exists = true;
            break;
          }
        }
        if (!exists) {
          storeList.push({
            storeId: mappedId,
            storeName: normalizeStoreName_(mappedId, storeName),
            advancedCounts: {},
            avgTicket: 0,
            orderCount: 0,
            employeeAdvancedCounts: {},
            paymentSummary: incomeMap[storeName]
          });
        }
      }
    }
    var global = computeGlobalTicketFromRows_(byDate[dateStr]);
    list.push({
      dateStr: dateStr,
      stores: storeList,
      topCourses: computeTopCoursesByStore_(aggAll.storeMap),
      globalAvgTicket: global.avgTicket
    });
  }
  return {
    yearMonth: range.yearMonth,
    startDate: range.startDate,
    endDate: range.endDate,
    daily: list
  };
}

function writeDailyReportShare(sessionData, content) {
  var ss = getDailyReportSpreadsheet_();
  if (!ss) return { ok: false, message: "無法開啟日報試算表" };
  var sheet = getOrCreateReportSheet_(ss, DAILY_REPORT_SHARE_SHEET_NAME, DAILY_REPORT_SHARE_HEADERS);
  if (!sheet) return { ok: false, message: "無法取得分享工作表" };
  var nowStr = Utilities.formatDate(new Date(), REPORT_HELPERS_TZ || "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
  sheet.appendRow([
    nowStr,
    sessionData.dateStr || "",
    sessionData.employeeCode || "",
    sessionData.employeeName || "",
    sessionData.storeId || "",
    sessionData.storeName || "",
    sessionData.avgTicket || 0,
    sessionData.orderCount || 0,
    String(content || "").trim(),
    "",
    "",
    ""
  ]);
  return { ok: true };
}

function writeDailyReportAccessLog(payload) {
  var ss = getDailyReportSpreadsheet_();
  if (!ss) return { ok: false, message: "無法開啟日報試算表" };
  var sheet = getOrCreateReportSheet_(ss, DAILY_REPORT_ACCESS_SHEET_NAME, DAILY_REPORT_ACCESS_HEADERS);
  if (!sheet) return { ok: false, message: "無法取得開啟紀錄工作表" };
  var numCols = DAILY_REPORT_ACCESS_HEADERS.length;
  if (sheet.getLastRow() >= 1) {
    var headerRange = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), numCols));
    var headerVals = headerRange.getValues()[0];
    while (headerVals.length < numCols) headerVals.push("");
    if (headerVals[7] !== "GroupId") headerVals[7] = "GroupId";
    if (headerVals[8] !== "GroupName") headerVals[8] = "GroupName";
    if (headerVals[9] !== "UserName") headerVals[9] = "UserName";
    sheet.getRange(1, 1, 1, headerVals.length).setValues([headerVals]);
  }
  var nowStr = Utilities.formatDate(new Date(), REPORT_HELPERS_TZ || "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
  sheet.appendRow([
    nowStr,
    payload.dateStr || "",
    payload.role || "",
    payload.userId || "",
    payload.employeeCode || "",
    payload.employeeName || "",
    (payload.storeIds || []).join(","),
    payload.groupId || "",
    payload.groupName || "",
    payload.userName || ""
  ]);
  return { ok: true };
}

/**
 * 排程用：每 30 分鐘同步當天日帳交易到快取表
 */
function runDailyReportSync() {
  return syncDailyReportTransactions();
}

/**
 * 一次性設定：建立每 30 分鐘觸發器
 * 若已存在則先清除，避免重複觸發
 */
function setupDailyReportTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "runDailyReportSync") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("runDailyReportSync")
    .timeBased()
    .everyMinutes(30)
    .create();
  return "ok";
}

/**
 * Debug：檢查當日日報資料是否可產出
 */
function debugDailyReportFlow(dateStr) {
  var targetDate = toReportDateStr_(dateStr);
  var syncResult = syncDailyReportTransactions(targetDate);
  var payload = buildDailyReportPayload(targetDate, null);
  Logger.log("[DailyReport] sync=" + JSON.stringify(syncResult));
  Logger.log("[DailyReport] stores=" + (payload.stores ? payload.stores.length : 0));
  Logger.log("[DailyReport] topCourses=" + JSON.stringify(payload.topCourses));
  Logger.log("[DailyReport] topAvg=" + JSON.stringify(payload.topAvgTicketEmployees));
  return payload;
}

/**
 * Debug：檢查當月日報清單是否可產出
 */
function debugMonthlyReportFlow(year, month) {
  var payload = buildMonthlyDailyReportPayload(year, month, null);
  Logger.log("[MonthlyReport] yearMonth=" + payload.yearMonth + " daily=" + (payload.daily ? payload.daily.length : 0));
  return payload;
}
