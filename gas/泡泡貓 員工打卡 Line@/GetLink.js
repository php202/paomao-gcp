function getOnlineCourse(replyToken, userId) {
  const auth = isUserAuthorized(userId);
  if (!auth.isAuthorized) {
    return noAuthorized(replyToken);
  }
  const driveLink = "https://www.paopaomao.tw/slides";
  const msg = `📅 【線上課程】\n\n請點擊下方連結查看所有課程：\n${driveLink}`;
  reply(replyToken, msg);
}

function getNews(replyToken, userId) {
  const auth = isUserAuthorized(userId);
  if (!auth.isAuthorized) {
    return noAuthorized(replyToken);
  }
  // 2. 直接回傳連結 (移除讀取 Sheet 的動作，大幅優化效能)
  const driveLink = "https://drive.google.com/drive/folders/1Y2hoU5nhM2-lJxHbm0KwfBPznFDQThmg?usp=drive_link";
  const msg = `📅 【最新活動資訊】\n\n請點擊下方連結查看所有活動檔案：\n${driveLink}`;
  reply(replyToken, msg);
}