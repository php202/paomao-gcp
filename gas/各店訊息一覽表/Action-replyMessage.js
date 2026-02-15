/**
 * replyMessage：用 replyToken 回覆該則訊息（不佔 Push 額度）。
 * 參數：botId, replyToken, text（皆必填）
 */
function replyMessage(e) {
  var botId = (e && e.parameter && e.parameter.botId) ? String(e.parameter.botId).trim() : "";
  var replyToken = (e && e.parameter && e.parameter.replyToken) ? String(e.parameter.replyToken).trim() : "";
  var text = (e && e.parameter && e.parameter.text) != null ? String(e.parameter.text) : "";

  if (!botId) return Core.jsonResponse({ status: "error", message: "請提供 botId" });
  if (!replyToken) return Core.jsonResponse({ status: "error", message: "請提供 replyToken（此則訊息可能已過期）" });

  var ssId = typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID ? CONFIG.INTEGRATED_SHEET_SS_ID : null;
  var ss = ssId ? SpreadsheetApp.openById(ssId) : null;
  if (!ss) return Core.jsonResponse({ status: "error", message: "無法取得試算表" });

  var configSheet = ss.getSheetByName("店家基本資料");
  if (!configSheet) return Core.jsonResponse({ status: "error", message: "找不到店家基本資料" });
  var configData = configSheet.getDataRange().getValues();
  var channelId = null, channelSecret = null;
  for (var i = 1; i < configData.length; i++) {
    if (configData[i][6] && String(configData[i][6]).trim() === botId) {
      channelId = configData[i][2];
      channelSecret = configData[i][3];
      break;
    }
  }
  if (!channelId || !channelSecret) return Core.jsonResponse({ status: "error", message: "無法取得該店 LINE 憑證" });

  var token = getLineAccessToken(channelId, channelSecret);
  if (!token) return Core.jsonResponse({ status: "error", message: "無法取得 LINE 存取權杖" });

  try {
    if (typeof Core.sendLineReply === "function") {
      Core.sendLineReply(replyToken, text, token);
    } else {
      return Core.jsonResponse({ status: "error", message: "Core.sendLineReply 未就緒" });
    }
  } catch (err) {
    Logger.log("replyMessage error: " + (err && err.message ? err.message : err));
    return Core.jsonResponse({ status: "error", message: "回覆失敗：" + (err && err.message ? err.message : String(err)) });
  }

  return Core.jsonResponse({ status: "success", message: "已回覆" });
}
