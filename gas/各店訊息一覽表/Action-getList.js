// 記得這裡括號內要加 e
function getList(e) {
  // 1. 接收參數
  const botId = e.parameter.botId; 
  if (!botId) return Core.jsonResponse({error: 'No botId'});

  const ssId = typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID ? CONFIG.INTEGRATED_SHEET_SS_ID : null;
  const ss = ssId ? SpreadsheetApp.openById(ssId) : null;
  if (!ss) return Core.jsonResponse({error: '無法取得試算表'});
  
  // ----------------------------------------------------
  // 第一步：先確認這個 Bot ID 是哪一家店？
  // ----------------------------------------------------
  const configSheet = ss.getSheetByName('店家基本資料');
  const configData = configSheet.getDataRange().getValues();
  let targetStoreName = null;

  // 欄位對照：
  // Index 1 = B欄 (店名)
  // Index 6 = G欄 (Bot ID) -> 請確認你的 Excel 真的是 G 欄，如果是 E 欄要改成 4
  for (let i = 1; i < configData.length; i++) {
    if (configData[i][6] && configData[i][6].toString().trim() === botId) {
      targetStoreName = configData[i][1]; 
      break;
    }
  }

  if (!targetStoreName) {
    return Core.jsonResponse({error: '找不到此 Bot ID 對應的店家', botId: botId});
  }

  // ----------------------------------------------------
  // 第二步：只撈出「那家店」的訊息
  // ----------------------------------------------------
  const logSheet = ss.getSheetByName('訊息一覽');
  const logs = logSheet.getDataRange().getValues();
  const result = [];

  for (let i = 1; i < logs.length; i++) {
    const row = logs[i]; 
    const storeName = row[2]; // C欄
    const status = row[5];    // F欄 (處理狀態)

    // 篩選：店名符合 且 狀態是空的(未處理)
    if (storeName === targetStoreName && !status) {
      
      // [優化] 轉成台灣時間，讓外掛顯示的時間是正確的
      let timeStr = row[0];
      try {
        timeStr = Utilities.formatDate(new Date(row[0]), "GMT+8", "yyyy/MM/dd HH:mm");
      } catch(err) {
        // 如果日期格式有問題，就維持原樣
      }

      result.push({
        row: i + 1, 
        time: timeStr,
        name: row[3],
        msg: row[4],
        userId: row[1],
        replyToken: (row.length > 8 && row[8]) ? String(row[8]).trim() : "",
      });
    }
  }

  // 讓最新的在最上面
  result.reverse(); 

  return Core.jsonResponse({status: 'success', storeName: targetStoreName, data: result});
}