function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🛠 帳務工具')
      .addItem('🚀 產出各店日報', 'runAccNeed')
      .addItem('📅 補跑 2026-02-22', 'runAccNeedDate20260222')
      .addItem('🔗 設定 Core API 網址說明', 'showCoreApiUrlHelp')
      .addItem('📋 楊梅金山店 日帳', 'runYangmeiJinshanDailyReport')
      .addSeparator()
      .addItem('📊 員工業績月報（2025～現在）', 'runEmployeeMonthlyReportFull')
      .addItem('📊 員工業績月報（上月）', 'runEmployeeMonthlyReportLastMonth')
      .addItem('🔧 除錯：測試 API 回傳', 'debugEmployeeMonthlyReportApi')
      .addItem('⏰ 建立每月排程（員工業績月報）', 'setupEmployeeMonthlyReportTrigger')
      .addToUi();
}