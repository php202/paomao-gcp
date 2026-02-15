/**
 * 查詢待處理問題清單
 */
function sendStoreLineQuestionRequest(replyToken) {
  try {
    // 2. 開啟試算表
    const ss = SpreadsheetApp.openById(LINE_HQ_SS_ID);
    const sheet = ss.getSheetByName("問題集");
    
    if (!sheet) {
      // 找不到工作表時，回傳錯誤並記錄 Log
      console.error("找不到 '問題集' 工作表");
      return reply(replyToken, "系統錯誤：找不到資料表");
    }

    // 3. 讀取資料並篩選待處理項目
    const data = sheet.getDataRange().getValues();
    let pendingTasks = [];
    
    // 從第 1 列 (Row 2) 開始，略過標題
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const returnDate = row[7]; // H欄：回覆日期
      
      // 判斷未回覆 (空值)
      if (!returnDate || String(returnDate).trim() === "") {
        pendingTasks.push({
          id: row[0],
          date: row[1] ? Utilities.formatDate(new Date(row[1]), "Asia/Taipei", "MM/dd") : "--/--",
          store: row[2],
          content: String(row[3]).replace(/[\n\r]/g, " "), // 移除換行符號
          owner: row[4]
        });
      }
    }

    // 4. 組裝訊息 (限制顯示筆數，避免洗版)
    let messageText = "";
    if (pendingTasks.length > 0) {
      messageText = "📝 【待處理問題清單】\n" + "=".repeat(15) + "\n";
      
      // 設定顯示上限 (例如只顯示前 10 筆)
      const displayLimit = 10;
      const count = Math.min(pendingTasks.length, displayLimit);
      
      for (let i = 0; i < count; i++) {
        const task = pendingTasks[i];
        // 內容截斷：超過 20 字就 ...
        let contentSummary = task.content.length > 20 ? task.content.substring(0, 20) + "..." : task.content;
        
        messageText += `${i + 1}. [${task.date}] ${task.store}\n`;
        messageText += `👤 ${task.owner}：${contentSummary}\n`;
        messageText += "-".repeat(15) + "\n";
      }
      
      // 如果還有剩下的，顯示剩餘數量
      if (pendingTasks.length > displayLimit) {
        messageText += `\n⚠️ 還有 ${pendingTasks.length - displayLimit} 筆未顯示，請至後台查看。`;
      } else {
        messageText += `\n共計 ${pendingTasks.length} 筆未回傳。`;
      }
      
    } else {
      messageText = "✅ 目前所有問題皆已處理完畢，辛苦了！";
    }

    // 5. 發送訊息 (呼叫 Core 或 Main 的 reply)
    // 這裡直接呼叫 Core.sendLineReply 確保獨立性
    return reply(replyToken, messageText);
  } catch (e) {
    console.error("[Question] Error:", e);
    // 發生未知錯誤時回報
    return reply(replyToken, "系統發生錯誤，請稍後再試");
  }
}