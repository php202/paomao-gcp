// 建議放在全域變數區或 Core 裡
const coreConfig = Core.getCoreConfig();
const LINE_TOKEN_PAOSTAFF = coreConfig.LINE_TOKEN_PAOSTAFF;
const LINE_STAFF_SS_ID = coreConfig.LINE_STAFF_SS_ID;
const LINE_HQ_SS_ID = coreConfig.LINE_HQ_SS_ID;
const CHECK_IN_LINK = 'https://www.paopaomao.tw/checkin'
const FOLDER_ID = "1jrJSmi_alPOwK7cCkJUOLRAPtBl9acC3"; // 請確認 ID 正確
/** 明日預約清單關鍵字是否開放：true = 「明天預約清單」「明日預約清單」可查清單；僅「明日預約」四字仍屏蔽 */
const TOMORROW_LIST_ENABLED = true;

/** 神美日報頁面網址（可用指令碼屬性 REPORT_PAGE_URL 覆寫） */
function getReportPageUrl() {
  try {
    var url = PropertiesService.getScriptProperties().getProperty("REPORT_PAGE_URL");
    if (url && String(url).trim() !== "") return String(url).trim();
  } catch (e) {}
  return "https://www.paopaomao.tw/report";
}

function collectManagedStoreIds(auth) {
  var out = [];
  if (auth && auth.managedStores && auth.managedStores.length) {
    (auth.managedStores || []).forEach(function (s) {
      String(s).split(/[,、，]/).forEach(function (id) {
        var t = id.trim();
        if (t) out.push(t);
      });
    });
  }
  return out;
}

function collectEmployeeStoreIds(auth) {
  var out = [];
  if (auth && auth.workStores && auth.workStores.length) {
    (auth.workStores || []).forEach(function (id) {
      var t = String(id || "").trim();
      if (t) out.push(t);
    });
  } else if (auth && auth.storeIds && auth.storeIds.length) {
    (auth.storeIds || []).forEach(function (id) {
      var t = String(id || "").trim();
      if (t) out.push(t);
    });
  } else if (auth && auth.stores && auth.stores.length) {
    (auth.stores || []).forEach(function (id) {
      var t = String(id || "").trim();
      if (t) out.push(t);
    });
  }
  return out;
}

/** 明日預約 API 網址：優先讀指令碼屬性 TOMORROW_BRIEFING_WEB_APP_URL，沒有再讀 Core Config */
function getTomorrowBriefingWebAppUrl() {
  try {
    var url = PropertiesService.getScriptProperties().getProperty("TOMORROW_BRIEFING_WEB_APP_URL");
    if (url && String(url).trim() !== "") return String(url).trim();
  } catch (e) {}
  return (coreConfig.TOMORROW_BRIEFING_WEB_APP_URL && String(coreConfig.TOMORROW_BRIEFING_WEB_APP_URL).trim() !== "") ? String(coreConfig.TOMORROW_BRIEFING_WEB_APP_URL).trim() : "";
}

/** 客人狀態頁（Odoo customer-info）：明日預約清單點擊手機時導向此頁 ?token=xxx。可設指令碼屬性 CUSTOMER_INFO_PAGE_URL 覆寫。 */
function getCustomerInfoPageUrl() {
  try {
    var url = PropertiesService.getScriptProperties().getProperty("CUSTOMER_INFO_PAGE_URL");
    if (url && String(url).trim() !== "") return String(url).trim();
  } catch (e) {}
  return "https://www.paopaomao.tw/customer-info";
}

// 2. 建立一個簡單的縮寫函式，不用每次都打 Core.sendLineReply(..., ..., LINE_TOKEN)
// Invalid reply token：LINE 重試或 token 過期時會發生，token 已無法使用，不 rethrow、不寫入錯誤清單
// ★ 直接呼叫 LINE API（不經 Core），避免 PaoMao_Core 帯域幅上限
function reply(replyToken, content) {
  if (!replyToken || !LINE_TOKEN_PAOSTAFF) return;
  try {
    if (typeof content === 'string') {
      directSendLineReply(replyToken, content, LINE_TOKEN_PAOSTAFF);
    } else {
      const messages = Array.isArray(content) ? content : [content];
      directSendLineReplyObj(replyToken, messages, LINE_TOKEN_PAOSTAFF);
    }
  } catch (e) {
    var msg = (e && e.message) ? String(e.message) : String(e);
    if (msg.indexOf("Invalid reply token") !== -1) {
      try { console.log("[reply] Invalid reply token，已略過（通常為 LINE 重試）"); } catch (_) {}
      return;
    }
    throw e;
  }
}

/** 直接呼叫 LINE Reply API（不經 Core），減輕 PaoMao_Core 帯域幅負荷。失敗時 throw。 */
function directSendLineReply(replyToken, text, token) {
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    var body = res.getContentText();
    throw new Error('LINE Reply 失敗: ' + (body ? body.slice(0, 200) : res.getResponseCode()));
  }
}

/** 直接呼叫 LINE Reply API（Flex/template 等物件訊息）。失敗時 throw。 */
function directSendLineReplyObj(replyToken, messages, token) {
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    payload: JSON.stringify({ replyToken: replyToken, messages: messages }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    var body = res.getContentText();
    throw new Error('LINE Reply 失敗: ' + (body ? body.slice(0, 200) : res.getResponseCode()));
  }
}
// Debug helper: 直接測試 Core.sendLineReply 是否可用
function debugSendLineReply(replyToken, text, tokenOverride) {
  var out = {
    ok: false,
    time: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"),
    hasReplyToken: !!replyToken,
    textLength: text ? String(text).length : 0,
    hasToken: false,
    error: ""
  };
  try {
    var token = tokenOverride || LINE_TOKEN_PAOSTAFF;
    out.hasToken = !!token;
    Core.sendLineReply(replyToken, text || "debug", token);
    out.ok = true;
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  }
  return out;
}
// 與 Core 對齊：使用 Core.jsonResponse
function outputJSON(data) {
  return Core.jsonResponse(data);
}

/**
 * 問卷提交觸發：呼叫 Core API 同步小費統整表
 * 請在問卷回應試算表綁定此專案後建立「表單提交時」觸發器。
 * @param {GoogleAppsScript.Events.SheetsOnFormSubmit} e
 */
function onTipsFormSubmitCallCore(e) {
  if (!e) return;
  try {
    Core.syncLastMonthTipsConsolidated();
  } catch (err) {
    console.warn("[onTipsFormSubmitCallCore] syncLastMonthTipsConsolidated failed:", err && err.message ? err.message : err);
  }
}

/**
 * 一次性呼叫：建立「提交表單時」執行 onTipsFormSubmitCallCore 的觸發器。
 */
function createTipsFormSubmitTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction && triggers[i].getHandlerFunction() === "onTipsFormSubmitCallCore") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("onTipsFormSubmitCallCore")
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onFormSubmit()
    .create();
  console.log("[onTipsFormSubmitCallCore] Trigger created.");
}

/**
 * 從「我要了解客人0925810424」或「我要了解客人925810424」擷取手機，正規化為 09xxxxxxxx（10 碼）回傳。
 * 925810424（9 碼）會補 0 成 0925810424，與試算表 0925810424 可正確對應。
 */
function extractPhoneFromCustomerKeyword(text) {
  if (!text || typeof text !== "string") return null;
  var s = text.replace(/我要了解客人\s*/i, "").trim();
  var digits = s.replace(/\D/g, "");
  if (digits.length === 0) return null;
  if (digits.length === 9 && digits.charAt(0) === "9") {
    return "0" + digits;
  }
  if (digits.length >= 10 && digits.charAt(0) === "9") {
    return digits.slice(0, 10);
  }
  var m = text.match(/09[\d\s\-]{8,}/);
  if (m) {
    var d = m[0].replace(/\D/g, "");
    if (d.length >= 10) return d.slice(0, 10);
    if (d.length === 9 && d.charAt(0) === "9") return "0" + d;
  }
  return null;
}

/**
 * 明日預約清單：點手機可開啟 Odoo 客人狀態頁（customer-info?token=xxx）。
 * 將 API 回傳的 JSON 轉成「單則」Flex 訊息，減少頁面拉動。
 * @param {Object} listData - { dateStr, byStore: [ { storeId, storeName, items: [ { name, phone, rsvtim, token } ] } ] }
 * @param {string} customerCardBaseUrl - 保留參數（未使用），原為各店訊息一覽表 Web App 網址
 * @param {string} [recipientUserId] - LINE 收件者 userId，帶入 customer-info 連結以便追蹤是誰傳送建議
 * @returns {Object|null} 單一 Flex 訊息物件，無資料時回傳 null
 */
function buildTomorrowListMessages(listData, customerCardBaseUrl, recipientUserId) {
  if (!listData || !listData.byStore || !listData.byStore.length) return null;
  var customerInfoBase = getCustomerInfoPageUrl();
  function customerInfoUri(item) {
    var token = (item && item.token) ? String(item.token).trim() : "";
    if (!token) return "";
    var q = (customerInfoBase.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(token);
    if (recipientUserId) q += "&userId=" + encodeURIComponent(String(recipientUserId));
    return customerInfoBase + q;
  }
  function normalizePhone(phone) {
    if (!phone) return "—";
    var digits = String(phone).replace(/\D/g, "");
    if (digits.length === 9 && digits.charAt(0) === "9") return "0" + digits;
    if (digits.length >= 10) return digits.slice(-10);
    return digits;
  }
  var totalStores = 0;
  var totalGuests = 0;
  for (var s = 0; s < listData.byStore.length; s++) {
    var block = listData.byStore[s];
    var items = block.items || [];
    if (items.length > 0) {
      totalStores++;
      totalGuests += items.length;
    }
  }
  var dateStr = listData.dateStr || "";
  var bodyContents = [];
  var storeLimit = 8;
  var guestLimit = 10; // 每店單一 box 最多 10 個元件，超過則拆成多個 guestListBox
  for (var s = 0; s < listData.byStore.length && bodyContents.length < storeLimit; s++) {
    var block = listData.byStore[s];
    var storeName = block.storeName || ("店" + (block.storeId || ""));
    var items = block.items || [];
    var slotsText = (block.availableSlotsText != null && String(block.availableSlotsText).trim() !== "") ? String(block.availableSlotsText).trim() : "";
    // 只有成功取得空位時才顯示「明日可預約空位」；抓不到（—、0 個空位、空字串）就整行不顯示
    var hasValidSlots = slotsText && slotsText !== "—" && slotsText !== "0 個空位" && slotsText.indexOf("還有") >= 0;
    var headerContents = [
      { type: "text", text: "【" + storeName + "】", weight: "bold", size: "sm" },
      { type: "text", text: "明天預約人數：" + (items.length), size: "xs" }
    ];
    if (hasValidSlots) {
      headerContents.splice(1, 0, { type: "text", text: "明日可預約空位：" + slotsText, size: "xs", color: "#666666", wrap: true });
    }
    var headerBox = {
      type: "box",
      layout: "vertical",
      spacing: "none",
      contents: headerContents
    };
    var storeBlockContents = [headerBox];
    for (var chunkStart = 0; chunkStart < items.length; chunkStart += guestLimit) {
      var chunk = items.slice(chunkStart, chunkStart + guestLimit);
      var guestListContents = [];
      for (var i = 0; i < chunk.length; i++) {
        var o = chunk[i];
        var timeText = (o.timeText && String(o.timeText).trim()) ? String(o.timeText).trim().slice(0, 5) : "";
        if (!timeText && (o.rsvtim != null && o.rsvtim !== "")) {
          try {
            var s = String(o.rsvtim).trim();
            var tPart = s.split(/[T\s]/)[1] || "";
            if (tPart) timeText = tPart.slice(0, 5);
            if (!timeText && /\d{1,2}:\d{2}/.test(s)) {
              var match = s.match(/(\d{1,2}):(\d{2})/);
              if (match) timeText = match[1].padStart(2, "0") + ":" + match[2];
            }
          } catch (e) {
            timeText = "";
          }
        }
        if (!timeText && (o.start_time != null && o.start_time !== "")) {
          var st = String(o.start_time).trim();
          var stPart = st.split(/[T\s]/)[1] || "";
          if (stPart) timeText = stPart.slice(0, 5);
        }
        var name = (o.name || "—").toString().trim();
        var phone = (o.phone || "").toString().trim();
        var displayPhone = normalizePhone(phone);
        var uri = customerInfoUri(o);
        // 名字旁邊顯示預約時間：王小明（14:00）
        var mainText = timeText ? (name + "（" + timeText + "）") : name;
        if (uri) {
          guestListContents.push({
            type: "box",
            layout: "horizontal",
            margin: "none",
            contents: [
              { type: "text", text: mainText, size: "xxs", wrap: true },
              { type: "box", layout: "vertical", action: { type: "uri", uri: uri }, contents: [{ type: "text", text: displayPhone, size: "xxs", color: "#0066cc" }] }
            ]
          });
        } else {
          guestListContents.push({ type: "text", text: mainText + " " + displayPhone, size: "xxs", wrap: true, margin: "none" });
        }
      }
      storeBlockContents.push({
        type: "box",
        layout: "vertical",
        margin: "none",
        spacing: "none",
        contents: guestListContents.length ? guestListContents : [{ type: "text", text: "（無預約）", size: "xxs", color: "#999999" }]
      });
    }
    if (items.length === 0) {
      storeBlockContents.push({
        type: "box",
        layout: "vertical",
        margin: "none",
        spacing: "none",
        contents: [{ type: "text", text: "（無預約）", size: "xxs", color: "#999999" }]
      });
    }
    bodyContents.push({
      type: "box",
      layout: "vertical",
      margin: "sm",
      spacing: "none",
      contents: storeBlockContents
    });
  }
  if (totalStores > storeLimit) {
    bodyContents.push({ type: "text", text: "（僅顯示前 " + storeLimit + " 店，共 " + totalStores + " 店）", size: "xs", color: "#999999", margin: "md" });
  }
  var bubble = {
    type: "bubble",
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: "📅 明日預約 " + dateStr + " 共 " + totalStores + " 店、" + totalGuests + " 人", weight: "bold", size: "sm", wrap: true }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      margin: "none",
      spacing: "xs",
      contents: bodyContents.length ? bodyContents : [{ type: "text", text: "無預約資料", size: "xs", color: "#999999" }]
    }
  };
  return {
    type: "flex",
    altText: "明日預約 " + dateStr + " 共 " + totalStores + " 店、" + totalGuests + " 人",
    contents: bubble
  };
}

/**
 * 「我要了解客人」：透過 Core API（action=getCustomerAIResult）取得該手機的 AI分析結果並回覆。
 * 需設定指令碼屬性：PAO_CAT_CORE_API_URL（PaoMao_Core「網路應用程式」部署網址，結尾 /exec）、PAO_CAT_SECRET_KEY。
 */
function replyCustomerAIResult(replyToken, text) {
  var phone = extractPhoneFromCustomerKeyword(text);
  if (!phone) {
    reply(replyToken, "請輸入「我要了解客人」後面接手機號碼，例如：我要了解客人0925810424");
    return;
  }
  var url = PropertiesService.getScriptProperties().getProperty("PAO_CAT_CORE_API_URL");
  var key = PropertiesService.getScriptProperties().getProperty("PAO_CAT_SECRET_KEY");
  if (!url || !key) {
    reply(replyToken, "查詢失敗：未設定 Core API（請設定 PAO_CAT_CORE_API_URL、PAO_CAT_SECRET_KEY）。");
    return;
  }
  url = url.trim();
  key = key.trim();
  try {
    var res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ key: key, action: "getCustomerAIResult", phone: phone }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    var body = res.getContentText();
    if (code !== 200) {
      console.warn("[我要了解客人] Core API HTTP " + code + " 請求網址:", url);
      if (code === 404) {
        reply(replyToken, "查詢失敗（404）。請依序檢查：\n1) PAO_CAT_CORE_API_URL 是設在「泡泡貓 員工打卡 Line@」的指令碼屬性（不是 PaoMao_Core）。\n2) 網址從 PaoMao_Core 的「部署→管理部署」複製「網路應用程式」那筆，結尾為 /exec（勿用「測試部署」網址）。\n3) 瀏覽器開啟「該網址?key=您的密鑰&action=token」若也 404，表示網址錯或未選類型「網路應用程式」。\n（實際請求網址已記在員工打卡專案的執行紀錄）");
      } else {
        reply(replyToken, "查詢失敗（Core API 回傳 " + code + "）。請確認 PaoMao_Core 已部署新版本且 PAO_CAT_CORE_API_URL 正確。");
      }
      return;
    }
    var data = void 0;
    try {
      data = JSON.parse(body);
    } catch (e) {
      console.warn("[我要了解客人] Core API 回傳非 JSON:", body ? body.slice(0, 200) : "");
      reply(replyToken, "查詢失敗（Core API 回傳格式異常）。請確認 PaoMao_Core 已部署新版本且含 getCustomerAIResult。");
      return;
    }
    if (data.status === "ok") {
      var content = (data.content != null && String(data.content).trim() !== "") ? String(data.content).trim() : "該客人尚無 AI 分析結果。";
      reply(replyToken, "【客人 " + phone + " AI分析結果】\n\n" + content);
      return;
    }
    reply(replyToken, data.message || "查無此客人（" + phone + "）。");
  } catch (e) {
    console.warn("[我要了解客人] Core API 呼叫失敗:", e && e.message ? e.message : e);
    reply(replyToken, "查詢時發生錯誤。請確認：1) 已設定 PAO_CAT_CORE_API_URL、PAO_CAT_SECRET_KEY；2) PaoMao_Core 已部署新版本；3) 網路正常。");
  }
}

// 定義一個全域的 OK 回應，供 doPost 最後使用
const LINE_OK_OUTPUT = outputJSON({ status: 'ok' });

function doPost(e) {
  // ★ 1. 最外層保護：發生任何無法預期的錯誤，最後一定要回傳 OK
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return outputJSON({ status: "failed", message: "No postData" });
    }
    const payload = JSON.parse(e.postData.contents);
    // #region agent log
    try {
      console.log("[doPost payload summary]", {
        hasAction: !!(payload && payload.action),
        action: payload && payload.action ? String(payload.action) : "",
        eventsCount: Array.isArray(payload && payload.events) ? payload.events.length : 0
      });
    } catch (e) {}
    // #endregion
    // (A) 來自網頁的請求 (Action 分流)
    // 網頁請求需要等待結果，所以不能用快取鎖直接擋掉
    if (payload.action === "bind") {
       return handleBindSession(payload); 
    }
    if (payload.action === "check_in") {
      return handleCheckInAPI(payload);  
    }
    // (B) 來自 LINE Webhook 的請求 (無限迴圈發生地)
    const events = Array.isArray(payload.events) ? payload.events : [];
    if (events.length === 0) return LINE_OK_OUTPUT;

    // ★ 2. 快取：同一 eventId 只處理一次，其餘立刻跳過（LINE 重試時就不會再跑一次，避免「LINE 一直打」）
    const cache = CacheService.getScriptCache();
    for (const event of events) {
      const replyToken = event.replyToken;
      const eventId = event.webhookEventId;
      if (eventId) {
        if (cache.get(eventId)) {
          console.log(`♻️ [重複請求] 已攔截 EventID: ${eventId}，直接回傳 OK。`);
          continue;
        }
        cache.put(eventId, 'processed', 600);
      }
      try {
        if (event.type === "message") {
          routeMessageEvent(event);
        }
      } catch (innerErr) {
        console.error(`❌ 處理單一事件失敗: ${innerErr.toString()}`);
        if (replyToken) {
          try {
            reply(replyToken, "🚧 系統發生未預期的錯誤，請稍後再試或聯繫管理員。");
          } catch (replyErr) {
            console.error(`❌ 回覆錯誤訊息失敗: ${replyErr.toString()}`);
          }
        }
      }
    }
    // ★ 3. 處理完畢 (或已攔截重複)，回傳 200 OK
    return LINE_OK_OUTPUT;
  } catch (fatalError) {
    console.error(`☠️ doPost 嚴重崩潰: ${fatalError.toString()}`);
    // 發生嚴重錯誤 (例如 JSON 解析失敗)，還是要回傳 OK，不然 LINE 會一直打
    return LINE_OK_OUTPUT; 
  }
}

function routeMessageEvent(event) {
  // 定義變數在 try 外面，確保 catch 區塊也能讀取到 (用於記錄是誰出錯)
  let userId = "Unknown"; 
  let inputContent = "Unknown"; // 用來記錄使用者傳了什麼 (文字或位置)

  try {
    const msg = event.message;
    const replyToken = event.replyToken;
    
    // 1. 取得 UserId
    if (event.source && event.source.userId) {
      userId = event.source.userId;
    }

    // 2. 取得輸入內容 (用於 Log)
    if (msg.type === "text") {
      inputContent = `[文字] ${msg.text}`;
    } else if (msg.type === "location") {
      inputContent = `[位置] ${msg.address || "無地址資訊"}`;
    } else {
      inputContent = `[其他類型] ${msg.type}`;
    }

    // ==========================================
    // 邏輯開始
    // ==========================================

    // 先提取文字 (避免 ReferenceError)
    let text = "";
    if (msg.type === "text") {
      text = String(msg.text || "").trim();
    }

    // ★ 特權通道：先判斷註冊，不需要驗證權限
    if (text.includes("我要註冊")) {
      return getUserId(replyToken, userId, text);
    }

    // ★ 權限檢查 (Gatekeeper)
    // 把它移到這裡，確保連「位置訊息」也會被擋下
    const auth = isUserAuthorized(userId);
    if (!auth.isAuthorized) {
      return noAuthorized(replyToken);
    }

    // --- (A) 位置訊息 (打卡) ---
    if (msg.type === "location") {
      // 這裡不需要內部的 try-catch 了，因為最外面已經包了一層
      return getStoreDistance(event); 
    }

    // --- (B) 文字訊息 (指令) ---
    if (text) {
      // 0. 我要了解客人 + 手機：回傳該客人在「客人消費狀態」的 AI分析結果 (K 欄)
      if (text.indexOf("我要了解客人") === 0 || text.includes("我要了解客人")) {
        return replyCustomerAIResult(replyToken, text);
      }

      // 1. 完全匹配
      switch (text) {
        case "我要打卡":      return sendLocationRequest(replyToken, userId);
        case "查詢打卡記錄":  return getAtt(replyToken, userId);
        case "最新活動":      return getNews(replyToken, userId);
        case "我要開店":      return sendStoreLocationRequest(replyToken);
        case "特約商店":      return getOnlineCourse(replyToken, userId);
      }

      // 2. 集合匹配
      const attKeywords = ['店家今天出勤', '店家本月出勤', '店家上月出勤', '本月出勤', '上月出勤', '店家可預約時間'];
      if (attKeywords.includes(text)) {
        return sendAtt(replyToken, userId, text);
      }

      // 3. 部分匹配
      if (text.includes("補打卡"))      return makeUpTime(replyToken, userId, text);
      if (text.includes("Line問題集"))  return sendStoreLineQuestionRequest(replyToken, userId);

      // 3.3 神美日報：員工看當天、管理者看當月
      if (text.trim() === "神美日報") {
        var url = "";
        var key = "";
        try {
          url = PropertiesService.getScriptProperties().getProperty("PAO_CAT_CORE_API_URL") || "";
          key = PropertiesService.getScriptProperties().getProperty("PAO_CAT_SECRET_KEY") || "";
        } catch (eConf) {}
        if (!url || !key) {
          reply(replyToken, "神美日報失敗：未設定 Core API（請在本專案指令碼屬性設定 PAO_CAT_CORE_API_URL、PAO_CAT_SECRET_KEY）。");
          return;
        }
        url = url.trim();
        key = key.trim();
        var isManager = auth.identity && auth.identity.indexOf("manager") !== -1;
        var storeIds = isManager ? collectManagedStoreIds(auth) : collectEmployeeStoreIds(auth);
        if (storeIds.length === 0) {
          reply(replyToken, "無法判斷您所屬的門市，請請管理者在「管理者清單」或員工設定中補上店家代碼。");
          return;
        }
        try {
          var groupId = (event.source && event.source.groupId) ? String(event.source.groupId) : "";
          var roomId = (event.source && event.source.roomId) ? String(event.source.roomId) : "";
          var displayName = "";
          try {
            if (typeof Core !== "undefined" && typeof Core.getUserDisplayName === "function") {
              displayName = Core.getUserDisplayName(userId, groupId, roomId, LINE_TOKEN_PAOSTAFF) || "";
            }
          } catch (eDisp) {}
          var payload = {
            key: key,
            action: "createReportToken",
            role: isManager ? "manager" : "employee",
            storeIds: storeIds.join(","),
            userId: userId,
            employeeCode: (auth.employeeCode != null ? String(auth.employeeCode).trim() : ""),
            groupId: groupId,
            userName: displayName
          };
          var res = UrlFetchApp.fetch(url, {
            method: "post",
            contentType: "application/json",
            payload: JSON.stringify(payload),
            muteHttpExceptions: true
          });
          if (res.getResponseCode() !== 200) {
            reply(replyToken, "神美日報產出失敗，請稍後再試。");
            return;
          }
          var data = JSON.parse(res.getContentText() || "{}");
          if (!data || data.status !== "ok" || !data.token) {
            reply(replyToken, "神美日報產出失敗，請稍後再試。");
            return;
          }
          var reportUrl = getReportPageUrl();
          var fullUrl = reportUrl + (reportUrl.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(data.token);
          // 先送一則純文字，確保至少會出現；再送 template 按鈕（相容性較 Flex 高）
          var btnMsg = {
            type: "template",
            altText: "神美日報：請點擊按鈕開啟日報（此連結僅可使用一次）",
            template: {
              type: "buttons",
              text: "神美日報\n請點擊下方按鈕開啟日報\n（此連結僅可使用一次）",
              actions: [{ type: "uri", label: "開啟日報", uri: fullUrl }]
            }
          };
          reply(replyToken, [btnMsg]);
          return;
        } catch (e) {
          console.warn("[神美日報] 失敗:", e);
          reply(replyToken, "神美日報產出時發生錯誤，請稍後再試或聯繫管理員。");
          return;
        }
      }

      // 僅「明日預約」四字屏蔽；「明日預約清單」「明天預約清單」可查清單
      if (text.trim() === "明日預約") {
        reply(replyToken, "此功能暫時關閉，敬請見諒。");
        return;
      }

      // 3.4 明天預約清單：列出店家的明日預約（含時間、姓名、手機，點擊手機導向 Odoo 客人狀態頁）
      if (text.trim() === "明天預約清單" || text.trim() === "明日預約清單") {
        if (!TOMORROW_LIST_ENABLED) {
          reply(replyToken, "此功能暫時關閉，敬請見諒。");
          return;
        }
        // 新邏輯：管理者可以看自己管理的所有門市；一般員工可以看自己所屬／上班店家（workStores / storeIds / stores）
        var managedStoreIds = [];
        if (auth.isAuthorized && auth.identity && auth.identity.indexOf("manager") !== -1) {
          managedStoreIds = collectManagedStoreIds(auth);
        } else {
          managedStoreIds = collectEmployeeStoreIds(auth);
        }
        if (managedStoreIds.length === 0) {
          reply(replyToken, "無法判斷您所屬的門市，請請管理者在「管理者清單」或員工設定中補上店家代碼。");
          return;
        }
        var tomorrowUrl = getTomorrowBriefingWebAppUrl();
        if (!tomorrowUrl) {
          reply(replyToken, "未設定明日預約 API。請在「泡泡貓 員工打卡 Line@」專案：專案設定 → 指令碼屬性 → 新增 TOMORROW_BRIEFING_WEB_APP_URL，值為「各店訊息一覽表」部署的 Web App 網址（例：https://script.google.com/macros/s/xxx/exec）。");
          return;
        }
        try {
          var listUrl = tomorrowUrl + (tomorrowUrl.indexOf("?") >= 0 ? "&" : "?") + "action=getTomorrowReservationList&storeIds=" + encodeURIComponent(managedStoreIds.join(","));
          var listResp = UrlFetchApp.fetch(listUrl, { muteHttpExceptions: true });
          if (listResp.getResponseCode() !== 200) {
            reply(replyToken, "取得明日預約清單失敗，請稍後再試。");
            return;
          }
          var listData = JSON.parse(listResp.getContentText());
          if (listData.closed === true) {
            reply(replyToken, listData.message || "明日預約報告當日已關閉，當日不提供預約清單。");
            return;
          }
          var flexMsg = buildTomorrowListMessages(listData, tomorrowUrl, userId);
          if (!flexMsg) {
            reply(replyToken, "📅 明日（" + (listData.dateStr || "") + "）您負責的店家目前無預約。");
            return;
          }
          reply(replyToken, flexMsg);
          return;
        } catch (e) {
          console.warn("[明天預約清單] 失敗:", e);
          reply(replyToken, "取得明日預約清單時發生錯誤，請稍後再試或聯繫管理員。");
          return;
        }
      }

      // 3.5a 上月小費：導向 Dashboard 個人頁面（不再產 Google Sheet 連結）
      if (text.trim() === "上月小費" || text.indexOf("上月小費") >= 0) {
        if (!auth.isAuthorized) {
          reply(replyToken, "⚠️ 你的帳號尚未開通，請等待管理員開通後再使用「上月小費」。");
          return;
        }
        try {
          // 計算上個月 YYYY-MM
          var now = new Date();
          var lastM = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          var ym = Utilities.formatDate(lastM, TZ, 'yyyy-MM');
          var dashboardUrl = "https://dashboard.paopaomao.tw/my#tips";
          var downloadUrl = "https://dashboard.paopaomao.tw/api/tips/my/excel?month=" + ym;
          reply(replyToken, "✅ 上月小費（" + ym + "）\n\n📊 線上查看：\n" + dashboardUrl + "\n\n📥 下載 Excel：\n" + downloadUrl + "\n\n💡 需先用 LINE 登入儀表板");
          return;
        } catch (err) {
          var errMsg = (err && err.message) ? err.message : String(err);
          console.warn("[上月小費] 例外:", errMsg);
          try {
            reply(replyToken, "上月小費報告發生錯誤：" + errMsg);
          } catch (_) {
            reply(replyToken, "上月小費報告發生錯誤，請稍後再試或聯繫管理員。");
          }
          return;
        }
      }

      // 3.4 店家回覆狀態（僅限管理者；從訊息一覽動態計算直營店未回覆數與完成率）
      if (text.indexOf("店家回覆狀態") !== -1) {
        if (!auth.identity || auth.identity.indexOf("manager") === -1) {
          reply(replyToken, "此功能僅限管理者使用。");
          return;
        }
        try {
          var directResult = typeof Core !== "undefined" && typeof Core.getDirectStoreReplyStatusText === "function"
            ? Core.getDirectStoreReplyStatusText()
            : { ok: false, message: "此功能需更新 Core 程式庫。" };
          reply(replyToken, directResult.ok ? directResult.text : directResult.message);
          return;
        } catch (eDir) {
          console.warn("[店家回覆狀態] 產出失敗:", eDir);
          reply(replyToken, "店家回覆狀態發生錯誤，請稍後再試或聯繫管理員。");
          return;
        }
      }

      // 3.5 報告關鍵字（僅限「管理者清單」內的使用者；只回傳該 user 管理的門市）
      const reportHandler = typeof Core !== "undefined" && typeof Core.getReportHandlerFromKeyword === "function"
        ? Core.getReportHandlerFromKeyword(text)
        : null;
      if (reportHandler && typeof Core !== "undefined" && typeof Core.getReportTextForKeyword === "function") {
        if (!auth.identity || auth.identity.indexOf("manager") === -1) {
          reply(replyToken, "此報告僅限管理者使用。請確認您已於「管理者清單」中設定。");
          return;
        }
        try {
          var managedStoreIds = [];
          (auth.managedStores || []).forEach(function (s) {
            String(s).split(/[,、，]/).forEach(function (id) {
              var t = id.trim();
              if (t) managedStoreIds.push(t);
            });
          });
          var reportText = null;
          var tomorrowBriefingUrl = getTomorrowBriefingWebAppUrl();
          if (reportHandler === "tomorrow" && tomorrowBriefingUrl) {
            try {
              var url = tomorrowBriefingUrl + (tomorrowBriefingUrl.indexOf("?") >= 0 ? "&" : "?") + "action=getTomorrowBriefing&storeIds=" + encodeURIComponent(managedStoreIds.join(","));
              var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
              if (resp.getResponseCode() === 200) reportText = resp.getContentText();
            } catch (webErr) {
              console.warn("[明日預約 AI] Web App 呼叫失敗:", webErr);
            }
          }
          if (!reportText) {
            const result = Core.getReportTextForKeyword(reportHandler, { managedStoreIds: managedStoreIds });
            if (result && result.text) reportText = result.text;
          }
          if (reportText) {
            return reply(replyToken, reportText);
          }
          return;
        } catch (e) {
          console.warn("[報告關鍵字] 產出失敗:", e);
          reply(replyToken, "產出報告時發生錯誤，請稍後再試或聯繫管理員。");
          return;
        }
      }

      // 4. 公司流程 (最後一關)
      const workflowLink = typeof Core !== "undefined" && typeof Core.getWorkflowLink === "function" ? Core.getWorkflowLink(text) : null;
      if (workflowLink) {
        return reply(replyToken, `請點擊:\n${workflowLink}`);
      }

      // 無對應指令時不回覆，已讀不回
    }

  } catch (error) {
    // ==========================================
    // 🚨 發生錯誤時的處理區
    // ==========================================
    console.error(`[系統錯誤] User: ${userId}, Input: ${inputContent}`, error);
    
    // 1. 寫入 Google Sheet 除錯清單
    logErrorToSheet(userId, inputContent, error);

    // 2. (選用) 回覆使用者，讓他知道系統出錯了，而不是已讀不回
    // 只有在還拿到 replyToken 的情況下才能回覆
    if (event.replyToken) {
        reply(event.replyToken, "🚧 系統發生未預期的錯誤，已自動回報給管理員進行修復。");
    }
  }
}