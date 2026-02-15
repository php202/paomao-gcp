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

// [核心] 找店家設定 (已修復 sayId 漏抓問題)
function findStoreConfig(userId, destinationId) {
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
    let sayIdInSheet = row[5]; // [重要] 取得 SayDou ID

    if (!channelId || !channelSecret) continue;

    // I 欄 (index 8)：isReply，false 時不自動回覆挽留文案
    var rawReply = row[8];
    var isReply = (rawReply == null || rawReply === "") ? true : (String(rawReply).toLowerCase().trim() === "false" || rawReply === 0 ? false : true);

    // 情況 A: 表單有 Bot ID
    if (botIdInSheet && botIdInSheet.toString().trim() === destinationId) {
      const token = getLineAccessToken(channelId, channelSecret);
      let userName = "未知(未加好友)";
      if (token) {
        const fetchedName = Core.getUserDisplayName(userId, '', '', token);
        if (fetchedName) userName = fetchedName;
      }
      return { storeName, token, userName, sayId: sayIdInSheet, isReply: isReply };
    }

    // 情況 B: 表單無 Bot ID (自動補填)
    if (!botIdInSheet || botIdInSheet === "") {
      const token = getLineAccessToken(channelId, channelSecret);
      if (token) {
        const checkedBotId = getBotUserIdFromToken(token);
        if (checkedBotId === destinationId) {
          sheet.getRange(i + 1, 5).setValue(destinationId); 
          let userName = "未知(未加好友)";
          const fetchedName = Core.getUserDisplayName(userId, '', '', token);
          if (fetchedName) userName = fetchedName;
          return { storeName, token, userName, sayId: sayIdInSheet, isReply: isReply };
        }
      }
    }
  }
  return null;
}