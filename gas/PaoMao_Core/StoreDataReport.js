// ======================================================
// [StoreDataReport] 儲值金請款報表（Core API 版本）
// ======================================================

// var STORE_DATA_BATCH_SIZE = 15;
// var STORE_DATA_SLEEP_MS = 1500;

/**
 * 產出儲值金請款報表（不寫入試算表，回傳資料列）
 * @param {{ startDate?: string, endDate?: string, managedStoreIds?: string|string[] }} options
 * @returns {{ ok: boolean, message?: string, startDate?: string, endDate?: string, rows?: any[][] }}
 */
function buildStoreDataReport(options) {
  var tz = Session.getScriptTimeZone();
  var now = new Date();
  var startDate = (options && options.startDate) ? String(options.startDate).trim() : Utilities.formatDate(new Date(now.getFullYear(), now.getMonth() - 1, 1), tz, 'yyyy-MM-dd');
  var endDate = (options && options.endDate) ? String(options.endDate).trim() : Utilities.formatDate(new Date(now.getFullYear(), now.getMonth(), 0), tz, 'yyyy-MM-dd');

  var token = typeof getBearerTokenFromSheet === 'function' ? getBearerTokenFromSheet() : '';
  if (!token) return { ok: false, message: '無法取得神美 Token' };

  var allStores = typeof getStoresInfo === 'function' ? getStoresInfo() : [];
  if (!allStores.length) return { ok: false, message: '無法取得店家列表' };

  // 過濾店家
  var targetIds = [];
  if (options && options.managedStoreIds) {
    if (Array.isArray(options.managedStoreIds)) {
      targetIds = options.managedStoreIds.map(String);
    } else if (typeof options.managedStoreIds === 'string') {
      targetIds = options.managedStoreIds.split(',').map(function(s) { return s.trim(); });
    }
  }

  var stores = [];
  if (targetIds.length > 0) {
    var targetSet = new Set(targetIds); // Set (ES6) 在 GAS V8 可用
    stores = allStores.filter(function(s) { return targetSet.has(String(s.id)); });
  } else {
    stores = allStores;
  }

  if (stores.length === 0) return { ok: true, message: '無符合的店家', rows: [] };


  var allRequests = [];
  var commonHeaders = { 'Authorization': 'Bearer ' + token };
  for (var s = 0; s < stores.length; s++) {
    var storeId = stores[s].id;
    // API 1: 儲值金實收
    allRequests.push({
      url: 'https://saywebdatafeed.saydou.com/api/management/unearn/storecashAddRecord?page=0&limit=20&sort=rectim&order=desc&keyword=&start=' +
        startDate + '&end=' + endDate + '&membid=0&storid%5B%5D=' + storeId + '&type=0&tabIndex=1',
      method: 'GET',
      headers: commonHeaders,
      muteHttpExceptions: true
    });
    // API 2: 使用細項
    allRequests.push({
      url: 'https://saywebdatafeed.saydou.com/api/management/unearn/storecashUseRecord?page=0&limit=20&sort=rectim&order=desc&keyword=&start=' +
        startDate + '&end=' + endDate + '&storid%5B%5D=' + storeId + '&type=0&tabIndex=2&membid=0',
      method: 'GET',
      headers: commonHeaders,
      muteHttpExceptions: true
    });
    // API 3: 總額統計
    allRequests.push({
      url: 'https://saywebdatafeed.saydou.com/api/management/finance/transactionStatistic?page=0&limit=20&sort=ordrsn&order=desc&keyword=&start=' +
        startDate + '&end=' + endDate +
        '&searchMemberCtrl=null&searchProductCtrl=null&searchStaffCtrl=null&membid=0&godsid=0&store%5B%5D=' + storeId +
        '&usrsid=0&memnam=&godnam=&usrnam=&assign=all&licnum=&goctString=',
      method: 'GET',
      headers: commonHeaders,
      muteHttpExceptions: true
    });
  }

  var allResponses = [];
  console.log('Total Requests:', allRequests.length);
  var totalReqs = allRequests.length;
  // 改回 batch fetchAll，以 15 為一組
  var STORE_DATA_BATCH_SIZE = 15; 
  var STORE_DATA_SLEEP_MS = 800;

  for (var i = 0; i < totalReqs; i += STORE_DATA_BATCH_SIZE) {
    var chunk = allRequests.slice(i, i + STORE_DATA_BATCH_SIZE);
    try {
      var chunkResponses = UrlFetchApp.fetchAll(chunk);
      allResponses = allResponses.concat(chunkResponses);
      if (STORE_DATA_SLEEP_MS > 0) Utilities.sleep(STORE_DATA_SLEEP_MS);
    } catch (e) {
      console.error('[StoreDataReport] Batch Error at index ' + i + ': ' + e);
      for (var k = 0; k < chunk.length; k++) allResponses.push(null);
    }
  }

  var outputValues = [];
  for (var si = 0; si < stores.length; si++) {
    var store = stores[si];
    var resAddRecord = allResponses[si * 3];
    var resUseRecord = allResponses[si * 3 + 1];
    var resTransStat = allResponses[si * 3 + 2];

    var dataAdd = tryParseStoreDataJson_(resAddRecord);
    var dataUse = tryParseStoreDataJson_(resUseRecord);
    var dataTrans = tryParseStoreDataJson_(resTransStat);

    var a = (dataAdd && dataAdd.summary) ? (dataAdd.summary.buyActual || 0) : 0;
    var summaryUse = (dataUse && dataUse.summary) ? dataUse.summary : {};
    var c = summaryUse.buyreplace || 0;
    var d = summaryUse.buyticket || 0;
    var stored = (dataTrans && dataTrans.card) ? dataTrans.card : 0;
    var balance = a - stored - c - d;

    outputValues.push([store.name, a, stored, c, d, '', balance]);
  }

  return { ok: true, startDate: startDate, endDate: endDate, rows: outputValues };
}

/**
 * 安全解析 API 回傳 JSON.data
 * @param {GoogleAppsScript.URL_Fetch.HTTPResponse|null} res
 * @returns {Object|null}
 */
function tryParseStoreDataJson_(res) {
  try {
    if (res && res.getResponseCode && res.getResponseCode() === 200) {
      var json = JSON.parse(res.getContentText() || '{}');
      return json.data || null;
    }
  } catch (e) {
    console.warn('[StoreDataReport] JSON Parse Error:', e);
  }
  return null;
}
