function handleDelete(e) {
  var ssId = typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID ? CONFIG.INTEGRATED_SHEET_SS_ID : null;
  const ss = ssId ? SpreadsheetApp.openById(ssId) : null;
  if (!ss) return Core.jsonResponse({error: '無法取得試算表'});
  // 2. 驗證列號 (防呆)
  const rowToUpdate = parseInt(e.parameter.row);
  if (isNaN(rowToUpdate) || rowToUpdate <= 1) {
    return Core.jsonResponse({error: '無效的列號 (Invalid Row)'});
  }

  const operator = e.parameter.operator_name ?? "未知人員";
  const logSheet = ss.getSheetByName('訊息一覽');

  // 3. 設定台灣時間格式 (讓 Excel 裡面看起來是正確的當地時間)
  const nowStr = Utilities.formatDate(new Date(), "GMT+8", "yyyy/MM/dd HH:mm:ss");

  try {
    logSheet.getRange(rowToUpdate, 6, 1, 2).setValues([
      [nowStr, operator]
    ]);
    return Core.jsonResponse({status: 'marked_done', row: rowToUpdate, by: operator, time: nowStr});
  } catch (err) {
    return Core.jsonResponse({error: '刪除失敗', details: err.toString()});
  }
}