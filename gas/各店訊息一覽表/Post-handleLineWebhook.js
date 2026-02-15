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

      // 辨識店家與取得 Token
      const storeInfo = findStoreConfig(userId, botDestinationId);
      
      let finalStoreName = "未知店家";
      let finalUserName = "未知/ID:" + userId;
      let validToken = null;
      let sayId = null;

      if (storeInfo) {
        finalStoreName = storeInfo.storeName;
        finalUserName = storeInfo.userName;
        validToken = storeInfo.token;
        sayId = storeInfo.sayId; // [已修復] 這裡現在能正確取值了
      } else {
        finalStoreName = "無法辨識(未加好友?)";
      }

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
          addToRetentionList(userId, msg, validToken, filterResult, sayId, replyToken, botDestinationId, storeInfo);
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
      logSheet.appendRow([timestamp, userId, finalStoreName, finalUserName, msg, statusCol, handlerCol, phoneCol, replyTokenStr]);
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
function addToRetentionList(userId, triggerMsg, token, context, sayId, replyToken, botDestinationId, storeInfo) {
  var ssId = typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID ? CONFIG.INTEGRATED_SHEET_SS_ID : null;
  var ss = ssId ? SpreadsheetApp.openById(ssId) : null;
  if (!ss) return;
  let sheet = ss.getSheetByName(RETENTION_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(RETENTION_SHEET_NAME);
    sheet.appendRow(['UserID', '暱稱', '觸發時間', '狀態', '類型', 'AI建議文案', 'ReplyToken', 'BotID']);
  }
  
  const data = sheet.getDataRange().getValues();
  // A. 狀態覆蓋 (將舊的 Pending 標記為失效)
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][0] == userId && data[i][3] == "Pending") {
      sheet.getRange(i + 1, 4).setValue("Overwritten");
      sheet.getRange(i + 1, 1, 1, 7).setBackground("#eeeeee"); 
    }
  }

  // B. 準備基本資料
  let displayName = "未知用戶";
  const profile = getLineProfile(userId, token);
  if (profile && profile.displayName) displayName = profile.displayName;
  
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
  
  // D. 線上預約（查詢空位）用 reply token 傳給客人；I 欄 isReply 為 false 時不發送，其餘照常
  var rowStatus = "Pending";
  var allowReply = (storeInfo == null || storeInfo.isReply !== false);
  var isQuerySlots = (context.desc === "查詢空位");
  if (allowReply && isQuerySlots && finalContent && replyToken && token && context.type !== "IGNORE" && finalContent.indexOf("(系統") !== 0) {
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
  
  // E. 寫入 Sheet（留紀錄）
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

// 取得 LINE 使用者資料
function getLineProfile(userId, token) {
  try {
    const url = `https://api.line.me/v2/bot/profile/${userId}`;
    const options = {
      "method": "get",
      "headers": { "Authorization": "Bearer " + token },
      "muteHttpExceptions": true
    };
    const response = UrlFetchApp.fetch(url, options);
    return JSON.parse(response.getContentText());
  } catch (e) { return null; }
}

// AI 生成文案
// ==========================================
// 【暫停】AI 僅用於「客人消費狀態」；LINE 回覆改為罐頭訊息，不呼叫 Gemini。
// ==========================================
function generateContextualAI(name, context, extraInfo) {
  return `Hi ${name}，我們收到您的${context.desc}需求，稍後將有專人為您服務。`;
}

// [修正] 查空位函式 (使用台灣時區)，同一間店 10 分鐘內共用同一份空位，減少 SayDou API 呼叫
var SLOTS_CACHE_TTL_SEC = 600; // 0=關閉快取；要開啟請改為 600（10 分鐘）

function getUpcomingSlots(sayId) {
  if (!sayId) return null;
  if (SLOTS_CACHE_TTL_SEC > 0) {
    var cacheKey = "slots_" + String(sayId);
    var cache = CacheService.getScriptCache();
    var cached = cache.get(cacheKey);
    if (cached != null && cached !== "") return cached;
  }

  // 1. 設定參數
  const today = new Date();
  const threeDaysLater = new Date();
  threeDaysLater.setDate(today.getDate() + 3);
  const timeZone = Session.getScriptTimeZone();
  const startDateStr = Utilities.formatDate(today, timeZone, "yyyy-MM-dd");
  const endDateStr = Utilities.formatDate(threeDaysLater, timeZone, "yyyy-MM-dd");

  try {
    const findSlots = Core.findAvailableSlots(sayId, startDateStr, endDateStr, 1, 90, {});
    var data = (findSlots && findSlots.data) ? findSlots.data : [];
    var lines = [];
    for (var i = 0; i < data.length; i++) {
      var day = data[i];
      if (!day || !day.times) continue;
      var slotsStr = Array.isArray(day.times) ? day.times.join("、") : String(day.times);
      // 不顯示年份：yyyy-MM-dd 只取 MM-DD，其餘沿用
      var datePart = (day.date && day.date.length >= 10 && day.date.charAt(4) === "-") ? day.date.substring(5) : (day.date || "");
      var weekPart = day.week || "";
      lines.push(datePart + (weekPart ? " (" + weekPart + ")" : "") + "：" + slotsStr);
    }
    var result = (lines.length > 0) ? "近期空位:\n" + lines.join(",\n") : null;
    if (result && SLOTS_CACHE_TTL_SEC > 0) CacheService.getScriptCache().put("slots_" + String(sayId), result, SLOTS_CACHE_TTL_SEC);
    return result;
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
    const json = JSON.parse(response.getContentText());
    if (json.access_token) {
      const newExpirationTime = now + json.expires_in;
      scriptProperties.setProperty(cacheKeyToken, json.access_token);
      scriptProperties.setProperty(cacheKeyTime, newExpirationTime.toString());
      return json.access_token;
    } else { return null; }
  } catch (e) { return null; }
}
