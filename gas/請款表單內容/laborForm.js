// --- 全域設定區 ---
const CONFIG = {
  // 1. Google Slides 模版 ID
  TEMPLATE_ID: '19rIcdJxE6eh_KA2o1kl0vt6BSqTnv075rXWdBVZJ47s',  
  
  // 2. 產出的 PDF 存放資料夾 ID
  OUTPUT_FOLDER_ID: '1KfSAs13zZuDUK3a5qDGjSt5ciZ50fcriF1ETb0ryrSQvExESJngPJIhU3yEcRGIIcQuAjFoq', 
  
  // 3. 工作表名稱
  SHEET_NAME: '勞報單',

  // 4. 關鍵判斷欄位名稱
  COL_CHECK_MONEY: '是否匯款成功（羅）', 
  COL_CHECK_DONE: '勞報單製作完成',      

  // 5. 文字欄位對應
  TEXT_MAPPING: {
    '{{姓名}}': '基本資料',
    '{{地址}}': '戶籍地址',
    '{{身分證字號}}': '身分證字號 / 居留證號',
    '{{起始日}}': '勞務提供期間（起始日）',
    '{{結束日}}': '勞務提供期間（結束日）',
    '{{內容}}': '勞務內容說明',
    '{{金額}}': '勞務報酬金額（未扣稅）',
    '{{銀行代碼}}': '銀行代碼（數字表示）',
    '{{分行代碼}}': '分行代碼（數字表示）',
    '{{銀行帳號}}': '銀行帳號',
    '{{戶名}}': '戶名',
    '{{電子郵件地址}}': '電子郵件地址'
  },

  // 6. 圖片欄位對應
  IMAGE_MAPPING: {
    '{{身分證正面}}': '身分證正面',
    '{{身分證反面}}': '身分證反面',
    '{{簽名}}': '簽名（可在下方押上日期）'
  }
};

function createLaborReceipts() {
  const ss = SpreadsheetApp.openById(PAYMENT_SS_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('找不到工作表：' + CONFIG.SHEET_NAME);
    return;
  }

  // 讀取所有資料 (二維陣列)
  const data = sheet.getDataRange().getValues();
  const headers = data[0]; // 第一列標題
  
  // 1. 先找出關鍵欄位的索引 (Index)，直接用數字查比較快
  const idxMoney = headers.indexOf(CONFIG.COL_CHECK_MONEY);
  const idxDone = headers.indexOf(CONFIG.COL_CHECK_DONE);

  if (idxMoney === -1 || idxDone === -1) {
    SpreadsheetApp.getUi().alert(`找不到關鍵欄位！\n找不到: ${idxMoney === -1 ? CONFIG.COL_CHECK_MONEY : CONFIG.COL_CHECK_DONE}`);
    return;
  }

  // --- 優化區塊：先建立「待辦清單 (Jobs)」---
  console.log('正在掃描資料表，尋找需製作的項目...');
  const pendingJobs = [];

  // 從第 1 列 (Row 2) 開始掃描
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    // 直接讀取陣列位置，不先轉物件，速度最快
    const moneyVal = row[idxMoney];
    const doneVal = row[idxDone];

    // 判斷條件：已匯款 (不為空) 且 未製作 (為空)
    if (moneyVal !== '' && doneVal === '') {
      pendingJobs.push({
        rowIndex: i,  // 記住原始列號 (0-based)
        rowDataArray: row // 記住這列的資料
      });
    }
  }

  // 如果沒有工作就直接結束，不浪費時間
  if (pendingJobs.length === 0) {
    SpreadsheetApp.getUi().alert('作業結束！沒有發現符合條件（已匯款且未製作）的資料。');
    return;
  }

  // --- 執行區塊：只針對待辦清單跑迴圈 ---
  
  // 取得輸出資料夾
  let folder;
  try {
    folder = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID);
  } catch(e) {
    folder = DriveApp.getRootFolder();
    console.log("資料夾 ID 錯誤，改存根目錄");
  }

  let successCount = 0;
  console.log(`共發現 ${pendingJobs.length} 筆資料需要製作。`);

  // 開始製作
  for (const job of pendingJobs) {
    // 這裡才把資料轉成物件 { '標題': '內容' } 給 generatePDF 用
    const rowObject = {};
    headers.forEach((header, index) => {
      rowObject[header] = job.rowDataArray[index];
    });

    const name = rowObject['基本資料'];
    console.log(`>> 正在製作 (${successCount + 1}/${pendingJobs.length}): ${name}`);

    try {
      // 1. 產生 PDF 並取得連結
      const pdfUrl = generatePDF(name, rowObject, folder);
      
      // 2. 回寫連結到試算表
      // 注意：job.rowIndex 是 0-based，getRange 是 1-based，所以要 +1
      sheet.getRange(job.rowIndex + 1, idxDone + 1).setValue(pdfUrl);
      
      successCount++;
      console.log(`   ✅ 完成`);

    } catch (e) {
      console.error(`   ❌ 失敗: ${e.toString()}`);
      sheet.getRange(job.rowIndex + 1, idxDone + 1).setValue('製作失敗: ' + e.message);
    }
  }
  
  SpreadsheetApp.getUi().alert(`作業結束！\n共製作了 ${successCount} 張勞報單。`);
}

function generatePDF(name, rowData, folder) {
  // --- 準備檔名 ---
  let timestampRaw = rowData['時間戳記'];
  if (!timestampRaw) timestampRaw = new Date(); 
  const dateStrForFilename = Utilities.formatDate(new Date(timestampRaw), Session.getScriptTimeZone(), 'yyyyMMdd');
  
  const newFilename = `${dateStrForFilename}_${name}_勞報單`;

  // --- 開始製作 ---
  const templateFile = DriveApp.getFileById(CONFIG.TEMPLATE_ID);
  const tempFile = templateFile.makeCopy(newFilename + "_temp", folder);
  const tempId = tempFile.getId();
  
  const presentation = SlidesApp.openById(tempId);
  const slide = presentation.getSlides()[0];

  // 1. 替換一般文字
  for (const [placeholder, header] of Object.entries(CONFIG.TEXT_MAPPING)) {
    let value = rowData[header];
    if (value instanceof Date) {
      value = Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy/MM/dd');
    }
    slide.replaceAllText(placeholder, value ? value.toString() : '');
  }

  // 3. 特殊處理：勞務期間 (合併顯示)
  const dStart = formatDate(rowData['勞務提供期間（起始日）']);
  const dEnd = formatDate(rowData['勞務提供期間（結束日）']);
  const rangeStr = (dStart === dEnd) ? dStart : `${dStart} ~ ${dEnd}`;
  slide.replaceAllText('{{日期}}', rangeStr);
  
  // 4. 特殊處理：填表日期 (使用時間戳記)
  slide.replaceAllText('{{填表日期}}', formatDate(timestampRaw));

  // 5. 替換圖片
  const pageElements = slide.getPageElements();
  for (const element of pageElements) {
    if (element.getPageElementType() === SlidesApp.PageElementType.IMAGE) {
      const img = element.asImage();
      const altText = img.getDescription();
      
      if (CONFIG.IMAGE_MAPPING[altText]) {
        const fileUrl = rowData[CONFIG.IMAGE_MAPPING[altText]];
        const fileId = getIdFromDriveUrl(fileUrl);
        
        if (fileId) {
          try {
            const blob = DriveApp.getFileById(fileId).getBlob();
            img.replace(blob);
          } catch (e) {
            console.log(`圖片讀取錯誤 ${altText}: ${e.message}`);
          }
        }
      }
    }
  }

  presentation.saveAndClose();

  // 6. 轉存 PDF 並設定檔名
  const pdfBlob = DriveApp.getFileById(tempId).getAs(MimeType.PDF);
  const pdfFile = folder.createFile(pdfBlob).setName(newFilename + ".pdf");

  // 7. 刪除暫存 Slides
  DriveApp.getFileById(tempId).setTrashed(true);

  // 8. 回傳 PDF 檔案的網址
  return pdfFile.getUrl();
}

// 工具：格式化日期 yyyy/MM/dd
function formatDate(dateObj) {
  if (!dateObj) return '';
  if (dateObj instanceof Date) {
    return Utilities.formatDate(dateObj, Session.getScriptTimeZone(), 'yyyy/MM/dd');
  }
  return dateObj.toString().substring(0, 10);
}

// 工具：抓 ID
function getIdFromDriveUrl(url) {
  if (!url) return null;
  let match = url.match(/id=([a-zA-Z0-9_-]{25,})/);
  if (match) return match[1];
  match = url.match(/\/d\/([a-zA-Z0-9_-]{25,})/);
  if (match) return match[1];
  return null;
}
function debugTemplateImages() {
  const templateId = CONFIG.TEMPLATE_ID;
  console.log(`正在檢查模版 ID: ${templateId}`);

  try {
    const slide = SlidesApp.openById(templateId).getSlides()[0];
    const elements = slide.getPageElements();
    
    console.log(`--- 頁面上共有 ${elements.length} 個物件 ---`);
    
    let imageCount = 0;
    
    elements.forEach((element, index) => {
      const type = element.getPageElementType();
      
      if (type === SlidesApp.PageElementType.IMAGE) {
        imageCount++;
        const altTitle = element.asImage().getTitle();
        const altDesc = element.asImage().getDescription();
        
        console.log(`[物件 ${index}] 是圖片 (IMAGE)`);
        console.log(`   - 替代文字(標題): "${altTitle}"`);
        console.log(`   - 替代文字(說明): "${altDesc}"  <-- 程式讀取這裡`);
        
        if (CONFIG.IMAGE_MAPPING[altDesc]) {
          console.log(`   ✅ 成功對應到程式設定: ${altDesc}`);
        } else if (CONFIG.IMAGE_MAPPING[altTitle]) {
          console.log(`   ⚠️ 您填在「標題」了！請移到「說明」欄位。`);
        } else {
          console.log(`   ❌ 未對應到任何設定，請檢查是否有錯字。`);
        }
        
      } else if (type === SlidesApp.PageElementType.SHAPE) {
        const shapeText = element.asShape().getText().asString().trim();
        console.log(`[物件 ${index}] 是圖案 (SHAPE) - 程式無法替換圖案！`);
        console.log(`   - 內容文字: "${shapeText}"`);
        if (shapeText.includes('{{')) {
             console.log(`   ⚠️ 警告：您可能誤用「圖案」來當圖片框，請改用「插入 > 圖片」。`);
        }
      }
    });

    if (imageCount === 0) {
      console.log(`❌ 警告：在模版中找不到任何「圖片」類型的物件！`);
    }

  } catch (e) {
    console.error(`檢查失敗: ${e.message}`);
  }
}