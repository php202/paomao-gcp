function getStoreConfig(botId) {
  var ssId = typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID ? CONFIG.INTEGRATED_SHEET_SS_ID : null;
  var ss = ssId ? SpreadsheetApp.openById(ssId) : null;
  if (!ss) return null;
  const configSheet = ss.getSheetByName('店家基本資料');
  
  // 抓取整張表的資料
  const configData = configSheet.getDataRange().getValues();

  // 從第 2 列開始跑迴圈 (假設第 1 列 i=0 是標題列)
  for (let i = 1; i < configData.length; i++) {
    const row = configData[i];
    
    // 欄位對應 (注意：程式中的陣列索引是從 0 開始)
    // A=0, B=1, C=2, D=3, E=4, F=5, G=6, H=7
    
    // 我們要比對的是 E 欄 (Index 4) 的 Bot ID
    const rowBotId = row[6]; 

    if (rowBotId && rowBotId.toString().trim() === botId) {
      return {
        storeName: row[1], // B欄: 店家名稱
        sayId: row[5],     // F欄: 神美 ID (SayDou ID)
        usrsid: row[7]     // H欄: 預設服務人員 ID (如果有用到的話)
      };
    }
  }
  
  // 如果跑完整張表都沒找到，回傳 null
  return null;
}

// [核心] 找店家設定；傳入 groupId/roomId 時 Core 會打 /group/member 或 /room/member，群組內使用者名稱才正確
function findStoreConfig(userId, destinationId, groupId, roomId) {
  var gid = (groupId != null && String(groupId).trim()) ? String(groupId).trim() : "";
  var rid = (roomId != null && String(roomId).trim()) ? String(roomId).trim() : "";
  var ssId = typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID ? CONFIG.INTEGRATED_SHEET_SS_ID : null;
  var ss = ssId ? SpreadsheetApp.openById(ssId) : null;
  if (!ss) return null;
  const sheet = ss.getSheetByName('店家基本資料'); 
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const storeName = row[1]; 
    const channelId = row[2].toString().trim(); 
    const channelSecret = row[3].toString().trim(); 
    let botIdInSheet = row[4]; 
    let sayIdInSheet = row[5];

    if (!channelId || !channelSecret) continue;

    var rawReply = row[8];
    var isReply = (rawReply == null || rawReply === "") ? true : (String(rawReply).toLowerCase().trim() === "false" || rawReply === 0 ? false : true);

    if (botIdInSheet && botIdInSheet.toString().trim() === destinationId) {
      const token = getLineAccessToken(channelId, channelSecret);
      if (!token && typeof appendErrorLog === "function") {
        appendErrorLog(
          "findStoreConfig: destination match 但 token 取得失敗，store=" + String(storeName || "") + ", row=" + (i + 1) + ", channelIdTail=" + String(channelId).slice(-6),
          "LINE token"
        );
      }
      // userName 改由 handleLineWebhook 統一取得，避免同一事件重複打 LINE API
      let userName = " ";
      return { storeName, token, userName, sayId: sayIdInSheet, isReply: isReply };
    }

    if (!botIdInSheet || botIdInSheet === "") {
      const token = getLineAccessToken(channelId, channelSecret);
      if (token) {
        const checkedBotId = getBotUserIdFromToken(token);
        if (checkedBotId === destinationId) {
          sheet.getRange(i + 1, 5).setValue(destinationId); 
          // userName 改由 handleLineWebhook 統一取得，避免同一事件重複打 LINE API
          let userName = " ";
          return { storeName, token, userName, sayId: sayIdInSheet, isReply: isReply };
        }
      }
    }
  }
  if (typeof appendErrorLog === "function") {
    appendErrorLog(
      "findStoreConfig: 找不到 destination 對應店家，destination=" + String(destinationId || "") + ", uid=" + String(userId || ""),
      "LINE webhook"
    );
  }
  return null;
}