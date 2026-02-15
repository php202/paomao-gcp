// ==========================================
// [StoreData.gs] 儲值金請款報表 (安全分批版)
// ==========================================
function storeData() {
  const ss = SpreadsheetApp.openById(PAOPAO_STORE_SS_ID);
  const reSheet = ss.getSheetByName("儲值金請款test");
  if (!reSheet) throw new Error('找不到工作表「儲值金請款」');

  // 1. 取得 Token 與 店家列表
  const token = Core.getBearerTokenFromSheet();
  const stores = Core.getStoresInfo();
  
  console.log(`取得店家數: ${stores.length}`);

  // 2. 計算日期範圍
  const tz = Session.getScriptTimeZone();
  const today = new Date();
  const fd = Utilities.formatDate(new Date(today.getFullYear(), today.getMonth() - 1, 1), tz, 'yyyy-MM-dd');
  const ld = Utilities.formatDate(new Date(today.getFullYear(), today.getMonth(), 0), tz, 'yyyy-MM-dd');
  
  console.log(`查詢區間: ${fd} ~ ${ld}`);

  // 3. 清除舊資料
  const lastRow = reSheet.getLastRow();
  if (lastRow >= 2) {
    reSheet.getRange(2, 1, lastRow - 1, reSheet.getLastColumn()).clearContent();
  }

  // 4. 準備所有請求 (Request Queue)
  // 我們先把「所有店家」的「所有 API」都建立好，放入一個大陣列
  let allRequests = [];
  const commonHeaders = { 'Authorization': 'Bearer ' + token };

  stores.forEach(s => {
    // API 1: 儲值金實收
    allRequests.push({
      url: `https://saywebdatafeed.saydou.com/api/management/unearn/storecashAddRecord?page=0&limit=20&sort=rectim&order=desc&keyword=&start=${fd}&end=${ld}&membid=0&storid%5B%5D=${s.id}&type=0&tabIndex=1`,
      method: 'GET',
      headers: commonHeaders,
      muteHttpExceptions: true
    });

    // API 2: 使用細項
    allRequests.push({
      url: `https://saywebdatafeed.saydou.com/api/management/unearn/storecashUseRecord?page=0&limit=20&sort=rectim&order=desc&keyword=&start=${fd}&end=${ld}&storid%5B%5D=${s.id}&type=0&tabIndex=2&membid=0`,
      method: 'GET',
      headers: commonHeaders,
      muteHttpExceptions: true
    });

    // API 3: 總額統計
    allRequests.push({
      url: `https://saywebdatafeed.saydou.com/api/management/finance/transactionStatistic?page=0&limit=20&sort=ordrsn&order=desc&keyword=&start=${fd}&end=${ld}&searchMemberCtrl=null&searchProductCtrl=null&searchStaffCtrl=null&membid=0&godsid=0&store%5B%5D=${s.id}&usrsid=0&memnam=&godnam=&usrnam=&assign=all&licnum=&goctString=`,
      method: 'GET',
      headers: commonHeaders,
      muteHttpExceptions: true
    });
  });

  // 5. ★ 分批平行處理 (Batch Chunking) ★
  console.log(`總共有 ${allRequests.length} 個請求，準備分批執行...`);
  
  let allResponses = [];
  const totalReqs = allRequests.length;

  for (let i = 0; i < totalReqs; i += REPORT_CONFIG.BATCH_SIZE) {
    // 切出一小批請求
    const chunk = allRequests.slice(i, i + REPORT_CONFIG.BATCH_SIZE);
    
    try {
      // 平行發送這一批
      const chunkResponses = UrlFetchApp.fetchAll(chunk);
      
      // 將結果存入總表
      allResponses = allResponses.concat(chunkResponses);
      
      console.log(`已完成 ${Math.min(i + REPORT_CONFIG.BATCH_SIZE, totalReqs)} / ${totalReqs}`);
      
      // ★ 休息一下，避免被鎖 IP
      Utilities.sleep(REPORT_CONFIG.SLEEP_MS);
      
    } catch (e) {
      console.error(`Batch Error at index ${i}:`, e);
      // 若發生錯誤，塞入 null 保持陣列長度一致，避免後續錯位
      for (let k = 0; k < chunk.length; k++) allResponses.push(null);
    }
  }

  // 6. 解析資料並組裝
  let outputValues = [];
  
  // 每個店家有 3 個 Request，所以迴圈每次跳 3 格
  // 因為 allResponses 的順序嚴格對應 stores 的順序，所以可以直接對應
  for (let i = 0; i < stores.length; i++) {
    const s = stores[i];
    
    // 取出該店的 3 個回應
    const resAddRecord = allResponses[i * 3];
    const resUseRecord = allResponses[i * 3 + 1];
    const resTransStat = allResponses[i * 3 + 2];

    // 解析 JSON
    const dataAdd = tryParseJson_(resAddRecord);
    const dataUse = tryParseJson_(resUseRecord);
    const dataTrans = tryParseJson_(resTransStat);

    // --- 取值邏輯 ---

    // 1. 儲值金實收 (a)
    const a = (dataAdd && dataAdd.summary) ? (dataAdd.summary.buyActual || 0) : 0;

    // 2. 使用細項 (c, d)
    const summaryUse = (dataUse && dataUse.summary) ? dataUse.summary : {};
    const c = summaryUse.buyreplace || 0;  // 商品卷/訂金
    const d = summaryUse.buyticket || 0;   // 購買優惠券
    
    // 3. 儲值金使用總額 (stored)
    const stored = (dataTrans && dataTrans.card) ? dataTrans.card : 0;

    // 4. 計算結餘
    const balance = a - stored - c - d;

    outputValues.push([
      s.name, 
      a,      // 儲值金實收
      stored, // 儲值金使用
      c,      // 商品卷(訂金)
      d,      // 購買優惠券
      '',     // 空白欄
      balance // 結餘
    ]);
  }

  // 7. 寫入 Sheet
  if (outputValues.length > 0) {
    reSheet.getRange(2, 1, outputValues.length, 7).setValues(outputValues);
    console.log(`成功寫入 ${outputValues.length} 筆資料`);
  }
}

// 輔助函式：安全解析 JSON
function tryParseJson_(res) {
  try {
    // 檢查 res 是否為 null (分批錯誤時可能為 null) 且狀態碼為 200
    if (res && res.getResponseCode && res.getResponseCode() === 200) {
      const json = JSON.parse(res.getContentText());
      return json.data;
    }
  } catch (e) {
    console.warn("JSON Parse Error:", e);
  }
  return null;
}