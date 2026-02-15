// ==========================================

// [Staff.gs] 員工權限與身分驗證
// ==========================================

/**
 * 🚀 檢查使用者是否在 員工 或 管理層 名單
 * @param {string} userId - LINE 使用者 ID
 * @return {object} { isAuthorized, identity, managedStores, workStores, idpercent }
 */
function isUserAuthorized(userId) {
  // 1. 取得設定 & ID
  let result = {
    isAuthorized: false,
    identity: [],      // ['employee', 'manager']
    managedStores: [],  // 管理的店家 ID (來自管理者清單)
    workStores: [],    // 工作的店家 ID (來自員工清單)
    employeeCode: '',  // 員工編號 (來自員工清單 L 欄 index 11，供上月小費依備註篩選)
    idpercent: 0       // 業績趴數
  };

  try {
    // 2. 開啟試算表
    const ss = SpreadsheetApp.openById(LINE_STAFF_SS_ID);
    const emSheet = ss.getSheetByName("員工清單");
    const maSheet = ss.getSheetByName("管理者清單");

    if (!emSheet || !maSheet) {
      console.error("❌ 找不到員工或管理者清單工作表");
      return result; 
    }

    // 3. 檢查員工清單 (Employee)
    // 優化：一次讀取整張表，比在迴圈中 getRange 快很多
    const emData = emSheet.getDataRange().getValues();
    
    // 從第 1 列 (Row 2) 開始，略過標題
    for (let i = 1; i < emData.length; i++) {
      const row = emData[i];
      // 假設第 4 欄 (Index 3) 是 UserId
      if (String(row[3]).trim() === userId) {
        result.isAuthorized = true;
        result.identity.push('employee');
        if (row[11] != null && String(row[11]).trim() !== '') {
          result.employeeCode = String(row[11]).trim();
        }
        // F 欄 (index 5) 為 storeId：視為員工平常上班的店家
        if (row[5] != null && String(row[5]).trim() !== '') {
          result.workStores.push(String(row[5]).trim());
        }
      }
    }

    // 4. 檢查管理者清單 (Manager)
    const maData = maSheet.getDataRange().getValues();
    
    for (let i = 1; i < maData.length; i++) {
      const row = maData[i];
      // 假設第 1 欄 (Index 0) 是 UserId
      if (String(row[0]).trim() === userId) {
        result.isAuthorized = true;
        result.identity.push('manager');
        
        // 管理店家：第 3 欄 (Index 2)
        if (row[2] && row[2] !== "") {
          result.managedStores.push(row[2]);
        }
      }
    }

    // 5. 資料清洗 (移除重複值)
    result.identity = [...new Set(result.identity)];
    result.workStores = [...new Set(result.workStores)];
    result.managedStores = [...new Set(result.managedStores)];

  } catch (e) {
    console.error("[Staff] isUserAuthorized Error:", e);
  }

  return result;
}

/**
 * 🚫 無權限時的回覆通知
 * 當 Main.gs 發現 isAuthorized 為 false 時呼叫
 */
function noAuthorized(replyToken) {
  // 為了讓此函式能獨立運作，我們直接從 Core 拿 Token
  const msg = "⚠️ 你的帳號尚未開通，麻煩通知泡泡貓負責顧問！";
  // 呼叫 Core 發送訊息
  reply(replyToken, msg);
}