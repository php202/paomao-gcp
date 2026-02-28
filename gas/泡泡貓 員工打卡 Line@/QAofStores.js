/**
 * 查詢待處理問題清單（改讀 PostgreSQL API）
 */
function sendStoreLineQuestionRequest(replyToken) {
  try {
    // 呼叫 Issues API
    var resp = UrlFetchApp.fetch(
      "https://api.paopaomao.tw/api/issues/pending?key=paomao-issues-2026&limit=50",
      { muteHttpExceptions: true }
    );

    if (resp.getResponseCode() !== 200) {
      console.error("Issues API error:", resp.getResponseCode(), resp.getContentText());
      return reply(replyToken, "⚠️ 問題集查詢暫時無法使用，請稍後再試。");
    }

    var data = JSON.parse(resp.getContentText());
    var issues = data.issues || [];

    // 組裝訊息
    var messageText = "";
    if (issues.length > 0) {
      messageText = "📝 【待處理問題清單】\n" + "=".repeat(15) + "\n";

      var displayLimit = 10;
      var count = Math.min(issues.length, displayLimit);

      for (var i = 0; i < count; i++) {
        var issue = issues[i];
        var date = issue.created_at
          ? Utilities.formatDate(new Date(issue.created_at), "Asia/Taipei", "MM/dd")
          : "--/--";
        var store = issue.store_name || "";
        var content = (issue.description || "").replace(/[\n\r]/g, " ");
        if (content.length > 20) content = content.substring(0, 20) + "...";
        var owner = issue.assignee || "";

        messageText += (i + 1) + ". [" + date + "] " + store + "\n";
        messageText += "👤 " + owner + "：" + content + "\n";
        messageText += "-".repeat(15) + "\n";
      }

      if (issues.length > displayLimit) {
        messageText += "\n⚠️ 還有 " + (issues.length - displayLimit) + " 筆未顯示，請至後台查看。";
      } else {
        messageText += "\n共計 " + issues.length + " 筆未回傳。";
      }
    } else {
      messageText = "✅ 目前所有問題皆已處理完畢，辛苦了！";
    }

    return reply(replyToken, messageText);
  } catch (e) {
    console.error("[Question] Error:", e);
    return reply(replyToken, "系統發生錯誤，請稍後再試");
  }
}
