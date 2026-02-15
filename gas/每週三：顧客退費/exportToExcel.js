/** 顧客退費（回覆）表單試算表 ID */
const REFUND_SS_ID = '1b2-ZFkyKabVeQxpNSgFdrsAkPzDb35vNXDNQYR75XKA';

/**
 * 篩選資料、整理欄位，並匯出為 Excel 檔案。
 * 
 * 步驟：
 * 1. 篩選資料：'確認匯款資料' (N欄) 非空 且 '登錄退費' (O欄) 為空。
 * 2. 格式化資料：將篩選後的資料對應到新的 Excel 格式，並處理特定欄位格式。
 * 3. 創建新工作表：將格式化後的資料貼到一個新的暫存工作表中。
 * 4. 匯出 Excel：生成一個連結，讓使用者可以下載該暫存工作表為 XLSX 格式。
 * 5. 刪除暫存工作表。
 */
function exportToExcelWithFilter() {
  const ss = SpreadsheetApp.openById(REFUND_SS_ID);
  const sourceSheetName = '表單回應 2'; // 您的工作表名稱
  const sourceSheet = ss.getSheetByName(sourceSheetName);
  const TODAY_YMD = getTransferDate(new Date());

  if (!sourceSheet) {
    SpreadsheetApp.getUi().alert(`找不到名為 ${sourceSheetName} 的工作表。`);
    return;
  }

  // 1. 獲取並篩選資料
  // 假設資料從 A1 開始，且第一行是標題。
  const range = sourceSheet.getRange('A1:U' + sourceSheet.getLastRow());
  const values = range.getValues();
  const header = values[0]; // 標題行
  const data = values.slice(1); // 資料行

  // 定義欄位索引 (0-based)
  const NAME_COL = header.indexOf('顧客姓名');                                 // B欄 (1)
  const BANK_CODE_COL = header.indexOf('退款帳戶  銀行代碼（3 碼 ）雪');            // G欄 (6)
  const ACCOUNT_COL = header.indexOf('退款帳戶  帳號（10-14碼，各家銀行不一樣）雪'); // I欄 (8)
  const ACCOUNT_BRANCH = header.indexOf('退款帳戶  分行代碼（4碼）雪')
  const REFUND_AMOUNT_COL = header.indexOf('公司轉客人退款 雪');                      // L欄 (11)
  const CONFIRM_COL = header.indexOf('確認匯款資料（雪）');                              // N欄 (13)
  const ACCOUNTED_COL = header.indexOf('匯出帳號(Robby)')                                // O欄 (14)
  const LOG_DATE_COL = header.indexOf('登錄退費');                                // O欄 (15)
  const STORE_COL = header.indexOf('消費店家');                                    // D欄 (3)
  const REFUND_REASON_COL = header.indexOf('退費原因');                              // E欄 (4)

  // 檢查關鍵欄位是否存在

  if (NAME_COL === -1 || BANK_CODE_COL === -1 || ACCOUNT_COL === -1 || REFUND_AMOUNT_COL === -1 || CONFIRM_COL === -1 || LOG_DATE_COL === -1 || STORE_COL === -1 || ACCOUNTED_COL === -1) {
    SpreadsheetApp.getUi().alert('找不到部分必要的欄位，請檢查標題名稱。');
    return;
  }

  const filteredData = [];
  
  // 新 Excel 檔案的標題
  const outputHeaders = [
    '收款人戶名',
    '收款帳號',
    '收款銀行代號',
    '交易金額',
    '收款人統編',
    '手續費扣法',
    '收款人傳真',
    '收款人email',
    '匯款附言',
    '付款帳號',
    '交易日期',
    '付款備註'
  ];
  filteredData.push(outputHeaders);

  data.forEach(row => {
    // 篩選條件: '確認匯款資料' (N欄) 非空 且 '登錄退費' (O欄) 為空
    const isConfirmed = String(row[CONFIRM_COL] || '').trim() !== '';
    const isRefundNotLogged = !row[LOG_DATE_COL] || String(row[LOG_DATE_COL]).trim() === '';
    
    if (isConfirmed && isRefundNotLogged) {
      console.log(row[NAME_COL])
      // 處理 '公司轉客人退款' (L欄): 移除貨幣符號 NT$ 和逗號
      let transactionAmount = row[REFUND_AMOUNT_COL];
      if (typeof transactionAmount === 'string') {
        transactionAmount = transactionAmount.replace('NT$', '').replace(/,/g, '').trim();
      }
      
      // 組合 '付款備註' (使用店家名稱和顧客姓名)
      const paymentMemo = `${row[STORE_COL]}-${row[NAME_COL]}`.substring(0, 72); 
      
      // 建立新的資料列
      const newRow = [
        row[NAME_COL],                               // (1) 收款人戶名 (1~65)
        "'"+String(row[ACCOUNT_COL]).substring(0, 16),   // (2) 收款帳號 (2~16)
        "'"+String(row[BANK_CODE_COL]).substring(0, 3)+String(row[ACCOUNT_BRANCH]).substring(0, 4),  // (3) 收款銀行代號 (7)
        transactionAmount,                           // (4) 交易金額 (1~18)
        '',                                          // (5) 收款人統編 (6~12) - 預設為 '99999999' (非必填)
        '0',                                         // (6) 手續費扣法 (1=內扣) - 固定為 '1'
        '',                                           // (7) 收款人傳真 - 預設
        '',                                            // (8) 收款人email - 預設
        paymentMemo,                                  // (9) 匯款附言 (1~72)
        String(row[ACCOUNTED_COL]).substring(0, 14),  // (10) 付款帳號 (6~17) - 預設為 '8888888888888'
        TODAY_YMD,                                   // (11) 交易日期 (YYYYMMDD)
        paymentMemo                                  // (12) 付款備註
      ];
      filteredData.push(newRow);
    }
  });

  // 2. 創建暫存工作表
  const tempSheetName = '退費匯款資料_Export_' + Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyyMMdd_HHmmss');
  const tempSheet = ss.insertSheet(tempSheetName);
  
  // 寫入篩選後的資料
  if (filteredData.length > 1) {
    tempSheet.getRange(1, 1, filteredData.length, filteredData[0].length).setValues(filteredData);
  } else {
     // 如果沒有篩選到資料，仍然寫入標題行
     tempSheet.getRange(1, 1, filteredData.length, outputHeaders.length).setValues(filteredData);
  }

  // 3. 匯出 Excel 連結
  const downloadUrl = `https://docs.google.com/spreadsheets/d/${ss.getId()}/export?format=xlsx&gid=${tempSheet.getSheetId()}`;

  try {
    const ui = SpreadsheetApp.getUi();
    const htmlOutput = HtmlService
      .createHtmlOutput(`<p>資料已整理到 <b>${tempSheetName}</b> 工作表。</p><p><a href="${downloadUrl}" target="_blank" onclick="google.script.host.close()">點擊此處下載 Excel (.xlsx) 檔案</a></p><p>下載完成後，請點選「擴充功能」→「刪除暫存工作表」來刪除暫存檔。</p>`)
      .setHeight(150)
      .setWidth(300);
    ui.showModalDialog(htmlOutput, 'Excel 匯出完成');
    ui.alert('下載完成後，請點選「擴充功能」→「刪除暫存工作表」來刪除 ' + tempSheetName + '。');
  } catch (e) {
    // 無 UI 情境（從編輯器 Run、觸發器、或試算表未開啟）：記入日誌，並在暫存表末列下方寫入連結
    var lastRow = Math.max(filteredData.length, 1);
    tempSheet.getRange(lastRow + 2, 1).setValue('下載連結（請從試算表選單執行以取得對話框）');
    tempSheet.getRange(lastRow + 3, 1).setFormula('=HYPERLINK("' + downloadUrl + '","點此下載 Excel")');
    Logger.log('匯出完成。下載連結: ' + downloadUrl);
  }
}

