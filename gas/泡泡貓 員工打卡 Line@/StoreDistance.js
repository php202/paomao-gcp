function getStoreDistance(event) {
  const replyToken = event.replyToken;
  const lat = event.message.latitude;
  const lon = event.message.longitude;

  // 取得定位結果 (假設回傳陣列已按距離排序)
  const checkResult = checkLocation(lat, lon);
  let msg = "";
  // 防呆：確認有回傳結果
  if (checkResult && checkResult.length > 0) {
    const nearestStore = checkResult[0];
    
    // 邏輯優化：距離 < 0.05 (50公尺) 或是 < 5 (5公里)? 
    // 請確認 checkLocation 回傳的單位。這裡假設你的邏輯是 "太近不能打卡(如防作弊?)"
    if (nearestStore.distance < 5) { 
      msg += `❌ 你的定位距離最近的店家 **${nearestStore.name}** 過近 (距離 ${nearestStore.distance.toFixed(2)} km)\n\n`;
    }

    msg += "📍 **最近的 5 間店家**：\n";
    
    // 使用 slice 取前 5 筆，並利用 map 簡潔組字
    const listMsg = checkResult.slice(0, 5)
      .map((store, index) => `${index + 1}. ${store.name} : 距離 ${store.distance.toFixed(2)} km`)
      .join("\n");
      
    msg += listMsg;
  } else {
    msg = "❌ 無法取得附近的店家資訊，請確認定位設定。";
  }

  reply(replyToken, msg);
}

