// ==========================================
// Pending 巡航：僅對「查詢空位」(線上預約) 的 Pending 逾 3 分鐘代發 Reply；其餘類型一律不發。
// 觸發：執行 Triggers.js 的 setupAllTriggers 會建立時間驅動；或手動加觸發 → 函式選 checkTimeoutPending。
// ==========================================
function checkTimeoutPending() {
  var ssId = typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID ? CONFIG.INTEGRATED_SHEET_SS_ID : null;
  var ss = ssId ? SpreadsheetApp.openById(ssId) : null;
  if (!ss) return;
  const sheet = ss.getSheetByName('準客挽留清單');
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  const now = new Date();
  
  const TIMEOUT_MINUTES = 3;
  const ONLY_REPLY_TYPE = "查詢空位"; // 只有點擊「線上預約」才做 Reply，其餘都不發

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const userId = row[0];
    const name = row[1];
    const timeStr = row[2];
    const status = row[3];
    const intentType = row[4];  // E 欄：類型 (查詢空位 / 取消挽回 / 會員權益 等)
    const aiText = row[5];
    const replyToken = row[6];
    const botId = row[7];
    
    if (status !== "Pending" || !replyToken || !botId) continue;

    // 只有「查詢空位」(線上預約) 才代發 Reply，其餘標記 Skipped、不發送
    if (intentType !== ONLY_REPLY_TYPE) {
      sheet.getRange(i + 1, 4).setValue("Skipped");
      sheet.getRange(i + 1, 1, 1, 8).setBackground("#eeeeee");
      Logger.log(`[巡邏] 僅線上預約才 Reply，跳過: ${name} | 類型: ${intentType}`);
      continue;
    }

    const triggerTime = new Date(timeStr);
    const diffMs = now - triggerTime;
    const diffMins = diffMs / (1000 * 60);

    if (diffMins >= TIMEOUT_MINUTES) {
      // 1. 拿 BotID 換 Token
        const token = getTokenByBotId_(botId);
        
        if (token) {
          const isSuccess = sendReplyMessage(token, replyToken, aiText);
          if (isSuccess) {
            sheet.getRange(i + 1, 4).setValue("AutoReplied");
            sheet.getRange(i + 1, 1, 1, 8).setBackground("#d9ead3");
            Logger.log("[巡邏] 成功挽回: " + name + " (延遲 " + Math.floor(diffMins) + " 分)");
          } else {
            sheet.getRange(i + 1, 4).setValue("SendFailed");
            sheet.getRange(i + 1, 1, 1, 8).setBackground("#f4cccc");
            Logger.log("[巡邏] 發送失敗 (Token過期): " + name);
          }
        } else {
          Logger.log(`[巡邏] 找不到 BotID: ${botId} 的 Token`);
        }
    }
  }
}

// ----------------------------------------------------
// 輔助函式 (維持不變)
// ----------------------------------------------------

// 用 BotID 快速查 Token
function getTokenByBotId_(targetBotId) {
  var ssId = typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID ? CONFIG.INTEGRATED_SHEET_SS_ID : null;
  var ss = ssId ? SpreadsheetApp.openById(ssId) : null;
  if (!ss) return null;
  const sheet = ss.getSheetByName('店家基本資料'); 
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const channelId = row[2];
    const channelSecret = row[3];
    const botId = row[4]; 

    if (botId && botId.toString().trim() === targetBotId.toString().trim()) {
      return getLineAccessToken(channelId, channelSecret);
    }
  }
  return null;
}

// 發送 Reply Message
function sendReplyMessage(token, replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const payload = {
    "replyToken": replyToken,
    "messages": [{ "type": "text", "text": text }]
  };

  const options = {
    "method": "post",
    "headers": {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    if (code === 200) {
      return true;
    } else {
      Logger.log("Reply API 錯誤: " + response.getContentText());
      return false;
    }
  } catch (e) {
    Logger.log("Reply 連線錯誤: " + e);
    return false;
  }
}