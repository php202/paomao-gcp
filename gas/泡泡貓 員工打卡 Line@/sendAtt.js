function sendAtt(replyToken, userId, message) {
  const { isAuthorized, identity, managedStores } = isUserAuthorized(userId)
  if(!isAuthorized) { noAuthorized(replyToken) }
  const timestamp = new Date()
  const year = timestamp.getFullYear();
  const month = timestamp.getMonth();
  // #region agent log
  try {
    console.log(JSON.stringify({ hypothesisId: "H1,H4,H5", location: "sendAtt.js:entry", message: "sendAtt", data: { message, identity: identity.join(","), hasManagedStores: !!(managedStores && managedStores.length) } }));
  } catch (e) {}
  // #endregion
  if (message === '本月出勤' && identity.includes('employee')) {
      //'本月出勤'：本人的本月出勤，直接列出 日期 上班時間 下班時間
      const attendances = formatAtt(getUserAttendance([userId], new Date(year, month, 1), new Date(year, month + 1, 0).setHours(23, 59, 59, 999)));
      reply(replyToken, attendances);
      return;
  } else if (message === '上月出勤' && identity.includes('employee')) {
      //'上月出勤'：本人的本月出勤，直接列出 日期 上班時間 下班時間
      const attendances = formatAtt(getUserAttendance([userId], new Date(year, month - 1, 1), new Date(year, month, 0).setHours(23, 59, 59, 999)));
      reply(replyToken, attendances);
      return;
  } else if (message === '本月出勤' && identity.includes('manager')) {
    // 管理者「本月出勤」→ 顯示今日各店出勤（與「店家今天出勤」相同），避免打關鍵字後沒有東西
    if (!managedStores || managedStores.length === 0) {
      reply(replyToken, "您目前尚未有管理的店家");
      return;
    }
    try {
      const storeAttendance = getTodayAttendanceByStores(managedStores);
      reply(replyToken, storeAttendance);
      return;
    } catch (e) {
      console.error(e);
      reply(replyToken, "查詢出勤失敗，請聯絡管理員");
      return;
    }
  } else if (message === '上月出勤' && identity.includes('manager')) {
    reply(replyToken, "請改用「店家上月出勤」取得上月出勤 Excel。");
    return;
  }

  if (message === '店家今天出勤'&& identity.includes('manager')) {
    if (!managedStores || managedStores.length === 0) {
      reply(replyToken, "您目前尚未有管理的店家1");
      return;
    }
    try {
      const storeAttendance = getTodayAttendanceByStores(managedStores);
      reply(replyToken, storeAttendance);
      return;
    } catch (e) {
      console.error(e);
      reply(replyToken, "查詢出勤失敗，請聯絡管理員");
      return;
    }
  } 
  if (message === '店家本月出勤'&& identity.includes('manager')) {
    if (!managedStores || managedStores.length === 0) {
      reply(replyToken, "您目前尚未有管理的店家");
      return;
    }
    const excelFile = sendExcelFile(userId, managedStores, new Date(year, month, 1), new Date(year, month + 1, 0).setHours(23, 59, 59, 999));
    reply(replyToken, excelFile);
    return;
  }
  if (message === '店家上月出勤'&& identity.includes('manager')) {
    if (!managedStores || managedStores.length === 0) {
      reply(replyToken, "您目前尚未有管理的店家");
      return;
    }
    const excelFile = sendExcelFile(userId, managedStores, new Date(year, month - 1, 1), new Date(year, month, 0).setHours(23, 59, 59, 999));
    reply(replyToken, excelFile);
    return;
  }
  if (message === '店家可預約時間'&& identity.includes('manager')) {
    if (!managedStores || managedStores.length === 0) {
      reply(replyToken, "您目前尚未有管理的店家");
      return;
    }
    const text = findAvailableList(managedStores);
    if (!text || String(text).trim() === "") {
      reply(replyToken, "查無可預約時間。");
      return;
    }
    reply(replyToken, text);
    return;
  }
  console.log(JSON.stringify({ hypothesisId: "H1,H4", location: "sendAtt.js:fallback", message: "無匹配 -> 您尚無本行動權限", data: { message } }));
  reply(replyToken, "您尚無本行動權限");
}

