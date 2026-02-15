/**
 * 上個月小費表 + 消費紀錄追蹤（採 runTips 邏輯）
 * 小費統整表（上月小費讀寫）：僅用 TIPS_CONSOLIDATED_SS_ID + gid=TIPS_CONSOLIDATED_SHEET_GID，來源固定拉對。
 * 依賴：TIPS_FORM_SS_ID（表單回應）、SayDou 消費與會員 API、getStoresInfo、fetchTransactions、fetchMembersByDateRange。
 */
var TZ_TIPS = Session.getScriptTimeZone() || 'Asia/Taipei';

/** 小費統整表試算表 ID（上月小費唯一來源：讀寫都從此試算表 gid=1727178779，不 fallback 其他 ID） */
var TIPS_CONSOLIDATED_SS_ID = '1GH2XbihFIY0AX8SMF9Tk6igrVKPpA_vMJVlkDkJjpe4';

var TIPS_FORM_KEYS = [
    '時間戳記', '您的手機號碼', '性別', '年齡',
    '因為這次的消費，我願意再次光臨泡泡貓', '我覺得泡泡貓在服務上，能給我好的體驗',
    '經過本次消費，我覺得泡泡貓這個品牌能讓我放心',
    '泡泡貓哪些服務，讓您覺得特別滿意', '您從哪裡得知泡泡貓？',
    '如有其他建議，還請不吝指教，我們會加以完善',
    '本次潔顏師的表現，我會給予幾顆星？',
    '願意給予小費，表達對潔顏師的支持', '今天消費地點',
  '', '電話', '會員姓名', '潔顏師', '確認扣款', '已撥款'
];

/**
 * 解析表單 時間戳記 字串為 Date（支援 上午/下午）
 */
function parseFormTimestamp(str) {
    if (!str || typeof str !== 'string') return null;
    var s = String(str).trim();
    var isPM = s.indexOf('下午') >= 0;
    var datePart = s.slice(0, s.indexOf('上午') >= 0 ? s.indexOf('上午') : (s.indexOf('下午') >= 0 ? s.indexOf('下午') : s.length)).trim();
    var timePart = (s.indexOf('上午') >= 0 ? s.slice(s.indexOf('上午') + 3) : (s.indexOf('下午') >= 0 ? s.slice(s.indexOf('下午') + 3) : '')).trim();
    if (!datePart) return null;
    var d = new Date(datePart + ' ' + timePart.replace(/\s/g, ''));
    if (isNaN(d.getTime())) return null;
  if (isPM) d.setHours(d.getHours() + 12);
  return d;
}

/**
 * 從 Google 客人問卷（表單回應試算表）讀取小費／五星好評回應。
 * 依第一列標題對應欄位（與 runTips 一致），不依固定欄序，避免表單改題目後錯欄。
 */
function getTipsFormDataFromSheet(startDate, endDate) {
  var ssId = typeof TIPS_FORM_SS_ID !== 'undefined' ? TIPS_FORM_SS_ID : '';
  var sheetName = typeof TIPS_FORM_SHEET_NAME !== 'undefined' ? TIPS_FORM_SHEET_NAME : 'sheet1';
  var sheetGid = typeof TIPS_FORM_SHEET_GID !== 'undefined' ? TIPS_FORM_SHEET_GID : null;
  if (!ssId) {
    console.warn('[TipsReport] 未設定 TIPS_FORM_SS_ID（客人問卷試算表 ID）');
    return [];
  }
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = null;
    if (sheetGid != null && sheetGid !== '') {
      var sheets = ss.getSheets();
      for (var i = 0; i < sheets.length; i++) {
        if (Number(sheets[i].getSheetId()) === Number(sheetGid)) {
          sheet = sheets[i];
          break;
        }
      }
    }
    if (!sheet) sheet = ss.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < 2) return [];
    var numCols = Math.max(sheet.getLastColumn(), 20);
    var data = sheet.getRange(1, 1, sheet.getLastRow(), numCols).getValues();
    var headerRow = data[0] || [];
    var colIndex = {};
    for (var c = 0; c < headerRow.length; c++) {
      var h = (headerRow[c] != null ? String(headerRow[c]).trim() : '');
      if (h) colIndex[h] = c;
    }
    if (colIndex['時間戳記'] === undefined) {
      console.warn('[TipsReport] 表單試算表第一列找不到「時間戳記」，請確認為 Google 客人問卷回應表');
      return [];
    }
    var out = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      var obj = {};
      for (var key in colIndex) {
        var idx = colIndex[key];
        obj[key] = (row[idx] != null ? String(row[idx]).trim() : '');
      }
      if (!obj['時間戳記']) continue;
      var dt = parseFormTimestamp(obj['時間戳記']);
      if (!dt) continue;
      var dateStr = Utilities.formatDate(dt, TZ_TIPS, 'yyyy-MM-dd');
      if (dateStr < startDate || dateStr > endDate) continue;
      out.push(obj);
    }
    return out;
  } catch (e) {
    console.error('[TipsReport] getTipsFormDataFromSheet:', e);
    return [];
  }
}

/**
 * 讀取問卷 A:M（第一列標題 + 資料列），並依日期篩選，回傳標題與每列的 keyed 物件 + 原始 13 欄（供寫入小費統整表）
 * @param {string} startDate - yyyy-MM-dd
 * @param {string} endDate - yyyy-MM-dd
 * @returns {{ headerRow13: Array, rows: Array<{ obj: Object, rawRow: Array }> }}
 */
function getTipsFormRowsWithRawAM(startDate, endDate) {
  var ssId = typeof TIPS_FORM_SS_ID !== 'undefined' ? TIPS_FORM_SS_ID : '';
  var sheetName = typeof TIPS_FORM_SHEET_NAME !== 'undefined' ? TIPS_FORM_SHEET_NAME : 'sheet1';
  var sheetGid = typeof TIPS_FORM_SHEET_GID !== 'undefined' ? TIPS_FORM_SHEET_GID : null;
  if (!ssId) {
    return { headerRow13: [], rows: [] };
  }
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = null;
    if (sheetGid != null && sheetGid !== '') {
      var sheets = ss.getSheets();
      for (var i = 0; i < sheets.length; i++) {
        if (Number(sheets[i].getSheetId()) === Number(sheetGid)) {
          sheet = sheets[i];
          break;
        }
      }
    }
    if (!sheet) sheet = ss.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < 2) {
      return { headerRow13: [], rows: [] };
    }
    var numCols = Math.max(sheet.getLastColumn(), 13);
    var data = sheet.getRange(1, 1, sheet.getLastRow(), numCols).getValues();
    var headerRow = data[0] || [];
    var headerRow13 = headerRow.slice(0, 13);
    var colIndex = {};
    for (var c = 0; c < headerRow.length; c++) {
      var h = (headerRow[c] != null ? String(headerRow[c]).trim() : '');
      if (h) colIndex[h] = c;
    }
    if (colIndex['時間戳記'] === undefined) {
      return { headerRow13: headerRow13, rows: [] };
    }
    var out = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      var obj = {};
      for (var key in colIndex) {
        var idx = colIndex[key];
        obj[key] = (row[idx] != null ? String(row[idx]).trim() : '');
      }
      if (!obj['時間戳記']) continue;
      var dt = parseFormTimestamp(obj['時間戳記']);
      if (!dt) continue;
      var dateStr = Utilities.formatDate(dt, TZ_TIPS, 'yyyy-MM-dd');
      if (dateStr < startDate || dateStr > endDate) continue;
      var rawRow = [];
      for (var k = 0; k < 13; k++) rawRow.push((row[k] != null ? String(row[k]) : ''));
      out.push({ obj: obj, rawRow: rawRow });
    }
    return { headerRow13: headerRow13, rows: out };
  } catch (e) {
    console.error('[TipsReport] getTipsFormRowsWithRawAM:', e);
    return { headerRow13: [], rows: [] };
  }
}

/** 每輪同步最多處理筆數（避免逾時／API 過多），處理完會存進度，下次依「上一筆 時間、手機」續跑 */
var TIPS_SYNC_BATCH_SIZE = 80;
/** Script 屬性鍵：目前同步的月份 YYYY-MM */
var TIPS_SYNC_MONTH_KEY = 'TIPS_SYNC_MONTH';
/** Script 屬性鍵：已處理到的問卷列索引（0-based） */
var TIPS_SYNC_LAST_INDEX_KEY = 'TIPS_SYNC_LAST_INDEX';
/** Script 屬性鍵：上一筆寫入的 時間戳記（用來續跑時定位從哪一筆開始抓） */
var TIPS_SYNC_LAST_TIMESTAMP_KEY = 'TIPS_SYNC_LAST_TIMESTAMP';
/** Script 屬性鍵：上一筆寫入的 手機（正規化後，用來續跑時定位） */
var TIPS_SYNC_LAST_PHONE_KEY = 'TIPS_SYNC_LAST_PHONE';

/**
 * 從小費統整表 A 欄找出最後一筆（A=時間）
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {{ timestampText: string, timestampMs: number|null }|null}
 */
function getLastSyncedFromConsolidated(sheet) {
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var lookback = Math.min(200, lastRow - 1);
  var startRow = lastRow - lookback + 1;
  var values = sheet.getRange(startRow, 1, lookback, 1).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    var ts = values[i][0];
    if (ts == null || String(ts).trim() === '') continue;
    var tsMs = null;
    if (Object.prototype.toString.call(ts) === '[object Date]' && !isNaN(ts.getTime())) {
      tsMs = ts.getTime();
    }
    var tsText = (ts != null) ? String(ts).trim() : '';
    if (!tsMs && tsText) {
      var dt = parseFormTimestamp(tsText);
      if (dt) tsMs = dt.getTime();
    }
    return { timestampText: tsText, timestampMs: tsMs };
  }
  return null;
}

/**
 * 追蹤問卷同步：從上一筆未新增到的問卷繼續，抓到今天為止；對每筆手機找最近一筆消費與儲值金，有抓到一筆就寫入小費統整表；進度存 Script 屬性，下次從上次位置繼續。
 * @returns {{ ok: boolean, message?: string, startDate?: string, endDate?: string, rowCount?: number, resumedFrom?: number, nextIndex?: number }}
 */
function syncLastMonthQuestionnaireToConsolidated() {
  console.log("[TipsReport][sync] start");
  var ssId = (typeof TIPS_CONSOLIDATED_SS_ID !== 'undefined' && TIPS_CONSOLIDATED_SS_ID) ? String(TIPS_CONSOLIDATED_SS_ID).trim() : '';
  var gid = typeof TIPS_CONSOLIDATED_SHEET_GID !== 'undefined' ? TIPS_CONSOLIDATED_SHEET_GID : 1727178779;
  if (!ssId) {
    return { ok: false, message: '未設定小費統整表試算表 TIPS_CONSOLIDATED_SS_ID（來源需拉對）' };
  }
  var now = new Date();
  var ss, sheet;
  try {
    ss = SpreadsheetApp.openById(ssId);
    var sheets = ss.getSheets();
    sheet = null;
    for (var si = 0; si < sheets.length; si++) {
      if (Number(sheets[si].getSheetId()) === Number(gid)) {
        sheet = sheets[si];
        break;
      }
    }
    if (!sheet) {
      return { ok: false, message: '找不到小費統整表 gid=' + gid };
    }
  } catch (e) {
    console.error('[TipsReport] sync 開啟試算表失敗:', e);
    return { ok: false, message: (e && e.message) ? e.message : String(e) };
  }
  var lastFromSheet = getLastSyncedFromConsolidated(sheet);
  console.log("[TipsReport][sync] lastFromSheet", lastFromSheet);
  if (lastFromSheet) {
    lastTimestamp = lastFromSheet.timestampText || '';
  }
  var startDate = '';
  var lastTimestampMs = null;
  if (lastTimestamp) {
    var lastTsDate = parseFormTimestamp(lastTimestamp);
    if (lastTsDate) {
      lastTimestampMs = lastTsDate.getTime();
      startDate = Utilities.formatDate(lastTsDate, TZ_TIPS, 'yyyy-MM-dd');
    }
  }
  if (!startDate && lastTimestampMs) {
    startDate = Utilities.formatDate(new Date(lastTimestampMs), TZ_TIPS, 'yyyy-MM-dd');
  }
  if (!startDate && savedMonth) {
    startDate = savedMonth + '-01';
  }
  if (!startDate) {
    var defaultStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    startDate = Utilities.formatDate(defaultStart, TZ_TIPS, 'yyyy-MM-dd');
  }
  var endDate = Utilities.formatDate(now, TZ_TIPS, 'yyyy-MM-dd');
  var monthKey = startDate.slice(0, 7);
  console.log("[TipsReport][sync] range", { startDate: startDate, endDate: endDate, monthKey: monthKey, lastTimestampMs: lastTimestampMs });

  var form = getTipsFormRowsWithRawAM(startDate, endDate);
  console.log("[TipsReport][sync] formRows", { count: form && form.rows ? form.rows.length : 0 });
  if (!form.rows || form.rows.length === 0) {
    console.warn('[TipsReport][sync] 問卷無資料 ' + startDate + '~' + endDate);
    console.log("[TipsReport][sync] done rowCount=0");
    return { ok: true, startDate: startDate, endDate: endDate, rowCount: 0 };
  }
  var startIndex = 0;
  if (lastTimestamp || lastTimestampMs) {
    for (var si = 0; si < form.rows.length; si++) {
      var rowTs = (form.rows[si].obj['時間戳記'] != null) ? String(form.rows[si].obj['時間戳記']).trim() : '';
      var rowMs = null;
      if (rowTs) {
        var rowDt = parseFormTimestamp(rowTs);
        if (rowDt) rowMs = rowDt.getTime();
      }
      if (lastTimestampMs && rowMs && rowMs > lastTimestampMs) {
        startIndex = si;
        break;
      }
      if (!lastTimestampMs && lastTimestamp && rowTs > lastTimestamp) {
        startIndex = si;
        break;
      }
    }
  }
  console.log("[TipsReport][sync] startIndex", { startIndex: startIndex, total: form.rows.length });
  if (startIndex >= form.rows.length) {
    console.log("[TipsReport][sync] completed startIndex>=rows", { startIndex: startIndex, total: form.rows.length });
    return { ok: true, startDate: startDate, endDate: endDate, rowCount: 0, completed: true };
  }

  var getMemApiFn = typeof getMemApi === 'function' ? getMemApi : (typeof Core !== 'undefined' && Core.getMemApi ? Core.getMemApi : null);
  var getMemApiBatchFn = typeof getMemApiBatch === 'function' ? getMemApiBatch : (typeof Core !== 'undefined' && Core.getMemApiBatch ? Core.getMemApiBatch : null);
  var getTransactionsBatchFn = typeof getAllTransactionsByMembidBatch === 'function' ? getAllTransactionsByMembidBatch : (typeof Core !== 'undefined' && Core.getAllTransactionsByMembidBatch ? Core.getAllTransactionsByMembidBatch : null);
  var findLatestFn = typeof findLatestConsumptionBefore === 'function' ? findLatestConsumptionBefore : (typeof Core !== 'undefined' && Core.findLatestConsumptionBefore ? Core.findLatestConsumptionBefore : null);
  var findLatestFromListFn = typeof findLatestFromTransactionList === 'function' ? findLatestFromTransactionList : (typeof Core !== 'undefined' && Core.findLatestFromTransactionList ? Core.findLatestFromTransactionList : null);
  if (!getMemApiFn || !findLatestFn) {
    return { ok: false, message: 'getMemApi 或 findLatestConsumptionBefore 未定義' };
  }

  var headerRow = form.headerRow13.concat(['消費項目', '消費備註', '消費金額', '店家名稱', '儲值金餘額', '消費店家storId', '姓名']);

  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, headerRow.length).setValues([headerRow]);
    startIndex = 0;
  }

  var batchLimit = Math.min(startIndex + TIPS_SYNC_BATCH_SIZE, form.rows.length);
  console.log("[TipsReport][sync] batch", { startIndex: startIndex, batchLimit: batchLimit, total: form.rows.length });
  var writtenThisRun = 0;
  var startWriteRow = sheet.getLastRow() + 1;

  var membersMap = {};
  var transactionsByMembid = {};
  if (getMemApiBatchFn) {
    var batchPhones = [];
    for (var b = startIndex; b < batchLimit; b++) {
      var p = normalizePhoneForTips((form.rows[b].obj['您的手機號碼'] || '').trim());
      if (p) batchPhones.push(p);
    }
    console.log("[TipsReport][sync] batchPhones", { count: batchPhones.length });
    membersMap = getMemApiBatchFn(batchPhones);
    console.log("[TipsReport][sync] membersMap", { count: Object.keys(membersMap || {}).length });
    if (getTransactionsBatchFn && findLatestFromListFn) {
      var membidsToFetch = [];
      var seenMembid = {};
      for (var ph in membersMap) {
        var mem = membersMap[ph];
        if (mem && mem.membid != null && !seenMembid[mem.membid]) {
          seenMembid[mem.membid] = true;
          membidsToFetch.push(mem.membid);
        }
      }
      if (membidsToFetch.length > 0) transactionsByMembid = getTransactionsBatchFn(membidsToFetch);
      console.log("[TipsReport][sync] transactionsBatch", { membids: membidsToFetch.length, keys: Object.keys(transactionsByMembid || {}).length });
    }
  }

  var memberNameCol = -1;
  for (var c = 0; c < form.headerRow13.length; c++) {
    if (String(form.headerRow13[c]).trim() === '會員姓名') { memberNameCol = c; break; }
  }
  var outRows = [];
  var redRowOffsets = [];
  for (var i = startIndex; i < batchLimit; i++) {
    var r = form.rows[i];
    var obj = r.obj;
    var rawRow = r.rawRow.slice();
    if (rawRow.length > 2) {
      var cVal = rawRow[2];
      while (rawRow.length < 13) rawRow.push('');
      rawRow[12] = cVal;
      rawRow[2] = '';
    }
    var phone = normalizePhoneForTips((obj['您的手機號碼'] || '').trim());
    var qtTime = parseFormTimestamp(obj['時間戳記']);
    var qtMs = qtTime ? qtTime.getTime() : 0;
    var member = phone ? (getMemApiBatchFn ? membersMap[phone] : getMemApiFn(phone)) : null;
    if (memberNameCol >= 0 && member && member.memnam != null && String(member.memnam).trim() !== '') {
      rawRow[memberNameCol] = String(member.memnam).trim();
    }
    var consumption = null;
    if (member && member.membid && qtMs) {
      if (findLatestFromListFn && transactionsByMembid[member.membid]) {
        consumption = findLatestFromListFn(transactionsByMembid[member.membid], qtMs);
      } else {
        consumption = findLatestFn(member.membid, qtMs);
      }
    }
    var itemsText = '';
    var remarkText = '';
    var amount = '';
    var storeName = '';
    var storId = '';
    var stcash = '';
    var memberName = '';
    if (member && member.memnam != null && String(member.memnam).trim() !== '') {
      memberName = String(member.memnam).trim();
    }
    if (member != null && member.stcash != null) stcash = String(member.stcash);
    var consumptionTimeText = '';
    var intervalDays = null;
    if (consumption) {
      remarkText = (consumption.remark != null) ? String(consumption.remark) : '';
      storId = (typeof getStorIdFromTransaction === 'function' ? getStorIdFromTransaction(consumption) : (typeof Core !== 'undefined' && typeof Core.getStorIdFromTransaction === 'function' ? Core.getStorIdFromTransaction(consumption) : (consumption.stor && consumption.stor.storid != null) ? String(consumption.stor.storid) : (consumption.storid != null ? String(consumption.storid) : (consumption.store != null ? String(consumption.store) : ''))));
      storeName = (consumption.stor && consumption.stor.stonam != null) ? String(consumption.stor.stonam) : '';
      var names = [];
      var sum = 0;
      if (consumption.ordds && consumption.ordds.length) {
        for (var j = 0; j < consumption.ordds.length; j++) {
          var o = consumption.ordds[j];
          if (o.godnam) names.push(String(o.godnam));
          sum += Number(o.price_) || 0;
        }
      }
      itemsText = names.join('、');
      amount = String(sum);
      var consTs = consumption.rectim || consumption.cretim || '';
      if (consTs) {
        var consDate = new Date(consTs);
        if (!isNaN(consDate.getTime())) {
          consumptionTimeText = Utilities.formatDate(consDate, TZ_TIPS, 'yyyy-MM-dd HH:mm');
          if (qtMs) intervalDays = Math.floor((qtMs - consDate.getTime()) / 86400000);
        }
      }
    }
    var intervalText = (intervalDays != null && !isNaN(intervalDays)) ? (String(intervalDays) + '天') : '';
    var itemsCombined = [consumptionTimeText, intervalText, itemsText].filter(function (s) { return s && String(s).trim() !== ''; }).join(' | ');
    var outRow = rawRow.concat([itemsCombined, remarkText, amount, storeName, stcash, storId, memberName]);
    outRows.push(outRow);
    if (intervalDays != null && intervalDays > 10) {
      redRowOffsets.push(i - startIndex);
    }
    if (i === startIndex || i === batchLimit - 1) {
      console.log("[TipsReport][sync] rowSample", {
        idx: i,
        phone: phone,
        qt: obj['時間戳記'] || '',
        member: member ? (member.membid || '') : '',
        hasConsumption: !!consumption,
        intervalDays: intervalDays,
        items: itemsText
      });
    }
  }
  writtenThisRun = outRows.length;
  if (outRows.length > 0) {
    var numRows = outRows.length;
    var numCols = headerRow.length;
    // getRange(row, col, numRows, numCols)：第 3 個參數是「列數」不是 endRow，勿用 startWriteRow + numRows
    for (var ri = 0; ri < outRows.length; ri++) {
      while (outRows[ri].length < numCols) outRows[ri].push('');
      if (outRows[ri].length > numCols) outRows[ri] = outRows[ri].slice(0, numCols);
    }
    sheet.getRange(startWriteRow, 1, numRows, numCols).setValues(outRows);
    if (redRowOffsets.length > 0) {
      for (var rr = 0; rr < redRowOffsets.length; rr++) {
        sheet.getRange(startWriteRow + redRowOffsets[rr], 14, 1, 1).setBackground('#ff0000');
      }
    }
  }
  var nextIndex = batchLimit;
  var completed = nextIndex >= form.rows.length;
  var lastWrittenTimestamp = '';
  var lastWrittenPhone = '';
  if (outRows.length > 0) {
    var lastR = form.rows[batchLimit - 1];
    lastWrittenTimestamp = (lastR.obj['時間戳記'] != null) ? String(lastR.obj['時間戳記']).trim() : '';
    lastWrittenPhone = normalizePhoneForTips((lastR.obj['您的手機號碼'] || '').trim());
  }
  var result = {
    ok: true,
    startDate: startDate,
    endDate: endDate,
    rowCount: writtenThisRun,
    resumedFrom: startIndex,
    nextIndex: nextIndex,
    totalRows: form.rows.length,
    completed: completed
  };
  console.log("[TipsReport][sync] done", result);
  return result;
}


/** 問卷前 13 欄標題（與小費統整表 A:M 對應，表單送出時用） */
var TIPS_FORM_HEADER_13 = TIPS_FORM_KEYS.slice(0, 13);

/**
 * 單筆問卷即時寫入小費統整表（問卷送出時觸發用）。依手機查神美會員與最近一筆消費，寫入一列。
 * @param {Object} obj - 一筆問卷的鍵值（含 時間戳記、您的手機號碼 等，鍵名同 TIPS_FORM_KEYS 前 13 個）
 * @param {Array<string>} rawRow - 該筆問卷前 13 欄原始值（與統整表 A:M 對應）
 * @returns {{ ok: boolean, message?: string }}
 */
function syncSingleTipsResponseToConsolidated(obj, rawRow) {
  var ssId = (typeof TIPS_CONSOLIDATED_SS_ID !== 'undefined' && TIPS_CONSOLIDATED_SS_ID) ? String(TIPS_CONSOLIDATED_SS_ID).trim() : '';
  var gid = typeof TIPS_CONSOLIDATED_SHEET_GID !== 'undefined' ? TIPS_CONSOLIDATED_SHEET_GID : 1727178779;
  // #region agent log
  try {
    console.log("[syncSingle entry]", {
      hasObj: !!obj,
      rawLen: rawRow ? rawRow.length : 0,
      ssIdSet: !!ssId,
      gid: gid
    });
  } catch (e) {}
  // #endregion
  if (!ssId) {
    return { ok: false, message: '未設定小費統整表試算表 TIPS_CONSOLIDATED_SS_ID（來源需拉對）' };
  }
  var getMemApiFn = typeof getMemApi === 'function' ? getMemApi : (typeof Core !== 'undefined' && Core.getMemApi ? Core.getMemApi : null);
  var findLatestFn = typeof findLatestConsumptionBefore === 'function' ? findLatestConsumptionBefore : (typeof Core !== 'undefined' && Core.findLatestConsumptionBefore ? Core.findLatestConsumptionBefore : null);
  if (!getMemApiFn || !findLatestFn) {
    // #region agent log
    try {
      console.log("[syncSingle missing core functions]", {
        hasGetMemApi: !!getMemApiFn,
        hasFindLatest: !!findLatestFn
      });
    } catch (e) {}
    // #endregion
    return { ok: false, message: 'getMemApi 或 findLatestConsumptionBefore 未定義' };
  }
  var sheet;
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheets = ss.getSheets();
    sheet = null;
    for (var si = 0; si < sheets.length; si++) {
      if (Number(sheets[si].getSheetId()) === Number(gid)) {
        sheet = sheets[si];
        break;
      }
    }
    if (!sheet) {
      // #region agent log
      try {
        console.log("[syncSingle sheet not found]", { gid: gid });
      } catch (e) {}
      // #endregion
      return { ok: false, message: '找不到小費統整表 gid=' + gid };
    }
  } catch (e) {
    return { ok: false, message: (e && e.message) ? e.message : String(e) };
  }
  var headerRow = TIPS_FORM_HEADER_13.concat(['消費項目', '消費備註', '消費金額', '店家名稱', '儲值金餘額', '消費店家storId']);
  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, headerRow.length).setValues([headerRow]);
  }
  var phone = normalizePhoneForTips((obj['您的手機號碼'] || '').trim());
  var qtTime = parseFormTimestamp(obj['時間戳記']);
  var qtMs = qtTime ? qtTime.getTime() : 0;
  // #region agent log
  try {
    console.log("[syncSingle lookup inputs]", {
      phoneEmpty: !phone,
      hasQtMs: !!qtMs
    });
  } catch (e) {}
  // #endregion
  var member = phone ? getMemApiFn(phone) : null;
  var consumption = member && member.membid && qtMs ? findLatestFn(member.membid, qtMs) : null;
  // #region agent log
  try {
    console.log("[syncSingle lookup results]", {
      memberFound: !!member,
      hasMembid: !!(member && member.membid),
      consumptionFound: !!consumption
    });
  } catch (e) {}
  // #endregion
  var itemsText = '';
  var remarkText = '';
  var amount = '';
  var storeName = '';
  var storId = '';
  var stcash = '';
  if (member != null && member.stcash != null) stcash = String(member.stcash);
  if (consumption) {
    remarkText = (consumption.remark != null) ? String(consumption.remark) : '';
    storId = (typeof getStorIdFromTransaction === 'function' ? getStorIdFromTransaction(consumption) : (typeof Core !== 'undefined' && typeof Core.getStorIdFromTransaction === 'function' ? Core.getStorIdFromTransaction(consumption) : (consumption.stor && consumption.stor.storid != null) ? String(consumption.stor.storid) : (consumption.storid != null ? String(consumption.storid) : (consumption.store != null ? String(consumption.store) : ''))));
    storeName = (consumption.stor && consumption.stor.stonam != null) ? String(consumption.stor.stonam) : '';
    var names = [];
    var sum = 0;
    if (consumption.ordds && consumption.ordds.length) {
      for (var j = 0; j < consumption.ordds.length; j++) {
        var o = consumption.ordds[j];
        if (o.godnam) names.push(String(o.godnam));
        sum += Number(o.price_) || 0;
      }
    }
    itemsText = names.join('、');
    amount = String(sum);
  }
  var consumptionTimeText = '';
  var intervalDays = null;
  if (consumption && qtMs) {
    var consTs = consumption.rectim || consumption.cretim || '';
    var consMs = null;
    if (consTs) {
      var consDate = new Date(consTs);
      if (!isNaN(consDate.getTime())) {
        consMs = consDate.getTime();
        consumptionTimeText = Utilities.formatDate(consDate, TZ_TIPS, 'yyyy-MM-dd HH:mm');
      }
    }
    if (consMs != null) {
      intervalDays = Math.floor((qtMs - consMs) / 86400000);
    }
  }
  var intervalText = (intervalDays != null && !isNaN(intervalDays)) ? (String(intervalDays) + '天') : '';
  var itemsCombined = [consumptionTimeText, intervalText, itemsText].filter(function (s) { return s && String(s).trim() !== ''; }).join(' | ');
  var row13 = (rawRow && rawRow.length >= 13) ? rawRow.slice(0, 13) : [];
  while (row13.length < 13) row13.push('');
  var outRow = row13.concat([itemsCombined, remarkText, amount, storeName, stcash, storId]);
  var writeRow = sheet.getLastRow() + 1;
  sheet.getRange(writeRow, 1, 1, outRow.length).setValues([outRow]);
  if (intervalDays != null && intervalDays > 10) {
    sheet.getRange(writeRow, 14, 1, 1).setBackground('#ff0000');
  }
  return { ok: true };
}

/**
 * 表單提交觸發：有人填寫問卷送出時由 GAS 自動呼叫。即時將該筆寫入小費統整表，之後不需每月跑批次。
 * 請在「問卷回應試算表」對應的 Apps Script 專案中，執行 createTipsFormSubmitTrigger() 建立「提交表單時」觸發此函式。
 * @param {GoogleAppsScript.Events.SheetsOnFormSubmit} e - 表單提交事件，e.values 為新一列的值（欄位順序同表單）
 */
function onTipsFormSubmit(e) {
  if (!e || !e.values || !e.values.length) return;
  var headerKeys = TIPS_FORM_HEADER_13;
  var obj = {};
  for (var i = 0; i < headerKeys.length && i < e.values.length; i++) {
    obj[headerKeys[i]] = e.values[i] != null ? String(e.values[i]).trim() : '';
  }
  var rawRow = e.values.slice(0, 13);
  syncSingleTipsResponseToConsolidated(obj, rawRow);
}

/**
 * 每月 2 號觸發用（選用）：若未用表單提交即時同步，可改以此補跑上個月問卷。
 */
function runSyncLastMonthTipsConsolidatedTrigger() {
  var today = new Date();
  var day = today.getDate();
  if (day !== 2) return;
  var result = syncLastMonthQuestionnaireToConsolidated();
  if (result.ok) {
    Logger.log('[TipsReport] 小費統整表同步完成 ' + (result.startDate || '') + '~' + (result.endDate || '') + ' 筆數 ' + (result.rowCount || 0));
  } else {
    Logger.log('[TipsReport] 小費統整表同步失敗: ' + (result.message || ''));
  }
}

/** 小費統整表 B 欄 = 手機（1-based 第 2 欄），T 欄 = 姓名（1-based 第 20 欄） */
var TIPS_CONSOLIDATED_COL_B = 2;
var TIPS_CONSOLIDATED_COL_T = 20;

/**
 * 小費統整表（gid=1727178779）：若 B 欄有手機，依神美 API 查會員 memnam 或 name，寫入 T 欄。
 * 可從 Apps Script 編輯器手動執行，或排程觸發。
 * 改版：分批處理 + 記憶體優化 + 效能計時
 */
function fillTipsConsolidatedNameFromPhoneBatch() {
  console.time('TotalExecutionTime'); // [Log] 開始計時總執行時間
  
  // --- 設定區 ---
  var BATCH_SIZE = 200;   // ★ 每批處理幾筆 (建議 100~500 之間，依 API 速度而定)
  var BATCH_DELAY_MS = 2000; // ★ 每批結束後停留幾毫秒再跑下一批，避免 API 限流／被擋 (建議 1500~3000)
  
  var ssId = (typeof TIPS_CONSOLIDATED_SS_ID !== 'undefined' && TIPS_CONSOLIDATED_SS_ID) ? String(TIPS_CONSOLIDATED_SS_ID).trim() : '';
  var gid = typeof TIPS_CONSOLIDATED_SHEET_GID !== 'undefined' ? TIPS_CONSOLIDATED_SHEET_GID : 1727178779;
  
  var getMemApiBatchFn = typeof getMemApiBatch === 'function' ? getMemApiBatch : (typeof Core !== 'undefined' && Core.getMemApiBatch ? Core.getMemApiBatch : null);
  
  if (!ssId) { console.error('錯誤: 未設定 TIPS_CONSOLIDATED_SS_ID'); return { ok: false, message: '未設定 TIPS_CONSOLIDATED_SS_ID' }; }
  if (!getMemApiBatchFn) { console.error('錯誤: getMemApiBatch 未定義'); return { ok: false, message: 'getMemApiBatch 未定義' }; }

  try {
    console.log('正在開啟試算表...');
    var ss = SpreadsheetApp.openById(ssId);
    
    var sheets = ss.getSheets();
    var sheet = null;
    for (var i = 0; i < sheets.length; i++) {
      if (Number(sheets[i].getSheetId()) === Number(gid)) { sheet = sheets[i]; break; }
    }
    
    if (!sheet) { console.error('錯誤: 找不到 GID=' + gid); return { ok: false, message: '找不到 GID=' + gid }; }

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) { console.log('表格無資料，結束。'); return { ok: true, updatedCount: 0 }; }

    var totalRows = lastRow - 1;
    console.log('資料總列數: ' + totalRows + ' (從第2列到第' + lastRow + '列)');
    
    var totalUpdatedCount = 0;

    // --- 分批迴圈開始 ---
    // startRow 代表這一批在 Sheet 中的起始「列號」(Row Index)
    for (var startRow = 2; startRow <= lastRow; startRow += BATCH_SIZE) {
      
      // 計算這一批要抓幾列 (處理最後一批不足 BATCH_SIZE 的情況)
      var rowsToProcess = Math.min(BATCH_SIZE, lastRow - startRow + 1);
      var endRow = startRow + rowsToProcess - 1;
      
      console.log('>> 正在處理批次: 第 ' + startRow + ' 列 到 第 ' + endRow + ' 列 (' + rowsToProcess + '筆)');

      // 1. 讀取這一批的資料 (只讀 B欄電話 與 T欄名字)
      // 注意：這裡使用 Range 讀取，減少記憶體消耗
      var phoneRange = sheet.getRange(startRow, TIPS_CONSOLIDATED_COL_B, rowsToProcess, 1);
      var nameRange = sheet.getRange(startRow, TIPS_CONSOLIDATED_COL_T, rowsToProcess, 1);
      
      var phoneValues = phoneRange.getValues();
      var nameValues = nameRange.getValues();

      var phonesToLookup = []; // 這一批次需要查的電話
      var lookupIndices = [];  // 紀錄是這一批次裡的第幾筆需要查

      // 2. 篩選：僅「T 欄為空」且 B 欄有手機才查，避免重複查、被 API 擋
      for (var i = 0; i < rowsToProcess; i++) {
        var existingName = nameValues[i][0];
        if (existingName != null && String(existingName).trim() !== '') continue; // T 已有姓名，不查
          var rawPhone = phoneValues[i][0];
          var ph = normalizePhoneForTips(rawPhone ? String(rawPhone).trim() : '');
          if (ph) {
            phonesToLookup.push(ph);
            lookupIndices.push(i);
          }
      }

      console.log('   - 此批次需查詢數量: ' + phonesToLookup.length + ' 筆');

      // 如果這批完全不需要查，就跳下一批
      if (phonesToLookup.length === 0) {
        console.log('   - 跳過 (皆已有名字或無電話)');
        continue;
      }

      // 3. 呼叫 API (針對這一批的電話)
      console.time('   - API 耗時'); // [Log] API 計時開始
      
      // 去重
      var uniquePhones = [];
      var seen = {};
      for (var k = 0; k < phonesToLookup.length; k++) {
        if (!seen[phonesToLookup[k]]) {
          uniquePhones.push(phonesToLookup[k]);
          seen[phonesToLookup[k]] = true;
        }
      }

      var membersMap = {};
      try {
        membersMap = getMemApiBatchFn(uniquePhones);
      } catch (apiErr) {
        console.error('   X API 呼叫失敗:', apiErr);
        // API 失敗不中斷整個程式，繼續跑下一批，或者你可以選擇 return
        continue; 
      }
      console.timeEnd('   - API 耗時'); // [Log] API 計時結束

      // 4. 填回資料到記憶體陣列 (nameValues)
      var batchUpdated = 0;
      
      // 只遍歷需要更新的那些 index
      for (var idx = 0; idx < lookupIndices.length; idx++) {
        var arrayIndex = lookupIndices[idx]; // 這是 dataValues 裡的 index
        var ph = phonesToLookup[idx];        // 對應的電話
        
        if (membersMap[ph]) {
          var member = membersMap[ph];
          var newName = (member.memnam || member.name || '').trim();
          
          if (newName) {
            nameValues[arrayIndex][0] = newName; // 更新陣列
            batchUpdated++;
          }
        }
      }

      // 5. 只有當這一批次真的有資料變動時，才寫入 Spreadsheet
      if (batchUpdated > 0) {
        console.log('   - 寫入資料中... (更新 ' + batchUpdated + ' 筆)');
        // 直接把整批 (包含沒變的和有變的) 寫回去，這樣最簡單且 API 消耗最少
        nameRange.setValues(nameValues);
        totalUpdatedCount += batchUpdated;
      } else {
        console.log('   - API 查無對應資料，無須寫入');
      }
      
      SpreadsheetApp.flush();
      // 批次間停留，避免連續打 API 被擋
      if (startRow + BATCH_SIZE <= lastRow && BATCH_DELAY_MS > 0) {
        console.log('   - 等待 ' + (BATCH_DELAY_MS / 1000) + ' 秒後繼續下一批...');
        Utilities.sleep(BATCH_DELAY_MS);
      }
    }
    // --- 分批迴圈結束 ---

    console.timeEnd('TotalExecutionTime'); // [Log] 總時間
    console.log('=== 執行完成 ===');
    console.log('總共更新: ' + totalUpdatedCount + ' 筆資料');
    
    return { ok: true, updatedCount: totalUpdatedCount };

  } catch (e) {
    console.error('嚴重錯誤:', e);
    return { ok: false, message: e.message };
  }
}

/**
 * 一次性呼叫：建立「提交表單時」執行 onTipsFormSubmit 的觸發器。
 * 請在「與問卷連結的試算表」的擴充功能 → Apps Script 中執行此函式（或該試算表綁定的專案需有 TIPS_FORM_SS_ID = 該試算表 ID）。
 * 建立後，每次有人填寫問卷送出會即時寫入小費統整表，不需每月跑。
 */
function createTipsFormSubmitTrigger() {
  var ssId = typeof TIPS_FORM_SS_ID !== 'undefined' ? TIPS_FORM_SS_ID : '';
  if (!ssId) {
    throw new Error('請先設定 TIPS_FORM_SS_ID（問卷回應試算表 ID）');
  }
  var spreadsheet = SpreadsheetApp.openById(ssId);
  ScriptApp.newTrigger('onTipsFormSubmit')
    .forSpreadsheet(spreadsheet)
    .onFormSubmit()
    .create();
}

/**
 * 一次性呼叫用（選用）：建立「每月 2 號 凌晨 2 點」補跑上個月的月觸發器。若已用表單提交即時同步，可不建。
 */
function createTipsSyncMonthlyTrigger() {
  ScriptApp.newTrigger('runSyncLastMonthTipsConsolidatedTrigger')
    .timeBased()
    .onMonthDay(2)
    .atHour(2)
    .create();
}

/**
 * 從小費統整表讀取上個月資料，依負責店家（storId）篩選、分店家排序，回傳試算表連結（可為同一份小費統整表）。
 * @param {string[]} managedStoreIds - SayDou 門市 ID 陣列
 * @returns {{ ok: boolean, sheetUrl?: string, message?: string, startDate?: string, endDate?: string, rowCount?: number }}
 */
function getLastMonthTipsConsolidatedForManager(managedStoreIds) {
  var ssId = (typeof TIPS_CONSOLIDATED_SS_ID !== 'undefined' && TIPS_CONSOLIDATED_SS_ID) ? String(TIPS_CONSOLIDATED_SS_ID).trim() : '';
  var gid = typeof TIPS_CONSOLIDATED_SHEET_GID !== 'undefined' ? TIPS_CONSOLIDATED_SHEET_GID : 1727178779;
  if (!ssId) {
    return { ok: false, message: '未設定小費統整表試算表 TIPS_CONSOLIDATED_SS_ID（來源需拉對）' };
  }
  var ids = (managedStoreIds || []).map(function (id) { return String(id).trim(); }).filter(Boolean);
  var now = new Date();
  var lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var startDate = Utilities.formatDate(lastMonth, TZ_TIPS, 'yyyy-MM-dd');
  var endDate = Utilities.formatDate(new Date(now.getFullYear(), now.getMonth(), 0), TZ_TIPS, 'yyyy-MM-dd');
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheets = ss.getSheets();
    var sheet = null;
    for (var i = 0; i < sheets.length; i++) {
      if (Number(sheets[i].getSheetId()) === Number(gid)) {
        sheet = sheets[i];
        break;
      }
    }
    if (!sheet || sheet.getLastRow() < 2) {
      return { ok: true, sheetUrl: 'https://docs.google.com/spreadsheets/d/' + ssId + '/edit#gid=' + gid, startDate: startDate, endDate: endDate, rowCount: 0 };
    }
    var lastCol = Math.max(sheet.getLastColumn(), 20);
    var dataRange = sheet.getRange(1, 1, sheet.getLastRow(), lastCol);
    var data = dataRange.getValues();
    var backgrounds = dataRange.getBackgrounds();
    var header = data[0] || [];
    var storIdCol = -1;
    for (var c = 0; c < header.length; c++) {
      if (String(header[c]).trim() === '消費店家storId') { storIdCol = c; break; }
    }
    if (storIdCol < 0) {
      return { ok: false, message: '小費統整表無「消費店家storId」欄' };
    }
    var rows = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      var sid = (row[storIdCol] != null) ? String(row[storIdCol]).trim() : '';
      if (ids.length > 0) {
        var match = false;
        for (var k = 0; k < ids.length; k++) { if (ids[k] === sid) { match = true; break; } }
        if (!match) continue;
      }
      rows.push(row);
    }
    rows.sort(function (a, b) {
      var sa = (a[storIdCol] != null) ? String(a[storIdCol]) : '';
      var sb = (b[storIdCol] != null) ? String(b[storIdCol]) : '';
      return sa.localeCompare(sb);
    });
    var sheetUrl = 'https://docs.google.com/spreadsheets/d/' + ssId + '/edit#gid=' + gid;
    if (ids.length === 0) {
      return { ok: true, sheetUrl: sheetUrl, startDate: startDate, endDate: endDate, rowCount: rows.length };
    }
    return { ok: true, sheetUrl: sheetUrl, startDate: startDate, endDate: endDate, rowCount: rows.length };
  } catch (e) {
    console.error('[TipsReport] getLastMonthTipsConsolidatedForManager:', e);
    return { ok: false, message: (e && e.message) ? e.message : String(e) };
  }
}

/** 小費統整表欄位：消費備註（O 欄，員工模式用 lowercase 比對 employeeCode，只顯示 消費備註.toLowerCase().includes(employeeCode) 的列） */
var TIPS_CONSOLIDATED_REMARK_HEADER = '消費備註';
/** 小費統整表：消費備註欄位為 O 欄（0-based index 14） */
var TIPS_CONSOLIDATED_REMARK_COL_O = 14;
/** 小費統整表欄位：消費店家storId（S 欄，管理者模式用） */
var TIPS_CONSOLIDATED_STORID_HEADER = '消費店家storId';
/** 上月小費產出欄位順序（來源 gid=1727178779，表頭含 T=姓名）：A(0)時間，T(19)姓名，B(1)手機，L(11),R(17),N(13),O(14),P(15),E(4),F(5),G(6),K(10),H(7),I(8),J(9)。EFGK 變色保留。 */
var TIPS_LAST_MONTH_DISPLAY_COLS = [0, 19, 1, 11, 17, 13, 14, 15, 4, 5, 6, 10, 7, 8, 9];

/** 上月小費請求紀錄表：同試算表、不同工作表，gid=1792957916。欄位：id, 店家/使用者, 月份, url, 請求時間, 完成時間, 備註。備註格式 YYYYMM_小費_userId 供同月同人重用。 */
var TIPS_REQUEST_LOG_SS_ID = '1GH2XbihFIY0AX8SMF9Tk6igrVKPpA_vMJVlkDkJjpe4';
var TIPS_REQUEST_LOG_SHEET_GID = 1792957916;

/**
 * 從小費統整表讀取上個月資料，依身份篩選後產出「僅顯示欄位」的標題列與資料列（供寫入新試算表用）。
 * 員工：依 options.employeeCode（如 "gd008"）篩選「消費備註」O 欄：只保留 消費備註.toLowerCase().includes(employeeCode) 的列。
 * @param {{ managedStoreIds?: string[], employeeCode?: string }} options
 * @returns {{ ok: boolean, headerRow?: string[], rows?: any[][], message?: string, startDate?: string, endDate?: string, rowCount?: number, monthStr?: string, monthKey?: string }}
 */
function getLastMonthTipsData(options) {
  var result = getLastMonthTipsAsText(options);
  if (!result.ok) return { ok: false, message: result.message };
  if (result.rowCount === 0) return { ok: true, headerRow: [], rows: [], startDate: result.startDate, endDate: result.endDate, rowCount: 0, monthStr: result.startDate ? result.startDate.slice(0, 7) : '', monthKey: result.startDate ? result.startDate.slice(0, 4) + result.startDate.slice(5, 7) : '' };
  var ssId = (typeof TIPS_CONSOLIDATED_SS_ID !== 'undefined' && TIPS_CONSOLIDATED_SS_ID) ? String(TIPS_CONSOLIDATED_SS_ID).trim() : '';
  var gid = typeof TIPS_CONSOLIDATED_SHEET_GID !== 'undefined' ? TIPS_CONSOLIDATED_SHEET_GID : 1727178779;
  var managedStoreIds = (options && options.managedStoreIds) ? options.managedStoreIds.map(function (id) { return String(id).trim(); }).filter(Boolean) : [];
  var employeeCode = (options && options.employeeCode != null) ? String(options.employeeCode).trim() : '';
  var now = new Date();
  var lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var startDate = Utilities.formatDate(lastMonth, TZ_TIPS, 'yyyy-MM-dd');
  var endDate = Utilities.formatDate(new Date(now.getFullYear(), now.getMonth(), 0), TZ_TIPS, 'yyyy-MM-dd');
  var monthStr = startDate.slice(0, 7);
  var monthKey = startDate.slice(0, 4) + startDate.slice(5, 7);
  function inLastMonthRange(value) {
    if (value == null || value === "") return false;
    var dt = null;
    if (value instanceof Date || (typeof value === "object" && typeof value.getTime === "function")) {
      dt = new Date(value.getTime ? value.getTime() : value);
    } else {
      var s = String(value).trim();
      if (!s) return false;
      dt = parseFormTimestamp(s);
      if (!dt) {
        var d = new Date(s);
        if (!isNaN(d.getTime())) dt = d;
      }
    }
    if (!dt || isNaN(dt.getTime())) return false;
    var dStr = Utilities.formatDate(dt, TZ_TIPS, "yyyy-MM-dd");
    return dStr >= startDate && dStr <= endDate;
  }
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheets = ss.getSheets();
    var sheet = null;
    for (var i = 0; i < sheets.length; i++) {
      if (Number(sheets[i].getSheetId()) === Number(gid)) { sheet = sheets[i]; break; }
    }
    if (!sheet || sheet.getLastRow() < 2) return { ok: true, headerRow: [], rows: [], startDate: startDate, endDate: endDate, rowCount: 0, monthStr: monthStr, monthKey: monthKey };
    var lastCol = Math.max(sheet.getLastColumn(), 20);
    var dataRange = sheet.getRange(1, 1, sheet.getLastRow(), lastCol);
    var data = dataRange.getValues();
    var backgrounds = dataRange.getBackgrounds();
    var header = data[0] || [];
    var storIdCol = -1, remarkCol = -1;
    for (var c = 0; c < header.length; c++) {
      var h = String(header[c]).trim();
      if (h === TIPS_CONSOLIDATED_STORID_HEADER) storIdCol = c;
      if (h === TIPS_CONSOLIDATED_REMARK_HEADER) remarkCol = c;
    }
    if (remarkCol < 0 && header.length > TIPS_CONSOLIDATED_REMARK_COL_O && String(header[TIPS_CONSOLIDATED_REMARK_COL_O]).trim() === TIPS_CONSOLIDATED_REMARK_HEADER) remarkCol = TIPS_CONSOLIDATED_REMARK_COL_O;
    if (storIdCol < 0) return { ok: false, message: '小費統整表無「消費店家storId」欄' };
    if (employeeCode && remarkCol < 0) return { ok: false, message: '小費統整表無「消費備註」(O欄)，無法依員工編號篩選' };
    var entries = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      if (!inLastMonthRange(row[0])) continue;
      if (managedStoreIds.length > 0) {
        var sid = (row[storIdCol] != null) ? String(row[storIdCol]).trim() : '';
        var match = false;
        for (var k = 0; k < managedStoreIds.length; k++) { if (managedStoreIds[k] === sid) { match = true; break; } }
        if (!match) continue;
      }
      if (employeeCode) {
        var remark = (remarkCol >= 0 && row[remarkCol] != null) ? String(row[remarkCol]).trim() : '';
        if (remark.toLowerCase().indexOf(employeeCode.toLowerCase()) < 0) continue;
      }
      entries.push({ row: row, bg: backgrounds[r] || [] });
    }
    if (managedStoreIds.length > 0) {
      entries.sort(function (a, b) {
        var sa = (a.row[storIdCol] != null) ? String(a.row[storIdCol]) : '';
        var sb = (b.row[storIdCol] != null) ? String(b.row[storIdCol]) : '';
        return sa.localeCompare(sb);
      });
    }
    var displayCols = (typeof TIPS_LAST_MONTH_DISPLAY_COLS !== 'undefined' && TIPS_LAST_MONTH_DISPLAY_COLS && TIPS_LAST_MONTH_DISPLAY_COLS.length) ? TIPS_LAST_MONTH_DISPLAY_COLS : [];
    if (!displayCols.length) for (var j0 = 0; j0 < header.length; j0++) displayCols.push(j0);
    var headerRow = [];
    for (var j = 0; j < displayCols.length; j++) {
      var c = displayCols[j];
      headerRow.push(c === 19 ? '姓名' : (c === 1 ? '手機' : (c < header.length && header[c] != null ? String(header[c]) : '')));
    }
    var outRows = [];
    var outBackgrounds = [];
    for (var ri = 0; ri < entries.length; ri++) {
      var rowLine = [];
      var bgLine = [];
      for (var j = 0; j < displayCols.length; j++) {
        var c = displayCols[j];
        var v = c < entries[ri].row.length ? entries[ri].row[c] : null;
        var cellVal = '';
        if (v != null) {
          if (v instanceof Date || (typeof v === 'object' && typeof v.getTime === 'function')) {
            cellVal = Utilities.formatDate(new Date(v.getTime ? v.getTime() : v), TZ_TIPS, 'yyyy-MM-dd HH:mm:ss');
          } else {
            cellVal = String(v);
          }
        }
        rowLine.push(cellVal);
        bgLine.push((entries[ri].bg && entries[ri].bg[c]) ? entries[ri].bg[c] : '#ffffff');
      }
      outRows.push(rowLine);
      outBackgrounds.push(bgLine);
    }
    return { ok: true, headerRow: headerRow, rows: outRows, rowBackgrounds: outBackgrounds, startDate: startDate, endDate: endDate, rowCount: entries.length, monthStr: monthStr, monthKey: monthKey };
  } catch (e) {
    return { ok: false, message: (e && e.message) ? e.message : String(e) };
  }
}

/**
 * 從小費統整表讀取上個月資料，依身份篩選後產出文字檔內容。
 * 管理者：依 managedStoreIds 篩選 S 欄（消費店家storId）相符的列。
 * 員工：依 options.employeeCode（如 "gd008"）篩選「消費備註」O 欄，只保留 消費備註.toLowerCase().includes(employeeCode) 的列。
 * @param {{ managedStoreIds?: string[], employeeCode?: string }} options
 * @returns {{ ok: boolean, text?: string, message?: string, startDate?: string, endDate?: string, rowCount?: number }}
 */
function getLastMonthTipsAsText(options) {
  var ssId = (typeof TIPS_CONSOLIDATED_SS_ID !== 'undefined' && TIPS_CONSOLIDATED_SS_ID) ? String(TIPS_CONSOLIDATED_SS_ID).trim() : '';
  var gid = typeof TIPS_CONSOLIDATED_SHEET_GID !== 'undefined' ? TIPS_CONSOLIDATED_SHEET_GID : 1727178779;
  if (!ssId) {
    return { ok: false, message: '未設定小費統整表試算表 TIPS_CONSOLIDATED_SS_ID（來源需拉對）' };
  }
  var managedStoreIds = (options && options.managedStoreIds) ? options.managedStoreIds.map(function (id) { return String(id).trim(); }).filter(Boolean) : [];
  var employeeCode = (options && options.employeeCode != null) ? String(options.employeeCode).trim() : '';
  var now = new Date();
  var lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var startDate = Utilities.formatDate(lastMonth, TZ_TIPS, 'yyyy-MM-dd');
  var endDate = Utilities.formatDate(new Date(now.getFullYear(), now.getMonth(), 0), TZ_TIPS, 'yyyy-MM-dd');
  function inLastMonthRange(value) {
    if (value == null || value === "") return false;
    var dt = null;
    if (value instanceof Date || (typeof value === "object" && typeof value.getTime === "function")) {
      dt = new Date(value.getTime ? value.getTime() : value);
    } else {
      var s = String(value).trim();
      if (!s) return false;
      dt = parseFormTimestamp(s);
      if (!dt) {
        var d = new Date(s);
        if (!isNaN(d.getTime())) dt = d;
      }
    }
    if (!dt || isNaN(dt.getTime())) return false;
    var dStr = Utilities.formatDate(dt, TZ_TIPS, "yyyy-MM-dd");
    return dStr >= startDate && dStr <= endDate;
  }
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheets = ss.getSheets();
    var sheet = null;
    for (var i = 0; i < sheets.length; i++) {
      if (Number(sheets[i].getSheetId()) === Number(gid)) {
        sheet = sheets[i];
        break;
      }
    }
    if (!sheet || sheet.getLastRow() < 2) {
      return { ok: true, text: '上個月小費 ' + startDate + ' ~ ' + endDate + '\n（無資料）', startDate: startDate, endDate: endDate, rowCount: 0 };
    }
    var lastCol = Math.max(sheet.getLastColumn(), 20);
    var data = sheet.getRange(1, 1, sheet.getLastRow(), lastCol).getValues();
    var header = data[0] || [];
    var storIdCol = -1;
    var remarkCol = -1;
    for (var c = 0; c < header.length; c++) {
      var h = String(header[c]).trim();
      if (h === TIPS_CONSOLIDATED_STORID_HEADER) storIdCol = c;
      if (h === TIPS_CONSOLIDATED_REMARK_HEADER) remarkCol = c;
    }
    if (remarkCol < 0 && header.length > TIPS_CONSOLIDATED_REMARK_COL_O && String(header[TIPS_CONSOLIDATED_REMARK_COL_O]).trim() === TIPS_CONSOLIDATED_REMARK_HEADER) remarkCol = TIPS_CONSOLIDATED_REMARK_COL_O;
    if (storIdCol < 0) return { ok: false, message: '小費統整表無「消費店家storId」欄' };
    if (employeeCode && remarkCol < 0) return { ok: false, message: '小費統整表無「消費備註」(O欄)，無法依員工編號篩選' };
    var rows = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      if (!inLastMonthRange(row[0])) continue;
      if (managedStoreIds.length > 0) {
        var sid = (row[storIdCol] != null) ? String(row[storIdCol]).trim() : '';
        var match = false;
        for (var k = 0; k < managedStoreIds.length; k++) { if (managedStoreIds[k] === sid) { match = true; break; } }
        if (!match) continue;
      }
      if (employeeCode) {
        var remark = (remarkCol >= 0 && row[remarkCol] != null) ? String(row[remarkCol]).trim() : '';
        if (remark.toLowerCase().indexOf(employeeCode.toLowerCase()) < 0) continue;
      }
      rows.push(row);
    }
    if (managedStoreIds.length > 0) {
      rows.sort(function (a, b) {
        var sa = (a[storIdCol] != null) ? String(a[storIdCol]) : '';
        var sb = (b[storIdCol] != null) ? String(b[storIdCol]) : '';
        return sa.localeCompare(sb);
      });
    }
    var displayCols = (typeof TIPS_LAST_MONTH_DISPLAY_COLS !== 'undefined' && TIPS_LAST_MONTH_DISPLAY_COLS && TIPS_LAST_MONTH_DISPLAY_COLS.length) ? TIPS_LAST_MONTH_DISPLAY_COLS : null;
    if (!displayCols) {
      displayCols = [];
      for (var j0 = 0; j0 < header.length; j0++) displayCols.push(j0);
    }
    var lines = [];
    lines.push('上個月小費 ' + startDate + ' ~ ' + endDate + '（共 ' + rows.length + ' 筆）');
    lines.push('');
    var headerLine = [];
    for (var j = 0; j < displayCols.length; j++) {
      var c = displayCols[j];
      headerLine.push(c === 19 ? '姓名' : (c === 1 ? '手機' : (c < header.length && header[c] != null ? String(header[c]) : '')));
    }
    lines.push(headerLine.join('\t'));
    for (var ri = 0; ri < rows.length; ri++) {
      var rowLine = [];
      for (var j = 0; j < displayCols.length; j++) {
        var c = displayCols[j];
        var v = c < rows[ri].length ? rows[ri][c] : null;
        rowLine.push(v != null ? String(v).replace(/\t/g, ' ').replace(/\n/g, ' ') : '');
      }
      lines.push(rowLine.join('\t'));
    }
    var text = lines.join('\n');
    return { ok: true, text: text, startDate: startDate, endDate: endDate, rowCount: rows.length };
  } catch (e) {
    return { ok: false, message: (e && e.message) ? e.message : String(e) };
  }
}

/**
 * 將試算表設為「可透過連結檢視」：先試「網際網路上的所有人」，失敗則試「知道連結的使用者」。
 * @param {string} fileId - 試算表檔案 ID
 * @returns {string|null} 成功回傳 null；失敗回傳提示文字（供呼叫端顯示給使用者）
 */
function setLastMonthTipsSheetSharing(fileId) {
  if (!fileId) return '缺少檔案 ID';
  var file = DriveApp.getFileById(fileId);
  try {
    file.setSharing(DriveApp.Access.ANYONE, DriveApp.Permission.VIEW);
    return null;
  } catch (e1) {
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      return null;
    } catch (e2) {
      var msg = (e1 && e1.message) ? e1.message : String(e1);
      console.warn('[上月小費] setSharing 失敗:', msg);
      return '無法自動開放連結。請手動：試算表右上「共用」→ 一般存取權 → 改為「知道連結的使用者」或「網際網路上的所有人」。';
    }
  }
}

/**
 * 上月小費報表：有則回傳既有試算表連結（備註 YYYYMM_小費_userId），無則產出新試算表並寫入請求紀錄表。
 * 請求紀錄表：同試算表 ID、工作表 gid=1792957916，欄位 id, 店家/使用者, 月份, url, 請求時間, 完成時間, 備註。
 * @param {{ managedStoreIds?: string[], userId: string }} options - userId 為 LINE userId
 * @returns {{ ok: boolean, url?: string, cached?: boolean, message?: string, rowCount?: number }}
 */
function getOrCreateLastMonthTipsSheet(options) {
  var userId = (options && options.userId != null) ? String(options.userId).trim() : '';
  if (!userId) return { ok: false, message: '缺少 userId' };
  var managedStoreIds = (options && options.managedStoreIds) ? options.managedStoreIds.map(function (id) { return String(id).trim(); }).filter(Boolean) : [];
  var employeeCode = (options && options.employeeCode != null) ? String(options.employeeCode).trim() : '';
  var logSsId = (typeof TIPS_REQUEST_LOG_SS_ID !== 'undefined' && TIPS_REQUEST_LOG_SS_ID) ? String(TIPS_REQUEST_LOG_SS_ID).trim() : '';
  var logGid = typeof TIPS_REQUEST_LOG_SHEET_GID !== 'undefined' ? TIPS_REQUEST_LOG_SHEET_GID : 1792957916;
  if (!logSsId) return { ok: false, message: '未設定 TIPS_REQUEST_LOG_SS_ID' };
  var now = new Date();
  var lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var monthStr = Utilities.formatDate(lastMonth, TZ_TIPS, 'yyyy-MM');
  var monthKey = monthStr.slice(0, 4) + monthStr.slice(5, 7);
  var remarkKey = monthKey + '_小費_' + userId;
  try {
    var logSs = SpreadsheetApp.openById(logSsId);
    var logSheets = logSs.getSheets();
    var logSheet = null;
    for (var i = 0; i < logSheets.length; i++) {
      if (Number(logSheets[i].getSheetId()) === Number(logGid)) {
        logSheet = logSheets[i];
        break;
      }
    }
    if (!logSheet) return { ok: false, message: '找不到請求紀錄表（gid=' + logGid + '）' };
    var logData = logSheet.getDataRange().getValues();
    var colUrl = 3;
    var colRemark = 6;
    if (logData.length > 1) {
      for (var r = 1; r < logData.length; r++) {
        var rowRemark = (logData[r][colRemark] != null) ? String(logData[r][colRemark]).trim() : '';
        if (rowRemark === remarkKey) {
          var existingUrl = (logData[r][colUrl] != null) ? String(logData[r][colUrl]).trim() : '';
          if (existingUrl) return { ok: true, url: existingUrl, cached: true };
        }
      }
    }
    var dataResult = getLastMonthTipsData({ managedStoreIds: managedStoreIds, employeeCode: employeeCode });
    if (!dataResult.ok) return { ok: false, message: dataResult.message || '取得小費資料失敗' };
    var headerRow = dataResult.headerRow || [];
    var rows = dataResult.rows || [];
    var newSs = SpreadsheetApp.create('上月小費 ' + monthStr);
    var newSheet = newSs.getSheets()[0];
    if (headerRow.length && (headerRow.length > 0 || rows.length > 0)) {
      var numCols = headerRow.length;
      var numRows = 1 + rows.length;
      var values = [headerRow].concat(rows);
      newSheet.getRange(1, 1, numRows, numCols).setValues(values);
      if (rows.length && dataResult.rowBackgrounds && dataResult.rowBackgrounds.length) {
        var bgValues = dataResult.rowBackgrounds.slice(0, rows.length);
        for (var bi = 0; bi < bgValues.length; bi++) {
          while (bgValues[bi].length < numCols) bgValues[bi].push('#ffffff');
          if (bgValues[bi].length > numCols) bgValues[bi] = bgValues[bi].slice(0, numCols);
        }
        newSheet.getRange(2, 1, rows.length, numCols).setBackgrounds(bgValues);
      }
      if (numRows >= 2 && numCols >= 5) {
        try {
          var existingRules = newSheet.getConditionalFormatRules();
          var colLetters = ['C', 'D', 'E'];
          var colors = { 1: '#ffc0cb', 2: '#ffff00', 3: '#90ee90' };
          for (var ci = 0; ci < 3; ci++) {
            var colLetter = colLetters[ci];
            var col1Based = 3 + ci;
            var range = newSheet.getRange(2, col1Based, numRows, 1);
            for (var val = 1; val <= 3; val++) {
              var formula = '=OR(' + colLetter + '2=' + val + ',' + colLetter + '2="' + val + '")';
              existingRules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(formula).setBackground(colors[val]).setRanges([range]).build());
            }
          }
          newSheet.setConditionalFormatRules(existingRules);
        } catch (fmtErr) {}
      }
    }
    try {
      DriveApp.getFileById(newSs.getId()).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (shareErr) {}
    var newUrl = 'https://docs.google.com/spreadsheets/d/' + newSs.getId() + '/edit';
    var now = new Date();
    var timeStr = Utilities.formatDate(now, TZ_TIPS, 'yyyy-MM-dd HH:mm:ss');
    var requestId = Utilities.getUuid();
    logSheet.appendRow([requestId, userId, monthStr, newUrl, timeStr, timeStr, remarkKey]);
    return { ok: true, url: newUrl, cached: false, rowCount: dataResult.rowCount };
  } catch (e) {
    return { ok: false, message: (e && e.message) ? e.message : String(e) };
  }
}

/**
 * 全門店該區間消費交易（分頁拉完）
 */
function fetchAllStoresTransactions(startDate, endDate) {
  var stores = typeof getStoresInfo === 'function' ? getStoresInfo() : [];
  if (!stores.length) return [];
  var all = [];
  for (var s = 0; s < stores.length; s++) {
    var storeId = stores[s].id;
    var page = 0;
    var limit = 100;
    var items;
    do {
      var res = fetchTransactions(startDate, endDate, [storeId], page, limit);
      items = (res && res.data && res.data.items) ? res.data.items : [];
      for (var i = 0; i < items.length; i++) {
        var t = items[i];
        var recDate = (t.rectim || t.cretim || '').toString().slice(0, 10);
        if (recDate >= startDate && recDate <= endDate) all.push(t);
      }
      page++;
    } while (items.length >= limit);
  }
  return all;
}

/** 正規化手機為 09xxxxxxxx（與神美／表單比對用） */
function normalizePhoneForTips(phone) {
  if (!phone || typeof phone !== 'string') return '';
  var digits = String(phone).replace(/\D/g, '');
  if (digits.length === 9 && digits.charAt(0) === '9') return '0' + digits;
  if (digits.length >= 10) return digits.slice(-10);
  return '';
}

/**
 * 僅依表單產出小費列（不依賴神美消費）：門店取自「今天消費地點」，以手機對標；神美該月無消費時使用。
 */
function buildTipsRowsFromFormOnly(formRows) {
  var data = [];
  for (var f = 0; f < formRows.length; f++) {
    var tip = formRows[f];
    var phoneNorm = normalizePhoneForTips(tip['您的手機號碼'] || '');
    if (!phoneNorm) continue;
    var dateTime = tip['時間戳記'];
    var newDate = parseFormTimestamp(dateTime);
    if (!newDate) continue;
    var opinionTimeStr = Utilities.formatDate(newDate, TZ_TIPS, 'yyyy-MM-dd HH:mm');
    var createTimeStr = Utilities.formatDate(newDate, TZ_TIPS, 'yyyy-MM-dd hh:mm');
    data.push({
      建立時間: createTimeStr,
      門店: '',
      門店SayDouId: '',
      地點: (tip['今天消費地點'] || '').trim(),
      會員: '',
      手機: phoneNorm,
      備註: '',
      總價: null,
      意見時間: opinionTimeStr,
      小費: (tip['願意給予小費，表達對潔顏師的支持'] || '').trim(),
      意見: (tip['如有其他建議，還請不吝指教，我們會加以完善'] || '').trim(),
      差距小時: null,
      會員儲值金: '',
      星數: (tip['本次潔顏師的表現，我會給予幾顆星？'] || '').trim()
    });
  }
  data.sort(function (a, b) {
    if ((a.門店 || '') !== (b.門店 || '')) return (a.門店 || '').localeCompare(b.門店 || '');
    return (a.意見時間 || '').localeCompare(b.意見時間 || '');
  });
  return data;
}

/**
 * 合併 Google 客人問卷（表單）與神美消費（與 runTips 相同邏輯）：依手機 + 時間差比對，產出小費表 + 消費追蹤 + 星數
 */
function mergeTipsWithConsumption(formRows, transactions, memberMap) {
  var receipt = [];
  for (var i = 0; i < transactions.length; i++) {
    var r = transactions[i];
    var membid = r.membid;
    var mem = memberMap[membid] || {};
    var priceSum = 0;
    if (r.ordds && r.ordds.length) {
      for (var j = 0; j < r.ordds.length; j++) priceSum += Number(r.ordds[j].price_) || 0;
    }
    var storName = (r.stor && r.stor.stonam) ? r.stor.stonam : '';
    var storId = (r.stor && r.stor.storid != null) ? String(r.stor.storid) : '';
    var cretim = r.cretim ? Utilities.formatDate(new Date(r.cretim), TZ_TIPS, 'yyyy-MM-dd hh:mm') : '';
    var phoneNorm = normalizePhoneForTips(mem.phone_ || '');
    receipt.push({
      建立時間: cretim,
      門店: storName,
      門店SayDouId: storId,
      會員: r.memnam || '',
      手機: phoneNorm,
      備註: r.remark || '',
      總價: priceSum,
      儲值金: mem.stcash != null ? mem.stcash : ''
    });
  }
  var dataMap = {};
  for (var k = 0; k < receipt.length; k++) {
    var ph = receipt[k].手機;
    if (!ph) continue;
    if (!dataMap[ph]) dataMap[ph] = [];
    dataMap[ph].push(receipt[k]);
  }

  var data = [];
  for (var f = 0; f < formRows.length; f++) {
    var tip = formRows[f];
    var phoneNorm = normalizePhoneForTips(tip['您的手機號碼'] || '');
    if (!phoneNorm) continue;
    var purchases = dataMap[phoneNorm] || [];
    if (purchases.length === 0) continue;

    var dateTime = tip['時間戳記'];
    var newDate = parseFormTimestamp(dateTime);
    if (!newDate) continue;
    var opinionTimeStr = Utilities.formatDate(newDate, TZ_TIPS, 'yyyy-MM-dd HH:mm');

      for (var p = 0; p < purchases.length; p++) {
        var p0 = purchases[p];
        var buildDate = p0.建立時間 ? new Date(p0.建立時間.replace(' ', 'T')) : null;
        if (!buildDate) continue;
        var diffHours = Math.round((buildDate - newDate) / (1000 * 60 * 60));
        if (diffHours >= 100 || diffHours <= -200) continue;
      data.push({
        建立時間: p0.建立時間,
        門店: p0.門店,
        門店SayDouId: p0.門店SayDouId || '',
        地點: tip['今天消費地點'] || '',
        會員: p0.會員,
        手機: p0.手機,
        備註: p0.備註,
        總價: p0.總價,
        意見時間: opinionTimeStr,
        小費: tip['願意給予小費，表達對潔顏師的支持'] || '',
        意見: tip['如有其他建議，還請不吝指教，我們會加以完善'] || '',
        差距小時: diffHours,
        會員儲值金: p0.儲值金,
        星數: tip['本次潔顏師的表現，我會給予幾顆星？'] || ''
      });
      break;
    }
  }
  data.sort(function (a, b) {
    if (a.門店 !== b.門店) return (a.門店 || '').localeCompare(b.門店 || '');
    if ((b.備註 || '') !== (a.備註 || '')) return (b.備註 || '').localeCompare(a.備註 || '');
    if ((b.小費 || '') !== (a.小費 || '')) return (b.小費 || '').localeCompare(a.小費 || '');
    return (a.意見 || '').localeCompare(b.意見 || '');
  });
  return data;
}

/**
 * 產出上個月小費表資料（合併表單 + SayDou 消費）
 */
function buildLastMonthTipsReport() {
  var now = new Date();
  var lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var startDate = Utilities.formatDate(lastMonth, TZ_TIPS, 'yyyy-MM-dd');
  var endDate = Utilities.formatDate(new Date(now.getFullYear(), now.getMonth(), 0), TZ_TIPS, 'yyyy-MM-dd');

  var formRows = getTipsFormDataFromSheet(startDate, endDate);
  var transactions = fetchAllStoresTransactions(startDate, endDate);
  var members = typeof fetchMembersByDateRange === 'function' ? fetchMembersByDateRange(startDate, endDate) : [];
  var memberMap = {};
  for (var i = 0; i < members.length; i++) {
    memberMap[members[i].membid] = members[i];
  }

  if (formRows.length === 0) console.warn('[TipsReport] 客人問卷試算表在 ' + startDate + '~' + endDate + ' 無回應，請確認 TIPS_FORM_SS_ID 與工作表名稱／gid');
  if (transactions.length === 0) console.warn('[TipsReport] 神美消費在 ' + startDate + '~' + endDate + ' 無資料，改以表單 alone 產出（門店取自「今天消費地點」）');
  if (members.length === 0 && transactions.length > 0) console.warn('[TipsReport] 神美會員區間無資料，消費紀錄無法帶出手機／儲值金');

  var merged = mergeTipsWithConsumption(formRows, transactions, memberMap);
  var formOnly = buildTipsRowsFromFormOnly(formRows);
  var rows = (merged.length > 0) ? merged : formOnly;
  return { startDate: startDate, endDate: endDate, rows: rows };
}

/**
 * 將上個月小費表寫入試算表（LINE_STAFF_SS_ID 內 gid=1792957916 的工作表）
 */
function writeLastMonthTipsToSheet() {
    var ssId = typeof LINE_STAFF_SS_ID !== 'undefined' ? LINE_STAFF_SS_ID : '';
    var gid = typeof TIP_TABLE_SHEET_GID !== 'undefined' ? TIP_TABLE_SHEET_GID : 1792957916;
    if (!ssId) {
      console.warn('[TipsReport] 未設定 LINE_STAFF_SS_ID');
      return { ok: false, message: '未設定 LINE_STAFF_SS_ID' };
    }
    var report = buildLastMonthTipsReport();
    var rows = report.rows || [];
    try {
      var ss = SpreadsheetApp.openById(ssId);
      var sheets = ss.getSheets();
      var sheet = null;
      for (var i = 0; i < sheets.length; i++) {
        if (Number(sheets[i].getSheetId()) === Number(gid)) {
          sheet = sheets[i];
          break;
        }
      }
      if (!sheet) {
        return { ok: false, message: '找不到 gid=' + gid + ' 的工作表' };
      }
      var headers = ['建立時間', '門店', '地點', '會員', '手機', '備註', '總價', '意見時間', '小費', '意見', '差距小時', '會員儲值金', '星數'];
      sheet.clear();
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      if (rows.length > 0) {
        var out = rows.map(function (r) {
          return [
            r.建立時間 || '', r.門店 || '', r.地點 || '', r.會員 || '', r.手機 || '',
            r.備註 || '', r.總價 != null ? r.總價 : '', r.意見時間 || '', r.小費 || '', r.意見 || '',
            r.差距小時 != null ? r.差距小時 : '', r.會員儲值金 != null ? r.會員儲值金 : '', r.星數 || ''
          ];
        });
        sheet.getRange(2, 1, 1 + out.length, headers.length).setValues(out);
      }
      return { ok: true, startDate: report.startDate, endDate: report.endDate, rowCount: rows.length };
    } catch (e) {
      console.error('[TipsReport] writeLastMonthTipsToSheet:', e);
    return { ok: false, message: (e && e.message) ? e.message : String(e) };
  }
}
