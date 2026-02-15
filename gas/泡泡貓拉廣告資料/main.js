function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🛠 分析幫手')
      .addItem('🚀 產出動態預約', 'appointmentLists')
      .addItem('🚀 取得今日預約', 'todayReservation')
      // .addSeparator()
      // .addItem('🗑️ 刪除暫存工作表', 'cleanupTempSheets')
      .addToUi();
}
