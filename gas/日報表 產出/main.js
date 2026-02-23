/**
 * 日報表 產出 - 本專案不依賴 Core 程式庫，一律透過 Core API URL 取得資料。
 * 若出現 "ReferenceError: Core is not defined"：請在專案「專案設定」→「程式庫」移除 Core；
 * 確認試算表綁定的附加專案為本專案；並執行 clasp push 部署最新版。
 *
 * 指令碼屬性：
 * - PAO_CAT_CORE_API_URL：必須是 PaoMao_Core「管理部署」裡「網路應用程式」那筆的網址（結尾 /exec）
 * - PAO_CAT_SECRET_KEY：與 Core 相同的密鑰
 */
var CORE_API_URL_MUST_BE = 'https://script.google.com/macros/s/AKfycby5ibTcUxvPD-Xj1-lOHOJ5oI27CbyyaHv2K3cvNd1PwMiPvwGCpjlzi6UbW4fwip2UaA/exec';

function getCoreApiParams() {
  const p = PropertiesService.getScriptProperties();
  const url = (p.getProperty('PAO_CAT_CORE_API_URL') || '').trim();
  const key = (p.getProperty('PAO_CAT_SECRET_KEY') || '').trim();
  return { url, key, useApi: url.length > 0 && key.length > 0 };
}

/** 選單用：顯示 Core API 網址設定說明（若日報一直 0 筆或 getCoreConfig 未回傳，請把此網址設到指令碼屬性） */
function showCoreApiUrlHelp() {
  const p = PropertiesService.getScriptProperties();
  const current = (p.getProperty('PAO_CAT_CORE_API_URL') || '').trim();
  const ok = (current === CORE_API_URL_MUST_BE);
  SpreadsheetApp.getUi().alert(
    ok ? 'Core API 網址已正確' : '請設定 Core API 網址',
    (ok ? '目前 PAO_CAT_CORE_API_URL 已與 PaoMao_Core 部署一致。\n\n' : '若日報出現「0 筆店家」或「未回傳 DAILY_ACCOUNT_REPORT_SS_ID」，請在「日報表 產出」專案：\n\n1. 擴充功能 → Apps Script → 左側 ⚙️ 專案設定\n2. 指令碼屬性 → 新增或編輯 PAO_CAT_CORE_API_URL\n3. 值貼上以下網址（整段複製）：\n\n') + CORE_API_URL_MUST_BE + (ok ? '' : '\n\n另需 PAO_CAT_SECRET_KEY（與 PaoMao_Core 相同密鑰）。')
  );
}

// -----------------------------------------------------------------------------
// GCP UI shim: prefer calling Cloud Run /admin for heavy jobs.
// Script properties:
// - GCP_ADMIN_URL: e.g. https://<cloud-run-service>/admin
// - GCP_ADMIN_KEY: same as ADMIN_KEY / PAO_CAT_SECRET_KEY
// -----------------------------------------------------------------------------
function getGcpAdminParams_() {
  const p = PropertiesService.getScriptProperties();
  const url = (p.getProperty('GCP_ADMIN_URL') || '').trim();
  const key = (p.getProperty('GCP_ADMIN_KEY') || p.getProperty('PAO_CAT_SECRET_KEY') || '').trim();
  return { url, key, useAdmin: url.length > 0 && key.length > 0 };
}

function callGcpAdmin_(action, extraParams) {
  const { url, key, useAdmin } = getGcpAdminParams_();
  if (!useAdmin) return null;
  const payload = Object.assign({ key: key, action: action }, extraParams || {});
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    followRedirects: true,
  });
  try {
    return JSON.parse(res.getContentText() || '{}');
  } catch (e) {
    return { status: 'error', message: res.getContentText() };
  }
}

/**
 * 呼叫 Core API（GET）。回傳 { status, data } 或 null（連線/解析失敗）。
 */
function callCoreApi(coreApiUrl, coreApiKey, action, extraParams) {
  if (!coreApiUrl || !coreApiKey) return null;
  const sep = coreApiUrl.indexOf('?') >= 0 ? '&' : '?';
  let q = sep + 'key=' + encodeURIComponent(coreApiKey) + '&action=' + encodeURIComponent(action);
  if (extraParams && typeof extraParams === 'object') {
    Object.keys(extraParams).forEach(function (k) {
      if (extraParams[k] != null && extraParams[k] !== '') {
        q += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(String(extraParams[k]));
      }
    });
  }
  try {
    const res = UrlFetchApp.fetch(coreApiUrl + q, { muteHttpExceptions: true, followRedirects: true });
    const text = res.getContentText();
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/**
 * 建立 Core API GET 的完整 URL
 */
function buildCoreApiUrl(coreApiUrl, coreApiKey, action, extraParams) {
  if (!coreApiUrl || !coreApiKey) return null;
  const sep = coreApiUrl.indexOf('?') >= 0 ? '&' : '?';
  let q = sep + 'key=' + encodeURIComponent(coreApiKey) + '&action=' + encodeURIComponent(action);
  if (extraParams && typeof extraParams === 'object') {
    Object.keys(extraParams).forEach(function (k) {
      if (extraParams[k] != null && extraParams[k] !== '') {
        q += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(String(extraParams[k]));
      }
    });
  }
  return coreApiUrl + q;
}

/** GAS UrlFetch 並發限制，每批最多 20 個請求 */
var FETCH_BATCH_SIZE = 20;

/**
 * 日報表 產出 - Web App API（URL 化）
 * 部署為「網路應用程式」後，可用 GET/POST 觸發日報產出。
 *
 * 【呼叫方式】
 * GET:  PAO_CAT_REPORT_API_URL?key=密鑰&action=runDailyReport
 * POST: body JSON: { "key": "密鑰", "action": "runDailyReport" }
 *
 * 指定重跑日期（單日/區間）：
 * - 單日：action=runAccNeed&date=2026-02-11
 * - 區間：action=runAccNeed&startDate=2026-02-10&endDate=2026-02-11
 *
 * 密鑰：與本專案指令碼屬性 PAO_CAT_SECRET_KEY 相同（可與 Core API 共用）。
 * action 支援：runDailyReport（執行產出各店日報，等同選單「產出各店日報」）
 */
function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  return handleReportApiRequest(params);
}

function doPost(e) {
  let params = {};
  if (e && e.postData && e.postData.contents) {
    try {
      params = JSON.parse(e.postData.contents);
    } catch (err) {
      return jsonReportOut({ status: 'error', message: 'JSON 解析失敗' });
    }
  }
  return handleReportApiRequest(params);
}

function jsonReportOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleReportApiRequest(params) {
  const key = (params.key != null) ? String(params.key).trim() : '';
  const expected = getCoreApiParams().key;
  if (!expected || key !== expected) {
    return jsonReportOut({ status: 'error', message: 'unauthorized' });
  }
  const action = (params.action != null) ? String(params.action).trim() : '';
  if (action === 'runDailyReport' || action === 'runAccNeed') {
    try {
      const date = (params.date != null) ? String(params.date).trim() : '';
      const startDate = (params.startDate != null) ? String(params.startDate).trim() : '';
      const endDate = (params.endDate != null) ? String(params.endDate).trim() : '';
      runAccNeed({ date: date, startDate: startDate, endDate: endDate });
      return jsonReportOut({ status: 'ok', message: '日報產出已執行' });
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      if (msg.indexOf('Core is not defined') !== -1) {
        return jsonReportOut({
          status: 'error',
          message: 'ReferenceError: Core is not defined。本專案已改為使用 Core API，不應依賴 Core 程式庫。請依序檢查：1) 專案「擴充功能→Apps Script 專案」確認此試算表綁定的是「日報表 產出」專案；2) 在該專案「專案設定」中移除 Core 程式庫（程式庫應為空）；3) 指令碼屬性已設定 PAO_CAT_CORE_API_URL、PAO_CAT_SECRET_KEY；4) 本機已執行 clasp push 部署最新版。'
        });
      }
      return jsonReportOut({ status: 'error', message: msg });
    }
  }
  if (action === 'runYangmeiJinshanDailyReport') {
    try {
      runYangmeiJinshanDailyReport();
      return jsonReportOut({ status: 'ok', message: '楊梅金山店日帳已產出' });
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      return jsonReportOut({ status: 'error', message: msg });
    }
  }
  if (action === 'employeeMonthlyPerformanceReport') {
    try {
      const mode = (params.mode != null) ? String(params.mode).trim() : 'lastMonth';
      const batchSize = (params.batchSize != null) ? parseInt(params.batchSize, 10) : 3;
      const res = callEmployeeMonthlyReportApi(mode, isNaN(batchSize) ? 3 : batchSize);
      return jsonReportOut(res);
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      return jsonReportOut({ status: 'error', message: msg });
    }
  }
  return jsonReportOut({ status: 'error', message: '未知 action: ' + (action || '(未提供)') });
}

function parseYmdOrNull_(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return d;
}

function runAccNeed(options) {
  options = options || {};
  // Preferred: run on GCP (Cloud Run Job) to avoid UrlFetch quotas.
  const adminRes = callGcpAdmin_('runDailyReport', options);
  if (adminRes && adminRes.status) {
    SpreadsheetApp.getUi().alert(
      adminRes.status === 'ok'
        ? '已送出 GCP 日報工作（請至 Cloud Run Logs/Jobs 查看進度）'
        : 'GCP 執行失敗：' + (adminRes.message || 'unknown'),
    );
    return;
  }
  const { url: coreApiUrl, key: coreApiKey, useApi } = getCoreApiParams();
  if (!useApi) {
    throw new Error('請在指令碼屬性設定 PAO_CAT_CORE_API_URL 與 PAO_CAT_SECRET_KEY，本專案改由 Core API 取得資料（不再使用 Core 程式庫）。');
  }

  // --- 從 Core API 取得日報試算表 ID（與 PaoMao_Core Config.js 一致；API 未回傳時用後備）---
  const DAILY_REPORT_SS_ID_FALLBACK = '1ZMutegYTLZ51XQHCbfFZ7-iAj1qTZGgSo5VTThXPQ5U';
  const configRes = callCoreApi(coreApiUrl, coreApiKey, 'getCoreConfig', {});
  let ssId = (configRes && configRes.status === 'ok' && configRes.data && configRes.data.DAILY_ACCOUNT_REPORT_SS_ID)
    ? String(configRes.data.DAILY_ACCOUNT_REPORT_SS_ID).trim()
    : '';
  if (!ssId) {
    ssId = DAILY_REPORT_SS_ID_FALLBACK;
    console.warn('Core API getCoreConfig 未回傳 DAILY_ACCOUNT_REPORT_SS_ID，使用後備試算表 ID。目前呼叫的 API 網址：' + (coreApiUrl || '(未設定)') + ' → 請在「日報表 產出」專案「專案設定」→「指令碼屬性」將 PAO_CAT_CORE_API_URL 設為：' + CORE_API_URL_MUST_BE);
  }
  if (!ssId) {
    throw new Error('Core API getCoreConfig 未回傳 DAILY_ACCOUNT_REPORT_SS_ID，請確認 PaoMao_Core 專案設定並重新部署。');
  }

  const externalSs = SpreadsheetApp.openById(ssId);
  const sheetAll = externalSs.getSheetByName('營收報表');       // 全門市
  const sheetDirect = externalSs.getSheetByName('營收報表_直營'); // 直營店

  const timeZone = externalSs.getSpreadsheetTimeZone();
  const getFormattedDate = (date) => Utilities.formatDate(date, timeZone, 'yyyy-MM-dd');

  // --- 1. 計算日期範圍：可指定重跑單日/區間，未指定時維持舊邏輯 ---
  const rawDate = options.date ? String(options.date).trim() : '';
  const rawStart = options.startDate ? String(options.startDate).trim() : '';
  const rawEnd = options.endDate ? String(options.endDate).trim() : '';
  const forceSingle = parseYmdOrNull_(rawDate);
  const forceStart = parseYmdOrNull_(rawStart);
  const forceEnd = parseYmdOrNull_(rawEnd);
  const hasManualRange = !!(rawDate || rawStart || rawEnd);
  if (rawDate && !forceSingle) throw new Error('date 格式錯誤，請使用 yyyy-MM-dd');
  if (rawStart && !forceStart) throw new Error('startDate 格式錯誤，請使用 yyyy-MM-dd');
  if (rawEnd && !forceEnd) throw new Error('endDate 格式錯誤，請使用 yyyy-MM-dd');

  const lastRowCheck = sheetAll.getLastRow();
  let startDate = new Date('2026-01-01');
  let endDate = null;

  if (forceSingle) {
    startDate = new Date(forceSingle);
    endDate = new Date(forceSingle);
    console.log(`使用指定單日重跑: ${getFormattedDate(startDate)}`);
  } else if (forceStart || forceEnd) {
    startDate = forceStart ? new Date(forceStart) : new Date('2026-01-01');
    endDate = forceEnd ? new Date(forceEnd) : new Date();
    console.log(`使用指定區間重跑: ${getFormattedDate(startDate)} ~ ${getFormattedDate(endDate)}`);
  } else {
    if (lastRowCheck > 1) {
      const dates = sheetAll.getRange('B2:B' + lastRowCheck).getValues().flat().filter(String);
      if (dates.length > 0) {
        // 用「B 欄最大日期」決定起始日，避免部分寫入或錯位時漏跑整天（例如 02/22）
        const maxDateStr = dates.reduce(function (max, d) {
          const t = new Date(d).getTime();
          if (isNaN(t)) return max;
          return t > new Date(max).getTime() ? d : max;
        }, dates[0]);
        const lastDate = new Date(maxDateStr);
        startDate = new Date(lastDate);
        startDate.setDate(startDate.getDate() + 1); // 從最大日期的「明天」開始
      }
    }
    endDate = new Date(); // 抓到今天（含今日業績）
  }

  if (startDate > endDate) {
    if (hasManualRange) throw new Error('日期區間錯誤：startDate 不可大於 endDate');
    console.log("資料已是最新，無需更新。");
    return;
  }

  console.log(`本次預計處理區間: ${getFormattedDate(startDate)} ~ ${getFormattedDate(endDate)}`);

  // --- 2. 從 Core API 取得門店列表 ---
  function parseStoresFromStoreMap(storeMap) {
    const list = [];
    for (const info of Object.values(storeMap || {})) {
      if (info && info.saydouId) {
        list.push({
          storid: info.saydouId,
          alias: info.name || '',
          isDirect: info.isDirect === true
        });
      }
    }
    return list;
  }
  let storeRes = callCoreApi(coreApiUrl, coreApiKey, 'getLineSayDouInfoMap', {});
  let storeMap = (storeRes && storeRes.status === 'ok' && storeRes.data && typeof storeRes.data === 'object') ? storeRes.data : {};
  let stores = parseStoresFromStoreMap(storeMap);
  if (stores.length === 0) {
    callCoreApi(coreApiUrl, coreApiKey, 'clearLineStoreMapCache', {});
    storeRes = callCoreApi(coreApiUrl, coreApiKey, 'getLineSayDouInfoMap', {});
    storeMap = (storeRes && storeRes.status === 'ok' && storeRes.data && typeof storeRes.data === 'object') ? storeRes.data : {};
    stores = parseStoresFromStoreMap(storeMap);
  }
  if (stores.length === 0) {
    var urlHint = (coreApiUrl && coreApiUrl.indexOf('/exec') !== -1) ? coreApiUrl.replace(/\?.*$/, '') : coreApiUrl || '(未設定)';
    throw new Error(
      'Core API getLineSayDouInfoMap 回傳 0 筆店家，無法產出日報。目前呼叫的 API：' + urlHint + '\n\n請在「日報表 產出」專案「專案設定」→「指令碼屬性」將 PAO_CAT_CORE_API_URL 設為（與 PaoMao_Core 管理部署一致）：\n' + CORE_API_URL_MUST_BE + '\n\n若已正確仍為 0 筆，請在 PaoMao_Core 專案執行 clearMyCache 清除快取，並確認「店家基本資料」試算表 F 欄有 SayDou 店號。'
    );
  }
  console.log(`取得店家數: ${stores.length}`);

  /**
   * 建立「日期|店家」-> 列號(1-based) 對照表，用於重複時更新
   * B 欄：日期、C 欄：店家。getRange(row, column, numRows, numColumns)
   */
  function buildDateStoreRowMap(sheet) {
    const map = {};
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return map;
    const numRows = lastRow - 2 + 1; // 第 2 列～lastRow 共幾列
    const data = sheet.getRange(2, 2, numRows, 2).getValues(); // B、C 兩欄（numColumns=2）
    for (let r = 0; r < data.length; r++) {
      const dateVal = data[r][0];   // B 欄：日期
      const storeVal = data[r][1];  // C 欄：店家
      const dateStr = dateVal != null ? (typeof dateVal === 'object' && dateVal.getTime ? Utilities.formatDate(dateVal, timeZone, 'yyyy-MM-dd') : String(dateVal).trim()) : '';
      const storeStr = storeVal != null ? String(storeVal).trim() : '';
      if (dateStr && storeStr) map[dateStr + '|' + storeStr] = r + 2; // 列號 1-based，資料從第 2 列起
    }
    return map;
  }

  let rowMapAll = buildDateStoreRowMap(sheetAll);
  let rowMapDirect = buildDateStoreRowMap(sheetDirect);

  // --- 3. 逐日執行並寫入 (關鍵修改區) ---
  
  let currentDate = new Date(startDate);

  while (currentDate <= endDate) {
    const dateStr = getFormattedDate(currentDate);
    console.log(`🔄 [${dateStr}] 開始抓取...`);

    // 每一天都重新建立暫存陣列，跑完一天就清空
    let dailyAllRows = [];
    let dailyDirectRows = [];

    // 平行打 API：每批 FETCH_BATCH_SIZE 個，避免超過 GAS 並發限制
    for (let batchStart = 0; batchStart < stores.length; batchStart += FETCH_BATCH_SIZE) {
      const batch = stores.slice(batchStart, batchStart + FETCH_BATCH_SIZE);
      const requests = batch.map(function (store) {
        const url = buildCoreApiUrl(coreApiUrl, coreApiKey, 'fetchDailyIncome', { date: dateStr, storeId: String(store.storid) });
        return url ? { url: url, muteHttpExceptions: true, followRedirects: true } : null;
      }).filter(Boolean);

      if (requests.length === 0) continue;

      const responses = UrlFetchApp.fetchAll(requests);

      for (let j = 0; j < responses.length; j++) {
        const store = batch[j];
        const res = responses[j];
        let dailyRes = null;
        try {
          dailyRes = JSON.parse(res.getContentText());
        } catch (e) {
          console.error(`Core API fetchDailyIncome 解析失敗 (${dateStr}, ${store.storid})`);
          continue;
        }
        const apiResponse = (dailyRes && dailyRes.status === 'ok') ? dailyRes.data : null;
        if (!apiResponse && dailyRes && dailyRes.message) {
          console.error(`Core API fetchDailyIncome 失敗 (${dateStr}, ${store.storid}): ` + dailyRes.message);
        }

        if (apiResponse && apiResponse.data && apiResponse.data.totalRow) {
          const runData = apiResponse.data.totalRow;

          const cashTotal = runData.sum_paymentMethod?.[0]?.total || 0;
          const cashBusiness = runData.cashpay?.business || 0;
          const cashUnearn = runData.cashpay?.unearn || 0;
          const lineTotal = runData.sum_paymentMethod?.[2]?.total || 0;
          const transferTotal = runData.sum_paymentMethod?.[9]?.total || 0;
          const thirdPayTotal = lineTotal + transferTotal;
          const lineRecord = runData.paymentMethod?.[2]?.total || 0;
          const transferRecord = runData.paymentMethod?.[9]?.total || 0;
          const transferUnearn = transferTotal - transferRecord;
          const lineUnearn = lineTotal - lineRecord;
          const todayService = runData.businessIncome?.service ?? 0;

          const rowData = [
            dateStr,
            store.alias,
            cashTotal,
            cashBusiness,
            cashUnearn,
            thirdPayTotal,
            transferRecord,
            lineRecord,
            transferUnearn,
            lineUnearn,
            todayService
          ];

          dailyAllRows.push(rowData);
          if (store.isDirect === true) {
            dailyDirectRows.push(rowData);
          }
        }
      }
    }

    // --- 4. 寫入當天資料：日期+店家重複則更新，否則新增 ---
    
    // B~L 共 11 欄：日期、店家、9 個數值欄（與標題列對齊）。getRange(row, column, numRows, numColumns)
    const startCol = 2;   // B 欄
    const numCols = 11;   // B~L

    // (A) 全門市：拆成「要更新」與「要新增」
    if (dailyAllRows.length > 0) {
      const toUpdateAll = [];
      const toAppendAll = [];
      for (const row of dailyAllRows) {
        const key = row[0] + '|' + (row[1] != null ? String(row[1]).trim() : '');
        const existingRow = rowMapAll[key];
        if (existingRow) {
          toUpdateAll.push({ rowIndex: existingRow, row: row });
        } else {
          toAppendAll.push(row);
        }
      }
      for (const { rowIndex, row } of toUpdateAll) {
        sheetAll.getRange(rowIndex, startCol, 1, numCols).setValues([row]);
      }
      if (toAppendAll.length > 0) {
        const lastRowAll = sheetAll.getLastRow();
        const startRow = lastRowAll + 1;
        sheetAll.getRange(startRow, startCol, toAppendAll.length, numCols).setValues(toAppendAll);
        for (let i = 0; i < toAppendAll.length; i++) {
          rowMapAll[toAppendAll[i][0] + '|' + (toAppendAll[i][1] != null ? String(toAppendAll[i][1]).trim() : '')] = startRow + i;
        }
      }
    }

    // (B) 直營店：同上
    if (dailyDirectRows.length > 0) {
      const toUpdateDirect = [];
      const toAppendDirect = [];
      for (const row of dailyDirectRows) {
        const key = row[0] + '|' + (row[1] != null ? String(row[1]).trim() : '');
        const existingRow = rowMapDirect[key];
        if (existingRow) {
          toUpdateDirect.push({ rowIndex: existingRow, row: row });
        } else {
          toAppendDirect.push(row);
        }
      }
      for (const { rowIndex, row } of toUpdateDirect) {
        sheetDirect.getRange(rowIndex, startCol, 1, numCols).setValues([row]);
      }
      if (toAppendDirect.length > 0) {
        const lastRowDirect = sheetDirect.getLastRow();
        const startRow = lastRowDirect + 1;
        sheetDirect.getRange(startRow, startCol, toAppendDirect.length, numCols).setValues(toAppendDirect);
        for (let i = 0; i < toAppendDirect.length; i++) {
          rowMapDirect[toAppendDirect[i][0] + '|' + (toAppendDirect[i][1] != null ? String(toAppendDirect[i][1]).trim() : '')] = startRow + i;
        }
      }
    }

    // (C) 強制儲存 (關鍵！)
    SpreadsheetApp.flush(); 
    
    console.log(`✅ [${dateStr}] 寫入完成 (全門市:${dailyAllRows.length}筆 / 直營:${dailyDirectRows.length}筆)`);

    // --- 5. 進入下一天 ---
    currentDate.setDate(currentDate.getDate() + 1);
  }

  console.log("所有作業完成！");
}

/**
 * 單店日帳產出設定
 * - storeNameMatch: 店家名稱關鍵字（用 indexOf 比對 getLineSayDouInfoMap 的 name，來自「店家基本資料」試算表）
 * - sheetName: 工作表名稱
 * 要一次抓多間店：在陣列新增項目即可，例如 { storeNameMatch: 'XX店', sheetName: '營收報表_XX' }
 */
var STORE_DAILY_REPORT_CONFIG = [
  { storeNameMatch: '楊梅金山', sheetName: '營收報表_楊梅金山' }
];

/** 選單用：只補跑 2026-02-22 當天日報 */
function runAccNeedDate20260222() {
  runAccNeed({ date: '2026-02-22' });
}

/**
 * 單店日帳報表（可多店）
 * 用「店家名稱」比對（storeNameMatch 對 getLineSayDouInfoMap 的 name 做 indexOf）。
 * 平行拉取多天（每批 FETCH_BATCH_SIZE 天），每跑一天 append 進對應 sheet，持續跑到今天。
 * 若逾時當機，下次執行會從各 sheet 最後一天續跑。
 */
function runYangmeiJinshanDailyReport() {
  const adminRes = callGcpAdmin_('runDailyReport', { storeHint: 'yangmei-jinshan' });
  if (adminRes && adminRes.status) {
    SpreadsheetApp.getUi().alert(
      adminRes.status === 'ok'
        ? '已送出 GCP 單店日帳工作（請至 Cloud Run Logs/Jobs 查看進度）'
        : 'GCP 執行失敗：' + (adminRes.message || 'unknown'),
    );
    return;
  }
  const START_DATE_STR = '2025-03-01';

  const { url: coreApiUrl, key: coreApiKey, useApi } = getCoreApiParams();
  if (!useApi) {
    throw new Error('請在指令碼屬性設定 PAO_CAT_CORE_API_URL 與 PAO_CAT_SECRET_KEY。');
  }

  const DAILY_REPORT_SS_ID_FALLBACK = '1ZMutegYTLZ51XQHCbfFZ7-iAj1qTZGgSo5VTThXPQ5U';
  const configRes = callCoreApi(coreApiUrl, coreApiKey, 'getCoreConfig', {});
  let ssId = (configRes && configRes.status === 'ok' && configRes.data && configRes.data.DAILY_ACCOUNT_REPORT_SS_ID)
    ? String(configRes.data.DAILY_ACCOUNT_REPORT_SS_ID).trim()
    : '';
  if (!ssId) ssId = DAILY_REPORT_SS_ID_FALLBACK;
  if (!ssId) {
    throw new Error('Core API getCoreConfig 未回傳 DAILY_ACCOUNT_REPORT_SS_ID。');
  }

  const storeRes = callCoreApi(coreApiUrl, coreApiKey, 'getLineSayDouInfoMap', {});
  const storeMap = (storeRes && storeRes.status === 'ok' && storeRes.data && typeof storeRes.data === 'object') ? storeRes.data : {};

  const externalSs = SpreadsheetApp.openById(ssId);
  const timeZone = externalSs.getSpreadsheetTimeZone();
  const getFormattedDate = (date) => Utilities.formatDate(date, timeZone, 'yyyy-MM-dd');

  const HEADERS = ['日期', '店家', '現金總額', '消費紀錄(現金)', '儲值(現金)', '第三方總額', '轉帳入帳', 'LINE入帳', '轉帳未收', 'LINE未收', '今日業績'];

  function parseRunDataToRow(dateStr, alias, runData) {
    if (!runData) return [dateStr, alias, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    return [
      dateStr, alias,
      runData.sum_paymentMethod?.[0]?.total || 0,
      runData.cashpay?.business || 0,
      runData.cashpay?.unearn || 0,
      (runData.sum_paymentMethod?.[2]?.total || 0) + (runData.sum_paymentMethod?.[9]?.total || 0),
      runData.paymentMethod?.[9]?.total || 0,
      runData.paymentMethod?.[2]?.total || 0,
      (runData.sum_paymentMethod?.[9]?.total || 0) - (runData.paymentMethod?.[9]?.total || 0),
      (runData.sum_paymentMethod?.[2]?.total || 0) - (runData.paymentMethod?.[2]?.total || 0),
      runData.businessIncome?.service ?? 0
    ];
  }

  let totalProcessed = 0;
  const completedSheets = [];

  for (const cfg of STORE_DAILY_REPORT_CONFIG) {
    const targetStore = (function () {
      for (const info of Object.values(storeMap)) {
        if (info && info.saydouId && (info.name || '').indexOf(cfg.storeNameMatch) >= 0) {
          return { storid: info.saydouId, alias: info.name || cfg.storeNameMatch };
        }
      }
      return null;
    })();
    if (!targetStore) {
      console.warn('找不到店家「' + cfg.storeNameMatch + '」，跳過。');
      continue;
    }

    let sheet = externalSs.getSheetByName(cfg.sheetName);
    if (!sheet) sheet = externalSs.insertSheet(cfg.sheetName);
    if (sheet.getLastRow() < 1) {
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    }

    const minStartDate = new Date(START_DATE_STR);
    let nextDate;
    if (sheet.getLastRow() >= 2) {
      const lastDateVal = sheet.getRange(sheet.getLastRow(), 1).getValue();
      const lastDateStr = lastDateVal != null ? (typeof lastDateVal === 'object' && lastDateVal.getTime ? getFormattedDate(lastDateVal) : String(lastDateVal).trim()) : '';
      if (lastDateStr) {
        const lastDate = new Date(lastDateStr);
        nextDate = new Date(lastDate);
        nextDate.setDate(nextDate.getDate() + 1);
      }
    }
    if (!nextDate || nextDate < minStartDate) {
      nextDate = new Date(minStartDate);
    }

    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (nextDate > today) {
      completedSheets.push({ name: cfg.sheetName, sheet: sheet });
      continue;
    }

    // --- 平行拉取：每批 FETCH_BATCH_SIZE 天 ---
    let currentDate = new Date(nextDate);
    let processed = 0;

    while (currentDate <= today) {
      const dateBatch = [];
      let batchDate = new Date(currentDate);
      for (let i = 0; i < FETCH_BATCH_SIZE && batchDate <= today; i++) {
        dateBatch.push({ date: new Date(batchDate), dateStr: getFormattedDate(batchDate) });
        batchDate.setDate(batchDate.getDate() + 1);
      }

      const requests = dateBatch.map(function (d) {
        const url = buildCoreApiUrl(coreApiUrl, coreApiKey, 'fetchDailyIncome', { date: d.dateStr, storeId: String(targetStore.storid) });
        return url ? { url: url, muteHttpExceptions: true, followRedirects: true } : null;
      }).filter(Boolean);

      if (requests.length === 0) break;

      const responses = UrlFetchApp.fetchAll(requests);
      const rowsToAppend = [];

      for (let j = 0; j < responses.length; j++) {
        const d = dateBatch[j];
        let dailyRes = null;
        try {
          dailyRes = JSON.parse(responses[j].getContentText());
        } catch (e) {}
        const apiResponse = (dailyRes && dailyRes.status === 'ok') ? dailyRes.data : null;
        const runData = (apiResponse && apiResponse.data && apiResponse.data.totalRow) ? apiResponse.data.totalRow : null;
        rowsToAppend.push(parseRunDataToRow(d.dateStr, targetStore.alias, runData));
      }

      if (rowsToAppend.length > 0) {
        const startRow = sheet.getLastRow() + 1;
        sheet.getRange(startRow, 1, startRow + rowsToAppend.length - 1, HEADERS.length).setValues(rowsToAppend);
        SpreadsheetApp.flush();
        processed += rowsToAppend.length;
      }

      currentDate = new Date(batchDate);
    }

    totalProcessed += processed;
    completedSheets.push({ name: cfg.sheetName, sheet: sheet });
  }

  const excelUrl = completedSheets.length > 0
    ? 'https://docs.google.com/spreadsheets/d/' + ssId + '/export?format=xlsx&gid=' + completedSheets[0].sheet.getSheetId()
    : '';
  try {
    const ui = SpreadsheetApp.getUi();
    if (ui) ui.alert('單店日帳已完成，共寫入 ' + totalProcessed + ' 筆。\n\n下載 Excel：\n' + excelUrl);
  } catch (e) {}
}

/**
 * 呼叫 Core API 取得員工業績月報資料（不寫入，僅回傳 rows）
 * @param {string} startYm - 起始月份，如 '2025-01'
 * @param {string} endYm - 結束月份，如 '2025-01'
 * @returns {{ status: string, data?: { rows: Array, months: Array }, _debug?: string }}
 */
function callEmployeeMonthlyReportFetchData(startYm, endYm) {
  const { url: coreApiUrl, key: coreApiKey, useApi } = getCoreApiParams();
  if (!useApi) {
    Logger.log('[員工業績月報] ✗ callEmployeeMonthlyReportFetchData: 未設定 Core API');
    return { status: 'error', message: '請在指令碼屬性設定 PAO_CAT_CORE_API_URL 與 PAO_CAT_SECRET_KEY。' };
  }
  const sep = coreApiUrl.indexOf('?') >= 0 ? '&' : '?';
  const q = sep + 'key=' + encodeURIComponent(coreApiKey) + '&action=employeeMonthlyPerformanceReport&mode=fetchData&startYm=' + encodeURIComponent(startYm || '') + '&endYm=' + encodeURIComponent(endYm || '');
  const fullUrl = coreApiUrl + q;
  Logger.log('[員工業績月報] 呼叫 Core API fetchData startYm=' + startYm + ' endYm=' + endYm);
  try {
    const res = UrlFetchApp.fetch(fullUrl, {
      muteHttpExceptions: true,
      followRedirects: true,
      timeout: 330000
    });
    const code = res.getResponseCode();
    const text = res.getContentText() || '{}';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      Logger.log('[員工業績月報] ✗ Core API 回傳非 JSON，前 200 字: ' + text.substring(0, 200));
      return { status: 'error', message: 'Core API 回傳非 JSON', _debug: text.substring(0, 300) };
    }
    if (code >= 400) {
      Logger.log('[員工業績月報] ✗ Core API HTTP ' + code + ': ' + (parsed.message || parsed._debug || text.substring(0, 150)));
      return { status: 'error', message: parsed.message || 'API 錯誤', _debug: 'code=' + code };
    }
    const rowCount = (parsed.data && parsed.data.rows) ? parsed.data.rows.length : 0;
    Logger.log('[員工業績月報] Core API 回傳 ok, rows=' + rowCount);
    return parsed;
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    const isTimeout = /timeout|timed out|deadline/i.test(msg);
    Logger.log('[員工業績月報] ✗ Core API 連線失敗: ' + msg);
    return {
      status: 'error',
      message: isTimeout ? 'Core API 逾時（SayDou 拉取較慢，請稍後重試或檢查 PaoMao_Core 執行紀錄）' : msg,
      _debug: 'fetch failed: ' + msg
    };
  }
}

/**
 * 呼叫 Core API 產出員工業績月報表（舊流程，Core 寫入試算表）
 * @param {string} mode - 'full' | 'lastMonth' | 'estimate'
 * @param {number} batchSize - full 時每次處理月份數
 * @param {string[]} processedMonths - 已處理月份
 */
function callEmployeeMonthlyReportApi(mode, batchSize, processedMonths) {
  const { url: coreApiUrl, key: coreApiKey, useApi } = getCoreApiParams();
  if (!useApi) {
    return { status: 'error', message: '請在指令碼屬性設定 PAO_CAT_CORE_API_URL 與 PAO_CAT_SECRET_KEY。' };
  }
  const sep = coreApiUrl.indexOf('?') >= 0 ? '&' : '?';
  let q = sep + 'key=' + encodeURIComponent(coreApiKey) + '&action=employeeMonthlyPerformanceReport&mode=' + encodeURIComponent(mode || 'lastMonth') + '&batchSize=' + encodeURIComponent(String(batchSize || 3));
  if (processedMonths && Array.isArray(processedMonths) && processedMonths.length > 0) {
    q += '&processedMonths=' + encodeURIComponent(processedMonths.join(','));
  }
  const fullUrl = coreApiUrl + q;
  const urlForLog = (coreApiUrl || '').replace(/\/exec.*/, '/exec') + '?action=employeeMonthlyPerformanceReport&mode=' + (mode || 'lastMonth') + '&batchSize=' + (batchSize || 1);
  try {
    const res = UrlFetchApp.fetch(fullUrl, {
      muteHttpExceptions: true,
      followRedirects: true,
      timeout: 300000 // 5 分鐘
    });
    const code = res.getResponseCode();
    const text = res.getContentText();
    try {
      const parsed = JSON.parse(text);
      if (code >= 400) {
        return {
          status: 'error',
          message: 'Core API HTTP ' + code + ': ' + (parsed.message || text.slice(0, 200)),
          _debug: 'code=' + code + ' body=' + text.slice(0, 500)
        };
      }
      return parsed;
    } catch (parseErr) {
      return {
        status: 'error',
        message: 'Core API 回傳非 JSON (HTTP ' + code + '): ' + (parseErr && parseErr.message ? parseErr.message : ''),
        _debug: 'code=' + code + ' body=' + (text ? text.slice(0, 500) : '(空)')
      };
    }
  } catch (e) {
    const errMsg = (e && e.message) ? e.message : String(e);
    return {
      status: 'error',
      message: 'Core API 連線失敗: ' + errMsg,
      _debug: 'url=' + (fullUrl ? fullUrl.slice(0, 80) + '...' : '') + ' error=' + errMsg
    };
  }
}

/** 員工業績月報表試算表 ID（泡泡貓日報表），可於指令碼屬性 DAILY_ACCOUNT_REPORT_SS_ID 覆寫 */
function getEmployeeMonthlyReportSsId() {
  const p = PropertiesService.getScriptProperties().getProperty('DAILY_ACCOUNT_REPORT_SS_ID');
  return (p && p.trim()) ? p.trim() : '1ZMutegYTLZ51XQHCbfFZ7-iAj1qTZGgSo5VTThXPQ5U';
}
var EMPLOYEE_MONTHLY_REPORT_SHEET_GID = 833948053;
var EMPLOYEE_MONTHLY_REPORT_SHEET_NAME = '員工業績月報';
var EMPLOYEE_MONTHLY_REPORT_HEADERS = ['月份', '員工編號', '員工姓名', '所屬店家', '業績金額'];

/**
 * 從試算表讀取既有月份（以表中資料為準，不依賴暫存）
 * @returns {string[]} 既有月份陣列，如 ['2025-01','2025-02',...]
 */
function getEmployeeMonthlyReportExistingMonthsFromSheet() {
  try {
    const ss = SpreadsheetApp.openById(getEmployeeMonthlyReportSsId());
    let sheet = ss.getSheetById(EMPLOYEE_MONTHLY_REPORT_SHEET_GID);
    if (!sheet) sheet = ss.getSheetByName(EMPLOYEE_MONTHLY_REPORT_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return [];
    const lr = sheet.getLastRow();
    const vals = sheet.getRange('A2:A' + lr).getValues();
    const seen = {};
    const allMonths = [];
    for (let i = 0; i < vals.length; i++) {
      let m = '';
      const v = vals[i][0];
      if (v instanceof Date) {
        m = Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM');
      } else if (v != null && v !== '') {
        m = String(v).trim().replace(/\//g, '-');
        if (/^\d{4}-\d$/.test(m)) m = m.slice(0, 5) + '0' + m.slice(5);
      }
      if (m && /^\d{4}-\d{2}$/.test(m) && !seen[m]) {
        seen[m] = true;
        allMonths.push(m);
      }
    }
    return allMonths.sort();
  } catch (e) {
    Logger.log('[員工業績月報] 讀取試算表既有月份失敗: ' + (e && e.message ? e.message : e));
    return [];
  }
}

/**
 * 取得員工業績月報表試算表
 */
function getEmployeeMonthlyReportSheet_() {
  const ss = SpreadsheetApp.openById(getEmployeeMonthlyReportSsId());
  if (!ss) return null;
  const sheet = ss.getSheetById(EMPLOYEE_MONTHLY_REPORT_SHEET_GID) || ss.getSheetByName(EMPLOYEE_MONTHLY_REPORT_SHEET_NAME);
  if (!sheet) {
    const newSheet = ss.insertSheet(EMPLOYEE_MONTHLY_REPORT_SHEET_NAME);
    newSheet.getRange(1, 1, 1, EMPLOYEE_MONTHLY_REPORT_HEADERS.length).setValues([EMPLOYEE_MONTHLY_REPORT_HEADERS]);
    newSheet.getRange(1, 1, 1, EMPLOYEE_MONTHLY_REPORT_HEADERS.length).setFontWeight('bold');
    return newSheet;
  }
  return sheet;
}

/**
 * 將 Core API 回傳的 rows 寫入試算表（本地執行，資料不失準）
 * 以 月份-員工編號 為 key：已存在則更新該列，否則 append
 * @param {Array} rows - [[月份, 員工編號, 員工姓名, 所屬店家, 業績金額], ...]
 * @param {string[]} replaceMonths - 已棄用，保留相容；一律以 key 更新不刪除
 */
function writeEmployeeMonthlyReportRowsToSheet(rows, replaceMonths) {
  try {
    const sheet = getEmployeeMonthlyReportSheet_();
    if (!sheet) {
      Logger.log('[員工業績月報] ✗ writeEmployeeMonthlyReportRowsToSheet: 無法取得工作表');
      return { ok: false, message: '無法取得工作表' };
    }
    const numCols = EMPLOYEE_MONTHLY_REPORT_HEADERS.length;
    let lastRow = sheet.getLastRow();
    let existingKeyToRow = {};

    if (lastRow >= 2) {
      const numDataRows = lastRow - 1;
      const values = sheet.getRange(2, 1, numDataRows, numCols).getValues();
      for (let i = 0; i < values.length; i++) {
        const m = (values[i][0] != null) ? String(values[i][0]).trim() : '';
        const code = (values[i][1] != null) ? String(values[i][1]).trim() : '';
        const key = m + '|' + code;
        existingKeyToRow[key] = i + 2;
      }
    }

    const toAppend = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const key = (row[0] || '') + '|' + (row[1] || '');
      const rowIndex = existingKeyToRow[key];
      if (rowIndex) {
        sheet.getRange(rowIndex, 1, 1, numCols).setValues([row]);
        delete existingKeyToRow[key];
      } else {
        toAppend.push(row);
      }
    }
    if (toAppend.length > 0) {
      const startRow = sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, toAppend.length, numCols).setValues(toAppend);
    }
    const sheetName = sheet.getName();
    const sheetGid = sheet.getSheetId();
    Logger.log('[員工業績月報] 寫入完成：工作表「' + sheetName + '」(gid=' + sheetGid + ')，更新 ' + (rows.length - toAppend.length) + ' 筆、新增 ' + toAppend.length + ' 筆（新資料在表格最下方，請向下捲動）');
    return { ok: true, rowCount: rows.length, updated: rows.length - toAppend.length, appended: toAppend.length };
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    Logger.log('[員工業績月報] ✗ writeEmployeeMonthlyReportRowsToSheet 例外: ' + msg);
    return { ok: false, message: msg };
  }
}

/**
 * 產出員工業績月報表（2025～現在）
 * 流程：日報表從試算表讀取既有月份 → 呼叫 Core API 取得資料 → 日報表本地寫入試算表
 * 輸出至 Logger（檢視 → 執行紀錄）
 */
function runEmployeeMonthlyReportFull() {
  const adminRes = callGcpAdmin_('runEmployeeMonthlyReport', { startYm: '2025-01' });
  if (adminRes && adminRes.status) {
    SpreadsheetApp.getUi().alert(
      adminRes.status === 'ok'
        ? '已送出 GCP 員工業績月報（Full）工作（請至 Cloud Run Logs/Jobs 查看進度）'
        : 'GCP 執行失敗：' + (adminRes.message || 'unknown'),
    );
    return;
  }
  const ts = function () { return Utilities.formatDate(new Date(), 'Asia/Taipei', 'HH:mm:ss'); };
  Logger.log('[員工業績月報] ' + ts() + ' 開始產出 2025～現在');
  const ssId = getEmployeeMonthlyReportSsId();
  Logger.log('[員工業績月報] 資料寫入：試算表 ' + ssId + ' → 工作表「' + EMPLOYEE_MONTHLY_REPORT_SHEET_NAME + '」(gid=' + EMPLOYEE_MONTHLY_REPORT_SHEET_GID + ')');
  Logger.log('[員工業績月報] 請開啟此連結查看：https://docs.google.com/spreadsheets/d/' + ssId + '/edit#gid=' + EMPLOYEE_MONTHLY_REPORT_SHEET_GID);

  const existingMonths = getEmployeeMonthlyReportExistingMonthsFromSheet();
  if (existingMonths.length > 0) {
    Logger.log('[員工業績月報] ' + ts() + ' 從試算表讀取既有月份: ' + existingMonths.join(','));
  }

  const endYm = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
  const endY = parseInt(endYm.slice(0, 4), 10);
  const endM = parseInt(endYm.slice(5, 7), 10);
  const allMonths = [];
  for (let y = 2025, m = 1; y < endY || (y === endY && m <= endM); ) {
    allMonths.push(y + '-' + (m < 10 ? '0' : '') + m);
    if (m >= 12) { m = 1; y++; } else { m++; }
  }

  const existingSet = {};
  for (let i = 0; i < existingMonths.length; i++) existingSet[existingMonths[i]] = true;

  let toProcess = [];
  for (let j = 0; j < allMonths.length; j++) {
    if (!existingSet[allMonths[j]]) toProcess.push(allMonths[j]);
  }

  const sheet = getEmployeeMonthlyReportSheet_();
  let lastMonthInSheet = null;
  if (sheet && sheet.getLastRow() >= 2) {
    const lr = sheet.getLastRow();
    const lastVal = sheet.getRange(lr, 1, 1, 1).getValues();
    let lastM = (lastVal && lastVal[0] && lastVal[0][0]) ? String(lastVal[0][0]).trim() : '';
    if (lastVal[0][0] instanceof Date) lastM = Utilities.formatDate(lastVal[0][0], 'Asia/Taipei', 'yyyy-MM');
    if (lastM && /^\d{4}-\d{2}$/.test(lastM) && allMonths.indexOf(lastM) >= 0) {
      lastMonthInSheet = lastM;
      if (toProcess.indexOf(lastMonthInSheet) === -1) toProcess.unshift(lastMonthInSheet);
      Logger.log('[員工業績月報] ' + ts() + ' 表末筆月份 ' + lastMonthInSheet + '，先重拉並以 月份-員工編號 更新');
    }
  }

  Logger.log('[員工業績月報] ' + ts() + ' 待處理 ' + toProcess.length + ' 個月: ' + (toProcess.slice(0, 5).join(',') + (toProcess.length > 5 ? '...' : '')));
  if (toProcess.length === 0) {
    Logger.log('[員工業績月報] ' + ts() + ' 無待處理月份，結束');
    return;
  }
  /** 每次最多處理月份數，避免逾時；剩餘月份下次執行會續跑 */
  const MAX_MONTHS_PER_RUN = 3;
  const toRun = toProcess.slice(0, MAX_MONTHS_PER_RUN);
  if (toProcess.length > MAX_MONTHS_PER_RUN) {
    Logger.log('[員工業績月報] 本次處理 ' + MAX_MONTHS_PER_RUN + ' 個月，剩餘 ' + (toProcess.length - MAX_MONTHS_PER_RUN) + ' 個月請再執行一次');
  }

  let totalProcessed = 0;
  let lastError = null;
  for (let round = 0; round < toRun.length; round++) {
    const ym = toRun[round];
    Logger.log('[員工業績月報] ' + ts() + ' 第 ' + (round + 1) + '/' + toRun.length + ' 批：向 Core API 取得 ' + ym + ' 資料');
    const t0 = new Date().getTime();
    const res = callEmployeeMonthlyReportFetchData(ym, ym);
    const elapsed = Math.round((new Date().getTime() - t0) / 1000);
    Logger.log('[員工業績月報] ' + ts() + ' API 回應耗時 ' + elapsed + ' 秒');

    if (res.status === 'ok' && res.data && res.data.rows) {
      const rows = res.data.rows;
      Logger.log('[員工業績月報] ' + ts() + ' 開始寫入 ' + ym + '，共 ' + rows.length + ' 筆');
      const write = writeEmployeeMonthlyReportRowsToSheet(rows, [ym]);
      if (write.ok) {
        totalProcessed++;
        Logger.log('[員工業績月報] ' + ts() + ' ✓ 已寫入 ' + ym + '（' + rows.length + ' 筆）');
      } else {
        lastError = { message: write.message || '寫入失敗' };
        Logger.log('[員工業績月報] ' + ts() + ' ✗ 寫入失敗: ' + (write.message || ''));
        break;
      }
    } else {
      lastError = res;
      Logger.log('[員工業績月報] ' + ts() + ' ✗ API 失敗 status=' + (res.status || '') + ' message=' + (res.message || '') + (res._debug ? ' _debug=' + res._debug : ''));
      break;
    }
  }
  if (lastError) {
    Logger.log('[員工業績月報] ' + ts() + ' 產出失敗: ' + lastError.message);
  } else {
    Logger.log('[員工業績月報] ' + ts() + ' 完成，共處理 ' + totalProcessed + ' 個月');
  }
}

/**
 * 產出員工業績月報表（僅上月，供排程或手動）
 * 流程：呼叫 Core API 取得上月資料 → 日報表本地寫入試算表
 */
function runEmployeeMonthlyReportLastMonth() {
  const adminRes = callGcpAdmin_('runEmployeeMonthlyReport', {});
  if (adminRes && adminRes.status) {
    SpreadsheetApp.getUi().alert(
      adminRes.status === 'ok'
        ? '已送出 GCP 員工業績月報（上月）工作（請至 Cloud Run Logs/Jobs 查看進度）'
        : 'GCP 執行失敗：' + (adminRes.message || 'unknown'),
    );
    return;
  }
  Logger.log('[員工業績月報] 開始產出上月');
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const ym = Utilities.formatDate(lastMonth, 'Asia/Taipei', 'yyyy-MM');
  const res = callEmployeeMonthlyReportFetchData(ym, ym);
  if (res.status === 'ok' && res.data && res.data.rows) {
    const write = writeEmployeeMonthlyReportRowsToSheet(res.data.rows, [ym]);
    Logger.log('[員工業績月報] ' + (write.ok ? '成功' : '失敗') + ': ' + (write.ok ? (res.data.rows.length + ' 筆') : (write.message || '')));
  } else {
    Logger.log('[員工業績月報] 失敗: ' + (res.message || '') + (res._debug ? ' | ' + res._debug : ''));
  }
}

/**
 * 【除錯用】測試員工業績月報 API，輸出至 Logger（檢視 → 執行紀錄）
 */
function debugEmployeeMonthlyReportApi() {
  const ui = SpreadsheetApp.getUi();
  const { useAdmin } = getGcpAdminParams_();
  if (useAdmin) {
    ui.alert('GCP 已接管排程與執行，請改到 Cloud Run Jobs/Logs 進行除錯。');
    return;
  }
  const now = new Date();
  const ym = Utilities.formatDate(new Date(now.getFullYear(), now.getMonth() - 1, 1), 'Asia/Taipei', 'yyyy-MM');
  const res = callEmployeeMonthlyReportFetchData(ym, ym);
  const full = 'status=' + res.status + '\nmessage=' + (res.message || '') + '\nrows=' + (res.data && res.data.rows ? res.data.rows.length : 0) + '\n\n完整 JSON:\n' + JSON.stringify(res, null, 2);
  Logger.log('[debugEmployeeMonthlyReportApi] ' + full);
}

/**
 * 建立每月 1 日觸發「員工業績月報表（上月）」的排程
 * 執行一次即可，之後每月 1 日會自動產出上月業績
 */
function setupEmployeeMonthlyReportTrigger() {
  const ui = SpreadsheetApp.getUi();
  const { useAdmin } = getGcpAdminParams_();
  if (useAdmin) {
    ui.alert('GCP 已改用 Cloud Scheduler + Cloud Run Jobs，不再需要在 GAS 建觸發。');
    return;
  }
  const triggers = ScriptApp.getProjectTriggers();
  const existing = triggers.find(function (t) {
    return t.getHandlerFunction() === 'runEmployeeMonthlyReportLastMonth';
  });
  if (existing) {
    ScriptApp.deleteTrigger(existing);
  }
  ScriptApp.newTrigger('runEmployeeMonthlyReportLastMonth')
    .timeBased()
    .onMonthDay(1)
    .atHour(8)
    .create();
  Logger.log('[員工業績月報] 已建立每月 1 日上午 8:00 觸發排程');
}