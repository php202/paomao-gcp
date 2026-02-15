function achP01(lists) {
  let bankInfoMap;
  try {
    bankInfoMap = Core.getBankInfoMap();
  } catch (e) {
    SpreadsheetApp.getUi().alert('設定錯誤：' + e.toString());
    return;
  }
  // 1. 日期處理
  const now = new Date();
  const todayROC = (now.getFullYear() - 1911).toString() +
    Utilities.formatDate(now, "GMT+8", "MMdd");
  const fileDate = Utilities.formatDate(now, "GMT+8", "yyyyMMddHHmmss");
  
  // 2. 初始化內容與 Header (固定長度 250)
  let txtContent = [];
  const header = `BOFACHP010${todayROC}20180680700149990250V10`.padEnd(250, ' ');
  txtContent.push(header);

  let totalFees = 0;
  let count = 0;

  // 3. 遍歷資料列 (從 i=1 開始跳過標題列)
  for (let i = 0; i < lists.length; i++) {
    // 欄位索引 (0-based):
    // A=0(日期), B=1(店家), C=2(金額), D=3(代碼), E=4(明細), F=5(客人確認), G=6(登陸ach)
    
    // 取得用於 TXT 檔生成的欄位資料
    let feeStr = lists[i][2];         // 金額 (Column C)
    const code = String(lists[i][3]).trim();         // 代碼 (Column D)
    // 清理金額欄位：移除貨幣符號和千分位符號，只保留數字和負號
    let fee = String(feeStr).replace(/[$,]/g, '').trim();

    // 如果清理後的金額為空或為 0，或為負數，則跳過
    if (!fee || parseFloat(fee) <= 0) continue;

    // 轉換為整數
    fee = parseInt(fee);
    console.log(bankInfoMap.get(code))
    // 4. 根據代碼查找銀行帳號
    const customerBankAccount = bankInfoMap.get(code).bankAccount;
    const customerBranch = bankInfoMap.get(code).branch;
    if (!customerBankAccount) {
       // 如果找不到帳號，警告並跳過此行
       console.log(`錯誤：找不到代碼 ${code} 對應的銀行帳號 (第 ${i + 1} 行)。請檢查 '店家基本資訊' 表格。`);
       continue;
    }
    
    // 清理銀行帳號，只保留數字
    let cleanedAccount = customerBankAccount.replace(/[^0-9]/g, '');
    let cleanedBranch = customerBranch.replace(/[^0-9]/g, '');

    count++;
    totalFees += fee;

    const countStr = count.toString().padStart(8, '0');
    const feeCents = (fee * 100).toString().padStart(10, '0'); // 補足至 10 位
    const accountStr = cleanedAccount.padEnd(14, '0');
    const branchStr = cleanedBranch.padEnd(4, '0')
    const pinStr = bankInfoMap.get(code).pin.toString().padEnd(10, ' ')
    // console.log(i, countStr, feeCents, accountStr, branchStr, pinStr)

    // 依據「拷貝(1)」格式進行組合 
    let line = "NSD904" + countStr + "80700140019201800234666" + branchStr + "00"+accountStr+"00"
               + feeCents + "B94256530" + "  " + pinStr + 
               "      0000000000000000 " + pinStr + "                                                            00000                                                           "

    txtContent.push(line);
  }

  // 4. 加入 Footer (固定長度 250)
  const footer = `EOFACHP010${todayROC}80700149990250000000${count.toString().padStart(2, '0')}${totalFees.toString().padStart(16, '0')}`.padEnd(250, ' ');
  txtContent.push(footer);

  // 5. 產出檔案
// 5. 產出檔案
  const finalString = txtContent.join('\r\n'); // 使用 CRLF 換行
  const achFileName = `94256530_P01_${fileDate}.txt`;

  try {
    // 建立檔案於雲端硬碟根目錄
    const file = DriveApp.createFile(achFileName, finalString, MimeType.PLAIN_TEXT);
    // --- 修改處：產出直接下載連結 ---
    // 將連結轉換成直接下載格式
    const achDownloadUrl = `https://drive.google.com/uc?export=download&id=${file.getId()}`;
    return { achFileName, achDownloadUrl }
    // 6. 完成提示與下載按鈕
  } catch (e) {
    SpreadsheetApp.getUi().alert('發生錯誤：' + e.toString());
  }
}
