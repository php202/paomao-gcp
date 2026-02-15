// ==========================================
// 1. 主要入口 (POST): 負責處理 LINE Webhook
// ==========================================
function doPost(e) {
  try {
    // 1. 安全檢查
    if (!e || !e.postData || !e.postData.contents) {
      return Core.jsonResponse({ status: "error", message: "No post data received" });
    }
    // 2. 解析 body：支援 JSON 或 application/x-www-form-urlencoded（Odoo 嵌入頁送出建議用）
    var raw = e.postData.contents;
    var contentType = (e.postData && e.postData.type) ? String(e.postData.type).toLowerCase() : "";
    var data;
    if (contentType.indexOf("application/json") >= 0) {
      try {
        data = JSON.parse(raw);
    } catch (parseErr) {
      return Core.jsonResponse({ status: "error", message: "JSON 解析失敗" });
      }
    } else {
      data = {};
      raw.split("&").forEach(function (pair) {
        var i = pair.indexOf("=");
        if (i >= 0) {
          var key = decodeURIComponent(pair.slice(0, i).replace(/\+/g, " "));
          var val = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, " "));
          data[key] = val;
        }
      });
    }
    // 3. 路由分流
    if (data.events) {
      // === 來自 LINE 的 Webhook ===
      // 建議將 handleLineWebhook 放在 Services.gs
      handleLineWebhook(data); 
      // LINE 平台只需要收到 200 OK
      return ContentService.createTextOutput("OK");
    }
    if (data.action === "updateAiAdjustmentSuggestion") {
      return updateAiAdjustmentSuggestionAction(data);
    }
      // === 未知請求 ===
      return Core.jsonResponse({ status: "error", message: "未知的請求格式" });
  } catch (error) {
    var msg = (error && error.message) ? error.message : String(error);
    try { appendErrorLog(msg, "doPost"); } catch (logErr) {}
    return Core.jsonResponse({ status: "error", message: "系統錯誤: " + msg });
  }
}

// ==========================================
// 2. 主要入口 (GET): 負責處理 Chrome 外掛 API
// ==========================================
function doGet(e) {
  // 1. 統一捕捉錯誤，確保回傳 JSON
  try {
    // 檢查是否有參數
    if (!e || !e.parameter) {
      return Core.jsonResponse({status: 'error', message: 'No parameters provided'});
    }
    const action = e.parameter.action;
    // 2. 使用 Switch 清楚分流 (這裡只負責導向，不寫邏輯)
    switch (action) {
      case 'getList':
        return getList(e); // 呼叫 Services.gs 裡的函式
      case 'delete':
        return handleDelete(e); // 呼叫 Services.gs 裡的函式
      case 'replyMessage':
        return replyMessage(e);
      case 'getSlots':
        return getSlots(e);
      case 'checkMember':
        return checkMember(e);
      case 'createBooking':
        return createBooking(e);
      case 'searchAvailability':
        return searchAvailability(e);
      case 'getTomorrowBriefing':
        return getTomorrowBriefingAction(e);
      case 'getTomorrowReservationList':
        return getTomorrowReservationListAction(e);
      case 'customerCard':
        return getCustomerCardAction(e);
      case 'getCustomerInfo':
        return getCustomerInfoAction(e);
      case 'getWaitlist':
        return getWaitlist(e);
      case 'addWaitlist':
        return addWaitlist(e);
      case 'markWaitlistPushed':
        return markWaitlistPushed(e);
      case 'markWaitlistDone':
        return markWaitlistDone(e);
      case 'markWaitlistHandled':
        return markWaitlistHandled(e);
      case 'updateAiAdjustmentSuggestion':
        return updateAiAdjustmentSuggestionAction({
          token: (e.parameter && e.parameter.token) ? e.parameter.token : "",
          suggestion: (e.parameter && e.parameter.suggestion) != null ? e.parameter.suggestion : "",
          userId: (e.parameter && e.parameter.userId) != null ? e.parameter.userId : ""
        });
      default:
        return Core.jsonResponse({status: 'error', message: 'Invalid Action: ' + action});
    }

  } catch (error) {
    var msg = (error && error.message) ? error.message : String(error);
    try { appendErrorLog(msg, "doGet " + (e && e.parameter && e.parameter.action || "")); } catch (logErr) {}
    return Core.jsonResponse({ status: "error", message: "API 執行錯誤", details: msg });
  }
}

// 本地手機正規化（當 Core 未定義時使用）：09xxxxxxxx
function normalizePhoneLocal(phone) {
  if (!phone || typeof phone !== "string") return "";
  var digits = String(phone).replace(/\D/g, "");
  if (digits.length === 9 && digits.charAt(0) === "9") return "0" + digits;
  if (digits.length >= 10) return digits.slice(-10);
  return digits.length >= 10 ? digits : "";
}

// ==========================================
// customerCard 一次性 token：防止網址被人改手機號盜用。產生後存 Cache，使用一次即失效。
// ==========================================
var CUSTOMER_CARD_CACHE_PREFIX = "cc_";
var CUSTOMER_CARD_TOKEN_EXPIRY_SEC = 24 * 60 * 60; // 24 小時

/** 為一支手機產生一次性 token，存於 Cache，回傳 token 字串 */
function createCustomerCardToken(phone) {
  var normalized = (typeof Core !== "undefined" && typeof Core.normalizePhone === "function") ? Core.normalizePhone(phone) : normalizePhoneLocal(phone);
  if (!normalized || normalized.length < 10) return "";
  var token = CUSTOMER_CARD_CACHE_PREFIX + Utilities.getUuid();
  try {
    var cache = CacheService.getScriptCache();
    cache.put(token, normalized, CUSTOMER_CARD_TOKEN_EXPIRY_SEC);
    return token;
  } catch (e) {
    console.warn("createCustomerCardToken 失敗:", e && e.message);
    return "";
  }
}

/** 用 token 換取手機號，使用一次後即失效（從 Cache 移除） */
function consumeCustomerCardToken(token) {
  if (!token || typeof token !== "string") return null;
  var t = String(token).trim();
  if (!t || t.indexOf(CUSTOMER_CARD_CACHE_PREFIX) !== 0) return null;
  try {
    var cache = CacheService.getScriptCache();
    var phone = cache.get(t);
    if (phone) {
      cache.put(t, "", 1);
      return phone;
    }
    return null;
  } catch (e) {
    console.warn("consumeCustomerCardToken 失敗:", e && e.message);
    return null;
  }
}

/** 依 token 取得手機號（不消耗 token，供 Odoo 網頁等重複取資料用） */
function getPhoneFromToken(token) {
  if (!token || typeof token !== "string") return null;
  var t = String(token).trim();
  if (!t || t.indexOf(CUSTOMER_CARD_CACHE_PREFIX) !== 0) return null;
  try {
    var cache = CacheService.getScriptCache();
    return cache.get(t) || null;
  } catch (e) {
    console.warn("getPhoneFromToken 失敗:", e && e.message);
    return null;
  }
}

// ==========================================
// customerCard：依一次性 token 回傳該客人在「客人消費狀態」的 AI分析結果（簡易 HTML，供 LINE 點手機連結開啟）
// 網址僅接受 token，不接受 phone，防止被人改手機號盜用。token 使用一次即失效。
// ==========================================
function getCustomerCardAction(e) {
  function htmlOut(body) {
    return ContentService.createTextOutput("<html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'></head><body>" + body + "</body></html>").setMimeType(ContentService.MimeType.HTML);
  }
  var token = (e && e.parameter && e.parameter.token) ? String(e.parameter.token).trim() : "";
  var normalized = null;
  if (token) {
    normalized = consumeCustomerCardToken(token);
    if (!normalized) return htmlOut("此連結已失效或已使用過，請從「明天預約清單」重新點擊該客人手機連結。");
  } else {
    return htmlOut("為保障個資，此頁僅能透過「明天預約清單」中的手機連結開啟，請勿直接輸入網址或修改參數。");
  }
  try {
    if (typeof CONFIG === "undefined" || !CONFIG.INTEGRATED_SHEET_SS_ID || !CONFIG.INTEGRATED_SHEET_NAME) {
      return htmlOut("系統設定未就緒（CONFIG 或試算表未設定），請聯繫管理員。");
    }
    var ss = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
    var sheet = ss.getSheetByName(CONFIG.INTEGRATED_SHEET_NAME);
    if (!sheet) return htmlOut("找不到工作表「" + CONFIG.INTEGRATED_SHEET_NAME + "」，請聯繫管理員。");
    var rowIndex = findRowIndexByPhone(sheet, normalized, CONFIG.INTEGRATED_PHONE_COL);
    var aiCol = (CONFIG.INTEGRATED_HEADERS && CONFIG.INTEGRATED_HEADERS.indexOf("AI分析結果") >= 0) ? CONFIG.INTEGRATED_HEADERS.indexOf("AI分析結果") + 1 : 11;
    var content = (rowIndex != null) ? (sheet.getRange(rowIndex, aiCol).getValue()) : "";
    content = content != null ? String(content).trim() : "";
    // 沒跑過：查無此客人 或 有列但尚無 AI 分析結果 → 先產出該手機的資料再顯示（資料寫入客人消費狀態，員工填寫欄留空）
    if (rowIndex == null || !content) {
      if (typeof refreshCustomerByPhone === "function") {
        try {
          refreshCustomerByPhone(normalized, { leaveEmployeeEmpty: true });
        } catch (refreshErr) {
          console.warn("customerCard refreshCustomerByPhone 失敗: " + (refreshErr && refreshErr.message ? refreshErr.message : ""));
        }
      }
      ss = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
      sheet = ss.getSheetByName(CONFIG.INTEGRATED_SHEET_NAME);
      rowIndex = sheet ? findRowIndexByPhone(sheet, normalized, CONFIG.INTEGRATED_PHONE_COL) : null;
      content = (rowIndex != null) ? (sheet.getRange(rowIndex, aiCol).getValue()) : "";
      content = content != null ? String(content).trim() : "";
    }
    if (!rowIndex) {
      return htmlOut("查無此客人（" + normalized + "）。已嘗試產出資料，若仍無列請確認該手機是否曾出現在問卷／員工填寫／明日預約中。");
    }
    if (!content) content = "該客人尚無 AI 分析結果（已嘗試產出，請稍後再試或確認 GEMINI_API_KEY / OPENAI_API_KEY 已設定）。";
    var escaped = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return htmlOut("<style>body{font-family:sans-serif;padding:1em;white-space:pre-wrap;word-break:break-word;}</style>" + escaped);
  } catch (err) {
    var errMsg = (err && err.message) ? err.message : String(err);
    console.warn("getCustomerCardAction 錯誤:", errMsg);
    return htmlOut("錯誤：" + errMsg);
  }
}

// ==========================================
// getCustomerInfo：依 token 回傳該客人在「客人消費狀態」的整列 JSON（供 Odoo 網頁等取資料，不消耗 token）
// ==========================================
function getCustomerInfoAction(e) {
  var token = (e && e.parameter && e.parameter.token) ? String(e.parameter.token).trim() : "";
  if (!token) {
    return jsonOutWithCors({ status: "error", message: "請提供 token 參數" });
  }
  var normalized = getPhoneFromToken(token);
  if (!normalized) {
    return jsonOutWithCors({ status: "error", message: "此連結已失效或 token 不存在，請從「明天預約清單」取得連結。" });
  }
  try {
    if (typeof CONFIG === "undefined" || !CONFIG.INTEGRATED_SHEET_SS_ID || !CONFIG.INTEGRATED_SHEET_NAME) {
      return jsonOutWithCors({ status: "error", message: "系統設定未就緒" });
    }
    var ss = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
    var sheet = ss.getSheetByName(CONFIG.INTEGRATED_SHEET_NAME);
    if (!sheet) return jsonOutWithCors({ status: "error", message: "找不到工作表「" + CONFIG.INTEGRATED_SHEET_NAME + "」" });
    var rowIndex = findRowIndexByPhone(sheet, normalized, CONFIG.INTEGRATED_PHONE_COL);
    if (!rowIndex) {
      // 查無此客人時先產出該手機的資料（新增/更新客人消費狀態列，員工填寫欄留空），再重試讀取
      if (typeof refreshCustomerByPhone === "function") {
        try {
          refreshCustomerByPhone(normalized, { leaveEmployeeEmpty: true });
        } catch (refreshErr) {
          console.warn("getCustomerInfo refreshCustomerByPhone 失敗:", refreshErr && refreshErr.message ? refreshErr.message : "");
        }
      }
      ss = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
      sheet = ss.getSheetByName(CONFIG.INTEGRATED_SHEET_NAME);
      rowIndex = sheet ? findRowIndexByPhone(sheet, normalized, CONFIG.INTEGRATED_PHONE_COL) : null;
    }
    if (!rowIndex) return jsonOutWithCors({ status: "error", message: "查無此客人（" + normalized + "）。已嘗試產出資料，若仍無列請確認該手機是否曾出現在問卷／員工填寫／明日預約中。" });
    var headers = CONFIG.INTEGRATED_HEADERS || ["時間", "手機", "員工填寫", "客人問卷", "line對話", "消費紀錄", "儲值紀錄", "saydouUserId", "ai prompt", "lineUserId", "AI分析結果"];
    var numCols = headers.length;
    var rowValues = sheet.getRange(rowIndex, 1, rowIndex, numCols).getValues()[0] || [];
    var data = {};
    for (var c = 0; c < headers.length && c < rowValues.length; c++) {
      var val = rowValues[c];
      data[headers[c]] = val != null ? String(val).trim() : "";
    }
    var out = ContentService.createTextOutput(JSON.stringify({ status: "ok", data: data })).setMimeType(ContentService.MimeType.JSON);
    try {
      out.setHeader("Access-Control-Allow-Origin", "*");
    } catch (h) {}
    return out;
  } catch (err) {
    var errMsg = (err && err.message) ? err.message : String(err);
    console.warn("getCustomerInfoAction 錯誤:", errMsg);
    return jsonOutWithCors({ status: "error", message: errMsg });
  }
}

/** 請求員工ID 試算表：依 LINE userId 查 E 欄姓名（A=時間 B=userID C=Line上的名字 D=訊息 E=姓名 F=uuid） */
var REQUEST_EMPLOYEE_SS_ID = "1GH2XbihFIY0AX8SMF9Tk6igrVKPpA_vMJVlkDkJjpe4";
var REQUEST_EMPLOYEE_SHEET_GID = 1893384568;

/**
 * 從「請求員工ID」試算表依 LINE userId 查詢 E 欄（姓名），取最後一筆符合的列。
 * @param {string} lineUserId - LINE 的 userId
 * @returns {string} 姓名，查無則回傳空字串
 */
function getEmployeeNameByLineUserId(lineUserId) {
  if (!lineUserId || String(lineUserId).trim() === "") return "";
  try {
    var ss = SpreadsheetApp.openById(REQUEST_EMPLOYEE_SS_ID);
    var sheet = ss.getSheetById(REQUEST_EMPLOYEE_SHEET_GID);
    if (!sheet) return "";
    var data = sheet.getDataRange().getValues();
    if (!data || data.length < 2) return "";
    var userIdCol = 1;   // B 欄 = userID (0-based)
    var nameCol = 4;    // E 欄 = 姓名 (0-based)
    var found = "";
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var rowUserId = row[userIdCol] != null ? String(row[userIdCol]).trim() : "";
      if (rowUserId === String(lineUserId).trim()) {
        found = row[nameCol] != null ? String(row[nameCol]).trim() : "";
      }
    }
    return found || "";
  } catch (e) {
    console.warn("getEmployeeNameByLineUserId 錯誤:", e && e.message ? e.message : e);
    return "";
  }
}

// ==========================================
// updateAiAdjustmentSuggestion：依 token 將「建議 AI 生成的意見調整」追加寫入 L 欄（ai調整建議）
// 格式為 [時間, 姓名或userId, 建議]；姓名由「請求員工ID」試算表依 userId 查 E 欄取得。
// ==========================================
function updateAiAdjustmentSuggestionAction(data) {
  var token = (data && data.token) ? String(data.token).trim() : "";
  var suggestion = (data && data.suggestion != null) ? String(data.suggestion).trim() : "";
  var userId = (data && data.userId != null) ? String(data.userId).trim() : "";
  if (!token) return jsonOutWithCors({ status: "error", message: "請提供 token 參數" });
  var normalized = getPhoneFromToken(token);
  if (!normalized) return jsonOutWithCors({ status: "error", message: "此連結已失效或 token 不存在" });
  try {
    if (typeof CONFIG === "undefined" || !CONFIG.INTEGRATED_SHEET_SS_ID || !CONFIG.INTEGRATED_SHEET_NAME) {
      return jsonOutWithCors({ status: "error", message: "系統設定未就緒" });
    }
    var ss = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
    var sheet = ss.getSheetByName(CONFIG.INTEGRATED_SHEET_NAME);
    if (!sheet) return jsonOutWithCors({ status: "error", message: "找不到工作表「" + CONFIG.INTEGRATED_SHEET_NAME + "」" });
    var rowIndex = findRowIndexByPhone(sheet, normalized, CONFIG.INTEGRATED_PHONE_COL);
    if (!rowIndex) return jsonOutWithCors({ status: "error", message: "查無此客人（" + normalized + "）" });
    var colL = 12; // L 欄 = ai調整建議（CONFIG.INTEGRATED_HEADERS 第 12 個）
    if (CONFIG.INTEGRATED_HEADERS && CONFIG.INTEGRATED_HEADERS.indexOf("ai調整建議") >= 0) {
      colL = CONFIG.INTEGRATED_HEADERS.indexOf("ai調整建議") + 1;
    }
    var currentVal = sheet.getRange(rowIndex, colL).getValue();
    currentVal = currentVal != null ? String(currentVal).trim() : "";
    var timeStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm");
    var displayName = userId ? getEmployeeNameByLineUserId(userId) : "";
    var who = (displayName && displayName.length > 0) ? displayName : userId;
    var entry = "[" + timeStr + ", " + who + ", " + suggestion + "]";
    var newVal = currentVal ? currentVal + "\n\n" + entry : entry;
    sheet.getRange(rowIndex, colL).setValue(newVal);
    return jsonOutWithCors({ status: "ok", message: "已寫入建議" });
  } catch (err) {
    var errMsg = (err && err.message) ? err.message : String(err);
    console.warn("updateAiAdjustmentSuggestionAction 錯誤:", errMsg);
    return jsonOutWithCors({ status: "error", message: errMsg });
  }
}

/** 回傳 JSON 並加上 CORS 標頭，供 getCustomerInfo 給 Odoo 等前端跨網域取用 */
function jsonOutWithCors(obj) {
  var out = ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  try { out.setHeader("Access-Control-Allow-Origin", "*"); } catch (h) {}
  return out;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}