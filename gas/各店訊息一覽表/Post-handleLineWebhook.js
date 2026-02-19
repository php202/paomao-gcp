function debugSystemStatus() {
  Logger.log("🔍 開始系統診斷...");

  // 1. 檢查 API Key
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    Logger.log("❌ 錯誤：找不到 'GEMINI_API_KEY'。請去 [專案設定] -> [指令碼屬性] 新增。");
  } else {
    Logger.log("✅ API Key 設定正常 (開頭: " + apiKey.substring(0, 5) + "...)");
  }

  // 2. 模擬查店家設定 (請手動填入您的測試 Bot ID)
  // 這裡填入您 Log 裡出現的那個 Bot ID
  const TEST_BOT_ID = "U92a933504a6702c87ddaa207275ec43a"; 
  const TEST_USER_ID = "U658b977a4685c65e6c464e5cb9ee8e38"; // 您 Log 裡的 User ID

  const storeInfo = findStoreConfig(TEST_USER_ID, TEST_BOT_ID);
  
  if (!storeInfo) {
    Logger.log("❌ 錯誤：找不到店家資料。請檢查 '店家基本資料' Sheet 的 Bot ID 是否正確。");
    return;
  }
  
  Logger.log(`✅ 找到店家: ${storeInfo.storeName}`);
  
  if (!storeInfo.sayId) {
    Logger.log("❌ 嚴重錯誤：抓不到 'sayId'。請檢查 '店家基本資料' Sheet 的 [F欄] 是否有填入 SayDou ID。");
  } else {
    Logger.log(`✅ SayID 正常: ${storeInfo.sayId}`);
    
    // 3. 測試查空位
    Logger.log("⏳ 正在測試查空位...");
    const slots = getUpcomingSlots(storeInfo.sayId, storeInfo.token);
    if (slots) {
      Logger.log(`🎉 查空位成功！結果: ${slots}`);
    } else {
      Logger.log("⚠️ 查無空位 (或 API 失敗)，請確認 SayDou 後台是否真的有空位。");
    }
  }

  // 4. 測試 AI 生成
  Logger.log("⏳ 正在測試 AI 生成...");
  const context = { desc: "查詢空位", prompt: "請列出空位並鼓勵預約。" };
  const extraInfo = "\n(系統資訊: 1/26 14:00 有空位)";
  
  const aiReply = generateContextualAI("測試員", context, extraInfo);
  Logger.log("🤖 AI 回覆結果:\n" + aiReply);

  if (aiReply.includes("歡迎留言")) {
    Logger.log("⚠️ 警告：AI 回傳了預設罐頭訊息，代表 Gemini API 呼叫失敗。");
  }
}

// ==========================================
// 全域設定
// ==========================================
const RETENTION_SHEET_NAME = "準客挽留清單"; // 統一 Sheet 名稱
const ERROR_LOG_SOURCE = "各店訊息一覽表";

/** 準客挽留清單 D 欄「已結案」狀態：不需再追蹤，可定期清理 */
var RETENTION_CLOSED_STATUSES = ["Overwritten", "Replied", "AutoReplied", "Skipped", "SendFailed"];

/**
 * 將錯誤寫入訊息一覽表試算表的「錯誤紀錄」工作表（統一錯誤表），方便集中查看。
 * @param {string} message 錯誤訊息
 * @param {string} [context] 上下文
 */
function appendErrorLog(message, context) {
  appendUnifiedErrorLog(ERROR_LOG_SOURCE, message, context);
}

// LINE API 失敗訊息精簡，避免錯誤表過長
function summarizeErrorText(text, maxLen) {
  var s = (text == null) ? "" : String(text);
  s = s.replace(/\s+/g, " ").trim();
  var limit = (maxLen && maxLen > 0) ? maxLen : 200;
  return (s.length > limit) ? (s.substring(0, limit) + "...") : s;
}

var LINE_FETCH_BLOCK_SECONDS = 900; // 15 分鐘熔斷，避免配額超限時狂打 UrlFetch
var DISPLAY_NAME_DB_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 天

function isUrlFetchQuotaExceededText(text) {
  if (!text) return false;
  var s = String(text);
  return s.indexOf("1 日にサービス urlfetch を実行した回数が多すぎます") >= 0
    || s.indexOf("Service invoked too many times for one day: urlfetch") >= 0
    || s.indexOf("Service invoked too many times") >= 0;
}

function isLineFetchBlocked() {
  try {
    var untilSec = Number(PropertiesService.getScriptProperties().getProperty("LINE_FETCH_BLOCK_UNTIL_SEC") || "0");
    return untilSec > Math.floor(Date.now() / 1000);
  } catch (_) {
    return false;
  }
}

function blockLineFetch(reason) {
  try {
    var nowSec = Math.floor(Date.now() / 1000);
    var untilSec = nowSec + LINE_FETCH_BLOCK_SECONDS;
    var props = PropertiesService.getScriptProperties();
    props.setProperty("LINE_FETCH_BLOCK_UNTIL_SEC", String(untilSec));
    var lastLogSec = Number(props.getProperty("LINE_FETCH_BLOCK_LAST_LOG_SEC") || "0");
    if (nowSec - lastLogSec >= 300) {
      appendErrorLog("LINE fetch 熔斷 15 分鐘（UrlFetch 配額或限制）: " + summarizeErrorText(reason, 180), "LINE fetch breaker");
      props.setProperty("LINE_FETCH_BLOCK_LAST_LOG_SEC", String(nowSec));
    }
  } catch (_) {}
}

function getDisplayNameDbKey(userId, groupId, roomId) {
  var gid = (groupId != null && String(groupId).trim()) ? String(groupId).trim() : "";
  var rid = (roomId != null && String(roomId).trim()) ? String(roomId).trim() : "";
  if (gid) return "DISPLAY_NAME_DB:" + String(userId) + ":G:" + gid;
  if (rid) return "DISPLAY_NAME_DB:" + String(userId) + ":R:" + rid;
  return "DISPLAY_NAME_DB:" + String(userId) + ":P";
}

function getDisplayNameDbSheet() {
  var ssId = typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID ? CONFIG.INTEGRATED_SHEET_SS_ID : null;
  if (!ssId) return null;
  var ss = SpreadsheetApp.openById(ssId);
  if (!ss) return null;
  var sheet = ss.getSheetByName("DisplayNameDB");
  if (!sheet) {
    sheet = ss.insertSheet("DisplayNameDB");
    sheet.appendRow(["key", "userId", "scope", "scopeId", "displayName", "updatedAt"]);
  }
  return sheet;
}

function readDisplayNameFromSheetByKey(sheet, key) {
  if (!sheet || !key) return "";
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return "";
  var found = sheet.getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(String(key))
    .matchEntireCell(true)
    .findNext();
  if (!found) return "";
  var row = found.getRow();
  var name = sheet.getRange(row, 5).getValue();
  var updatedAtVal = sheet.getRange(row, 6).getValue();
  var n = (name != null) ? String(name).trim() : "";
  if (!n || n === "未知用戶" || n === "未知(未加好友)" || n === "未知用户") return "";
  if (updatedAtVal) {
    var t = (updatedAtVal instanceof Date) ? Math.floor(updatedAtVal.getTime() / 1000) : Math.floor(new Date(updatedAtVal).getTime() / 1000);
    if (t > 0) {
      var now = Math.floor(Date.now() / 1000);
      if ((now - t) > DISPLAY_NAME_DB_TTL_SECONDS) return "";
    }
  }
  return n;
}

function upsertDisplayNameToSheet(sheet, key, userId, scope, scopeId, name) {
  if (!sheet || !key || !userId || !name) return;
  var lastRow = sheet.getLastRow();
  var found = null;
  if (lastRow > 1) {
    found = sheet.getRange(2, 1, lastRow - 1, 1)
      .createTextFinder(String(key))
      .matchEntireCell(true)
      .findNext();
  }
  var rowValues = [key, userId, scope, scopeId, name, new Date()];
  if (found) {
    sheet.getRange(found.getRow(), 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
}

function readDisplayNameFromDb(userId, groupId, roomId) {
  if (!userId) return "";
  try {
    var gid = (groupId != null && String(groupId).trim()) ? String(groupId).trim() : "";
    var rid = (roomId != null && String(roomId).trim()) ? String(roomId).trim() : "";
    var sheet = getDisplayNameDbSheet();
    if (!sheet) return "";
    var scopedKey = getDisplayNameDbKey(userId, gid, rid);
    var scoped = readDisplayNameFromSheetByKey(sheet, scopedKey);
    if (scoped) return scoped;
    var global = readDisplayNameFromSheetByKey(sheet, "DISPLAY_NAME_DB_GLOBAL:" + String(userId));
    if (global) return global;
  } catch (_) {}
  return "";
}

function saveDisplayNameToDb(userId, groupId, roomId, name) {
  if (!userId || !name) return;
  var n = String(name).trim();
  if (!n || n === "未知用戶" || n === "未知(未加好友)" || n === "未知用户") return;
  try {
    var gid = (groupId != null && String(groupId).trim()) ? String(groupId).trim() : "";
    var rid = (roomId != null && String(roomId).trim()) ? String(roomId).trim() : "";
    var sheet = getDisplayNameDbSheet();
    if (!sheet) return;
    var scope = gid ? "group" : (rid ? "room" : "profile");
    var scopeId = gid || rid || "";
    upsertDisplayNameToSheet(sheet, getDisplayNameDbKey(userId, gid, rid), String(userId), scope, scopeId, n);
    upsertDisplayNameToSheet(sheet, "DISPLAY_NAME_DB_GLOBAL:" + String(userId), String(userId), "global", "", n);
  } catch (_) {}
}

// ==========================================
// 功能 1: 處理 LINE 訊息 (主程式)
// ==========================================
function handleLineWebhook(data) {
  try {
    var ssId = PropertiesService.getScriptProperties().getProperty("ERROR_LOG_SS_ID")
      || (typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID)
      || null;
    var ss = ssId ? SpreadsheetApp.openById(ssId) : null;
    if (!ss) {
      appendErrorLog("handleLineWebhook: 無法取得試算表（Web App 請設定指令碼屬性 ERROR_LOG_SS_ID）", "LINE webhook");
      return ContentService.createTextOutput("OK");
    }
    var logSheet = ss.getSheetByName("訊息一覽");
    if (!logSheet) {
      logSheet = ss.insertSheet("訊息一覽");
      logSheet.appendRow(["時間", "id", "店家", "名字", "訊息", "狀態", "處理人員", "手機", "replyToken"]);
    }

    var events = data.events;
    for (var i = 0; i < events.length; i++) {
    const event = events[i];

    if (event.type === 'postback' && event.postback && event.postback.data) {
      var postbackData = event.postback.data;
      var userId = event.source ? event.source.userId : "";
      var replyToken = event.replyToken;
      var storeInfo = data.destination ? findStoreConfig(userId, data.destination) : null;
      var token = storeInfo ? storeInfo.token : null;
      if (postbackData.indexOf("action=book_reengagement") === 0 && typeof handleReengagementBooking === "function") {
        try {
          handleReengagementBooking(postbackData, userId, replyToken, token);
        } catch (pbErr) {
          appendErrorLog("handleReengagementBooking: " + (pbErr && pbErr.message), "postback");
        }
      }
      continue;
    }
    
    if (event.type === 'message' && event.message.type === 'text') {
      const msg = event.message.text;
      const userId = event.source.userId;
      const replyToken = event.replyToken; 
      const botDestinationId = data.destination; 
      const timestamp = new Date();
      const groupId = (event.source && event.source.groupId) ? String(event.source.groupId) : "";
      const roomId = (event.source && event.source.roomId) ? String(event.source.roomId) : "";

      const storeInfo = findStoreConfig(userId, botDestinationId, groupId, roomId);
      let finalStoreName = "未知店家";
      let finalUserName = "未知/ID:" + userId;
      let validToken = null;
      let sayId = null;

      if (storeInfo) {
        finalStoreName = storeInfo.storeName;
        finalUserName = storeInfo.userName;
        validToken = storeInfo.token;
        sayId = storeInfo.sayId;
      } else {
        finalStoreName = "無法辨識(未加好友?)";
        appendErrorLog("handleLineWebhook: storeInfo 為空，destination=" + String(botDestinationId || "") + ", uid=" + String(userId || ""), "LINE webhook");
      }
      if (storeInfo && !storeInfo.token) {
        appendErrorLog("handleLineWebhook: storeInfo 存在但 token 為空，store=" + String(storeInfo.storeName || "") + ", uid=" + String(userId || ""), "LINE token");
      }
      if (storeInfo && storeInfo.token && (!finalUserName || finalUserName === "未知(未加好友)" || finalUserName.trim() === "")) {
        var directName = fetchDisplayNameFromLine(userId, groupId, roomId, storeInfo.token);
        if (directName && directName.trim()) finalUserName = directName.trim();
      }
      if (!finalUserName || finalUserName.trim() === "" || finalUserName === "未知(未加好友)") finalUserName = " ";

      // 報告關鍵字已移至「員工打卡 Line@」專案，僅員工可見；客人 LINE 不回應報告關鍵字。

      // ==========================================
      // 訊息篩選與挽留機制
      // ==========================================
      const filterResult = messFilter(msg); 

      if (filterResult) {
        // I 欄 isReply 只控制「查詢空位」是否用 reply token 傳給客人；不關閉查詢空位功能，仍會查空位、寫入挽留清單
        // [我的會員][課程介紹] 不用出現挽留清單、也不 Reply；只有 [線上預約] 才寫入清單並有機會 Reply
        var skipList = (filterResult.desc === "會員權益" || filterResult.desc === "了解課程");
        if (!skipList && validToken) {
          addToRetentionList(userId, msg, validToken, filterResult, sayId, replyToken, botDestinationId, storeInfo, groupId, roomId, finalUserName);
        }
        continue;
      }

      // [狀況 B] 這是客人打字的真實訊息
      markAsReplied(userId);

      // 若訊息中有提到手機號碼，擷取並寫入 H 欄（手機），之後問卷填寫時可依手機比對出 lineUserId
      var extractedPhone = (typeof extractPhoneFromText === "function") ? extractPhoneFromText(msg) : null;
      var statusCol = "";
      var handlerCol = "";
      var phoneCol = extractedPhone || "";
      var replyTokenStr = (replyToken && typeof replyToken === "string") ? replyToken : "";
      var nameForSheet = (finalUserName && String(finalUserName).trim()) ? String(finalUserName).trim() : " ";
      if (nameForSheet === "未知用戶" || nameForSheet === "未知(未加好友)" || nameForSheet === "未知用户" || nameForSheet.indexOf("未知/ID:") === 0) nameForSheet = " ";
      logSheet.appendRow([timestamp, userId, finalStoreName, nameForSheet, msg, statusCol, handlerCol, phoneCol, replyTokenStr]);
      if (extractedPhone && typeof syncLineUserIdForPhoneToCustomerState === "function") {
        try { syncLineUserIdForPhoneToCustomerState(extractedPhone, userId); } catch (syncErr) {
          appendErrorLog("syncLineUserIdForPhoneToCustomerState: " + (syncErr && syncErr.message), "handleLineWebhook");
        }
      }
    }
  }
  return Core.jsonResponse({ status: "ok" });
  } catch (e) {
    var msg = (e && e.message) ? e.message : String(e);
    appendErrorLog(msg, "handleLineWebhook");
    return ContentService.createTextOutput("OK");
  }
}

// ==========================================
// [核心] 寫入挽留清單 (支援 AI 與 固定模板)
// I 欄 isReply 只控制「查詢空位」是否用 reply token 傳給客人；查詢空位、寫入清單照常執行
// ==========================================
function addToRetentionList(userId, triggerMsg, token, context, sayId, replyToken, botDestinationId, storeInfo, groupId, roomId, knownDisplayName) {
  var ssId = typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID ? CONFIG.INTEGRATED_SHEET_SS_ID : null;
  var ss = ssId ? SpreadsheetApp.openById(ssId) : null;
  if (!ss) return;
  let sheet = ss.getSheetByName(RETENTION_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(RETENTION_SHEET_NAME);
    sheet.appendRow(['UserID', '暱稱', '觸發時間', '狀態', '類型', 'AI建議文案', 'ReplyToken', 'BotID']);
  }
  
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][0] == userId && data[i][3] == "Pending") {
      sheet.getRange(i + 1, 4).setValue("Overwritten");
      sheet.getRange(i + 1, 1, 1, 7).setBackground("#eeeeee"); 
    }
  }

  // B. 準備基本資料：優先沿用同一 webhook 已取得的名字，避免重複打 LINE API
  let displayName = "";
  if (knownDisplayName && String(knownDisplayName).trim()) {
    var known = String(knownDisplayName).trim();
    if (known !== "未知用戶" && known !== "未知(未加好友)" && known !== "未知用户" && known.indexOf("未知/ID:") !== 0) {
      displayName = known;
    }
  }
  if (!displayName) displayName = (typeof fetchDisplayNameFromLine === "function") ? fetchDisplayNameFromLine(userId, groupId || "", roomId || "", token) : "";
  if (!displayName && storeInfo && storeInfo.userName && String(storeInfo.userName).trim() && storeInfo.userName !== "未知(未加好友)") displayName = storeInfo.userName;
  if (!displayName) {
    try {
      var profile = getLineProfile(userId, token);
      if (profile && profile.displayName) displayName = profile.displayName;
    } catch (e) {}
  }
  var displayNameForSheet = (displayName && String(displayName).trim()) ? String(displayName).trim() : " ";
  if (displayNameForSheet === "未知用戶" || displayNameForSheet === "未知(未加好友)" || displayNameForSheet === "未知用户") displayNameForSheet = " ";
  displayName = displayNameForSheet;

  // C. 產生文案內容
  let finalContent = "";

  if (context.type !== "IGNORE") {
    // 1. 查詢空位照常執行（不因 isReply 關閉）；I 欄 isReply 只控制是否用 reply token 傳給客人
    let slotsStr = "";
    if (context.type === "BOOKING" && sayId) {
      slotsStr = getUpcomingSlots(sayId, token);
    }

    // 2. 判斷要用 AI 還是 模板
    if (context.useAI) {
      // === 走 AI 路線 ===
      const extraInfo = slotsStr ? `(系統資訊: ${slotsStr})` : "";
      finalContent = generateContextualAI(displayName, context, extraInfo);

    } else {
      // === 走固定模板路線 (省錢、快速) ===
      if (context.template) {
        if (context.desc === "查詢空位" && (!slotsStr || !slotsStr.trim())) {
          finalContent = "Hi " + displayName + "，近幾天都滿了，可以呼叫貓小編協助看預約時間唷～";
        } else {
          finalContent = context.template
            .replace("${name}", displayName)
            .replace("${slots}", slotsStr || "(目前查詢較滿，請直接聯繫小編)");
        }
      } else {
        finalContent = "(系統紀錄，無須回覆)";
      }
    }
  } else {
    finalContent = "(系統指令，無需挽留)";
  }
  
  // D. 線上預約（查詢空位）用 reply token 傳給客人；I 欄 isReply 為 false 時不發送。拉不到 token 或 token 失效時不傳訊息給客戶。
  var rowStatus = "Pending";
  var allowReply = (storeInfo == null || storeInfo.isReply !== false);
  var isQuerySlots = (context.desc === "查詢空位");
  var hasValidToken = token && String(token).trim();
  if (allowReply && isQuerySlots && finalContent && replyToken && hasValidToken && context.type !== "IGNORE" && finalContent.indexOf("(系統") !== 0) {
    try {
      var sent = sendLineReplyViaCoreApi(replyToken, finalContent, token);
      if (sent) {
        rowStatus = "Replied";
      } else if (typeof Core !== "undefined" && typeof Core.sendLineReply === "function") {
        Core.sendLineReply(replyToken, finalContent, token);
        rowStatus = "Replied";
      }
    } catch (e) {
      appendErrorLog("addToRetentionList 立即 Reply 失敗: " + (e && e.message), "LINE reply");
    }
  }
  
  // E. 寫入 Sheet（留紀錄）；暱稱欄用 displayName（已統一為空/未知→" "）
  const timeStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
  sheet.appendRow([userId, displayName, timeStr, rowStatus, context.desc, finalContent, replyToken, botDestinationId]);
}

// 標記為已互動
function markAsReplied(userId) {
  var ssId = typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID ? CONFIG.INTEGRATED_SHEET_SS_ID : null;
  var ss = ssId ? SpreadsheetApp.openById(ssId) : null;
  if (!ss) return;
  const sheet = ss.getSheetByName(RETENTION_SHEET_NAME);
  if (!sheet) return; 
  
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][0] == userId && data[i][3] == "Pending") {
      sheet.getRange(i + 1, 4).setValue("Replied");
      sheet.getRange(i + 1, 1, 1, 7).setBackground("#d9ead3"); 
      break; 
    }
  }
}

/**
 * 準客挽留清單定期清理：刪除「已結案」與過期 Pending，只保留真的需要關注的列。
 * 已結案 = Overwritten / Replied / AutoReplied / Skipped / SendFailed（不需再追蹤）。
 * 每 10 天執行一次（由 Triggers 排程呼叫，內部依 ScriptProperties 判斷間隔）。
 */
function cleanupRetentionList() {
  var ssId = typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID ? CONFIG.INTEGRATED_SHEET_SS_ID : null;
  var ss = ssId ? SpreadsheetApp.openById(ssId) : null;
  if (!ss) return;
  var sheet = ss.getSheetByName(RETENTION_SHEET_NAME);
  if (!sheet) return;

  var props = PropertiesService.getScriptProperties();
  var key = "RETENTION_LAST_CLEANUP";
  var lastStr = props.getProperty(key);
  var now = new Date();
  var CLEANUP_INTERVAL_DAYS = 10;
  var PENDING_STALE_DAYS = 7; // Pending 逾 7 天 ReplyToken 已失效，可刪

  if (lastStr) {
    var last = new Date(lastStr);
    var diffDays = (now.getTime() - last.getTime()) / (24 * 60 * 60 * 1000);
    if (diffDays < CLEANUP_INTERVAL_DAYS) {
      Logger.log("[準客挽留清理] 距上次未滿 " + CLEANUP_INTERVAL_DAYS + " 天，跳過。");
      return;
    }
  }

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    props.setProperty(key, now.toISOString().slice(0, 10));
    return;
  }

  var closedSet = {};
  RETENTION_CLOSED_STATUSES.forEach(function (s) { closedSet[s] = true; });

  var deleted = 0;
  for (var i = data.length - 1; i >= 1; i--) {
    var row = data[i];
    var status = (row[3] != null) ? String(row[3]).trim() : "";
    var timeVal = row[2];
    var triggerTime = timeVal instanceof Date ? timeVal : (timeVal ? new Date(timeVal) : null);
    var isStalePending = (status === "Pending" && triggerTime && (now - triggerTime) > PENDING_STALE_DAYS * 24 * 60 * 60 * 1000);
    var isClosed = !!closedSet[status];

    if (isClosed || isStalePending) {
      sheet.deleteRow(i + 1);
      deleted++;
    }
  }

  props.setProperty(key, now.toISOString().slice(0, 10));
  Logger.log("[準客挽留清理] 已刪除 " + deleted + " 筆（已結案或逾 " + PENDING_STALE_DAYS + " 天 Pending），下次 " + CLEANUP_INTERVAL_DAYS + " 天後執行。");
}

// ==========================================
// 輔助函式
// ==========================================

/**
 * 透過 Core API 發送 LINE Reply（action=lineReply）。
 * 指令碼屬性需設 PAO_CAT_CORE_API_URL（PaoMao_Core「網路應用程式」部署網址，結尾 /exec）、PAO_CAT_SECRET_KEY。
 * @returns {boolean} 已透過 API 送出為 true，未設定 API 或失敗為 false
 */
function sendLineReplyViaCoreApi(replyToken, text, token) {
  var url = PropertiesService.getScriptProperties().getProperty("PAO_CAT_CORE_API_URL");
  var key = PropertiesService.getScriptProperties().getProperty("PAO_CAT_SECRET_KEY");
  if (!url || !key || !replyToken || !token) return false;
  url = url.trim();
  key = key.trim();
  if (url === "" || key === "") return false;
  try {
    var res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        key: key,
        action: "lineReply",
        replyToken: replyToken,
        text: text,
        token: token
      }),
      muteHttpExceptions: true
    });
    var body = res.getContentText();
    if (res.getResponseCode() !== 200) {
      appendErrorLog("Core API lineReply 失敗: " + res.getResponseCode() + " " + body, "LINE reply");
      return false;
    }
    var data = JSON.parse(body);
    if (data.status === "ok") return true;
    appendErrorLog("Core API lineReply 回傳: " + (data.message || body), "LINE reply");
    return false;
  } catch (e) {
    appendErrorLog("sendLineReplyViaCoreApi: " + (e && e.message), "LINE reply");
    return false;
  }
}

/**
 * 直接呼叫 LINE API 取得 displayName（群組/聊天室用 /member，否則 /profile）
 * 不依賴 Core；群組 API 非 200 時再試 /profile（有加好友才有效）
 */
function fetchDisplayNameFromLine(userId, groupId, roomId, token) {
  if (!userId || !token) return "";
  var dbName = readDisplayNameFromDb(userId, groupId, roomId);
  if (dbName) return dbName;
  if (isLineFetchBlocked()) return "";
  var gid = (groupId != null && String(groupId).trim()) ? String(groupId).trim() : "";
  var rid = (roomId != null && String(roomId).trim()) ? String(roomId).trim() : "";
  var cache = CacheService.getScriptCache();
  var cacheKey = "DISPLAY_NAME_V2:" + String(userId) + ":" + (gid || "-") + ":" + (rid || "-");
  var cached = cache.get(cacheKey);
  if (cached && cached !== " " && cached !== "未知用戶" && cached !== "未知(未加好友)" && cached !== "未知用户") return cached;
  var url;
  var route = "profile";
  if (gid) {
    url = "https://api.line.me/v2/bot/group/" + gid + "/member/" + userId;
    route = "groupMember";
  } else if (rid) {
    url = "https://api.line.me/v2/bot/room/" + rid + "/member/" + userId;
    route = "roomMember";
  } else {
    url = "https://api.line.me/v2/bot/profile/" + userId;
  }
  try {
    var res = UrlFetchApp.fetch(url, { method: "get", headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true });
    var code = res.getResponseCode();
    if (code === 200) {
      var json = JSON.parse(res.getContentText());
      var name = (json && json.displayName) ? String(json.displayName).trim() : "";
      if (name && name !== "未知用戶" && name !== "未知(未加好友)" && name !== "未知用户") {
        cache.put(cacheKey, name, 21600);
        saveDisplayNameToDb(userId, gid, rid, name);
        return name;
      }
    } else {
      var body = res.getContentText();
      if (isUrlFetchQuotaExceededText(body)) blockLineFetch(body);
      appendErrorLog(
        "fetchDisplayNameFromLine 非200: code=" + code + ", route=" + route + ", uid=" + userId + ", body=" + summarizeErrorText(body, 220),
        "LINE displayName"
      );
    }
    if (gid || rid) {
      var profile = getLineProfile(userId, token);
      if (profile && profile.displayName) {
        var pname = String(profile.displayName).trim();
        if (pname && pname !== "未知用戶" && pname !== "未知(未加好友)" && pname !== "未知用户") {
          cache.put(cacheKey, pname, 21600);
          saveDisplayNameToDb(userId, gid, rid, pname);
          return pname;
        }
      }
    }
  } catch (e) {}
  return "";
}

// 取得 LINE 使用者資料（/profile，僅對有加好友有效）
function getLineProfile(userId, token) {
  if (!userId || !token || isLineFetchBlocked()) return null;
  try {
    const url = `https://api.line.me/v2/bot/profile/${userId}`;
    const options = {
      "method": "get",
      "headers": { "Authorization": "Bearer " + token },
      "muteHttpExceptions": true
    };
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      var body = response.getContentText();
      if (isUrlFetchQuotaExceededText(body)) blockLineFetch(body);
      appendErrorLog(
        "getLineProfile 非200: code=" + response.getResponseCode() + ", uid=" + userId + ", body=" + summarizeErrorText(body, 220),
        "LINE profile"
      );
      return null;
    }
    return JSON.parse(response.getContentText());
  } catch (e) {
    var emsg = (e && e.message) ? e.message : String(e);
    if (isUrlFetchQuotaExceededText(emsg)) blockLineFetch(emsg);
    return null;
  }
}

// AI 生成文案
// ==========================================
// 【暫停】AI 僅用於「客人消費狀態」；LINE 回覆改為罐頭訊息，不呼叫 Gemini。
// ==========================================
function generateContextualAI(name, context, extraInfo) {
  return `Hi ${name}，我們收到您的${context.desc}需求，稍後將有專人為您服務。`;
}

// [修正] 查空位函式 (使用台灣時區)。不快取，每次都即時查詢。
// 規則：先查四天內；若四天內都沒有空位，往後查至多 MAX_DAYS_AHEAD 天，取「至少 MIN_DAYS_WITH_SLOTS 天」有空位的時段
var FIRST_RANGE_DAYS = 4;
var MIN_DAYS_WITH_SLOTS = 3;
var MAX_DAYS_AHEAD = 30;

function formatSlotsLinesFromData(data) {
  if (!data || !data.length) return null;
  var lines = [];
  for (var i = 0; i < data.length; i++) {
    var day = data[i];
    if (!day || !day.times) continue;
    var slotsStr = Array.isArray(day.times) ? day.times.join("、") : String(day.times);
    var datePart = (day.date && day.date.length >= 10 && day.date.charAt(4) === "-") ? day.date.substring(5) : (day.date || "");
    var weekPart = day.week || "";
    lines.push(datePart + (weekPart ? " (" + weekPart + ")" : "") + "：" + slotsStr);
  }
  return lines.length > 0 ? "近期空位:\n" + lines.join(",\n") : null;
}

function getUpcomingSlots(sayId) {
  if (!sayId) return null;
  const timeZone = Session.getScriptTimeZone() || "Asia/Taipei";
  const today = new Date();
  const endFirst = new Date(today);
  endFirst.setDate(endFirst.getDate() + FIRST_RANGE_DAYS - 1);
  const startDateStr = Utilities.formatDate(today, timeZone, "yyyy-MM-dd");
  const endDateFirstStr = Utilities.formatDate(endFirst, timeZone, "yyyy-MM-dd");

  try {
    var findSlots = Core.findAvailableSlots(sayId, startDateStr, endDateFirstStr, 1, 90, {});
    var data = (findSlots && findSlots.data) ? findSlots.data : [];
    var daysWithSlots = data.filter(function (d) { return d && d.times && (Array.isArray(d.times) ? d.times.length : 1); });

    if (daysWithSlots.length > 0) {
      return formatSlotsLinesFromData(data);
    }

    var endExtended = new Date(today);
    endExtended.setDate(endExtended.getDate() + MAX_DAYS_AHEAD);
    var endDateExtendedStr = Utilities.formatDate(endExtended, timeZone, "yyyy-MM-dd");
    findSlots = Core.findAvailableSlots(sayId, startDateStr, endDateExtendedStr, 1, 90, {});
    data = (findSlots && findSlots.data) ? findSlots.data : [];
    daysWithSlots = data.filter(function (d) { return d && d.times && (Array.isArray(d.times) ? d.times.length : 1); });
    var take = Math.min(MIN_DAYS_WITH_SLOTS, daysWithSlots.length);
    if (take === 0) return null;
    return formatSlotsLinesFromData(daysWithSlots.slice(0, take));
  } catch (e) {
    Logger.log("查空位發生錯誤: " + e.toString());
    return null;
  }
}
// ------------------------------------------
// 必須補上的輔助函式 (如果您的程式碼最下方沒有這些，請補上)
// ------------------------------------------

function messFilter(msg) {
  if (!msg) return null;

  const rules = [
    // -----------------------------------------------------------
    // Type 1: 固定模板 (不用 AI，速度快)
    // -----------------------------------------------------------
    { 
      keyword: "我的會員", 
      type: "MEMBER", 
      desc: "會員權益",
      useAI: false, // ❌ 不用 AI
      template: "${name} 您好！想查詢點數嗎？請點擊選單下方的「會員中心」即可查看喔！"
    },
    { 
      keyword: "課程介紹", 
      type: "INTRO", 
      desc: "了解課程", 
      useAI: false, // ❌ 不用 AI
      template: "${name} 您好，我們的熱門課程都在選單裡囉！如果需要專人解說，請直接留言，我們稍後回覆您。"
    },
    { 
      keyword: "送出預約", 
      type: "IGNORE", 
      desc: "系統操作", 
      useAI: false, 
      template: null // IGNORE 類型通常不寫入 Sheet，這裡填 null 即可
    },

    // -----------------------------------------------------------
    // Type 2: 需要查空位 + 簡單模板 (不用 AI，但要插空位資料)
    // -----------------------------------------------------------
    { 
      keyword: "線上預約", 
      type: "BOOKING", 
      desc: "查詢空位",
      useAI: false, // ❌ 改成不用 AI，直接用模板帶入空位
      // 注意：${slots} 會被自動替換成查到的空位時間
      template: "Hi ${name}，想預約嗎？系統查到最近還有空位：\n${slots}\n\n有哪一個時段對妳來說比較方便嗎？\n如果想預約的話，再麻煩留下你的【姓名、電話】，稍後為妳登記保留喔。"
    },

    // -----------------------------------------------------------
    // Type 3: 需要 AI 安撫 (使用 AI)
    // -----------------------------------------------------------
    { 
      keyword: "您已取消預約",
      type: "BOOKING", 
      desc: "取消挽回", 
      useAI: true, // ✅ 這個維持用 AI，比較有溫度
      prompt: "客人剛取消了預約。請產生一段貼心、不給壓力的文案，表示遺憾，並主動列出系統查到的最近空位(${slots})，詢問是否改約。" 
    }
  ];

  return rules.find(r => msg.includes(r.keyword));
}

// Token 相關函式 (保持原樣)
function getBotUserIdFromToken(token) {
  try {
    const url = 'https://api.line.me/v2/bot/info';
    const options = {
      'method': 'get',
      'headers': { 'Authorization': 'Bearer ' + token },
      'muteHttpExceptions': true
    };
    const response = UrlFetchApp.fetch(url, options);
    const json = JSON.parse(response.getContentText());
    if (json.userId) return json.userId;
  } catch (e) { console.log(e); }
  return null;
}

function getLineAccessToken(channelId, channelSecret) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const cacheKeyToken = 'TOKEN_' + channelId;
  const cacheKeyTime = 'EXPIRATION_' + channelId;
  const cachedToken = scriptProperties.getProperty(cacheKeyToken);
  const expirationTime = scriptProperties.getProperty(cacheKeyTime);
  const now = Math.floor(Date.now() / 1000);

  if (cachedToken && expirationTime && (parseInt(expirationTime) - now > 600)) {
    return cachedToken;
  }
  if (isLineFetchBlocked()) return null;

  try {
    const url = 'https://api.line.me/v2/oauth/accessToken';
    const payload = {
      'grant_type': 'client_credentials',
      'client_id': channelId,
      'client_secret': channelSecret
    };
    const options = {
      'method': 'post',
      'headers': { 'Content-Type': 'application/x-www-form-urlencoded' },
      'payload': payload,
      'muteHttpExceptions': true
    };
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      var body = response.getContentText();
      if (isUrlFetchQuotaExceededText(body)) blockLineFetch(body);
      appendErrorLog(
        "getLineAccessToken 非200: code=" + response.getResponseCode() + ", channelIdTail=" + String(channelId).slice(-6) + ", body=" + summarizeErrorText(body, 220),
        "LINE token"
      );
      return null;
    }
    const json = JSON.parse(response.getContentText());
    if (json.access_token) {
      const newExpirationTime = now + json.expires_in;
      scriptProperties.setProperty(cacheKeyToken, json.access_token);
      scriptProperties.setProperty(cacheKeyTime, newExpirationTime.toString());
      return json.access_token;
    } else {
      appendErrorLog(
        "getLineAccessToken 無 access_token: channelIdTail=" + String(channelId).slice(-6) + ", body=" + summarizeErrorText(response.getContentText(), 220),
        "LINE token"
      );
      return null;
    }
  } catch (e) {
    var emsg = (e && e.message) ? e.message : String(e);
    if (isUrlFetchQuotaExceededText(emsg)) blockLineFetch(emsg);
    appendErrorLog("getLineAccessToken 例外: " + emsg, "LINE token");
    return null;
  }
}
