// ==========================================
// 1. 主流程控制 (Controller)
// ==========================================
function sendLocationRequest(replyToken, userId) {
  // A. 權限驗證
  const auth = isUserAuthorized(userId); // 假設這會回傳完整物件
  if (!auth.isAuthorized) { 
    return noAuthorized(replyToken); 
  }

  // B. 準備資料 (UUID & Link)
  const uuid = Utilities.getUuid();
  const uri = `${CHECK_IN_LINK}?userId=${encodeURIComponent(userId)}&uuid=${encodeURIComponent(uuid)}`;
  // Debug log (GAS does not support fetch; keep local logging only)
  try {
    console.log("[sendLocationRequest] created check-in link", {
      userIdSuffix: userId ? String(userId).slice(-6) : "",
      uuidTail: String(uuid).slice(-8),
      hasAuth: !!(auth && auth.isAuthorized),
    });
  } catch (e) {}

  // C. 每月 1–7 號僅對已開通帳號顯示「上月小費」按鈕（本函式已於開頭檢查 auth，未開通不會進入）
  const actions = [{ "type": "uri", "label": "📍 點擊開啟打卡", "uri": uri }];
  const dayOfMonth = new Date().getDate();
  if (dayOfMonth >= 1 && dayOfMonth <= 7 && auth.isAuthorized) {
    actions.push({ "type": "message", "label": "上月小費", "text": "上月小費" });
  }

  // D. 建構訊息 (UI)
  const message = {
    "type": "template",
    "altText": "請進行打卡驗證",
    "template": {
      "type": "buttons",
      "title": "打卡驗證",
      "text": "請點擊下方按鈕開啟打卡頁面。",
      "actions": actions
    }
  };

  // E. 發送訊息
  reply(replyToken, [message]);
  // F. 寫入資料庫 (將存檔邏輯抽離)
  logCheckInAttempt(userId, uuid);
}

// Debug helper: 檢查「我要打卡」必要條件（不寫入、不回覆）
function debugCheckInRequest(userId) {
  var out = {
    ok: false,
    time: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"),
    hasUserId: !!userId,
    userIdSuffix: userId ? String(userId).slice(-6) : "",
    auth: null,
    link: "",
    sheet: { found: false, error: "" }
  };
  try {
    var auth = isUserAuthorized(userId);
    out.auth = {
      isAuthorized: !!(auth && auth.isAuthorized),
      identity: auth && auth.identity ? auth.identity : [],
      managedStoresLen: auth && auth.managedStores ? auth.managedStores.length : 0,
      workStoresLen: auth && auth.workStores ? auth.workStores.length : 0
    };
  } catch (eAuth) {
    out.auth = { isAuthorized: false, error: eAuth && eAuth.message ? eAuth.message : String(eAuth) };
  }
  if (out.auth && out.auth.isAuthorized) {
    var uuid = Utilities.getUuid();
    out.link = CHECK_IN_LINK + "?userId=" + encodeURIComponent(String(userId)) + "&uuid=" + encodeURIComponent(uuid);
  }
  try {
    var ss = SpreadsheetApp.openById(LINE_STAFF_SS_ID);
    var sheet = ss.getSheetByName("員工打卡紀錄");
    out.sheet.found = !!sheet;
  } catch (eSheet) {
    out.sheet.error = eSheet && eSheet.message ? eSheet.message : String(eSheet);
  }
  out.ok = !!(out.auth && out.auth.isAuthorized && out.sheet.found && out.link);
  return out;
}


function logCheckInAttempt(userId, uuid) {
  try {
    const sheet = SpreadsheetApp.openById(LINE_STAFF_SS_ID).getSheetByName("員工打卡紀錄"); // 確保 ID 正確
    if (sheet) {
      // 建議：將 new Date() 格式化，或直接存物件
      sheet.appendRow([userId, new Date(), '', '', uuid]);
    }
  } catch (e) {
    console.error(`寫入 UUID 失敗: ${e.toString()}`);
    // 寫入失敗不應影響使用者打卡，所以用 try-catch 包起來
  }
}

