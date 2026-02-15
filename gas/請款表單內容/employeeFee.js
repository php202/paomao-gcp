function payToEmployee() {
  const ss = SpreadsheetApp.openById(PAYMENT_SS_ID);
  const sourceSheetName = '勞報單'; // 您的工作表名稱
  const sourceSheet = ss.getSheetByName(sourceSheetName);

  if (!sourceSheet) {
    SpreadsheetApp.getUi().alert(`找不到名為 ${sourceSheetName} 的工作表。`);
    return;
  }


  // 1. 獲取並篩選資料
  // 假設資料從 A1 開始，且第一行是標題。
  const range = sourceSheet.getRange('A1:AA' + sourceSheet.getLastRow());
  const values = range.getValues();
  const header = values[0]; // 標題行
  const data = values.slice(1); // 資料行

  // 定義欄位索引 (0-based)
  const TIMESTAMP_COL = header.indexOf('時間戳記');
  const EMAIL_COL = header.indexOf('電子郵件地址');
  const NAME_COL = header.indexOf('基本資料');
  const ADDRESS_COL = header.indexOf('戶籍地址');
  const ID_NUMBER_COL = header.indexOf('身分證字號 / 居留證號');
  const SERVICE_START_DATE_COL = header.indexOf('勞務提供期間（起始日）');
  const SERVICE_END_DATE_COL = header.indexOf('勞務提供期間（結束日）');
  const SERVICE_DESCRIPTION_COL = header.indexOf('勞務內容說明');
  const AMOUNT_COL = header.indexOf('勞務報酬金額（未扣稅）');
  const IDENTITY_TYPE_COL = header.indexOf('身分類型');
  const BANK_CODE_COL = header.indexOf('銀行代碼（數字表示）');
  const BRANCH_CODE_COL = header.indexOf('分行代碼（數字表示）');
  const BANK_ACCOUNT_COL = header.indexOf('銀行帳號');
  const ACCOUNT_HOLDER_COL = header.indexOf('戶名');
  const ID_FRONT_COL = header.indexOf('身分證正面');
  const ID_BACK_COL = header.indexOf('身分證反面');
  const SIGNATURE_COL = header.indexOf('簽名（可在下方押上日期）');
  const PASSBOOK_COL = header.indexOf('存摺封面');
  const DECLARATION_COL = header.indexOf('聲明與同意');
  const CONFIRM_LUO_COL = header.indexOf('確認（羅）');
  const EXPENSE_TYPE_LUO_COL = header.indexOf('費用性質（羅）');
  const EXPECTED_TRANSFER_DATE_LUO_COL = header.indexOf('預計匯款日（羅）');
  const TRANSFER_FORM_COMPLETE_YU_COL = header.indexOf('製作匯款單完成（余）');
  const RELEASE_YU_COL = header.indexOf('放行（余）');
  const NUMBER_COL = header.indexOf('編號');
  const POSTED_LUO_COL = header.indexOf('是否入帳（羅）');
  const ODOO_POSTED_COL = header.indexOf('odoo入帳');

  if (NAME_COL === -1 || BANK_CODE_COL === -1 || BANK_ACCOUNT_COL === -1 || ACCOUNT_HOLDER_COL === -1 || BRANCH_CODE_COL === -1 || EXPECTED_TRANSFER_DATE_LUO_COL === -1 || EXPENSE_TYPE_LUO_COL === -1 || ID_NUMBER_COL === -1) {
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

  data.forEach(row => {
    if (row[EXPENSE_TYPE_LUO_COL] === '現金') { return }
    // 篩選條件: '確認（羅）' (T欄) 非空 且 '製作匯款單完成（余）' (W欄) 為空
    const isConfirmed = String(row[EXPECTED_TRANSFER_DATE_LUO_COL] || '').trim() !== '';
    const isRefundNotLogged = !row[TRANSFER_FORM_COMPLETE_YU_COL] || String(row[TRANSFER_FORM_COMPLETE_YU_COL]).trim() === '';
    if (isConfirmed && isRefundNotLogged) {
      console.log(row[NAME_COL])
      const TODAY_YMD = Core.getTransferDate(row[EXPECTED_TRANSFER_DATE_LUO_COL])
      // 處理 '公司轉客人退款' (L欄): 移除貨幣符號 NT$ 和逗號
      let transactionAmount = row[AMOUNT_COL];
      if (typeof transactionAmount === 'string') {
        transactionAmount = transactionAmount.replace('NT$', '').replace(/,/g, '').trim();
      }
      
      // 組合 '付款備註' (使用店家名稱和顧客姓名)
      const paymentMemo = `${row[EXPENSE_TYPE_LUO_COL]}-${row[NAME_COL]}`.substring(0, 72); 
      
      // 建立新的資料列
      const newRow = [
        row[NAME_COL],                               // (1) 收款人戶名 (1~65)
        "'"+String(row[BANK_ACCOUNT_COL]).substring(0, 16),   // (2) 收款帳號 (2~16)
        "'"+String(row[BANK_CODE_COL]).substring(0, 3)+String(row[BRANCH_CODE_COL]).substring(0, 4),  // (3) 收款銀行代號 (7)
        transactionAmount,                           // (4) 交易金額 (1~18)
        '',                                          // (5) 收款人統編 (6~12) - 預設為 '99999999' (非必填)
        '0',                                         // (6) 手續費扣法 (1=內扣) - 固定為 '1'
        '',                                           // (7) 收款人傳真 - 預設
        row[EMAIL_COL] ?? '',                                            // (8) 收款人email - 預設
        paymentMemo,                                  // (9) 匯款附言 (1~72)
        String(19201800238686).substring(0, 14),  // (10) 付款帳號 (6~17) - 預設為 '8888888888888'
        TODAY_YMD,                                   // (11) 交易日期 (YYYYMMDD)
        paymentMemo                                  // (12) 付款備註
      ];
      filteredData.push(newRow);
    }
  });
  return filteredData
  
}
