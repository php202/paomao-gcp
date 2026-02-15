/**
 * 每週三：顧客退費 - 本專案改為使用 Core API，不再依賴 Core 程式庫。
 * 指令碼屬性：PAO_CAT_CORE_API_URL、PAO_CAT_SECRET_KEY
 */
/** 顧客退費（回覆）表單試算表 ID */
const REFUND_SS_ID = '1b2-ZFkyKabVeQxpNSgFdrsAkPzDb35vNXDNQYR75XKA';

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🛠 帳務工具')
      .addItem('📖匯出篩選後的 Excel', 'exportToExcelWithFilter')
      .addItem('🚀 退還儲值金', 'refund')
      .addSeparator()
      .addItem('🗑️ 刪除暫存工作表', 'cleanupTempSheets')
      .addToUi();
}

function getCoreApiParams() {
  const p = PropertiesService.getScriptProperties();
  const url = (p.getProperty('PAO_CAT_CORE_API_URL') || '').trim();
  const key = (p.getProperty('PAO_CAT_SECRET_KEY') || '').trim();
  return { url: url, key: key, useApi: url.length > 0 && key.length > 0 };
}

function callCoreApiPost(url, key, action, extraParams) {
  if (!url || !key) return null;
  const payload = Object.assign({ key: key, action: action }, extraParams || {});
  try {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects: true
    });
    return JSON.parse(res.getContentText() || '{}');
  } catch (e) {
    Logger.log('callCoreApiPost error: ' + (e && e.message));
    return null;
  }
}

function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  var digits = String(phone).replace(/\D/g, '');
  if (digits.length === 9 && digits.charAt(0) === '9') return '0' + digits;
  if (digits.length >= 10) return digits.slice(-10);
  return '';
}

function refund() {
  const ss = SpreadsheetApp.openById(REFUND_SS_ID);
  const sheet = ss.getSheetByName('表單回應 2');
  const data = getPhonesFromSheet();
  const refundList = data.list || [];
  const returnedCol = data.returnedCol || 17;

  if (!refundList.length) {
    SpreadsheetApp.getUi().alert('沒有需要退費的資料 (需勾選「登錄退費」且未勾選「已歸還」)');
    return;
  }

  Logger.log('準備處理筆數：' + refundList.length);

  let successCount = 0;
  let failCount = 0;
  let logs = [];
  let refundedPhones = new Set();

  refundList.forEach(function(item) {
    const phone = item.phone;
    const rowIndex = item.rowIndex;

    if (refundedPhones.has(phone)) {
      logs.push(`⚠️ ${phone}: 重複資料，標記為已完成`);
      sheet.getRange(rowIndex, returnedCol).setValue(true);
      return;
    }

    const { url: apiUrl, key: apiKey } = getCoreApiParams();
    if (!apiUrl || !apiKey) {
      SpreadsheetApp.getUi().alert('請在指令碼屬性設定 PAO_CAT_CORE_API_URL 與 PAO_CAT_SECRET_KEY');
      return;
    }
    const result = callCoreApiPost(apiUrl, apiKey, 'executeRefundByPhone', { phone: phone });

    if (result && result.success) {
      successCount++;
      logs.push(`✅ ${phone}: 成功退費 $${result.amount}`);

      sheet.getRange(rowIndex, returnedCol).setValue(true);
      refundedPhones.add(phone);
      SpreadsheetApp.flush();

    } else {
      failCount++;
      logs.push(`❌ ${phone}: 失敗 - ${(result && (result.msg || result.message)) || 'API 無回傳'}`);
    }
  });

  // 顯示結果
  const summary = `退費作業結束。\n成功: ${successCount} 筆\n失敗: ${failCount} 筆\n\n詳細紀錄已寫入日誌。`;
  Logger.log(logs.join('\n'));
  SpreadsheetApp.getUi().alert(summary);
}

function getPhonesFromSheet() {
  const ss = SpreadsheetApp.openById(REFUND_SS_ID);
  const sheet = ss.getSheetByName('表單回應 2');
  if (!sheet) {
    Logger.log('找不到工作表：表單回應 2');
    return { list: [], returnedCol: 17 };
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { list: [], returnedCol: 17 };

  // 讀取標題列以動態取得欄位索引（避免欄位順序變動導致錯讀）
  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const phoneCol = findHeaderIndex(headerRow, ['顧客手機', '手機', '聯絡電話']);
  const confirmCol = findHeaderIndex(headerRow, ['確認匯款資料（雪）', '確認匯款資料', '確認匯款']);
  const logCol = findHeaderIndex(headerRow, ['登錄退費']);
  const returnedCol = findHeaderIndex(headerRow, ['已歸還', '儲值金已歸還']);

  if (phoneCol < 0 || confirmCol < 0 || logCol < 0 || returnedCol < 0) {
    Logger.log('找不到必要欄位。phone=' + phoneCol + ' confirm=' + confirmCol + ' log=' + logCol + ' returned=' + returnedCol);
    return { list: [], returnedCol: 17 };
  }

  const maxCol = Math.max(phoneCol, confirmCol, logCol, returnedCol) + 1;
  const range = sheet.getRange(2, 1, lastRow - 1, maxCol);
  const rows = range.getValues();

  const refundList = rows
    .map(function(row, index) {
      const phone = row[phoneCol];
      const nCol = row[confirmCol];
      const pCol = row[logCol];
      const qCol = row[returnedCol];

      const isAccount = (nCol || nCol === true || String(nCol).trim() !== '' || String(nCol).toUpperCase() === 'TRUE');
      const isLogged = (String(pCol).trim() !== '');
      // 已歸還：需為「未勾選」才要處理（空、false、FALSE、0 皆視為未歸還）
      const isNotReturned = !isReturnedChecked(qCol);

      if (isLogged && isNotReturned && isAccount) {
        return {
          phone: normalizePhone(phone),
          rowIndex: index + 2
        };
      }
      return null;
    })
    .filter(function(item) {
      return item !== null && item.phone !== '';
    });

  return { list: refundList, returnedCol: returnedCol + 1 };
}

function findHeaderIndex(headerRow, names) {
  for (var i = 0; i < headerRow.length; i++) {
    var h = String(headerRow[i] || '').trim();
    for (var j = 0; j < names.length; j++) {
      if (h.indexOf(names[j]) >= 0) return i;
    }
  }
  return -1;
}

function isReturnedChecked(val) {
  if (val == null) return false;
  var s = String(val).trim().toUpperCase();
  if (s === '') return false;
  if (s === 'FALSE' || s === '0') return false;
  if (val === false) return false;
  return true;  // TRUE、true、1、任何非空值皆視為已歸還
}

function getTransferDate(rowTransferDate) {
  const timeZone = 'Asia/Taipei';
  let now = new Date();
  const nowHourMinute = parseInt(Utilities.formatDate(now, timeZone, 'HHmm'));
  const literalTodayYMD = Utilities.formatDate(now, timeZone, 'yyyyMMdd');
  let rowDateObj = new Date(rowTransferDate);
  if (isNaN(rowDateObj.getTime())) rowDateObj = now;
  const rowTransferDateYMD = Utilities.formatDate(rowDateObj, timeZone, 'yyyyMMdd');
  let newTransferDate;
  if (rowTransferDateYMD <= literalTodayYMD) {
    if (nowHourMinute > 1510) {
      var tomorrow = new Date(now.getTime());
      tomorrow.setDate(tomorrow.getDate() + 1);
      newTransferDate = tomorrow;
    } else {
      newTransferDate = now;
    }
  } else {
    newTransferDate = rowDateObj;
  }
  return Utilities.formatDate(newTransferDate, timeZone, 'yyyyMMdd');
}

function cleanupTempSheets() {
  const delName = '退費匯款資料_Export_';
  const ss = SpreadsheetApp.openById(REFUND_SS_ID);
  const sheets = ss.getSheets();
  let count = 0;
  sheets.forEach(function(sheet) {
    const name = sheet.getName();
    if (name.indexOf(delName) === 0) {
      ss.deleteSheet(sheet);
      count++;
    }
  });
  SpreadsheetApp.getUi().alert(count > 0 ? '已成功刪除 ' + count + ' 個暫存工作表。' : '沒有找到任何暫存工作表。');
}
