// ==========================================
// [Register.gs] 智慧註冊流程
// ==========================================
function getUserId(replyToken, userId, message) {
  // 1. 基本檢查：防止老員工重複按
  const auth = isUserAuthorized(userId);
  if (auth.isAuthorized) {
    return reply(replyToken, "您已是正式員工/管理員，無須再次註冊。");
  }

  // 2. 檢查是否已經在「審核中」 (避免重複送單)
  const applySheet = SpreadsheetApp.openById(LINE_STAFF_SS_ID).getSheetByName("請求員工ID");
  const lastRow = applySheet.getLastRow();
  
  if (lastRow >= 2) {
    // 檢查 F 欄 (User ID) 是否已存在
    const pendingIds = applySheet.getRange(2, 6, lastRow - 1, 1).getValues().flat();
    if (pendingIds.includes(userId)) {
      return reply(replyToken, "您的申請正在審核中，請勿重複傳送。");
    }
  }

  // ==========================================
  // ★★★ 3. 自動化核心：解析名字與驗證 ★★★
  // ==========================================
  
  // (A) 嘗試從訊息中「撈」出名字
  const extractedName = extractNameFromMessage(message);

  if (!extractedName) {
    return reply(replyToken, "⚠️ 系統無法辨識您的名字。\n\n請依照格式輸入，例如：\n【我要註冊】\n姓名：王小明\n電話：0912345678");
  }

  // (B) 比對「員工清單」(白名單驗證)
  const employeeListSheet = SpreadsheetApp.openById(LINE_STAFF_SS_ID).getSheetByName("員工清單"); // 確認工作表名稱
  // 假設 C 欄是姓名
  const validNames = employeeListSheet.getRange("C2:C").getValues().flat().filter(n => n !== "");
  
  // 模糊比對 (移除空白後比對)
  const cleanInputName = extractedName.replace(/\s/g, "");
  const matchName = validNames.find(dbName => String(dbName).replace(/\s/g, "") === cleanInputName);

  // (C) 名字不在清單中：仍允許申請，交由內部審核
  const isExternalApplicant = !matchName;
  if (isExternalApplicant) {
    console.log(`外部申請: 輸入[${cleanInputName}] 不在員工清單內`);
  }

  // ==========================================
  // 4. 驗證成功：寫入資料 (自動填寫 E, F 欄)
  // ==========================================
  
  // 為了讓 E 欄整齊，若有比對成功就用標準名字；外部申請則寫入使用者姓名
  const timestamp = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
  
  // 欄位對應：
  // A: 時間, B: UserId, C: LINE暱稱(自動抓), D: 原始訊息, E: 解析姓名(matchName), F: UserId
  const lineProfileName = Core.getUserDisplayName(userId, '', '', LINE_TOKEN_PAOSTAFF);
  const displayNameForSheet = isExternalApplicant ? extractedName : matchName;
  const messageForSheet = isExternalApplicant ? `【外部申請】${message}` : message;

  applySheet.appendRow([
    timestamp,       // A
    userId,          // B
    lineProfileName, // C
    messageForSheet, // D
    displayNameForSheet, // E (標準姓名或外部姓名)
    userId           // F (自動填入 ID)
  ]);

  // 回覆成功訊息
  if (isExternalApplicant) {
    reply(replyToken, `✅ 申請已送出！\n\n系統未在員工清單中找到「${extractedName}」，已改由內部審核。\n請等待管理員開通權限。`);
  } else {
    reply(replyToken, `✅ 申請已送出！\n\n系統已確認您的身分：${matchName}\n請等待管理員開通權限。`);
  }
}

// ==========================================
// 🛠️ 輔助工具：從亂七八糟的訊息抓名字
// ==========================================
function extractNameFromMessage(msg) {
  if (!msg) return null;
  let text = String(msg).trim();

  // 1. 如果訊息包含 "姓名" 關鍵字 (例如: "📝姓名：王小明")
  // 邏輯：抓取 "姓名" 或 "Name" 後面的文字，直到換行
  const namePattern = /(?:姓名|Name)[:：\s]*([^\n\r]+)/i;
  const match = text.match(namePattern);
  
  if (match && match[1]) {
    // 去除一些常見的干擾字 (如 emoji)
    return cleanString(match[1]);
  }

  // 2. 如果沒有關鍵字，嘗試分析行數 (例如: "我要註冊\n王小明\n09xx")
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l !== "");
  
  // 過濾掉 "我要註冊"、"===" 這種無效行
  const potentialNames = lines.filter(line => {
    return !line.includes("我要註冊") && 
           !line.includes("===") && 
           !line.includes("訊息留下") &&
           !/^\d+$/.test(line); // 不是純數字(電話)
  });

  // 通常剩下行的第一行就是名字
  if (potentialNames.length > 0) {
    // 假設名字長度通常在 2~4 字 (中文) 或 英文，太長可能是句子
    if (potentialNames[0].length < 10) {
      return cleanString(potentialNames[0]);
    }
  }

  return null; // 真的抓不到
}

// 清理字串 (移除 emoji 和多餘符號)
function cleanString(str) {
  return str.replace(/[^\u4e00-\u9fa5a-zA-Z\s]/g, "").trim(); 
}