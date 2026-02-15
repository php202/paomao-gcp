function payToReceipt() {
  const ss = SpreadsheetApp.openById(PAYMENT_SS_ID);
  const sourceSheetName = '2026請款表'; // 您的工作表名稱
  const sourceSheet = ss.getSheetByName(sourceSheetName);

  if (!sourceSheet) {
    SpreadsheetApp.getUi().alert(`找不到名為 ${sourceSheetName} 的工作表。`);
    return;
  }


  // 1. 獲取並篩選資料
  // 假設資料從 A1 開始，且第一行是標題。
  const range = sourceSheet.getRange('A1:Y' + sourceSheet.getLastRow());
  const values = range.getValues();
  const header = values[0]; // 標題行
  const data = values.slice(1); // 資料行

  // 定義欄位索引 (0-based)
const BIANHAO_COL = header.indexOf("編號");
const CLAIMANT_COL = header.indexOf("請款人");
const UNIT_COL = header.indexOf("單位");
const CLAIM_REASON_COL = header.indexOf("請款事由");
const CLAIM_AMOUNT_COL = header.indexOf("請款金額");
const APPROVAL_LI_COL = header.indexOf("簽核完成(李)");
const ESTIMATED_REMITTANCE_LUO_COL = header.indexOf("預計匯款日(羅)");
const DISBURSEMENT_RO_COL = header.indexOf("登錄撥款(Ro)");

if (
  BIANHAO_COL === -1 ||
  CLAIMANT_COL === -1 || 
  CLAIM_REASON_COL === -1 || 
  UNIT_COL === -1 || 
  CLAIM_AMOUNT_COL === -1 || 
  ESTIMATED_REMITTANCE_LUO_COL === -1 ||  
  APPROVAL_LI_COL === -1
  ) {
    SpreadsheetApp.getUi().alert('找不到部分必要的欄位，請檢查標題名稱。');
    return;
  }
  const filteredData = [];

  // 1. 取得銀行資訊 Map
  let bankInfoMap;
  try {
    bankInfoMap = Core.getBankInfoMap();
  } catch (e) {
    SpreadsheetApp.getUi().alert('設定錯誤：' + e.toString());
    return;
  }

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
    // 篩選條件: '確認（羅）' (T欄) 非空 且 '製作匯款單完成（余）' (W欄) 為空
    const isConfirmed = String(row[ESTIMATED_REMITTANCE_LUO_COL] || '').trim() !== '';
    const isRefundNotLogged = !row[DISBURSEMENT_RO_COL] || String(row[DISBURSEMENT_RO_COL]).trim() === '';
    if (isConfirmed && isRefundNotLogged) {
      console.log(row[CLAIMANT_COL])
      const TODAY_YMD = Core.getTransferDate(row[ESTIMATED_REMITTANCE_LUO_COL])
      
      // 處理 '轉帳金額' (L欄): 移除貨幣符號 NT$ 和逗號
      let transactionAmount = row[CLAIM_AMOUNT_COL];
      if (typeof transactionAmount === 'string') {
        transactionAmount = transactionAmount.replace('NT$', '').replace(/,/g, '').trim();
      }
      
      // 組合 '付款備註' (使用店家名稱和顧客姓名)
      const paymentMemo = `id${row[BIANHAO_COL]}-${row[UNIT_COL]}-${row[CLAIM_REASON_COL]}`.replace(/[*~&]/g, '').substring(0, 16); 
      const info = bankInfoMap.get(row[CLAIMANT_COL]); 
    
      if (!info) {
        console.warn(`在「店家基本資訊」找不到代碼: ${row[CLAIMANT_COL]}`);
        // 如果找不到，可以選擇跳過或是填入預設值
        return [
          row[row[CLAIMANT_COL]]+"(未知)",    // 戶名暫代
          '',           // 帳號未知
          '',           // 銀行未知
          amount, sourceAccount, TODAY_YMD, memo // ...其餘略
        ];
      }
      // 建立新的資料列
      const newRow = [
        info.name,                               // (1) 收款人戶名 (1~65)
        "'"+info.bankAccount.toString().padStart(14, '0'),    // (2) 收款帳號 (2~16)
        "'"+info.branch.toString().padStart(7, '0'),  // (3) 收款銀行代號 (7)
        transactionAmount,                           // (4) 交易金額 (1~18)
        '',                                          // (5) 收款人統編 (6~12) - 預設為 '99999999' (非必填)
        '0',                                         // (6) 手續費扣法 (1=內扣) - 固定為 '1'
        '',                                           // (7) 收款人傳真 - 預設
        '',                                            // (8) 收款人email - 預設
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
