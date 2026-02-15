function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🛠 帳務工具')
      .addItem('🚀 預約表單（每天早上都有跑）', 'runReservationReport')
      .addItem('🚀 儲值金', 'storeData')
      .addItem('🚀 通知未繳錢的', 'dailyCheckAndPush')
      .addToUi();
}
// ==========================================
// [Client] Main.gs - 主要入口
// ==========================================

function doPost(e) {
  try {
    // 1. 安全檢查
    if (!e || !e.postData || !e.postData.contents) {
      return Core.jsonResponse({ status: "error", message: "No post data" });
    }
    const postData = e.postData.contents;
    const data = JSON.parse(postData);
    // 2. 路由分流
    if (data.events) {
      // === 情況 A: LINE Webhook ===
      const events = data.events;
      const coreConfig = Core.getCoreConfig();
      const paopaoToken = coreConfig && coreConfig.LINE_TOKEN_PAOPAO ? coreConfig.LINE_TOKEN_PAOPAO : '';

      for (const event of events) {
        if (event.type === 'postback') {
          handleConfirmPostback(event);
        } else if (event.type === 'message' && event.message && event.message.type === 'text') {
          const text = (event.message.text || '').trim();
          if (text.includes("店家回覆狀態")) {
            handleDirectStoreReplyStatus(event, paopaoToken);
            continue;
          }
          const reportHandler = typeof Core.getReportHandlerFromKeyword === 'function' ? Core.getReportHandlerFromKeyword(text) : null;
          if (reportHandler && paopaoToken) {
            const userId = (event.source && event.source.userId) || '';
            const auth = typeof Core.getManagerManagedStores === 'function' ? Core.getManagerManagedStores(userId) : { isManager: false, managedStores: [] };
            if (!auth.isManager) {
              // 非管理者查詢報告時不再回覆提示訊息（依需求隱藏此文字）
              return;
            } else if (!auth.managedStores || auth.managedStores.length === 0) {
              Core.sendLineReply(event.replyToken, '請於「管理者清單」設定您管理的門市（第 3 欄）。', paopaoToken);
            } else {
              try {
                const managedStoreIds = (auth.managedStores || []).map(function (s) { return String(s).trim(); });
                const result = Core.getReportTextForKeyword(reportHandler, { managedStoreIds: managedStoreIds });
                if (result && result.text) {
                  Core.sendLineReply(event.replyToken, result.text, paopaoToken);
                }
              } catch (err) {
                Core.sendLineReply(event.replyToken, '產出報告時發生錯誤，請稍後再試或聯繫管理員。', paopaoToken);
              }
            }
          }
        }
      }

      // 處理訊息紀錄
      handleLineWebhook(data, paopaoToken);
      
      // 回傳標準 LINE 成功訊號
      return Core.jsonResponse({ status: "ok" });

    } else if (data.cookie) {
      // === 情況 B: Update Cookie ===
      return handleUpdateCookie(data);

    } else if (data.token) {
      // === 情況 C: Update Token ===
      return handleUpdateToken(data);

    } else {
      return Core.jsonResponse({ status: "error", message: "Unknown Request" });
    }

  } catch (error) {
    var msg = (error && error.message) ? error.message : String(error);
    console.error("System Error: " + msg);
    try { appendErrorLog(msg, "doPost"); } catch (logErr) {}
    // 發生錯誤仍回傳 OK 給 LINE，避免無限重試
    return Core.jsonResponse({ status: "error", message: "System Error" });
  }
}

// ==========================================
// 店家回覆狀態（僅直營店 / pao 官方 Line@ 接收與回覆）
// 邏輯已移至 Core.getDirectStoreReplyStatusText，從「訊息一覽」動態計算
// ==========================================
function handleDirectStoreReplyStatus(event, paopaoToken) {
  if (!paopaoToken) return;
  var userId = (event.source && event.source.userId) || "";
  var auth = typeof Core.getManagerManagedStores === "function" ? Core.getManagerManagedStores(userId) : { isManager: false };
  if (!auth.isManager) {
    Core.sendLineReply(event.replyToken, "此功能僅限管理者使用。", paopaoToken);
    return;
  }
  var result = typeof Core.getDirectStoreReplyStatusText === "function" ? Core.getDirectStoreReplyStatusText() : { ok: false, message: "此功能需更新 Core 程式庫。" };
  Core.sendLineReply(event.replyToken, result.ok ? result.text : result.message, paopaoToken);
}

function summarizeErrorText(text, maxLen) {
  var s = (text == null) ? "" : String(text);
  s = s.replace(/\s+/g, " ").trim();
  var limit = (maxLen && maxLen > 0) ? maxLen : 220;
  return s.length > limit ? (s.substring(0, limit) + "...") : s;
}

function fetchDisplayNameFromLineDirect(userId, groupId, roomId, token) {
  if (!userId || !token) return "";
  var url;
  var route = "profile";
  if (groupId) {
    url = "https://api.line.me/v2/bot/group/" + groupId + "/member/" + userId;
    route = "groupMember";
  } else if (roomId) {
    url = "https://api.line.me/v2/bot/room/" + roomId + "/member/" + userId;
    route = "roomMember";
  } else {
    url = "https://api.line.me/v2/bot/profile/" + userId;
  }
  try {
    var res = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { Authorization: "Bearer " + token },
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code !== 200) {
      if (typeof appendErrorLog === "function") {
        appendErrorLog("PAOPAO 直打 displayName 非200: code=" + code + ", route=" + route + ", uid=" + userId + ", body=" + summarizeErrorText(res.getContentText(), 220), "LINE displayName");
      }
      return "";
    }
    var json = JSON.parse(res.getContentText());
    return (json && json.displayName) ? String(json.displayName).trim() : "";
  } catch (err) {
    if (typeof appendErrorLog === "function") {
      appendErrorLog("PAOPAO 直打 displayName 例外: " + ((err && err.message) ? err.message : String(err)), "LINE displayName");
    }
    return "";
  }
}

// ==========================================
// 子函式 1: 處理 Gogoshop Cookie 更新
// ==========================================
function handleUpdateCookie(data) {
  const ss = SpreadsheetApp.openById(PAOPAO_STORE_SS_ID);
  const sheet = ss.getSheetByName('安全庫存');
  if (!sheet) return Core.jsonResponse({ error: "Sheet '安全庫存' not found" });
  
  sheet.getRange('P1:Q1').setValues([[data.cookie, new Date()]]);
  
  try {
    gogoshopStocksReport(); 
  } catch(e) {
    console.error("Report Error: " + e.toString());
  }
  
  return Core.jsonResponse({ status: "success", message: "Cookie Updated" });
}

// ==========================================
// 功能 1: 處理 LINE 訊息 (批次寫入)
// ==========================================
function handleLineWebhook(data, lineToken) {
  const events = data.events;
  const logData = []; 

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    
    // 只記錄文字訊息
    if (event.type === 'message' && event.message.type === 'text') {
      const msg = event.message.text;
      const replyToken = event.replyToken;
      const userId = (event.source && event.source.userId) ? String(event.source.userId).trim() : "";
      const timestamp = new Date();

      // --- 處理來源 ---
      let sourceName = "個人私訊";
      let groupId = null;
      let roomId = null;
      
      if (event.source.type === 'group') {
        groupId = event.source.groupId;
        
        // ★★★ 修改重點：改用 Core 的函式 ★★★
        // 假設 Core 裡已經有了 getGroupName (含快取)
        const groupName = Core.getGroupName(groupId, lineToken);
        sourceName = `[群] ${groupName}`; 

      } else if (event.source.type === 'room') {
        roomId = event.source.roomId;
        sourceName = `[聊天室] ${roomId}`;
      }

      // --- 取得發言者姓名 (Core) ---
      var userName = "";
      if (userId && lineToken) {
        userName = Core.getUserDisplayName(userId, groupId, roomId, lineToken) || "";
        if (!userName) userName = fetchDisplayNameFromLineDirect(userId, groupId, roomId, lineToken) || "";
      }
      if (!userName && typeof appendErrorLog === "function") {
        appendErrorLog(
          "PAOPAO 取得姓名為空: hasUserId=" + (userId ? "Y" : "N") + ", hasToken=" + (lineToken ? "Y" : "N") + ", uid=" + userId + ", gid=" + (groupId || "") + ", rid=" + (roomId || ""),
          "LINE displayName"
        );
      }

      logData.push([timestamp, replyToken, sourceName, userName, msg, groupId, roomId]);
    }
  }

  // --- 批次寫入 ---
  if (logData.length > 0) {
    const ss = SpreadsheetApp.openById(PAOPAO_STORE_SS_ID);
    let logSheet = ss.getSheetByName('訊息一覽');
    if (!logSheet) {
      logSheet = ss.insertSheet('訊息一覽');
      logSheet.appendRow(['時間', 'ReplyToken', '來源', '姓名', '訊息內容', 'GID', 'RID']);
    }

    const lastRow = logSheet.getLastRow();
    logSheet.getRange(lastRow + 1, 1, logData.length, logData[0].length).setValues(logData);
  }
}

// ==========================================
// 功能 2: 更新 Token
// ==========================================
function handleUpdateToken(data) {
  const ss = SpreadsheetApp.openById(PAOPAO_STORE_SS_ID);
  const sheet = ss.getSheetByName('預約表單');
  if (!sheet) return Core.jsonResponse({ error: "Sheet '預約表單' not found" });
  sheet.getRange('C2:D2').setValues([[data.token, new Date()]]);
  return Core.jsonResponse({ status: "success", message: "Token Updated" });
}