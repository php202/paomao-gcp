// LineBot.gs

// 發送 Flex Message (支援收款綠色/付款橘色)
function sendLineConfirmButton(storeName, itemsText, totalAmount, rowNum, odooId, groupId, isPayment) {
  if (!groupId) return;
  const url = 'https://api.line.me/v2/bot/message/push';
  const themeColor = isPayment ? "#FF5733" : "#1DB446"; 
  const titleText = isPayment ? "💰 付款通知" : "📢 請款提醒";
  const footerText = isPayment ? `泡泡貓將付款給您：$${totalAmount} 元` : `ACH 將自動扣款：$${totalAmount} 元`;
  const safeItemsText = itemsText.length > 500 ? itemsText.substring(0, 500) + "\n... (更多)" : itemsText;

  const payload = {
    'to': groupId,
    'messages': [{
      "type": "flex",
      "altText": `${titleText}：${storeName}`,
      "contents": {
        "type": "bubble",
        "header": {
          "type": "box", "layout": "vertical",
          "contents": [
            { "type": "text", "text": titleText, "weight": "bold", "color": themeColor, "size": "sm" },
            { "type": "text", "text": `單號 ID: ${odooId}`, "size": "xs", "color": "#aaaaaa", "margin": "xs" }
          ]
        },
        "body": {
          "type": "box", "layout": "vertical",
          "contents": [
            { "type": "text", "text": storeName || "店家", "weight": "bold", "size": "md" },
            { "type": "separator", "margin": "md" },
            { "type": "text", "text": safeItemsText, "wrap": true, "size": "xs", "margin": "md", "color": "#555555", "lineSpacing": "4px" },
            { "type": "separator", "margin": "md" },
            { "type": "box", "layout": "vertical", "margin": "md", "contents": [
                { "type": "text", "text": "如果以上內容正確，請點擊下方按鈕確認。", "size": "xs", "color": "#888888", "wrap": true },
                { "type": "text", "text": footerText, "size": "sm", "weight": "bold", "margin": "xs", "color": "#333333" }
            ]}
          ]
        },
        "footer": {
          "type": "box", "layout": "vertical",
          "contents": [{ "type": "button", "style": "primary", "color": themeColor, "height": "sm", "action": { "type": "postback", "label": "正確", "data": "action=confirm&storeName=" + encodeURIComponent(storeName || "") + "&odoo=" + encodeURIComponent(odooId || "") } }]
        }
      }
    }]
  };
  var res = UrlFetchApp.fetch(url, { method: 'post', headers: { 'Authorization': 'Bearer ' + LINE_TOKEN_PAOPAO, 'Content-Type': 'application/json' }, payload: JSON.stringify(payload), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    var body = res.getContentText();
    console.error("[Core] sendLineConfirmButton LINE API 錯誤: " + res.getResponseCode() + " " + body);
    throw new Error("LINE Push 失敗: " + (body ? body.slice(0, 200) : res.getResponseCode()));
  }
}

// 一般回覆
function sendLineReply(replyToken, text, token) {
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    var body = res.getContentText();
    console.error("[Core] sendLineReply LINE API 錯誤: " + res.getResponseCode() + " " + body);
    throw new Error("LINE Reply 失敗: " + (body ? body.slice(0, 200) : res.getResponseCode()));
  }
}
// 物件訊息
function sendLineReplyObj(replyToken, messages, token) {
  const url = "https://api.line.me/v2/bot/message/reply";
  try {
    var res = UrlFetchApp.fetch(url, {
      "method": "post",
      "headers": {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      },
      "payload": JSON.stringify({
        "replyToken": replyToken,
        "messages": messages
      }),
      "muteHttpExceptions": true
    });
    var code = res.getResponseCode();
    if (code !== 200) {
      var body = res.getContentText();
      console.error("[Core] sendLineReplyObj LINE API 非 200: " + code + " " + (body ? body.slice(0, 300) : ""));
      throw new Error("LINE reply API " + code + (body ? ": " + body.slice(0, 200) : ""));
    }
  } catch (e) {
    console.error("[Core] sendLineReplyObj Error:", e);
    throw e;
  }
}

/**
 * Push 純文字訊息給指定 userId（不需 replyToken，可主動推給店家管理者等）
 * @param {string} userId - LINE 使用者 ID
 * @param {string} text - 訊息內容（單則上限約 5000 字，過長請自行分段）
 * @param {string} token - Channel Access Token（例：LINE_TOKEN_PAOSTAFF）
 */
function sendLinePushText(userId, text, token) {
  if (!userId || !text || !token) return;
  const url = "https://api.line.me/v2/bot/message/push";
  const maxLen = 4500;
  const messages = [];
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = remaining.length > maxLen ? remaining.slice(0, maxLen) : remaining;
    remaining = remaining.length > maxLen ? remaining.slice(maxLen) : "";
    messages.push({ type: "text", text: chunk });
  }
  try {
    UrlFetchApp.fetch(url, {
      method: "post",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      payload: JSON.stringify({ to: userId, messages: messages }),
      muteHttpExceptions: true
    });
  } catch (e) {
    console.error("[Core] sendLinePushText Error:", e);
  }
}

/**
 * 發送回訪提醒 Flex Message（含可預約時段按鈕）
 * @param {string} lineUserId - LINE 使用者 ID
 * @param {string} customerName - 客戶名稱
 * @param {string} lastVisitDate - 上次來訪日期，如 "1/1"
 * @param {number} daysSince - 距上次已過天數
 * @param {string} suggestedDate - 建議回訪日，如 "2026-02-05"
 * @param {Array<string>} availableSlots - 可預約時段陣列，如 ["11:00","14:00","16:00"]
 * @param {string} phone - 客戶手機
 * @param {string} storeId - 分店 SayDou ID
 * @param {string} storeName - 分店名稱
 * @param {string} token - Channel Access Token
 */
function sendReengagementFlexMessage(lineUserId, customerName, lastVisitDate, daysSince, suggestedDate, availableSlots, phone, storeId, storeName, token) {
  if (!lineUserId || !token) return false;
  var suggestedShort = suggestedDate;
  if (suggestedDate && suggestedDate.length >= 10) {
    var parts = suggestedDate.split("-");
    if (parts.length >= 2) suggestedShort = parts[1] + "/" + parts[2];
  }
  var slotButtons = [];
  var maxSlots = Math.min(availableSlots && availableSlots.length ? availableSlots.length : 0, 3);
  for (var i = 0; i < maxSlots; i++) {
    var slot = availableSlots[i];
    var postbackData = "action=book_reengagement&phone=" + encodeURIComponent(phone || "") + "&storeId=" + encodeURIComponent(storeId || "") + "&slot=" + encodeURIComponent(slot || "") + "&suggestedDate=" + encodeURIComponent(suggestedDate || "");
    slotButtons.push({
      type: "button",
      style: "primary",
      action: { type: "postback", label: slot || "", data: postbackData }
    });
  }
  if (slotButtons.length === 0) {
    slotButtons.push({
      type: "button",
      action: { type: "uri", label: "聯繫預約", uri: "https://line.me/R/ti/p/@paopao" }
    });
  }
  var bodyContents = [
    { type: "text", text: "您好" + (customerName ? " " + customerName : "") + "！", weight: "bold", size: "md" },
    { type: "text", text: "您上次來的時間 " + (lastVisitDate || "—") + " 已經過了 " + (daysSince || 0) + " 天", wrap: true, size: "sm" },
    { type: "text", text: "到了您習慣的保養時間囉～", wrap: true, size: "sm", margin: "md" },
    { type: "text", text: "建議回訪日：" + (suggestedShort || "—"), size: "sm" },
    { type: "text", text: "分店：" + (storeName || "—"), size: "xs", color: "#666666" }
  ];
  var footerContents = [
    { type: "text", text: "請選擇預約時段：", size: "xs", margin: "md" },
    { type: "box", layout: "horizontal", margin: "sm", contents: slotButtons }
  ];
  var bubble = {
    type: "bubble",
    header: {
      type: "box", layout: "vertical",
      contents: [{ type: "text", text: "回訪提醒", weight: "bold", size: "lg" }]
    },
    body: { type: "box", layout: "vertical", contents: bodyContents },
    footer: { type: "box", layout: "vertical", contents: footerContents }
  };
  var payload = {
    to: lineUserId,
    messages: [{ type: "flex", altText: "回訪提醒：" + (suggestedShort || ""), contents: bubble }]
  };
  try {
    var res = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
      method: "post",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    return res.getResponseCode() === 200;
  } catch (e) {
    console.error("[Core] sendReengagementFlexMessage Error:", e);
    return false;
  }
}

// 取得使用者名稱
function getUserDisplayName(userId, groupId, roomId, token) {
  if (!userId) return "未知用戶";

  // --- 快取機制 ---
  // 使用 userId 作為主要 Key，這樣同一個人在不同群組講話也能吃到快取
  const cache = CacheService.getScriptCache();
  const cacheKey = `UNAME_${userId}`; 
  const cachedName = cache.get(cacheKey);

  if (cachedName) return cachedName;
  // ----------------

  try {
    // 依照優先順序決定 API URL (群組優先 -> 聊天室 -> 個人)
    let url = groupId ? `https://api.line.me/v2/bot/group/${groupId}/member/${userId}` :
              roomId ? `https://api.line.me/v2/bot/room/${roomId}/member/${userId}` :
              `https://api.line.me/v2/bot/profile/${userId}`;

    const res = UrlFetchApp.fetch(url, { 
      headers: { 'Authorization': 'Bearer ' + token }, 
      muteHttpExceptions: true 
    });

    if (res.getResponseCode() !== 200) {
      return "未知用戶";
    }

    const json = JSON.parse(res.getContentText());
    const displayName = json.displayName || "未知用戶";

    // 寫入快取 (存 6 小時)
    // 這樣下次這個人再講話，就不用問 LINE 了
    cache.put(cacheKey, displayName, 21600);

    return displayName;
  } catch (e) { 
    console.error(`[Core] getUserDisplayName Error: ${e}`);
    return "未知用戶"; 
  }
}
function getGroupName(groupId, token) {
  if (!token || !groupId) return groupId;

  // --- 快取機制 ---
  const cache = CacheService.getScriptCache();
  const cacheKey = `GNAME_${groupId}`; // Key: GNAME_C12345...
  const cachedName = cache.get(cacheKey);
  
  if (cachedName) return cachedName; // 有快取直接回傳
  // ----------------

  try {
    const url = `https://api.line.me/v2/bot/group/${groupId}/summary`;
    const res = UrlFetchApp.fetch(url, { 
      headers: { 'Authorization': 'Bearer ' + token }, 
      muteHttpExceptions: true 
    });

    // 檢查 HTTP 狀態碼 (非 200 代表失敗，可能是機器人不在群組內)
    if (res.getResponseCode() !== 200) {
      return `未知群組(${groupId})`;
    }

    const json = JSON.parse(res.getContentText());
    const name = json.groupName || "未命名群組";
    
    // 寫入快取 (存 6 小時 = 21600 秒)
    cache.put(cacheKey, name, 21600);
    
    return name;
  } catch (e) {
    console.error(`[Core] getGroupName Error: ${e}`);
    return groupId; // 失敗時回傳 ID
  }
}

// 傳送 Line 結案資料
function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}


/**
 * 發送「已核銷收據」樣式的 Flex Message
 * 特色：灰色標頭，給予使用者「已完成」的視覺回饋
 */
// [PaoMao_Core] LineBot.gs
function pushFlexReceipt(targetId, storeName, odooId, operatorName) {
  const url = 'https://api.line.me/v2/bot/message/push'; // ★ 改成 Push
  const timestamp = Utilities.formatDate(new Date(), "GMT+8", "yyyy/MM/dd HH:mm");

  const safeStoreName = storeName || "未知店家";

  const payload = {
    'to': targetId,
    'messages': [{
      "type": "flex",
      "altText": "✅ 核銷完成憑證",
      "contents": {
        "type": "bubble",
        "header": {
          "type": "box",
          "layout": "vertical",
          "backgroundColor": "#d1d1d1", // ★ 灰色背景設定在這裡最安全
          "contents": [
            { 
              "type": "text", 
              "text": "已確認 / CONFIRMED", 
              "weight": "bold", 
              "color": "#555555", 
              "size": "sm", 
              "align": "center"
            }
          ]
        },
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            { "type": "text", "text": safeStoreName, "weight": "bold", "size": "lg", "align": "center", "color": "#333333" },
            { "type": "separator", "margin": "md" },
            {
              "type": "box",
              "layout": "vertical",
              "margin": "md",
              "spacing": "sm",
              "contents": [
                {
                  "type": "box", "layout": "baseline",
                  "contents": [
                    { "type": "text", "text": "Odoo 單號", "color": "#aaaaaa", "size": "xs", "flex": 2 },
                    { "type": "text", "text": String(odooId), "wrap": true, "color": "#666666", "size": "xs", "flex": 4 }
                  ]
                },
                {
                  "type": "box", "layout": "baseline",
                  "contents": [
                    { "type": "text", "text": "操作人員", "color": "#aaaaaa", "size": "xs", "flex": 2 },
                    { "type": "text", "text": operatorName, "wrap": true, "color": "#666666", "size": "xs", "flex": 4 }
                  ]
                },
                {
                  "type": "box", "layout": "baseline",
                  "contents": [
                    { "type": "text", "text": "確認時間", "color": "#aaaaaa", "size": "xs", "flex": 2 },
                    { "type": "text", "text": timestamp, "wrap": true, "color": "#666666", "size": "xs", "flex": 4 }
                  ]
                }
              ]
            }
          ]
        },
        "footer": {
           "type": "box", "layout": "vertical",
           "contents": [
             { "type": "text", "text": "此單據已結案，請勿重複操作", "size": "xxs", "color": "#bbbbbb", "align": "center" }
           ]
        }
      }
    }]
  };

  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + LINE_TOKEN_PAOPAO, 'Content-Type': 'application/json' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    var body = res.getContentText();
    console.error("[Core] pushFlexReceipt LINE API 錯誤: " + res.getResponseCode() + " " + body);
    throw new Error("LINE 收據 Push 失敗: " + (body ? body.slice(0, 200) : res.getResponseCode()));
  }
  console.log("[Core] 收據 Push 成功 (To: " + targetId + ")");
}