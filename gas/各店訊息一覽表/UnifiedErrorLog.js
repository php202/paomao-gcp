/**
 * 統一錯誤紀錄：將各專案錯誤寫入訊息一覽表試算表的「錯誤紀錄」工作表。
 * 欄位：時間、來源、錯誤訊息、上下文
 *
 * 使用方式：
 * - 各店訊息一覽表：appendErrorLog(message, context) → 來源「各店訊息一覽表」
 * - 泡泡貓 員工打卡 Line@：logErrorToSheet(userId, userMessage, error) → 來源「泡泡貓 員工打卡 Line@」
 * - 泡泡貓 門市 預約表單 PAOPAO：appendErrorLog(message, context) → 來源「泡泡貓 門市 預約表單 PAOPAO」
 */
const UNIFIED_ERROR_LOG_SHEET_NAME = "錯誤紀錄";
var UNIFIED_ERROR_LOG_HEADERS = ["時間", "來源", "錯誤訊息", "上下文"];

/**
 * 取得統一錯誤紀錄的試算表 ID（訊息一覽表）
 * @returns {string}
 */
function getUnifiedErrorLogSsId() {
  if (typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID) {
    return CONFIG.INTEGRATED_SHEET_SS_ID;
  }
  return "1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0";
}

/**
 * 寫入統一錯誤紀錄表
 * @param {string} source 來源（例：「各店訊息一覽表」「泡泡貓 員工打卡 Line@」「泡泡貓 門市 預約表單 PAOPAO」）
 * @param {string} message 錯誤訊息
 * @param {string} [context] 上下文或備註（可選）
 */
function appendUnifiedErrorLog(source, message, context) {
  try {
    var ssId = getUnifiedErrorLogSsId();
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName(UNIFIED_ERROR_LOG_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(UNIFIED_ERROR_LOG_SHEET_NAME);
      sheet.appendRow(UNIFIED_ERROR_LOG_HEADERS);
      sheet.setColumnWidth(1, 150);
      sheet.setColumnWidth(2, 120);
      sheet.setColumnWidth(3, 300);
      sheet.setColumnWidth(4, 250);
    }
    var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
    sheet.appendRow([
      now,
      String(source || "").slice(0, 80),
      String(message || "").slice(0, 2000),
      String(context || "").slice(0, 500)
    ]);
  } catch (err) {
    Logger.log("appendUnifiedErrorLog 寫入失敗: " + err);
  }
}
