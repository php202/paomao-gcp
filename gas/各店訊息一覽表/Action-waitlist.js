/**
 * 候補清單：新工作表「候補清單」、店家 ID = 店家基本資料 F 欄。
 * API: getWaitlist, addWaitlist, markWaitlistPushed, markWaitlistDone, markWaitlistHandled.
 * 排程: runWaitlistAutoPush（每日 22:00）、結算寫入店家基本資料 M 欄（候補追蹤率）。
 */

var WAITLIST_HEADERS = ["店家ID", "日期", "userId", "狀態", "建立時間", "時段", "人數", "處理人", "姓名", "處理時間", "備註"];
var WAITLIST_STATUS_PENDING = "pending";
var WAITLIST_STATUS_PUSHED = "pushed";
var WAITLIST_STATUS_AUTO_PUSHED = "auto_pushed";
var WAITLIST_STATUS_DONE = "done";
var WAITLIST_STATUS_HANDLED = "handled";

/** 依候補日期與時段產出 Push 開頭文案（MM/DD HH:mm）；時段僅在為 HH:mm 格式時顯示 */
function getWaitlistPushPrefix(waitlistDateStr, timeStr) {
  var tz = "Asia/Taipei";
  var mmdd = "";
  if (waitlistDateStr) {
    var s = String(waitlistDateStr).trim().replace(/\//g, "-");
    if (s.length >= 10) mmdd = s.substring(5, 7) + "/" + s.substring(8, 10);
    else mmdd = s;
  }
  var hhmm = (timeStr && isTimeLike(timeStr)) ? String(timeStr).trim().substring(0, 5) : "";
  var part = hhmm ? mmdd + " " + hhmm : mmdd;
  return "真是抱歉今天的候補（" + part + "）沒有補位上，提供近三天，還有下 1–2 週同一時間的可預約時段：\n\n";
}

/** 取得試算表（一律 openById） */
function getWaitlistSpreadsheet() {
  var ssId = typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID ? CONFIG.INTEGRATED_SHEET_SS_ID : null;
  return ssId ? SpreadsheetApp.openById(ssId) : null;
}

/** 取得或建立「候補清單」工作表；第 1 列為表頭 */
function getWaitlistSheet() {
  var ss = getWaitlistSpreadsheet();
  if (!ss) return null;
  var sheet = ss.getSheetByName("候補清單");
  if (!sheet) {
    sheet = ss.insertSheet("候補清單");
    sheet.appendRow(WAITLIST_HEADERS);
  } else if (sheet.getLastRow() < 1) {
    sheet.appendRow(WAITLIST_HEADERS);
  }
  return sheet;
}

/** 依 botId 從店家基本資料取得店家 ID（F 欄） */
function getStoreIdByBotId(botId) {
  var config = getStoreConfig(botId);
  return config ? String(config.sayId || "").trim() : null;
}

/** 依店家 ID 從店家基本資料取得該列 channelId, channelSecret, botId（供 getSlots / token） */
function getStoreRowBySayId(ss, sayId) {
  if (!ss || !sayId) return null;
  var configSheet = ss.getSheetByName("店家基本資料");
  if (!configSheet) return null;
  var data = configSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var fVal = row[5];
    if (fVal != null && String(fVal).trim() === String(sayId).trim()) {
      return {
        channelId: row[2],
        channelSecret: row[3],
        botId: row[6],
        storeName: row[1]
      };
    }
  }
  return null;
}

/** 驗證日期為 yyyy-MM-dd */
function isValidDateStr(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return false;
  dateStr = dateStr.trim().replace(/\//g, "-");
  var m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  var y = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1, d = parseInt(m[3], 10);
  var date = new Date(y, mo, d);
  return date.getFullYear() === y && date.getMonth() === mo && date.getDate() === d;
}

/** 取得今日 yyyy-MM-dd */
function getTodayStr() {
  var tz = Session.getScriptTimeZone() || "Asia/Taipei";
  return Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
}

// ---------------------------------------------------------------------------
// doGet actions
// ---------------------------------------------------------------------------

/** 判斷是否為 HH:mm 或 HH:mm:ss 格式（才當作時段顯示） */
function isTimeLike(val) {
  if (val == null || String(val).trim() === "") return false;
  return /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(val).trim());
}

/** 將候補一筆的日期＋時段格式為 Asia/Taipei 的 MM-dd HH:mm（不顯示 yyyy）；僅當 時段 為 HH:mm 或日期含時間時才顯示時間 */
function formatWaitlistDisplayDate(dateVal, timeVal) {
  var tz = "Asia/Taipei";
  var datePart = "";
  if (dateVal instanceof Date) {
    datePart = Utilities.formatDate(dateVal, tz, "MM-dd");
  } else if (dateVal != null && String(dateVal).trim() !== "") {
    var s = String(dateVal).trim().replace(/\//g, "-");
    if (s.length >= 10) datePart = s.substring(5, 10);
    else datePart = s;
  }
  var timePart = "";
  if (timeVal != null && isTimeLike(timeVal)) {
    var t = String(timeVal).trim();
    timePart = t.length >= 5 ? t.substring(0, 5) : t;
  } else if (dateVal instanceof Date) {
    var d = dateVal;
    if (d.getHours() > 0 || d.getMinutes() > 0) {
      timePart = Utilities.formatDate(dateVal, tz, "HH:mm");
    }
  }
  return timePart ? datePart + " " + timePart : datePart;
}

/** 取得候補一筆的排序用字串 yyyy-MM-dd HH:mm（僅當 時段 為 HH:mm 時才用，否則 00:00） */
function getWaitlistSortKey(dateVal, timeVal) {
  var dateStr = "";
  if (dateVal instanceof Date) {
    dateStr = Utilities.formatDate(dateVal, "Asia/Taipei", "yyyy-MM-dd");
  } else if (dateVal != null && String(dateVal).trim() !== "") {
    dateStr = String(dateVal).trim().replace(/\//g, "-");
    if (dateStr.length > 10) dateStr = dateStr.substring(0, 10);
  }
  var timeStr = "00:00";
  if (timeVal != null && isTimeLike(timeVal)) {
    var t = String(timeVal).trim();
    timeStr = t.length >= 5 ? t.substring(0, 5) : t;
  } else if (dateVal instanceof Date && (dateVal.getHours() > 0 || dateVal.getMinutes() > 0)) {
    timeStr = Utilities.formatDate(dateVal, "Asia/Taipei", "HH:mm");
  }
  return dateStr + " " + timeStr;
}

/** getWaitlist：以 botId 取得店家 ID，篩選該店家且狀態為 pending（已傳 Push 的 pushed/auto_pushed 不再顯示），回傳陣列含 rowIndex、displayDate、handler，依時間由早到晚排序。 */
function getWaitlist(e) {
  var botId = (e && e.parameter && e.parameter.botId) ? String(e.parameter.botId).trim() : "";
  if (!botId) return Core.jsonResponse({ status: "error", message: "請提供 botId" });

  var storeId = getStoreIdByBotId(botId);
  if (!storeId) return Core.jsonResponse({ status: "error", message: "找不到此 Bot ID 對應的店家" });

  var sheet = getWaitlistSheet();
  if (!sheet) return Core.jsonResponse({ status: "error", message: "無法取得候補清單工作表" });

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return Core.jsonResponse({ status: "success", data: [] });

  var storeIdCol = 0, dateCol = 1, userIdCol = 2, statusCol = 3, createdAtCol = 4, timeCol = 5, peopleCol = 6, handlerCol = 7, nameCol = 8, remarkCol = 10;
  var list = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rowStoreId = row[storeIdCol] != null ? String(row[storeIdCol]).trim() : "";
    var status = row[statusCol] != null ? String(row[statusCol]).trim() : "";
    if (rowStoreId !== storeId) continue;
    if (status !== WAITLIST_STATUS_PENDING) continue;

    var userId = row[userIdCol] != null ? String(row[userIdCol]).trim() : "";
    var displayName = (row.length > nameCol && row[nameCol] != null && String(row[nameCol]).trim() !== "") ? String(row[nameCol]).trim() : userId;
    var dateVal = row[dateCol];
    var timeVal = row[timeCol];
    var peopleVal = (row.length > peopleCol && row[peopleCol] != null && !isNaN(Number(row[peopleCol]))) ? Math.max(1, parseInt(Number(row[peopleCol]), 10)) : 1;
    var displayDate = "";
    var sortKey = "";
    try {
      displayDate = formatWaitlistDisplayDate(dateVal, timeVal);
      sortKey = getWaitlistSortKey(dateVal, timeVal);
    } catch (err) {
      sortKey = String(dateVal || "") + " " + String(timeVal || "");
    }
    var handler = (row.length > handlerCol && row[handlerCol] != null) ? String(row[handlerCol]).trim() : "";
    var remark = (row.length > remarkCol && row[remarkCol] != null && String(row[remarkCol]).trim() !== "") ? String(row[remarkCol]).trim() : "";
    var dateStr = normalizeWaitlistDateStr(dateVal);
    var timeStr = (timeVal != null && isTimeLike(timeVal)) ? String(timeVal).trim().substring(0, 5) : "";
    var todayStr = getTodayStr();
    var slotCheck = (dateStr && dateStr >= todayStr) ? checkSlotAvailableForWaitlist(botId, dateStr, timeStr, peopleVal) : null;
    var slotAvailable = slotCheck != null ? slotCheck.available : null;

    list.push({
      rowIndex: i + 1,
      userId: userId,
      displayName: displayName,
      displayDate: displayDate,
      sortKey: sortKey,
      status: status,
      handler: handler,
      remark: remark,
      people: peopleVal,
      slotAvailable: slotAvailable,
      createdAt: row[createdAtCol],
      time: row[timeCol]
    });
  }

  list.sort(function (a, b) {
    var ka = a.sortKey || "";
    var kb = b.sortKey || "";
    return ka.localeCompare(kb);
  });

  return Core.jsonResponse({ status: "success", data: list });
}

/** addWaitlist：新增一筆候補（店家ID, 日期, userId, pending, 建立時間, 時段, 人數, 處理人, 姓名, 處理時間, 備註） */
function addWaitlist(e) {
  var botId = (e && e.parameter && e.parameter.botId) ? String(e.parameter.botId).trim() : "";
  var dateStr = (e && e.parameter && e.parameter.date) ? String(e.parameter.date).trim().replace(/\//g, "-") : "";
  var userId = (e && e.parameter && e.parameter.userId) ? String(e.parameter.userId).trim() : "";
  var timeStr = (e && e.parameter && e.parameter.time) ? String(e.parameter.time).trim() : "";
  var peopleNum = (e && e.parameter && e.parameter.people != null && !isNaN(Number(e.parameter.people))) ? Math.max(1, parseInt(Number(e.parameter.people), 10)) : 1;
  var nameStr = (e && e.parameter && e.parameter.name != null) ? String(e.parameter.name).trim() : "";
  var remarkStr = (e && e.parameter && e.parameter.remark != null) ? String(e.parameter.remark).trim() : "";

  if (!botId) return Core.jsonResponse({ status: "error", message: "請提供 botId" });
  if (!dateStr || !isValidDateStr(dateStr)) return Core.jsonResponse({ status: "error", message: "請提供有效日期（yyyy-MM-dd）" });
  if (!userId) return Core.jsonResponse({ status: "error", message: "請提供 userId" });

  var storeId = getStoreIdByBotId(botId);
  if (!storeId) return Core.jsonResponse({ status: "error", message: "找不到此 Bot ID 對應的店家" });

  var sheet = getWaitlistSheet();
  if (!sheet) return Core.jsonResponse({ status: "error", message: "無法取得候補清單工作表" });

  var tz = Session.getScriptTimeZone() || "Asia/Taipei";
  var createdAt = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm");
  sheet.appendRow([storeId, dateStr, userId, WAITLIST_STATUS_PENDING, createdAt, timeStr, peopleNum, "", nameStr, "", remarkStr]);

  return Core.jsonResponse({ status: "success", message: "已加入候補清單" });
}

/** markWaitlistDone：依 rowIndex 將該列狀態改為 done，並寫入處理人與處理時間 */
function markWaitlistDone(e) {
  var rowIndex = (e && e.parameter && e.parameter.rowIndex) ? parseInt(String(e.parameter.rowIndex), 10) : 0;
  var operatorName = (e && e.parameter && e.parameter.operator_name != null) ? String(e.parameter.operator_name).trim() : "";
  if (!rowIndex || rowIndex < 2) return Core.jsonResponse({ status: "error", message: "請提供有效的 rowIndex" });

  var sheet = getWaitlistSheet();
  if (!sheet) return Core.jsonResponse({ status: "error", message: "無法取得候補清單工作表" });
  if (sheet.getLastRow() < rowIndex) return Core.jsonResponse({ status: "error", message: "找不到該筆資料" });

  var tz = Session.getScriptTimeZone() || "Asia/Taipei";
  var handledAt = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm");
  sheet.getRange(rowIndex, 4).setValue(WAITLIST_STATUS_DONE);
  if (operatorName) sheet.getRange(rowIndex, 8).setValue(operatorName);
  sheet.getRange(rowIndex, 10).setValue(handledAt);
  return Core.jsonResponse({ status: "success", message: "已標記為已完成預約" });
}

/** markWaitlistHandled：依 rowIndex 將該列狀態改為 handled，並寫入處理人與處理時間 */
function markWaitlistHandled(e) {
  var rowIndex = (e && e.parameter && e.parameter.rowIndex) ? parseInt(String(e.parameter.rowIndex), 10) : 0;
  var operatorName = (e && e.parameter && e.parameter.operator_name != null) ? String(e.parameter.operator_name).trim() : "";
  if (!rowIndex || rowIndex < 2) return Core.jsonResponse({ status: "error", message: "請提供有效的 rowIndex" });

  var sheet = getWaitlistSheet();
  if (!sheet) return Core.jsonResponse({ status: "error", message: "無法取得候補清單工作表" });
  if (sheet.getLastRow() < rowIndex) return Core.jsonResponse({ status: "error", message: "找不到該筆資料" });

  var tz = Session.getScriptTimeZone() || "Asia/Taipei";
  var handledAt = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm");
  sheet.getRange(rowIndex, 4).setValue(WAITLIST_STATUS_HANDLED);
  if (operatorName) sheet.getRange(rowIndex, 8).setValue(operatorName);
  sheet.getRange(rowIndex, 10).setValue(handledAt);
  return Core.jsonResponse({ status: "success", message: "已標記為已處理" });
}

/** 將候補日期正規化為 yyyy-MM-dd 字串（支援 Date 或字串） */
function normalizeWaitlistDateStr(dateVal) {
  if (dateVal == null || dateVal === "") return "";
  if (dateVal instanceof Date) return Utilities.formatDate(dateVal, "Asia/Taipei", "yyyy-MM-dd");
  var s = String(dateVal).trim().replace(/\//g, "-");
  if (s.length >= 10 && s.charAt(4) === "-") return s.substring(0, 10);
  if (s.length >= 10) return s.substring(0, 4) + "-" + s.substring(5, 7) + "-" + s.substring(8, 10);
  return s;
}

/** 偵測該候補日期＋時段＋人數目前是否有空位（隔天課表可能變動）。回傳 { available: true/false }，失敗則 null。 */
function checkSlotAvailableForWaitlist(botId, dateStr, timeStr, people) {
  try {
    var config = getStoreConfig(botId);
    if (!config || !config.sayId) return null;
    var sayId = String(config.sayId);
    var peopleVal = (people != null && !isNaN(Number(people))) ? Math.max(1, parseInt(Number(people), 10)) : 1;
    var opts = { startDate: dateStr, endDate: dateStr, people: peopleVal, duration: 1.5, weekDays: "" };
    if (timeStr && isTimeLike(timeStr)) {
      var t = String(timeStr).trim().substring(0, 5);
      opts.timeStart = t;
      opts.timeEnd = t;
    }
    var text = cleanData(sayId, opts);
    if (!text || typeof text !== "string") return null;
    var hasSlots = text.indexOf("（無）") < 0;
    return { available: hasSlots };
  } catch (err) {
    Logger.log("checkSlotAvailableForWaitlist error: " + (err && err.message ? err.message : err));
    return null;
  }
}

/** 產出候補 Push 用的空位文字：近三天 + 下 1–2 週同一時段（依候補人數查可預約空位）。people 預設 1。 */
function getSlotsTextForWaitlist(botId, waitlistDateStr, timeStr, people) {
  var tz = Session.getScriptTimeZone() || "Asia/Taipei";
  var config = getStoreConfig(botId);
  if (!config || !config.sayId) return "（無法取得空位，請直接聯繫店家）";

  var sayId = String(config.sayId);
  var todayStr = getTodayStr();
  var timeOpt = (timeStr && isTimeLike(timeStr)) ? String(timeStr).trim().substring(0, 5) : "";
  var peopleVal = (people != null && !isNaN(Number(people))) ? Math.max(1, parseInt(Number(people), 10)) : 1;

  var lines = [];

  try {
    // 近三天：今天起連續 3 天（日期 B 欄、時段 F 欄、人數 G 欄）
    var startD = parseDateOnly_(todayStr);
    if (!startD) startD = new Date();
    var endD3 = addDays_(startD, 2);
    var endStr3 = Utilities.formatDate(endD3, tz, "yyyy-MM-dd");
    var options3 = { startDate: todayStr, endDate: endStr3, people: peopleVal, duration: 1.5, weekDays: "" };
    if (timeOpt) options3.timeStart = timeOpt;
    if (timeOpt) options3.timeEnd = timeOpt;
    var text3 = cleanData(sayId, options3);
    lines.push(text3);

    // 下 1–2 週同一時段：候補日期 +7 天、+14 天的同一 HH:mm（依人數查）
    var baseDateStr = normalizeWaitlistDateStr(waitlistDateStr);
    if (baseDateStr) {
      var baseD = parseDateOnly_(baseDateStr);
      if (baseD) {
        var d7 = addDays_(baseD, 7);
        var d14 = addDays_(baseD, 14);
        var str7 = Utilities.formatDate(d7, tz, "yyyy-MM-dd");
        var str14 = Utilities.formatDate(d14, tz, "yyyy-MM-dd");
        var opts7 = { startDate: str7, endDate: str7, people: peopleVal, duration: 1.5, weekDays: "" };
        var opts14 = { startDate: str14, endDate: str14, people: peopleVal, duration: 1.5, weekDays: "" };
        if (timeOpt) { opts7.timeStart = timeOpt; opts7.timeEnd = timeOpt; opts14.timeStart = timeOpt; opts14.timeEnd = timeOpt; }
        var line7 = cleanData(sayId, opts7);
        var line14 = cleanData(sayId, opts14);
        lines.push("");
        lines.push("下1-2週同一時段" + (timeOpt ? "（" + timeOpt + "）" : "") + "：");
        lines.push(line7);
        lines.push(line14);
      }
    }

    return lines.join("\n");
  } catch (err) {
    Logger.log("getSlotsTextForWaitlist error: " + (err && err.message ? err.message : err));
    return "（查詢空位失敗，請直接聯繫店家）";
  }
}

/** markWaitlistPushed：發送 LINE Push（文案＋近三天＋下 1–2 週時段），並將該列狀態改為 pushed */
function markWaitlistPushed(e) {
  var botId = (e && e.parameter && e.parameter.botId) ? String(e.parameter.botId).trim() : "";
  var rowIndex = (e && e.parameter && e.parameter.rowIndex) ? parseInt(String(e.parameter.rowIndex), 10) : 0;

  if (!botId) return Core.jsonResponse({ status: "error", message: "請提供 botId" });
  if (!rowIndex || rowIndex < 2) return Core.jsonResponse({ status: "error", message: "請提供有效的 rowIndex" });

  var sheet = getWaitlistSheet();
  if (!sheet) return Core.jsonResponse({ status: "error", message: "無法取得候補清單工作表" });
  if (sheet.getLastRow() < rowIndex) return Core.jsonResponse({ status: "error", message: "找不到該筆資料" });

  // 日期 B 欄（1）、時段 F 欄（5）、人數 G 欄（6）
  var dateColB = 1, timeColF = 5, peopleColG = 6;
  var row = sheet.getRange(rowIndex, 1, rowIndex, 7).getValues()[0];
  var userId = row[2] ? String(row[2]).trim() : "";
  var dateVal = row[dateColB];
  var timeStr = row[timeColF] != null ? String(row[timeColF]).trim() : "";
  var peopleVal = (row[peopleColG] != null && !isNaN(Number(row[peopleColG]))) ? Math.max(1, parseInt(Number(row[peopleColG]), 10)) : 1;
  if (!userId) return Core.jsonResponse({ status: "error", message: "該筆缺少 userId" });

  var ss = getWaitlistSpreadsheet();
  var configSheet = ss.getSheetByName("店家基本資料");
  var configData = configSheet.getDataRange().getValues();
  var channelId = null, channelSecret = null;
  for (var i = 1; i < configData.length; i++) {
    if (configData[i][6] && String(configData[i][6]).trim() === botId) {
      channelId = configData[i][2];
      channelSecret = configData[i][3];
      break;
    }
  }
  if (!channelId || !channelSecret) return Core.jsonResponse({ status: "error", message: "無法取得該店 LINE 憑證" });

  var waitlistDateStr = normalizeWaitlistDateStr(dateVal);
  var slotsText = getSlotsTextForWaitlist(botId, waitlistDateStr, timeStr, peopleVal);
  var message = getWaitlistPushPrefix(waitlistDateStr, timeStr) + slotsText;
  var token = getLineAccessToken(channelId, channelSecret);
  if (!token) return Core.jsonResponse({ status: "error", message: "無法取得 LINE 存取權杖" });

  try {
    if (typeof Core.sendLinePushText === "function") {
      Core.sendLinePushText(userId, message, token);
    } else {
      return Core.jsonResponse({ status: "error", message: "Core.sendLinePushText 未就緒" });
    }
  } catch (pushErr) {
    Logger.log("markWaitlistPushed sendLinePushText error: " + (pushErr && pushErr.message ? pushErr.message : pushErr));
    return Core.jsonResponse({ status: "error", message: "發送 Push 失敗：" + (pushErr && pushErr.message ? pushErr.message : String(pushErr)) });
  }

  var tz = Session.getScriptTimeZone() || "Asia/Taipei";
  var handledAt = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm");
  sheet.getRange(rowIndex, 4).setValue(WAITLIST_STATUS_PUSHED);
  var operatorName = (e && e.parameter && e.parameter.operator_name != null) ? String(e.parameter.operator_name).trim() : "";
  if (operatorName) sheet.getRange(rowIndex, 8).setValue(operatorName);
  sheet.getRange(rowIndex, 10).setValue(handledAt);
  return Core.jsonResponse({ status: "success", message: "已傳送提醒" });
}

// ---------------------------------------------------------------------------
// 每日 22:00 排程：今日候補仍 pending 則自動 Push，狀態改為 auto_pushed
// ---------------------------------------------------------------------------

function runWaitlistAutoPush() {
  var ss = getWaitlistSpreadsheet();
  if (!ss) {
    Logger.log("runWaitlistAutoPush: 無法取得試算表");
    return;
  }

  var sheet = getWaitlistSheet();
  if (!sheet) return;

  var todayStr = getTodayStr();
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    runWaitlistDailySettlement();
    return;
  }

  var storeIdCol = 0, dateCol = 1, userIdCol = 2, statusCol = 3, timeCol = 5, peopleCol = 6;
  var configSheet = ss.getSheetByName("店家基本資料");
  if (!configSheet) {
    runWaitlistDailySettlement();
    return;
  }
  var configData = configSheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var dateVal = row[dateCol];
    var status = row[statusCol] != null ? String(row[statusCol]).trim() : "";
    if (status !== WAITLIST_STATUS_PENDING) continue;
    var rowDateStr = dateVal != null ? String(dateVal).trim().replace(/\//g, "-") : "";
    if (rowDateStr.indexOf("20") !== 0) continue;
    if (rowDateStr.substring(0, 10) !== todayStr) continue;

    var storeId = row[storeIdCol] != null ? String(row[storeIdCol]).trim() : "";
    var userId = row[userIdCol] ? String(row[userIdCol]).trim() : "";
    var timeStr = (row.length > timeCol && row[timeCol] != null) ? String(row[timeCol]).trim() : "";
    var peopleVal = (row.length > peopleCol && row[peopleCol] != null && !isNaN(Number(row[peopleCol]))) ? Math.max(1, parseInt(Number(row[peopleCol]), 10)) : 1;
    if (!userId) continue;

    var botId = null;
    var channelId = null, channelSecret = null;
    for (var c = 1; c < configData.length; c++) {
      if (configData[c][5] != null && String(configData[c][5]).trim() === storeId) {
        botId = configData[c][6];
        channelId = configData[c][2];
        channelSecret = configData[c][3];
        break;
      }
    }
    if (!botId || !channelId || !channelSecret) continue;

    var token = getLineAccessToken(channelId, channelSecret);
    if (!token) continue;

    var waitlistDateStr = normalizeWaitlistDateStr(dateVal);
    var slotsText = getSlotsTextForWaitlist(botId, waitlistDateStr, timeStr, peopleVal);
    var message = getWaitlistPushPrefix(waitlistDateStr, timeStr) + slotsText;
    try {
      if (typeof Core.sendLinePushText === "function") {
        Core.sendLinePushText(userId, message, token);
        sheet.getRange(i + 1, 4).setValue(WAITLIST_STATUS_AUTO_PUSHED);
      }
    } catch (err) {
      Logger.log("runWaitlistAutoPush row " + (i + 1) + " error: " + (err && err.message ? err.message : err));
    }
  }

  runWaitlistDailySettlement();
}

/** 結算各店「候補追蹤率」寫入店家基本資料 M 欄（pushed / (pushed + auto_pushed)） */
function runWaitlistDailySettlement() {
  var ss = getWaitlistSpreadsheet();
  if (!ss) return;

  var waitSheet = getWaitlistSheet();
  var storeSheet = ss.getSheetByName("店家基本資料");
  if (!waitSheet || !storeSheet) return;

  var todayStr = getTodayStr();
  var data = waitSheet.getDataRange().getValues();
  var storeIdCol = 0, dateCol = 1, statusCol = 3;

  var byStore = {};
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var dateVal = row[dateCol];
    var rowDateStr = dateVal != null ? String(dateVal).trim().replace(/\//g, "-") : "";
    if (rowDateStr.substring(0, 10) !== todayStr) continue;
    var status = row[statusCol] != null ? String(row[statusCol]).trim() : "";
    if (status !== WAITLIST_STATUS_PUSHED && status !== WAITLIST_STATUS_AUTO_PUSHED) continue;

    var storeId = row[storeIdCol] != null ? String(row[storeIdCol]).trim() : "";
    if (!storeId) continue;
    if (!byStore[storeId]) byStore[storeId] = { pushed: 0, total: 0 };
    byStore[storeId].total += 1;
    if (status === WAITLIST_STATUS_PUSHED) byStore[storeId].pushed += 1;
  }

  var storeData = storeSheet.getDataRange().getValues();
  var M_COL_1BASED = 13;
  if (storeData.length >= 1) {
    var headerM = storeSheet.getRange(1, M_COL_1BASED).getValue();
    if (headerM == null || String(headerM).trim() === "") {
      storeSheet.getRange(1, M_COL_1BASED).setValue("候補追蹤率");
    }
  }

  for (var r = 2; r <= storeData.length; r++) {
    var storeIdVal = storeData[r - 1][5];
    var storeId = storeIdVal != null ? String(storeIdVal).trim() : "";
    var rate = "";
    if (storeId && byStore[storeId] && byStore[storeId].total > 0) {
      var pushed = byStore[storeId].pushed || 0;
      var total = byStore[storeId].total;
      rate = pushed / total;
    }
    storeSheet.getRange(r, M_COL_1BASED).setValue(rate);
  }
}
