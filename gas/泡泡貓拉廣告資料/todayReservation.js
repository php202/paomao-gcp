/** 預約清單（動態）試算表 ID */
const AD_SS_ID = '19NWuiZ1hI0pC6_eMxsKvQlzcf5aGrs4OJgtOTJANjjQ';

function todayReservation() {
  Logger.log("todayReservation: 開始");
  const ss = SpreadsheetApp.openById(AD_SS_ID);
  const sheet = ss.getSheetByName("今日建立（動態）");
  if (!sheet) throw new Error("找不到工作表：今日建立（動態）");
  const dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");

  // 清空舊資料（第 4 列以下）
  const lastRow = sheet.getLastRow();
  if (lastRow >= 4) {
    sheet.getRange(4, 1, lastRow - 3, sheet.getLastColumn()).clearContent();
  }

  Logger.log("todayReservation: 取得店家列表...");
  let stores;
  try {
    stores = CoreApi.getStoresInfo();
  } catch (e) {
    Logger.log("todayReservation: getStoresInfo 失敗 - " + e.message);
    throw e;
  }
  Logger.log("todayReservation: 共 " + (stores ? stores.length : 0) + " 家店");

  const output = [];
  const total = stores ? stores.length : 0;

  for (let i = 0; i < total; i++) {
    const store = stores[i];
    Logger.log("todayReservation: 處理第 " + (i + 1) + "/" + total + " 家 " + (store.name || store.id));
    let count = 0;
    try {
      const result = CoreApi.fetchTodayReservationData(dateStr, dateStr, store.id);
      count = (result && result.member && Array.isArray(result.member)) ? result.member.length : 0;
    } catch (e) {
      Logger.log("todayReservation: 店家 " + (store.name || store.id) + " 失敗 - " + e.message);
      count = "錯誤";
    }
    output.push([store.name || store.id, count]);
  }

  Logger.log("todayReservation: 寫入 " + output.length + " 筆");
  if (output.length > 0) {
    sheet.getRange(4, 1, output.length, 2).setValues(output);
  }
  Logger.log("todayReservation: 完成");
}
