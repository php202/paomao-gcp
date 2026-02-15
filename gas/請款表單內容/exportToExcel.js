function exportToExcelWithFilter(excel666To686, pay666ToFranchisee, pay686ToFranchisee) {
  const ss = SpreadsheetApp.openById(PAYMENT_SS_ID);
  const TODAY_YMD = Core.getTransferDate(new Date())

  const outputHeaders = [
    '收款人戶名', '收款帳號', '收款銀行代號', '交易金額', '收款人統編', 
    '手續費扣法', '收款人傳真', '收款人email', '匯款附言', '付款帳號', 
    '交易日期', '付款備註'
  ];
  
  const filteredData = [outputHeaders];

  // 1. 取得銀行資訊 Map
  let bankInfoMap;
  try {
    bankInfoMap = Core.getBankInfoMap();
  } catch (e) {
    SpreadsheetApp.getUi().alert('設定錯誤：' + e.toString());
    return;
  }
  
  /**
   * 內部輔助函式：增加資料檢查
   */
  const processRow = (row, sourceAccount) => {
    // 【防錯 1】檢查 row 是否存在
    if (!row || !Array.isArray(row)) {
      console.error("傳入 processRow 的資料無效:", row);
      return null;
    }

    const storeName = row[1];
    const amount = Math.abs(row[2]); 
    const memo = `${storeName}-${row[4]}`.substring(0, 72); 
    const storeCode = String(row[3]).trim();
    
    // 【防錯 2】檢查 Map 中是否有該店家資料
    const info = bankInfoMap.get(storeCode); 
    
    if (!info) {
      console.warn(`在「店家基本資訊」找不到代碼: ${storeCode}`);
      // 如果找不到，可以選擇跳過或是填入預設值
      return [
        storeName,    // 戶名暫代
        '',           // 帳號未知
        '',           // 銀行未知
        amount, sourceAccount, TODAY_YMD, memo // ...其餘略
      ];
    }
    
    return [
      info.name,           
      "'"+info.bankAccount.toString().padStart(14, '0'),  
      "'"+info.branch.toString().padStart(7, '0'),         
      amount,              
      '',                  
      '0',                 
      '',                  
      '',                  
      memo,                
      sourceAccount,       
      TODAY_YMD,           
      memo                 
    ];
  };

  // 2. 處理各類資料 (加入防錯迴圈)
  const COMPANY_ACC_666 = '19201800234666'; 
  const COMPANY_ACC_686 = '19201800238686';

  // Case 1: 貨款
  if (excel666To686 && excel666To686.length > 0) {
    excel666To686.forEach(row => {
      let modifiedRow = [...row]; 
      modifiedRow[3] = '94256530686'
      const processed = processRow(modifiedRow, COMPANY_ACC_666);
      if (processed) filteredData.push(processed);
    });
  }

  // Case 2: 儲值金退款 (注意這裡 item 必須存在)
  if (pay666ToFranchisee && pay666ToFranchisee.length > 0) {
    pay666ToFranchisee.forEach(row => {
      if (row) {
        const processed = processRow(row, COMPANY_ACC_666);
        if (processed) filteredData.push(processed);
      }
    });
  }

  // Case 3: 票卷
  if (pay686ToFranchisee && pay686ToFranchisee.length > 0) {
    pay686ToFranchisee.forEach(row => {
      if (row) {
        const processed = processRow(row, COMPANY_ACC_686);
        if (processed) filteredData.push(processed);
      }
    });
  }
  // 加入勞務費用
  let pay686ToEmployee = payToEmployee(); // 存放公司須轉帳給勞務人員資料
  if (pay686ToEmployee && pay686ToEmployee.length > 0)  {
    filteredData.push(...pay686ToEmployee);
  }
  // 加入請款表費用
  let pay686ToReceipt = payToReceipt();
  // console.log(pay686ToReceipt)
  if (pay686ToReceipt && pay686ToReceipt.length > 0) {
    filteredData.push(...pay686ToReceipt)
  }
  // ... 後續匯出邏輯不變 ...
  if (filteredData.length === 1) {
    SpreadsheetApp.getUi().alert('沒有符合條件的資料可匯出。');
    return;
  }

  const etewfTempSheetName = '銀行匯款格式_' + Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyyMMdd_HHmmss');
  const tempSheet = ss.insertSheet(etewfTempSheetName);
  tempSheet.getRange(1, 1, filteredData.length, outputHeaders.length).setValues(filteredData);
  const etewfDownloadUrl = `https://docs.google.com/spreadsheets/d/${ss.getId()}/export?format=xlsx&gid=${tempSheet.getSheetId()}`;

  return {etewfTempSheetName, etewfDownloadUrl}
  // const htmlOutput = HtmlService.createHtmlOutput(`...省略部分HTML...`).setHeight(180).setWidth(350);
  // SpreadsheetApp.getUi().showModalDialog(htmlOutput, '🚀 銀行匯出工具');
}