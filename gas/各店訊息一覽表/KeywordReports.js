/**
 * 關鍵字產報告：使用者傳關鍵字 → Reply 報告（不 Push）。
 * 資料過長則寫入試算表並 Reply 試算表連結。
 * 參考員工打卡 Line@ 的 keyword / reply 流程。
 */

var KEYWORD_REPORT_CONFIG = {
  /** Reply 單則上限（字元），超過則改寫入試算表並回傳連結 */
  MAX_REPLY_LEN: 4500,
  /** 關鍵字報告暫存工作表名稱 */
  TEMP_SHEET_NAME: "關鍵字報告暫存",
  /** 試算表 ID（與報表同份） */
  getReportSsId: function () {
    return (typeof YESTERDAY_SALES_CONFIG !== "undefined" && YESTERDAY_SALES_CONFIG.REPORT_SS_ID) ||
      (typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID) || null;
  }
};

/**
 * 關鍵字對應報告類型（任一關鍵字即觸發）
 */
var REPORT_KEYWORD_RULES = [
  { keywords: ["昨日報告", "昨日消費", "昨日"], handler: "yesterday", label: "昨日消費報告" },
  { keywords: ["明日預約", "明日預約報告", "明日"], handler: "tomorrow", label: "明日預約報告" },
  { keywords: ["本月報告", "本月消費", "月報"], handler: "monthly", label: "本月消費報告" },
  { keywords: ["員工樣態", "員工月報", "員工每月"], handler: "employee", label: "員工每月樣態" }
];

/**
 * 檢查訊息是否為報告關鍵字，回傳對應規則或 null
 * @param {string} msg - 使用者輸入（會 trim）
 * @returns {Object|null} { handler, label, keywords } 或 null
 */
function matchReportKeyword(msg) {
  if (!msg || typeof msg !== "string") return null;
  var text = msg.trim();
  if (!text) return null;
  for (var i = 0; i < REPORT_KEYWORD_RULES.length; i++) {
    var rule = REPORT_KEYWORD_RULES[i];
    for (var j = 0; j < rule.keywords.length; j++) {
      if (text.indexOf(rule.keywords[j]) !== -1) return rule;
    }
  }
  return null;
}

/**
 * 依 handler 產出報告文字
 * @param {string} handler - "yesterday" | "tomorrow" | "monthly" | "employee"
 * @returns {string} 報告全文
 */
function getReportTextByHandler(handler) {
  var lines = [];
  if (handler === "yesterday") {
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    var dateStr = Utilities.formatDate(yesterday, "Asia/Taipei", "yyyy-MM-dd");
    var result = buildYesterdaySalesReport(dateStr);
    lines.push("📊 昨日消費報告 " + result.dateStr);
    if (result.byStore && result.byStore.length > 0) {
      for (var i = 0; i < result.byStore.length; i++) {
        lines.push("\n" + (result.byStore[i].reportText || ""));
      }
    } else {
      lines.push("\n（無資料）");
    }
    return lines.join("\n");
  }
  if (handler === "tomorrow") {
    var tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    var tomorrowStr = Utilities.formatDate(tomorrow, "Asia/Taipei", "yyyy-MM-dd");
    var res = buildTomorrowReservationReport(tomorrowStr);
    lines.push("📅 明日預約報告 " + res.dateStr);
    if (res.byStore && res.byStore.length > 0) {
      for (var k = 0; k < res.byStore.length; k++) {
        lines.push("\n" + (res.byStore[k].reportText || ""));
      }
    } else {
      lines.push("\n（無資料）");
    }
    return lines.join("\n");
  }
  if (handler === "monthly") {
    var monthly = buildMonthlySalesReport();
    lines.push("📊 本月消費報告 " + monthly.yearMonth + " (" + monthly.startDate + " ~ " + monthly.endDate + ")");
    if (monthly.byStore && monthly.byStore.length > 0) {
      for (var m = 0; m < monthly.byStore.length; m++) {
        lines.push("\n" + (monthly.byStore[m].reportText || ""));
      }
    } else {
      lines.push("\n（無資料）");
    }
    return lines.join("\n");
  }
  if (handler === "employee") {
    var empRes = buildMonthlySalesReport();
    writeEmployeeMonthlySummaryToSheet(empRes);
    var url = getEmployeeMonthlySheetLink();
    if (url) return "📊 員工每月樣態已產出。\n資料較多，請至試算表查看：\n" + url;
    return "📊 員工每月樣態已寫入試算表「員工每月樣態」，請開啟試算表查看。";
  }
  return "（未知報告類型）";
}

/**
 * 將報告寫入試算表「關鍵字報告暫存」並回傳連結
 * @param {string} keywordLabel - 關鍵字標籤（例：昨日消費報告）
 * @param {string} reportText - 報告全文
 * @returns {string} 試算表連結
 */
function writeReportToSheetAndGetLink(keywordLabel, reportText) {
  var ssId = KEYWORD_REPORT_CONFIG.getReportSsId();
  if (!ssId) return "(無法取得試算表)";
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName(KEYWORD_REPORT_CONFIG.TEMP_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(KEYWORD_REPORT_CONFIG.TEMP_SHEET_NAME);
      sheet.appendRow(["時間", "關鍵字", "報告內容"]);
    }
    var timeStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
    sheet.appendRow([timeStr, keywordLabel, reportText]);
    var url = ss.getUrl() + "#gid=" + sheet.getSheetId();
    return url;
  } catch (e) {
    console.warn("writeReportToSheetAndGetLink:", e);
    return "(寫入失敗)";
  }
}

/**
 * 取得「員工每月樣態」試算表連結（供員工樣態關鍵字用）
 */
function getEmployeeMonthlySheetLink() {
  var ssId = KEYWORD_REPORT_CONFIG.getReportSsId();
  if (!ssId) return null;
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName("員工每月樣態");
    if (sheet) return ss.getUrl() + "#gid=" + sheet.getSheetId();
  } catch (e) {}
  return null;
}

/**
 * 處理報告關鍵字：產出報告，若過長則寫入試算表並 Reply 連結，否則 Reply 報告文字
 * @param {string} replyToken - LINE replyToken
 * @param {string} msg - 使用者輸入
 * @param {string} token - LINE Channel Access Token
 * @returns {boolean} 是否已處理（已 reply）
 */
function handleReportKeyword(replyToken, msg, token) {
  var rule = matchReportKeyword(msg);
  if (!rule) return false;
  if (!token) {
    var config = typeof Core !== "undefined" && typeof Core.getCoreConfig === "function" ? Core.getCoreConfig() : null;
    token = config ? config.LINE_TOKEN_PAOSTAFF : null;
  }
  if (!token) {
    console.warn("handleReportKeyword: 無 LINE token，略過 reply");
    return true;
  }
  try {
    var text = getReportTextByHandler(rule.handler);
    var maxLen = KEYWORD_REPORT_CONFIG.MAX_REPLY_LEN;
    if (text.length > maxLen && rule.handler !== "employee") {
      var url = writeReportToSheetAndGetLink(rule.label, text);
      text = "📊 " + rule.label + " 資料較多，已寫入試算表：\n" + url;
    }
    if (typeof Core !== "undefined" && typeof Core.sendLineReply === "function") {
      Core.sendLineReply(replyToken, text, token);
    }
    return true;
  } catch (e) {
    console.warn("handleReportKeyword 失敗:", e);
    if (typeof Core !== "undefined" && typeof Core.sendLineReply === "function") {
      Core.sendLineReply(replyToken, "產出報告時發生錯誤，請稍後再試或聯繫管理員。", token);
    }
    return true;
  }
}
