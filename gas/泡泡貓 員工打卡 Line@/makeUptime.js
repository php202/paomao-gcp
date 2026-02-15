// function makeUpTime(replyToken, userId, message) {
//   const { isAuthorized } = isUserAuthorized(userId)
//   // 我要記錄這個人
//   if (isAuthorized) {
//     const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("補打卡");
//     let status;
//     if (message.includes("上班")) {
//       status = "上班";
//       sheet.appendRow([userId, Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"), status, "店家", "","","補打卡", message]);
//     } else if (message.includes("下班")) {
//       status = "下班";
//       sheet.appendRow([userId, Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"), status, "店家", "","","補打卡", message]);
//     } else {
//       // 第三種情況：沒有「上班」也沒有「下班」
//       reply(replyToken, "複製這段，並打上資訊\n\n補打卡\n店家:\n補登時間:\n輸入上/下班：\n\n幫您做補登");
//     }
//     // 告訴他的UseId
//     reply(replyToken, "您的申請已經送出，並記錄於列表中。");
//   } else {
//     reply(replyToken, "請先註冊");
//   }
// }

function makeUpTime(replyToken, userId, message) {
  // 1. 權限與身分檢查 (順便拿店家資訊，不用使用者自己打)
  const auth = isUserAuthorized(userId);
  if (!auth.isAuthorized) {
    return reply(replyToken, "您尚未註冊或無權限，無法使用補打卡功能。");
  }

  // 2. 定義正規表達式 (Regex) 來抓取資料
  // 支援格式： "補登時間: 2025/02/01 09:00" 或 "輸入上/下班：上班"
  // [:\：] 兼容半形與全形冒號
  const timeRegex = /補登時間[:：]\s*([0-9\/\-\s:]+)/;
  const typeRegex = /輸入上\/下班[:：]\s*(.+)/;

  // 3. 判斷使用者是「剛點擊按鈕」還是「已經填好送出」
  
  // 情況 A：使用者只輸入 "補打卡" -> 回傳填寫範本
  if (!message.includes("補登時間") && !message.includes("輸入上/下班")) {
    const defaultStore = auth.workStores[0] || "請輸入店家"; // 自動帶入他的店家
    
    // 取得現在時間作為範例
    const nowStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm");
    
    const template = 
      `請「複製」以下內容，修改後傳送給機器人：\n\n` +
      `補打卡申請\n` +
      `店家：${defaultStore}\n` +
      `補登時間：${nowStr}\n` +
      `輸入上/下班：上班打卡`; // 預設文字

    return reply(replyToken, template);
  }

  // 情況 B：使用者回傳了填好的資料 -> 解析並寫入
  const timeMatch = message.match(timeRegex);
  const typeMatch = message.match(typeRegex);

  // 防呆：格式檢查
  if (!timeMatch || !typeMatch) {
    return reply(replyToken, "❌ 格式錯誤！無法讀取時間或類型。\n請確保您保留了「補登時間：」與「輸入上/下班：」的標題。");
  }

  // 解析出的資料
  let inputTimeStr = timeMatch[1].trim(); // 例如 "2025/02/01 09:00"
  let inputType = typeMatch[1].trim();    // 例如 "上班" 或 "上班打卡"
  
  // 處理類型文字 (統一名稱)
  if (inputType.includes("上")) inputType = "上班打卡";
  else if (inputType.includes("下")) inputType = "下班打卡";
  else return reply(replyToken, "❌ 類型錯誤：請填寫「上班」或「下班」。");

  // 處理時間物件
  const makeUpDate = new Date(inputTimeStr);
  if (isNaN(makeUpDate.getTime())) {
    return reply(replyToken, "❌ 時間格式錯誤！\n範例：2025/02/01 09:00");
  }

  // 4. 寫入「員工打卡紀錄」 (主資料表)
  const sheet = SpreadsheetApp.openById(LINE_STAFF_SS_ID).getSheetByName("員工打卡紀錄");
  if (sheet) {
    // 欄位順序假設：
    // A: UserId
    // B: 打卡時間 (這裡填入「補登的時間」，這樣算薪水才準)
    // C: 類型 (上班打卡/下班打卡)
    // D: 店家 (從 Auth 抓，或解析訊息中的店家)
    // E: UUID (補打卡沒有 UUID，留空)
    // F: FrontUUID (留空)
    // G: 備註 (新增這一欄，標記 "補打卡")
    
    // 嘗試解析店家 (如果訊息有填就用填的，沒填就用系統紀錄的)
    let storeName = auth.workStores[0] || "未知店家";
    const storeMatch = message.match(/店家[:：]\s*(.+)/);
    if (storeMatch && storeMatch[1].trim() !== "") {
      storeName = storeMatch[1].trim();
    }

    sheet.appendRow([
      userId,
      makeUpDate, // 這裡寫入「應該打卡的時間」
      inputType,
      storeName,
      "",         // UUID 空白
      "",         // FrontUUID 空白
      "📝補打卡"   // ★ 關鍵：標記這是補的
    ]);

    reply(replyToken, `✅ 補打卡成功！\n\n已為您補登：\n📅 ${Utilities.formatDate(makeUpDate, "Asia/Taipei", "MM/dd HH:mm")}\n📍 ${inputType}\n(系統已標記為補打卡)`);
  
  } else {
    reply(replyToken, "系統錯誤：找不到打卡紀錄表，請聯繫管理員。");
  }
}