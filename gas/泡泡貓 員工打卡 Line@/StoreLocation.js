/**
 * 📍 請使用者發送店面位置 (開店用)
 */
function sendStoreLocationRequest(replyToken) {
  const messageObj = {
    "type": "text",
    "text": "請點擊下方按鈕，傳送您的店面位置以進行開店設定：",
    "quickReply": {
      "items": [
        {
          "type": "action",
          "action": {
            "type": "location",
            "label": "📍 傳送店面位置"
          }
        }
      ]
    }
  };

  // 3. 發送訊息 (呼叫 Core)
  reply(replyToken, [messageObj]);
}