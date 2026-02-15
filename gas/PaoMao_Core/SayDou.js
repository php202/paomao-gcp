// 拉取神美的 Token（優先從 Token Web App API 取得，無設定時才直接讀試算表）
var TOKEN_SHEET_SS_ID = '1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE';
var TOKEN_SHEET_NAME = '預約表單';
var TOKEN_CELL = 'C2';

function getBearerTokenFromSheet() {
  try {
    var props = PropertiesService.getScriptProperties();
    var apiUrl = (props.getProperty('PAO_CAT_TOKEN_API_URL') || '').trim();
    var secretKey = (props.getProperty('PAO_CAT_SECRET_KEY') || '').trim();
    if (apiUrl && secretKey) {
      var url = apiUrl.replace(/\s+$/, '') + (apiUrl.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(secretKey);
      var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      var token = response.getContentText();
      if (token && token.indexOf('Error') !== 0) return String(token).trim();
    }
  } catch (e) {
    Logger.log('getBearerTokenFromSheet API 失敗: ' + (e && e.message));
  }
  var ss = SpreadsheetApp.openById(TOKEN_SHEET_SS_ID);
  var sheet = ss.getSheetByName(TOKEN_SHEET_NAME);
  if (!sheet) {
    Logger.log('找不到工作表：' + TOKEN_SHEET_NAME);
    return '';
  }
  var token = sheet.getRange(TOKEN_CELL).getValue();
  return token ? String(token).trim() : '';
}

/** 正規化手機為純數字 09xxxxxxxx（與神美 API／表單比對用，避免 0911-789967 與 0911789967 不一致） */
function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  var digits = String(phone).replace(/\D/g, '');
  if (digits.length === 9 && digits.charAt(0) === '9') return '0' + digits;
  if (digits.length >= 10) return digits.slice(-10);
  return '';
}

// 用手機抓出神美會員
function getMemApi(phone) {
  var keyword = normalizePhone(phone);
  if (!keyword) return null;
  const bearerToken = getBearerTokenFromSheet()
  const apiUrl =
    'https://saywebdatafeed.saydou.com/api/management/unearn/memberStorecash' +
    '?page=0&limit=20&sort=stcash&order=desc' +
    '&keyword=' + encodeURIComponent(keyword) +
    '&showGroup=0&tabIndex=0';

  try {
    const response = UrlFetchApp.fetch(apiUrl, {
      method: 'get',
      headers: {
        Authorization: 'Bearer ' + bearerToken,
      },
      muteHttpExceptions: true,
    });

    // 2. [修正] 必須先取得 HTTP 狀態碼
    const code = response.getResponseCode(); 
    const json = JSON.parse(response.getContentText());

    // 如果 API 回傳非 200，視為失敗
    if (code !== 200) {
      Logger.log('getMemApi error (Code ' + code + '): ' + phone);
      return null;
    }

    // 3. 檢查是否有資料
    if (json && json.data && json.data.items && json.data.items.length > 0) {
      // 回傳第一筆符合的會員資料
      return json.data.items[0];
    } else {
      // API 成功但沒找到人
      return null;
    }

  } catch (e) {
    Logger.log('getMemApi exception for ' + phone + ': ' + e);
    return null;
  }
}

/** GAS UrlFetchApp.fetchAll 單次並行數（官方建議 20，過高易逾時／限流） */
var FETCH_ALL_LIMIT = 20;

/**
 * 並行依手機查會員（用 UrlFetchApp.fetchAll 一次打多支 API）
 * @param {string[]} phones - 手機號碼陣列（可含重複，會去重後再查）
 * @returns {Object.<string, Object|null>} phone -> member 或 null
 */
function getMemApiBatch(phones) {
  var bearerToken = getBearerTokenFromSheet();
  var uniq = [];
  var seen = {};
  for (var p = 0; p < phones.length; p++) {
    var ph = normalizePhone(phones[p] != null ? String(phones[p]).trim() : '');
    if (!ph || seen[ph]) continue;
    seen[ph] = true;
    uniq.push(ph);
  }
  var out = {};
  for (var i = 0; i < uniq.length; i += FETCH_ALL_LIMIT) {
    var chunk = uniq.slice(i, i + FETCH_ALL_LIMIT);
    var requests = chunk.map(function (phone) {
      var apiUrl = 'https://saywebdatafeed.saydou.com/api/management/unearn/memberStorecash' +
        '?page=0&limit=20&sort=stcash&order=desc' +
        '&keyword=' + encodeURIComponent(phone) +
        '&showGroup=0&tabIndex=0';
      return {
        url: apiUrl,
        method: 'get',
        headers: { Authorization: 'Bearer ' + bearerToken },
        muteHttpExceptions: true
      };
    });
    var responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      Logger.log('getMemApiBatch fetchAll: ' + e);
      for (var k = 0; k < chunk.length; k++) out[chunk[k]] = null;
      continue;
    }
    for (var j = 0; j < responses.length; j++) {
      var phone = chunk[j];
      var resp = responses[j];
      try {
        var code = resp.getResponseCode();
        var content = resp.getContentText();
        var json = JSON.parse(content || '{}');

        // 參照 getMemApi：若非 200 視為失敗
        if (code !== 200) {
          // Logger.log('getMemApiBatch error (Code ' + code + '): ' + phone);
          out[phone] = null;
        } else if (json && json.data && json.data.items && json.data.items.length > 0) {
          out[phone] = json.data.items[0];
        } else {
          out[phone] = null;
        }
      } catch (err) {
        Logger.log('getMemApiBatch exception for ' + phone + ': ' + err);
        out[phone] = null;
      }
    }
  }
  return out;
}

/**
 * [主要功能] 根據手機號碼自動執行退費
 * @param {string} phone 手機號碼
 * @return {object} { success: boolean, msg: string, data: object }
 */
function executeRefundByPhone(phone) {
  // 1. 查詢會員
  const member = getMemApi(phone);
  
  if (!member) {
    return { success: false, msg: '找不到會員資料', phone: phone };
  }

  // 2. 檢查儲值金
  if (!member.stcash || member.stcash <= 0) {
    return { success: false, msg: '儲值金為 0 或無儲值金', phone: phone };
  }

  const payload = {
    membid: member.membid,
    cdcode: member.cdcode
  };

  Logger.log(`[Core] 執行退費: ${phone}, 金額: ${member.stcash}`);

  // 3. 呼叫退費 API
  const bearerToken = getBearerTokenFromSheet();
  const apiUrl = 'https://saywebdatafeed.saydou.com/api/management/unearn/returnStorecash';
  
  try {
    const response = UrlFetchApp.fetch(apiUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + bearerToken },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    const result = JSON.parse(response.getContentText() || '{}');

    if (code === 200) {
      return { success: true, msg: '退費成功', data: result, amount: member.stcash };
    } else {
      return { success: false, msg: 'API 錯誤', data: result };
    }
  } catch (e) {
    return { success: false, msg: '系統異常: ' + e.message };
  }
}

/**
 * [批次功能] 如果想一次丟一堆手機進來
 */
function batchRefund(phones) {
  return phones.map(phone => executeRefundByPhone(phone));
}

// [PaoMao_Core] ApiTools.gs

/**
 * [API 1] 抓取單店單日營收 (對應您提供的 runDailyIncomeApiGAS)
 * 用途：跑日報表迴圈用
 */
function fetchDailyIncome(dateStr, storeId) {
  const bearerToken = getBearerTokenFromSheet(); // 內部取得 Token
  
  // 修正：參數傳入 storeId 與 dateStr
  const apiUrl = `https://saywebdatafeed.saydou.com/api/management/finance/dailyIncome?storid=${storeId}&date=${dateStr}&end_date=${dateStr}`;
  
  try {
    const response = UrlFetchApp.fetch(apiUrl, {
      method: 'get',
      headers: { 'Authorization': `Bearer ${bearerToken}` },
      muteHttpExceptions: true 
    });
    
    const json = JSON.parse(response.getContentText());
    return json; // 直接回傳完整 JSON，讓外面去解析 data
  } catch (e) {
    console.error(`[Core] fetchDailyIncome 錯誤 (${storeId}, ${dateStr}): ${e.message}`);
    return { data: { total: 0, items: [] } }; // 回傳預設空結構防爆
  }
}

/**
 * [API 2] 抓取消費明細 (對應您提供的 runReceiptApiGAS)
 * 用途：如果未來需要抓詳細交易紀錄時呼叫
 */
function fetchTransactions(startDate, endDate, storeIds, page = 0, limit = 50) {
  const bearerToken = getBearerTokenFromSheet();
  
  // 組合 storeId 陣列字串（以 store%5B%5D 參數傳遞）
  const storeIdString = storeIds.map(id => `&store%5B%5D=${encodeURIComponent(id)}`).join('');
  
  const apiUrl = `https://saywebdatafeed.saydou.com/api/management/finance/transaction?page=${page}&limit=${limit}&sort=ordrsn&order=desc&keyword=&start=${startDate}&end=${endDate}&searchMemberCtrl=null&searchProductCtrl=null&searchStaffCtrl=null&membid=0&godsid=0&usrsid=0&memnam=&godnam=&usrnam=&assign=all&licnum=&goctString=${storeIdString}`;
    
  try {
    const response = UrlFetchApp.fetch(apiUrl, {
      method: 'get',
      headers: { 'Authorization': `Bearer ${bearerToken}` },
      muteHttpExceptions: true
    });
    return JSON.parse(response.getContentText());
  } catch (e) {
    console.error("[Core] fetchTransactions 錯誤：" + e.message);
    return { data: { total: 0, items: [] } };
  }
}

/**
 * [小費表／五星好評] 依日期區間拉取 CRM 會員列表（供合併消費紀錄時取得手機、儲值金）
 * @param {string} startDate - yyyy-MM-dd
 * @param {string} endDate - yyyy-MM-dd
 * @returns {Array} 會員項目陣列，每筆含 membid, phone_, stcash 等
 */
function fetchMembersByDateRange(startDate, endDate) {
  var bearerToken = getBearerTokenFromSheet();
  if (!bearerToken) return [];
  var all = [];
  var page = 0;
  var limit = 50;
  var res, items;
  do {
    var apiUrl = 'https://saywebdatafeed.saydou.com/api/management/crm/members?page=' + page + '&limit=' + limit +
      '&sort=membid&order=desc&keyword=&start=' + encodeURIComponent(startDate) + '&end=' + encodeURIComponent(endDate) +
      '&searchLeaveStaffCtrl=null&searchProductCtrl=null&searchStaffCtrl=null&godsid=0&usrsid=0&line=0&godnam=&usrnam=&showGroup=0';
    try {
      res = UrlFetchApp.fetch(apiUrl, {
        method: 'get',
        headers: { 'Authorization': 'Bearer ' + bearerToken },
        muteHttpExceptions: true
      });
      var json = JSON.parse(res.getContentText());
      items = (json && json.data && json.data.items) ? json.data.items : [];
      for (var i = 0; i < items.length; i++) {
        var m = items[i];
        all.push({ membid: m.membid, phone_: m.phone_ || '', stcash: m.stcash != null ? m.stcash : '' });
      }
      page++;
    } catch (e) {
      console.error("[Core] fetchMembersByDateRange 錯誤：" + e.message);
      break;
    }
  } while (items && items.length >= limit);
  return all;
}

/**
 * 取得指定店家、指定日期的消費交易明細（分頁拉完），供昨日報表「誰做收多少」用
 * @param {string} storeId - SayDou 店家 ID (storid)
 * @param {string} dateStr - yyyy-MM-dd
 * @returns {Array} transaction 項目陣列（該店、該日）
 */
function getTransactionsForStoreByDate(storeId, dateStr) {
  if (!storeId || !dateStr) return [];
  var all = [];
  var page = 0;
  var limit = 100;
  var res;
  do {
    res = fetchTransactions(dateStr, dateStr, [storeId], page, limit);
    var items = (res.data && res.data.items) ? res.data.items : [];
    for (var i = 0; i < items.length; i++) {
      var t = items[i];
      var recDate = (t.rectim || t.cretim || "").slice(0, 10);
      var storId = "";
      if (t.storid != null && t.storid !== "") {
        storId = String(t.storid);
      } else if (t.stor && t.stor.storid != null) {
        storId = String(t.stor.storid);
      } else if (t.store != null) {
        storId = String(t.store);
      }
      if (recDate === dateStr && storId === String(storeId)) all.push(t);
    }
    page++;
  } while (items.length >= limit);
  return all;
}

/**
 * 取得指定店家、日期區間的消費交易明細（分頁拉完），供月報用
 * @param {string} storeId - SayDou 店家 ID (storid)
 * @param {string} startDate - yyyy-MM-dd
 * @param {string} endDate - yyyy-MM-dd
 * @returns {Array} transaction 項目陣列
 */
function getTransactionsForStoreByDateRange(storeId, startDate, endDate) {
  if (!storeId || !startDate || !endDate) return [];
  var all = [];
  var page = 0;
  var limit = 100;
  var res;
  do {
    res = fetchTransactions(startDate, endDate, [storeId], page, limit);
    var items = (res.data && res.data.items) ? res.data.items : [];
    for (var i = 0; i < items.length; i++) {
      var t = items[i];
      var recDate = (t.rectim || t.cretim || "").slice(0, 10);
      var storId = "";
      if (t.storid != null && t.storid !== "") {
        storId = String(t.storid);
      } else if (t.stor && t.stor.storid != null) {
        storId = String(t.stor.storid);
      } else if (t.store != null) {
        storId = String(t.store);
      }
      if (recDate >= startDate && recDate <= endDate && storId === String(storeId)) all.push(t);
    }
    page++;
  } while (items.length >= limit);
  return all;
}

// 取得店家的大的預約資訊
function fetchReservationData(startDate, endDate, storeId) {
  const url = 'https://saywebdatafeed.saydou.com/api/management/analytics/reservation';
  const payload = {
    timebase: 'reservation',
    start: Utilities.formatDate(new Date(startDate), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    end: Utilities.formatDate(new Date(endDate), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    'store[]': [storeId]
  };

  const options = {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: {
      Authorization: `Bearer ${getBearerTokenFromSheet()}`
    },
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const data = JSON.parse(response.getContentText());

  return data.source;
}

// 取得神的新舊客資訊
function oldNewA(startDate, endDate, storeId) {
  const str = Utilities.formatDate(new Date(startDate), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  const end = Utilities.formatDate(new Date(endDate), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  const url = `https://saywebdatafeed.saydou.com/api/management/analytics/member/oldNewAnalyse/0/1?start=${str}&end=${end}&store%5B%5D=${storeId}&page=0&limit=100`;
  const options = {
    method: 'GET',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${getBearerTokenFromSheet()}`
    },
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const data = JSON.parse(response.getContentText());
  const stores = data.data.ratio;
  return stores

}

// 去得今天預約的狀況
function fetchTodayReservationData(start, end, storeId) {
  const url = 'https://saywebdatafeed.saydou.com/api/management/analytics/reservation';

  const payload = {
    timebase: "create",
    start: start,
    end: end,
    'store[]': [storeId],
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${getBearerTokenFromSheet()}`
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  return JSON.parse(response.getContentText());
}

// ---------------------------------------------------------------------------
// 會員全貌：依 membid 拉取 member view / 消費全筆 / 儲值金全筆（供 CRM 整合用）
// ---------------------------------------------------------------------------

/**
 * GET 會員個人資料（完整 view）
 * @param {number} membid 會員 ID
 * @returns {object|null} data 或 null
 */
function getMemberViewByMembid(membid) {
  if (!membid) return null;
  const bearerToken = getBearerTokenFromSheet();
  const apiUrl = 'https://saywebdatafeed.saydou.com/api/management/crm/member/' + membid + '?type=view';
  try {
    const response = UrlFetchApp.fetch(apiUrl, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + bearerToken },
      muteHttpExceptions: true,
    });
    const code = response.getResponseCode();
    const json = JSON.parse(response.getContentText() || '{}');
    if (code !== 200 || !json.status || !json.data) return null;
    return json.data;
  } catch (e) {
    Logger.log('getMemberViewByMembid exception: ' + e);
    return null;
  }
}

/**
 * 拉一頁「消費紀錄」transaction
 * @param {number} membid
 * @param {number} page
 * @param {number} limit
 * @returns {{ items: Array, total: number }}
 */
function fetchTransactionsByMembidPage(membid, page, limit) {
  const bearerToken = getBearerTokenFromSheet();
  const apiUrl = 'https://saywebdatafeed.saydou.com/api/management/finance/transaction' +
    '?page=' + page + '&limit=' + limit +
    '&sort=ordrsn&order=desc&keyword=&searchMemberCtrl=null&searchProductCtrl=null&searchStaffCtrl=null' +
    '&membid=' + membid + '&godsid=0&usrsid=0&memnam=&godnam=&usrnam=&assign=all&licnum=&goctString=';
  try {
    const response = UrlFetchApp.fetch(apiUrl, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + bearerToken },
      muteHttpExceptions: true,
    });
    const json = JSON.parse(response.getContentText() || '{}');
    if (!json.status || !json.data) return { items: [], total: 0 };
    return { items: json.data.items || [], total: json.data.total || 0 };
  } catch (e) {
    Logger.log('fetchTransactionsByMembidPage exception: ' + e);
    return { items: [], total: 0 };
  }
}

/**
 * 依 membid 全筆拉取消費紀錄（分頁迴圈直到取完）
 * @param {number} membid
 * @param {number} pageSize 每頁筆數，預設 20
 * @returns {Array} 所有 transaction 項目
 */
function getAllTransactionsByMembid(membid, pageSize) {
  if (!membid) return [];
  var limit = pageSize || 20;
  var all = [];
  var page = 0;
  var res;
  do {
    res = fetchTransactionsByMembidPage(membid, page, limit);
    if (res.items && res.items.length > 0) all = all.concat(res.items);
    page++;
  } while (res.items && res.items.length >= limit);
  return all;
}

/** transaction API 每頁筆數（與 findLatestConsumptionBefore 一致） */
var TRANSACTION_PAGE_LIMIT = 50;

/**
 * 並行拉取多個 membid 的全部分頁消費紀錄（用 UrlFetchApp.fetchAll）
 * @param {number[]} membids - 會員 ID 陣列
 * @returns {Object.<number, Array>} membid -> 該會員全部 transaction 陣列
 */
function getAllTransactionsByMembidBatch(membids) {
  var bearerToken = getBearerTokenFromSheet();
  var out = {};
  var list = [];
  for (var m = 0; m < membids.length; m++) {
    var id = membids[m];
    if (id == null) continue;
    out[id] = [];
    list.push({ membid: id, page: 0 });
  }
  var limit = TRANSACTION_PAGE_LIMIT;
  while (list.length > 0) {
    var chunk = list.splice(0, FETCH_ALL_LIMIT);
    var requests = chunk.map(function (item) {
      var apiUrl = 'https://saywebdatafeed.saydou.com/api/management/finance/transaction' +
        '?page=' + item.page + '&limit=' + limit +
        '&sort=ordrsn&order=desc&keyword=&searchMemberCtrl=null&searchProductCtrl=null&searchStaffCtrl=null' +
        '&membid=' + item.membid + '&godsid=0&usrsid=0&memnam=&godnam=&usrnam=&assign=all&licnum=&goctString=';
      return {
        url: apiUrl,
        method: 'get',
        headers: { Authorization: 'Bearer ' + bearerToken },
        muteHttpExceptions: true
      };
    });
    var responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      Logger.log('getAllTransactionsByMembidBatch fetchAll: ' + e);
      break;
    }
    for (var j = 0; j < responses.length; j++) {
      var item = chunk[j];
      var resp = responses[j];
      try {
        var json = JSON.parse(resp.getContentText() || '{}');
        var items = (json && json.data && json.data.items) ? json.data.items : [];
        if (items.length > 0) out[item.membid] = out[item.membid].concat(items);
        if (items.length >= limit) list.push({ membid: item.membid, page: item.page + 1 });
      } catch (err) { }
    }
  }
  return out;
}

/**
 * 從已拉好的 transaction 陣列中，找出在指定時間「之前」最近一筆消費（排除小費）。供批次結果使用。
 * @param {Array} all - transaction 陣列
 * @param {number} beforeTimeMs - 問卷填寫時間 (ms)
 * @returns {Object|null} transaction 或 null
 */
function findLatestFromTransactionList(all, beforeTimeMs) {
  if (!all || !all.length || beforeTimeMs == null) return null;
  var valid = [];
  for (var i = 0; i < all.length; i++) {
    var t = all[i];
    var cretim = t.cretim || t.rectim;
    if (!cretim) continue;
    var tMs = new Date(cretim).getTime();
    if (tMs >= beforeTimeMs) continue;
    var remark = (t.remark != null) ? String(t.remark) : '';
    if (remark.indexOf('小費') >= 0) continue;
    var hasXiaofei = false;
    if (t.ordds && t.ordds.length) {
      for (var j = 0; j < t.ordds.length; j++) {
        var godnam = (t.ordds[j].godnam != null) ? String(t.ordds[j].godnam) : '';
        if (godnam.indexOf('小費') >= 0) { hasXiaofei = true; break; }
      }
    }
    if (hasXiaofei) continue;
    valid.push(t);
  }
  if (valid.length === 0) return null;
  valid.sort(function (a, b) {
    var ta = (a.cretim || a.rectim) || '';
    var tb = (b.cretim || b.rectim) || '';
    return tb > ta ? 1 : (tb < ta ? -1 : 0);
  });
  return valid[0];
}

/**
 * 從一筆消費紀錄（transaction）取出店家 ID。
 * finance/transaction API（依 membid 查）回傳根層 storid；依 store 查可能回傳 stor.storid。
 * @param {Object} t - transaction 物件
 * @returns {string}
 */
function getStorIdFromTransaction(t) {
  if (!t) return '';
  if (t.storid !== undefined && t.storid !== null && t.storid !== '') return String(t.storid);
  if (t.stor && t.stor.storid !== undefined && t.stor.storid !== null && t.stor.storid !== '') return String(t.stor.storid);
  if (t.store !== undefined && t.store !== null && t.store !== '') return String(t.store);
  return '';
}

/**
 * 找出會員在指定時間「之前」最近一筆消費（排除名稱或備註含「小費」、不取比填問卷時間晚的消費）
 * @param {number} membid
 * @param {number} beforeTimeMs - 問卷填寫時間 (ms)
 * @returns {Object|null} transaction 或 null
 */
function findLatestConsumptionBefore(membid, beforeTimeMs) {
  if (!membid || beforeTimeMs == null) {
    return null;
  }
  var all = getAllTransactionsByMembid(membid, 50);
  var valid = [];
  for (var i = 0; i < all.length; i++) {
    var t = all[i];
    var cretim = t.cretim || t.rectim;
    if (!cretim) continue;
    var tMs = new Date(cretim).getTime();
    if (tMs >= beforeTimeMs) continue;
    var remark = (t.remark != null) ? String(t.remark) : '';
    if (remark.indexOf('小費') >= 0) continue;
    var hasXiaofei = false;
    if (t.ordds && t.ordds.length) {
      for (var j = 0; j < t.ordds.length; j++) {
        var godnam = (t.ordds[j].godnam != null) ? String(t.ordds[j].godnam) : '';
        if (godnam.indexOf('小費') >= 0) { hasXiaofei = true; break; }
      }
    }
    if (hasXiaofei) continue;
    valid.push(t);
  }
  if (valid.length === 0) {
    return null;
  }
  valid.sort(function (a, b) {
    var ta = (a.cretim || a.rectim) || '';
    var tb = (b.cretim || b.rectim) || '';
    return tb > ta ? 1 : (tb < ta ? -1 : 0);
  });
  var chosen = valid[0];
  return chosen;
}

/**
 * 拉一頁「儲值金使用紀錄」storecashUseRecord
 * @param {number} membid
 * @param {number} page
 * @param {number} limit
 * @returns {{ items: Array, total: number }}
 */
function fetchStorecashUseRecordPage(membid, page, limit) {
  const bearerToken = getBearerTokenFromSheet();
  const apiUrl = 'https://saywebdatafeed.saydou.com/api/management/unearn/storecashUseRecord' +
    '?page=' + page + '&limit=' + (limit || 20) +
    '&sort=rectim&order=desc&keyword=&type=0&tabIndex=2&membid=' + membid;
  try {
    const response = UrlFetchApp.fetch(apiUrl, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + bearerToken },
      muteHttpExceptions: true,
    });
    const json = JSON.parse(response.getContentText() || '{}');
    if (!json.status || !json.data) return { items: [], total: 0 };
    return { items: json.data.items || [], total: json.data.total || 0 };
  } catch (e) {
    Logger.log('fetchStorecashUseRecordPage exception: ' + e);
    return { items: [], total: 0 };
  }
}

/**
 * 依 membid 全筆拉取儲值金使用紀錄（分頁迴圈直到取完）
 * @param {number} membid
 * @param {number} pageSize 預設 20
 * @returns {Array}
 */
function getAllStorecashUseRecordByMembid(membid, pageSize) {
  if (!membid) return [];
  var limit = pageSize || 20;
  var all = [];
  var page = 0;
  var res;
  do {
    res = fetchStorecashUseRecordPage(membid, page, limit);
    if (res.items && res.items.length > 0) all = all.concat(res.items);
    page++;
  } while (res.items && res.items.length >= limit);
  return all;
}

/**
 * 拉一頁「儲值紀錄」storecashAddRecord（儲值／加值）
 * @param {number} membid
 * @param {number} page
 * @param {number} limit
 * @returns {{ items: Array, total: number }}
 */
function fetchStorecashAddRecordPage(membid, page, limit) {
  const bearerToken = getBearerTokenFromSheet();
  const apiUrl = 'https://saywebdatafeed.saydou.com/api/management/unearn/storecashAddRecord' +
    '?page=' + page + '&limit=' + (limit || 20) +
    '&sort=rectim&order=desc&keyword=&membid=' + membid + '&type=0&tabIndex=1';
  try {
    const response = UrlFetchApp.fetch(apiUrl, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + bearerToken },
      muteHttpExceptions: true,
    });
    const json = JSON.parse(response.getContentText() || '{}');
    if (!json.status || !json.data) return { items: [], total: 0 };
    return { items: json.data.items || [], total: json.data.total || 0 };
  } catch (e) {
    Logger.log('fetchStorecashAddRecordPage exception: ' + e);
    return { items: [], total: 0 };
  }
}

/**
 * 依 membid 全筆拉取儲值紀錄（加值／儲值），分頁迴圈直到取完
 * @param {number} membid
 * @param {number} pageSize 預設 20
 * @returns {Array}
 */
function getAllStorecashAddRecordByMembid(membid, pageSize) {
  if (!membid) return [];
  var limit = pageSize || 20;
  var all = [];
  var page = 0;
  var res;
  do {
    res = fetchStorecashAddRecordPage(membid, page, limit);
    if (res.items && res.items.length > 0) all = all.concat(res.items);
    page++;
  } while (res.items && res.items.length >= limit);
  return all;
}

/**
 * 依 membid 取得會員的預約記錄，回傳「未來且未取消」的有效預約
 * API: /api/management/calendar/reservation/record/saydou/{membid}/{membid}
 * @param {number} membid 會員 ID（對應 saydouUserId）
 * @returns {Array<{rsvtim:string, stonam:string, txtser:string}>} 有效預約陣列
 */
function getReservationRecordByMembid(membid) {
  if (!membid) return [];
  var bearerToken = getBearerTokenFromSheet();
  var apiUrl = 'https://saywebdatafeed.saydou.com/api/management/calendar/reservation/record/saydou/' +
    membid + '/' + membid + '?page=0&limit=20&sort=rsvtim&order=desc';
  try {
    var response = UrlFetchApp.fetch(apiUrl, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + bearerToken },
      muteHttpExceptions: true
    });
    var json = JSON.parse(response.getContentText() || '{}');
    if (!json.status || !json.data || !json.data.items) return [];
    var items = json.data.items;
    var now = new Date();
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var r = items[i];
      if (r.memcel === 'Y') continue;
      var rsvtim = r.rsvtim || '';
      if (!rsvtim) continue;
      var rsvDate = new Date(rsvtim);
      if (isNaN(rsvDate.getTime()) || rsvDate < now) continue;
      var stonam = (r.stor && r.stor.stonam) ? r.stor.stonam : '';
      var txtser = r.txtser || r.services || '';
      out.push({ rsvtim: rsvtim, stonam: stonam, txtser: txtser });
    }
    return out;
  } catch (e) {
    Logger.log('getReservationRecordByMembid exception: ' + (e && e.message));
    return [];
  }
}

/**
 * 檢查 SayDou Bearer Token 是否有效；若無效或為空則發送通知（Email）。
 * 可由時間驅動觸發排程執行（例如每日一次）。
 * 指令碼屬性可設：PAO_CAT_ADMIN_EMAIL（通知寄送對象，多個用逗號分隔）；未設則只寫入 Logger。
 */
function checkSaydouTokenAndNotify() {
  var token = getBearerTokenFromSheet();
  var problem = null;
  if (!token || String(token).trim() === '') {
    problem = 'Token 為空或無法取得';
  } else {
    try {
      var testUrl = 'https://saywebdatafeed.saydou.com/api/management/unearn/memberStorecash' +
        '?page=0&limit=1&sort=stcash&order=desc&keyword=0&showGroup=0&tabIndex=0';
      var response = UrlFetchApp.fetch(testUrl, {
        method: 'get',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true
      });
      var code = response.getResponseCode();
      if (code === 401 || code === 403) {
        problem = 'Token 無效或已過期（HTTP ' + code + '）';
      }
    } catch (e) {
      problem = '驗證 Token 時發生錯誤: ' + (e && e.message);
    }
  }
  if (!problem) {
    Logger.log('checkSaydouTokenAndNotify: Token 正常');
    return;
  }
  Logger.log('checkSaydouTokenAndNotify: ' + problem);
  var props = PropertiesService.getScriptProperties();
  var to = (props.getProperty('PAO_CAT_ADMIN_EMAIL') || '').trim();
  if (to) {
    try {
      MailApp.sendEmail(to, '[泡泡貓] SayDou Token 檢查異常', 'SayDou Bearer Token 檢查結果：' + problem + '\n\n請檢查 Token 試算表或 Token Web App 設定。');
    } catch (mailErr) {
      Logger.log('checkSaydouTokenAndNotify 寄信失敗: ' + (mailErr && mailErr.message));
    }
  }
}



