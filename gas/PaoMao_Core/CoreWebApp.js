/**
 * Core 中央 API：以 doGet / doPost 對外提供 Core 資料與函式，呼叫端以 PAO_CAT_CORE_API_URL（此專案「網路應用程式」部署網址）呼叫即可。
 *
 * 【部署】⚠️ 更新程式時請「更新既有部署」、不要「新增部署」，否則網址會變、所有 Core API 連結都要重換。
 * - 網頁：部署 → 管理部署作業 → 現有 Web App 右側「編輯」→ 版本選「新版本」→ 部署。
 * - 指令：在 gas/PaoMao_Core 執行 npm run deploy（會用 package.json 的 deploymentId 更新同一個網址）。
 * 首次才需：部署 → 新增部署 → 類型：網路應用程式，執行身分：我、誰可存取：任何人 → 部署，複製網址與 Deployment ID 到 package.json。
 *
 * 【PaoMao_Core 本專案】指令碼屬性：
 * - PAO_CAT_SECRET_KEY：密鑰（與呼叫端一致）。
 *
 * 【呼叫端】指令碼屬性：
 * - PAO_CAT_CORE_API_URL：此專案「網路應用程式」部署網址（結尾 /exec，從 部署→管理部署 複製）
 * - PAO_CAT_SECRET_KEY：與 Core 相同的密鑰
 *
 * 【doGet】查詢參數：key, action[, startDate, endDate, storeId, start, end, date]
 * - key=密鑰（必填，以下 action 除外）
 * - action=storeList：門市列表 JSON（公開，無需 key）
 * - action=token | getStoresInfo | fetchReservationData | oldNewA | fetchTodayReservationData | lastMonthTipsReport | fetchDailyIncome
 * - fetchReservationData / oldNewA：startDate, endDate, storeId
 * - fetchTodayReservationData：start, end, storeId
 * - getOdooInvoice：id（Odoo 發票/單據 ID），回傳明細陣列
 *
 * 【doPost】body JSON：{ key, action[, ...] }
 * - action=lineReply：replyToken, text, token（必填），代為呼叫 LINE Reply API
 * - action=getCustomerAIResult：phone（必填），從「客人消費狀態」試算表依手機回傳 AI分析結果（K 欄）
 * - action=executeRefundByPhone：phone（必填），依手機號碼執行儲值金退費
 * - action=issueInvoice：storeInfo, odooNumber, buyType, items（必填），代為開立 B2B 發票，回傳 Giveme 結果
 *
 * ⚠️ 若呼叫端出現「未知 action」→ 請在「PaoMao_Core」專案重新部署 Web App（部署 → 管理部署 → 編輯 → 版本：新版本 → 部署）。
 */

function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};
  var action = (params.action != null) ? String(params.action).trim() : "";
  if (action === "reportHtml") {
    return HtmlService.createHtmlOutputFromFile("odoo_report");
  }
  if (action === "near") {
    return actionNearRedirect(params);
  }
  if (action === "nearRecord") {
    return actionNearRecord(params);
  }
  if (action === "nearHit") {
    return actionNearHit(params);
  }
  if (action === "consumeReportToken") {
    return actionConsumeReportToken(params);
  }
  if (action === "submitReportShare") {
    return actionSubmitReportShare(params);
  }
  if (action === "getReportByDate") {
    return actionGetReportByDate(params);
  }
  if (action === "storeList") {
    return actionStoreList();
  }
  return handleRequest(params, "GET");
}

function doPost(e) {
  var params = {};
  if (e && e.postData && e.postData.contents) {
    try {
      params = JSON.parse(e.postData.contents);
    } catch (err) {
      return jsonOut({ status: "error", message: "JSON 解析失敗" });
    }
  }
  return handleRequest(params, "POST");
}

function handleRequest(params, method) {
  var key = (params.key != null) ? String(params.key).trim() : "";
  var expected = "";
  try {
    expected = PropertiesService.getScriptProperties().getProperty("PAO_CAT_SECRET_KEY") || "";
    expected = expected.trim();
  } catch (err) {
    return jsonOut({ status: "error", message: "config" });
  }
  if (!expected || key !== expected) {
    return jsonOut({ status: "error", message: "unauthorized" });
  }

  var action = (params.action != null) ? String(params.action).trim() : "";
  if (!action) {
    action = "token";
  }

  try {
    switch (action) {
      case "token":
        return tokenResponse();
      case "getStoresInfo":
        return actionGetStoresInfo();
      case "fetchReservationData":
        return actionFetchReservationData(params);
      case "oldNewA":
        return actionOldNewA(params);
      case "fetchTodayReservationData":
        return actionFetchTodayReservationData(params);
      case "fetchDailyIncome":
        return actionFetchDailyIncome(params);
      case "lineReply":
        return actionLineReply(params);
      case "getCustomerAIResult":
        return actionGetCustomerAIResult(params);
      case "getCoreConfig":
        return actionGetCoreConfig();
      case "getLineSayDouInfoMap":
        return jsonOut({ status: "ok", data: getLineSayDouInfoMap() });
      case "lastMonthTipsReport":
        return actionLastMonthTipsReport(params);
      case "syncLastMonthTipsConsolidated":
        return actionSyncLastMonthTipsConsolidated();
      case "getOdooInvoice":
        return actionGetOdooInvoice(params);
      case "issueInvoice":
        return actionIssueInvoice(params);
      case "createReportToken":
        return actionCreateReportToken(params);
      case "findAvailableSlots":
        return actionFindAvailableSlots(params);
      case "debugLineStoreMap":
        return jsonOut({ status: "ok", data: debugLineStoreMap() });
      case "getDirectStoreReplyStatusText":
        var directRes = (typeof getDirectStoreReplyStatusText === "function") ? getDirectStoreReplyStatusText() : { ok: false, message: "功能未就緒" };
        return jsonOut(directRes.ok ? { status: "ok", ok: true, text: directRes.text } : { status: "error", ok: false, message: directRes.message || "取得失敗" });
      case "getUserDisplayName":
        return actionGetUserDisplayName(params);
      case "executeRefundByPhone":
        return actionExecuteRefundByPhone(params);
      case "employeeMonthlyPerformanceReport":
        return actionEmployeeMonthlyPerformanceReport(params);
      default:
        return jsonOut({ status: "error", message: "未知 action: " + action });
    }
  } catch (err) {
    return jsonOut({ status: "error", message: (err && err.message) ? err.message : String(err) });
  }
}

// Debug helper: 直接讀取店家基本資料（不走快取）
function debugLineStoreMap() {
  var out = {
    time: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"),
    lineStoreSsId: LINE_STORE_SS_ID || "",
    sheetId: 72760104,
    sheetName: "",
    lastRow: 0,
    total: 0,
    sample: [],
    error: ""
  };
  try {
    var ss = SpreadsheetApp.openById(LINE_STORE_SS_ID);
    var sheet = ss.getSheetById(72760104) || ss.getSheetByName("店家基本資料");
    if (!sheet) {
      out.error = "sheet not found";
      return out;
    }
    out.sheetName = sheet.getName();
    out.lastRow = sheet.getLastRow();
    if (out.lastRow >= 2) {
      var data = sheet.getRange("A2:I" + out.lastRow).getValues();
      data.forEach(function (row) {
        var saydouId = row[5];
        if (saydouId != null && String(saydouId).trim() !== "") {
          var sId = String(saydouId).trim();
          out.total++;
          if (out.sample.length < 20) {
            out.sample.push({ saydouId: sId, name: String(row[1] || "").trim() });
          }
        }
      });
    }
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  }
  return out;
}

function tokenResponse() {
  var token = "";
  try {
    token = getBearerTokenFromSheet();
  } catch (err) {
    return ContentService.createTextOutput("Error: " + (err && err.message ? err.message : "token")).setMimeType(ContentService.MimeType.TEXT);
  }
  return ContentService.createTextOutput(token || "").setMimeType(ContentService.MimeType.TEXT);
}

function actionGetStoresInfo() {
  var stores = getStoresInfo();
  var out = (stores || []).map(function (s) {
    return {
      id: s.id,
      name: s.name,
      totalStaff: s.totalStaff,
      isDirect: s.isDirect,
      validStaffSet: (s.validStaffSet && typeof s.validStaffSet.forEach !== "undefined") ? Array.from(s.validStaffSet) : []
    };
  });
  return jsonOut({ status: "ok", data: out });
}

function actionFetchReservationData(params) {
  var startDate = params.startDate;
  var endDate = params.endDate;
  var storeId = params.storeId;
  if (startDate == null || endDate == null || storeId == null) {
    return jsonOut({ status: "error", message: "缺少 startDate, endDate 或 storeId" });
  }
  var data = fetchReservationData(startDate, endDate, String(storeId));
  return jsonOut({ status: "ok", data: data });
}

function actionOldNewA(params) {
  var startDate = params.startDate;
  var endDate = params.endDate;
  var storeId = params.storeId;
  if (startDate == null || endDate == null || storeId == null) {
    return jsonOut({ status: "error", message: "缺少 startDate, endDate 或 storeId" });
  }
  var data = oldNewA(startDate, endDate, String(storeId));
  return jsonOut({ status: "ok", data: data });
}

function actionFetchTodayReservationData(params) {
  var start = params.start;
  var end = params.end;
  var storeId = params.storeId;
  if (start == null || end == null || storeId == null) {
    return jsonOut({ status: "error", message: "缺少 start, end 或 storeId" });
  }
  var data = fetchTodayReservationData(start, end, String(storeId));
  return jsonOut({ status: "ok", data: data });
}

/**
 * 透過 Core Web App 對外提供「單店單日營收」查詢，供「日報表 產出」等專案呼叫。
 * 參數：date（yyyy-MM-dd）、storeId
 */
function actionFetchDailyIncome(params) {
  var date = params.date;
  var storeId = params.storeId;
  if (date == null || storeId == null) {
    return jsonOut({ status: "error", message: "缺少 date 或 storeId" });
  }
  var data = fetchDailyIncome(String(date), String(storeId));
  return jsonOut({ status: "ok", data: data });
}

/**
 * Core API：查詢店家可預約時段
 * GET: ?key=密鑰&action=findAvailableSlots&sayId=...&startDate=yyyy-MM-dd&endDate=yyyy-MM-dd
 * 可選：needPeople, durationMin, weekDays(JSON), timeStart, timeEnd, token
 */
function actionFindAvailableSlots(params) {
  var sayId = params.sayId;
  var startDate = params.startDate;
  var endDate = params.endDate;
  if (sayId == null || startDate == null || endDate == null) {
    return jsonOut({ status: "error", message: "缺少 sayId, startDate 或 endDate" });
  }
  var needPeople = (params.needPeople != null && params.needPeople !== "") ? Number(params.needPeople) : 1;
  var durationMin = (params.durationMin != null && params.durationMin !== "") ? Number(params.durationMin) : 90;
  var options = {};
  if (params.weekDays != null && params.weekDays !== "") {
    try {
      options.weekDays = (typeof params.weekDays === "string") ? JSON.parse(params.weekDays) : params.weekDays;
    } catch (e) {
      return jsonOut({ status: "error", message: "weekDays 解析失敗" });
    }
  }
  if (params.timeStart != null && params.timeStart !== "") options.timeStart = String(params.timeStart);
  if (params.timeEnd != null && params.timeEnd !== "") options.timeEnd = String(params.timeEnd);
  if (params.token != null && params.token !== "") options.token = String(params.token);
  try {
    var result = findAvailableSlots(String(sayId), String(startDate), String(endDate), needPeople, durationMin, options);
    return jsonOut({ status: "ok", result: result });
  } catch (err) {
    return jsonOut({ status: "error", message: (err && err.message) ? err.message : String(err) });
  }
}

/**
 * 將任意手機字串正規成「後 9 碼」供比對（支援全形數字、試算表頭前去 0）
 */
function toPhoneNorm9(str) {
  if (str == null || str === "") return "";
  var s = String(str);
  s = s.replace(/[\uFF10-\uFF19]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  return s.replace(/\D/g, "").slice(-9);
}

/**
 * 上月小費：產出試算表連結（同月同人重用）。有紀錄則回傳既有 url，無則建新試算表並寫入請求紀錄表。
 * 管理者：傳 managedStoreIds（逗號分隔）、userId，篩選負責店家。
 * 員工：傳 employeeCode、userId，篩選消費備註 lowercase 含該員工編號的列。
 * 參數：managedStoreIds（選填）、employeeCode（選填）、userId（必填）
 */
function actionLastMonthTipsReport(params) {
  if (typeof getOrCreateLastMonthTipsSheet !== "function") {
    return jsonOut({ status: "error", message: "getOrCreateLastMonthTipsSheet 未定義（請確認 TipsReport.js 已加入專案）" });
  }
  var idsParam = (params && params.managedStoreIds != null) ? String(params.managedStoreIds).trim() : "";
  var managedStoreIds = idsParam ? idsParam.split(",").map(function (s) { return s.trim(); }).filter(Boolean) : [];
  var employeeCode = (params && params.employeeCode != null) ? String(params.employeeCode).trim() : "";
  var userId = (params && params.userId != null) ? String(params.userId).trim() : "";
  if (!userId) {
    return jsonOut({ ok: false, message: "請提供 userId（LINE 使用者 ID）" });
  }
  var result = getOrCreateLastMonthTipsSheet({ managedStoreIds: managedStoreIds, employeeCode: employeeCode, userId: userId });
  if (result.ok) {
    return jsonOut({ ok: true, url: result.url, cached: result.cached === true, rowCount: result.rowCount, shareWarning: result.shareWarning || undefined });
  }
  return jsonOut({ ok: false, message: result.message || "未知錯誤" });
}

/**
 * 每月 2 號觸發：把上個月問卷 A:M + 消費／儲值金同步到小費統整表。
 */
function actionSyncLastMonthTipsConsolidated() {
  if (typeof syncLastMonthQuestionnaireToConsolidated !== "function") {
    return jsonOut({ status: "error", message: "syncLastMonthQuestionnaireToConsolidated 未定義（請確認 TipsReport.js 已加入專案）" });
  }
  var result = syncLastMonthQuestionnaireToConsolidated();
  return jsonOut(result);
}

function actionGetCustomerAIResult(params) {
  var phone = (params.phone != null) ? String(params.phone).trim() : "";
  if (!phone) {
    return jsonOut({ status: "error", message: "請提供 phone 參數" });
  }
  var config = getCoreConfig();
  var ssId = (config && config.LINE_STORE_SS_ID) ? config.LINE_STORE_SS_ID : "";
  if (!ssId) {
    return jsonOut({ status: "error", message: "Core 未設定 LINE_STORE_SS_ID" });
  }
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName("客人消費狀態");
    if (!sheet) {
      return jsonOut({ status: "error", message: "找不到「客人消費狀態」工作表" });
    }
    var data = sheet.getDataRange().getValues();
    if (data.length < 1) {
      return jsonOut({ status: "error", message: "查無此客人（" + phone + "）。" });
    }
    var header = data[0];
    var phoneCol = 1;
    var aiResultCol = 10;
    for (var c = 0; c < header.length; c++) {
      var h = String(header[c] || "").trim();
      if (h === "手機") phoneCol = c;
      if (h === "AI分析結果") aiResultCol = c;
    }
    var phoneNorm9 = toPhoneNorm9(phone);
    for (var i = 0; i < data.length; i++) {
      var rowPhone = data[i][phoneCol];
      if (rowPhone == null) continue;
      var rowStr = String(rowPhone).trim();
      if (rowStr === "手機" || rowStr === "時間") continue;
      var rowPhoneNorm9 = toPhoneNorm9(rowPhone);
      if (rowPhoneNorm9.length >= 9 && rowPhoneNorm9 === phoneNorm9) {
        var aiResult = data[i][aiResultCol];
        var content = (aiResult != null && String(aiResult).trim() !== "") ? String(aiResult).trim() : "該客人尚無 AI 分析結果。";
        return jsonOut({ status: "ok", phone: phone, content: content });
      }
    }
    return jsonOut({ status: "error", message: "查無此客人（" + phone + "）。請確認該手機是否已在「客人消費狀態」試算表 B 欄。" });
  } catch (err) {
    return jsonOut({ status: "error", message: (err && err.message) ? err.message : String(err) });
  }
}

/**
 * Core API：取得 Core 設定
 */
function actionGetCoreConfig() {
  if (typeof getCoreConfig !== "function") {
    return jsonOut({ status: "error", message: "getCoreConfig 未定義（請確認 Config.js 已加入專案）" });
  }
  return jsonOut({ status: "ok", data: getCoreConfig() });
}

/**
 * 依 LINE userId 取得 displayName（供請求員工ID 等試算表填 C 欄 LINE 暱稱）
 * 參數：userId, token（必填）；groupId, roomId 可選（群組/聊天室時傳入）
 */
function actionGetUserDisplayName(params) {
  var userId = (params.userId != null) ? String(params.userId).trim() : "";
  var token = (params.token != null) ? String(params.token).trim() : "";
  var groupId = (params.groupId != null) ? String(params.groupId).trim() : "";
  var roomId = (params.roomId != null) ? String(params.roomId).trim() : "";
  if (!userId || !token) {
    return jsonOut({ status: "error", message: "缺少 userId 或 token" });
  }
  if (typeof getUserDisplayName !== "function") {
    return jsonOut({ status: "error", message: "getUserDisplayName 未定義（請確認 LineBot.js 已加入專案）" });
  }
  var displayName = getUserDisplayName(userId, groupId, roomId, token);
  return jsonOut({ status: "ok", displayName: displayName });
}

/**
 * Core API：依手機號碼執行退費（儲值金退還）。
 * 參數：phone（必填）
 * 回傳：{ status, success, msg, amount? }
 */
function actionExecuteRefundByPhone(params) {
  var phone = (params.phone != null) ? String(params.phone).trim() : "";
  if (!phone) {
    return jsonOut({ status: "error", message: "請提供 phone 參數" });
  }
  if (typeof executeRefundByPhone !== "function") {
    return jsonOut({ status: "error", message: "executeRefundByPhone 未定義（請確認 SayDou.js 已加入專案）" });
  }
  try {
    var result = executeRefundByPhone(phone);
    return jsonOut({
      status: result.success ? "ok" : "error",
      success: result.success,
      msg: result.msg || "",
      amount: result.amount
    });
  } catch (err) {
    return jsonOut({
      status: "error",
      success: false,
      message: (err && err.message) ? err.message : String(err)
    });
  }
}

/**
 * Core API：員工業績月報表
 * 參數：mode（full | lastMonth | fetchData）、batchSize（可選）
 * full：Core 讀寫試算表（舊流程，保留相容）
 * lastMonth：只處理上一個月
 * fetchData：僅拉取資料回傳，不寫入試算表（供日報表 產出本地寫入）
 */
function actionEmployeeMonthlyPerformanceReport(params) {
  try {
    var mode = (params.mode != null) ? String(params.mode).trim() : "lastMonth";
    var batchSize = (params.batchSize != null) ? parseInt(params.batchSize, 10) : (typeof BATCH_MONTHS !== "undefined" ? BATCH_MONTHS : 3);
    if (isNaN(batchSize) || batchSize < 1) batchSize = 3;
    var config = (typeof getCoreConfig === "function") ? getCoreConfig() : {};
    var ssId = (config.DAILY_ACCOUNT_REPORT_SS_ID && String(config.DAILY_ACCOUNT_REPORT_SS_ID).trim()) ? String(config.DAILY_ACCOUNT_REPORT_SS_ID).trim() : "";
    if (!ssId && mode !== "fetchData") return jsonOut({ status: "error", message: "未設定 DAILY_ACCOUNT_REPORT_SS_ID", _debug: "config=" + JSON.stringify(config).slice(0, 200) });

    if (mode === "fetchData") {
      var startYm = (params.startYm != null) ? String(params.startYm).trim() : "";
      var endYm = (params.endYm != null) ? String(params.endYm).trim() : startYm;
      Logger.log("[員工業績月報] fetchData 開始 startYm=" + startYm + " endYm=" + endYm);
      if (!startYm || !endYm) {
        Logger.log("[員工業績月報] ✗ fetchData 缺少 startYm 或 endYm");
        return jsonOut({ status: "error", message: "fetchData 需提供 startYm、endYm" });
      }
      try {
        var data = (typeof buildEmployeeMonthlyPerformanceReport === "function")
          ? buildEmployeeMonthlyPerformanceReport(startYm, endYm) : {};
        Logger.log("[員工業績月報] buildEmployeeMonthlyPerformanceReport 完成，月份=" + (data ? Object.keys(data).join(",") : "無"));
        var built = (typeof buildEmployeeMonthlyReportRows === "function")
          ? buildEmployeeMonthlyReportRows(data) : { rows: [], months: [] };
        var rowCount = (built.rows && built.rows.length) ? built.rows.length : 0;
        Logger.log("[員工業績月報] buildEmployeeMonthlyReportRows 完成，rows=" + rowCount);
        return jsonOut({ status: "ok", data: { rows: built.rows, months: built.months } });
      } catch (fetchErr) {
        var errMsg = (fetchErr && fetchErr.message) ? fetchErr.message : String(fetchErr);
        Logger.log("[員工業績月報] ✗ fetchData 錯誤: " + errMsg);
        if (fetchErr && fetchErr.stack) Logger.log("[員工業績月報] stack: " + fetchErr.stack.slice(0, 500));
        return jsonOut({ status: "error", message: "拉取資料失敗: " + errMsg, _debug: (fetchErr && fetchErr.stack) ? fetchErr.stack.slice(0, 300) : "" });
      }
    }

    if (mode === "lastMonth") {
      Logger.log("[員工業績月報] mode=lastMonth start");
      var now = new Date();
      var lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      var ym = Utilities.formatDate(lastMonth, "Asia/Taipei", "yyyy-MM");
      Logger.log("[員工業績月報] fetching " + ym);
      var data = (typeof buildEmployeeMonthlyPerformanceReport === "function")
        ? buildEmployeeMonthlyPerformanceReport(ym, ym) : {};
      Logger.log("[員工業績月報] data keys=" + Object.keys(data).join(",") + " empCount=" + (data[ym] ? Object.keys(data[ym]).length : 0));
      var writeResult = (typeof writeEmployeeMonthlyReportToSheet === "function")
        ? writeEmployeeMonthlyReportToSheet(ssId, data, { replaceMonths: [ym] }) : { ok: false };
      Logger.log("[員工業績月報] writeResult=" + JSON.stringify(writeResult));
      return jsonOut({
        status: writeResult.ok ? "ok" : "error",
        message: writeResult.ok ? "上月業績已更新" : (writeResult.message || "寫入失敗"),
        month: ym,
        rowCount: writeResult.rowCount || 0,
        _debug: writeResult.ok ? "" : ("writeResult=" + JSON.stringify(writeResult))
      });
    }

    if (mode === "estimate") {
      var endYm = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM");
      var allMonths = (typeof listMonthsFrom2025_ === "function") ? listMonthsFrom2025_(endYm) : [];
      var existingData = {};
      try {
        var sheet = SpreadsheetApp.openById(ssId).getSheetById(833948053) || SpreadsheetApp.openById(ssId).getSheetByName("員工業績月報");
        if (sheet && sheet.getLastRow() >= 2) {
          var lr = sheet.getLastRow();
          var vals = sheet.getRange(2, 1, lr - 1, 4).getValues();
          for (var i = 0; i < vals.length; i++) {
            var m = vals[i][0] ? String(vals[i][0]).trim() : "";
            if (allMonths.indexOf(m) >= 0) existingData[m] = true;
          }
        }
      } catch (e) {}
      var toProcess = [];
      for (var j = 0; j < allMonths.length; j++) {
        if (!existingData[allMonths[j]]) toProcess.push(allMonths[j]);
      }
      return jsonOut({ status: "ok", totalMonths: allMonths.length, toProcess: toProcess, toProcessCount: toProcess.length });
    }

    if (mode === "full") {
      Logger.log("[員工業績月報] mode=full start");
      var endYm = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM");
      var allMonths = (typeof listMonthsFrom2025_ === "function") ? listMonthsFrom2025_(endYm) : [];
      Logger.log("[員工業績月報] allMonths=" + allMonths.length + " " + (allMonths.slice(0, 3).join(",")) + "...");
      var existingData = {};
      // 客戶端傳入的已處理月份（避免試算表讀取延遲導致重複）
      var processedMonthsParam = (params.processedMonths != null) ? String(params.processedMonths).trim() : "";
      if (processedMonthsParam) {
        var arr = processedMonthsParam.split(",");
        for (var p = 0; p < arr.length; p++) {
          var ym = arr[p] ? String(arr[p]).trim() : "";
          if (ym && allMonths.indexOf(ym) >= 0) existingData[ym] = true;
        }
        Logger.log("[員工業績月報] processedMonths=" + processedMonthsParam + " -> existingData=" + Object.keys(existingData).join(","));
      }
      var lastMonthInSheet = null;
      try {
        var sheet = SpreadsheetApp.openById(ssId).getSheetById(833948053) || SpreadsheetApp.openById(ssId).getSheetByName("員工業績月報");
        if (sheet && sheet.getLastRow() >= 2) {
          var lr = sheet.getLastRow();
          var numDataRows = lr - 1;
          var vals = sheet.getRange(2, 1, numDataRows, 4).getValues();
          for (var i = 0; i < vals.length; i++) {
            var m = vals[i][0] ? String(vals[i][0]).trim() : "";
            if (allMonths.indexOf(m) >= 0) existingData[m] = true;
          }
          var lastRowVal = sheet.getRange(lr, 1, 1, 1).getValues();
          if (lastRowVal && lastRowVal[0] && lastRowVal[0][0]) {
            lastMonthInSheet = String(lastRowVal[0][0]).trim();
            if (!lastMonthInSheet || allMonths.indexOf(lastMonthInSheet) < 0) lastMonthInSheet = null;
          }
        }
      } catch (e) {
        Logger.log("[員工業績月報] readExisting err=" + (e && e.message ? e.message : e));
      }
      var toProcess = [];
      for (var j = 0; j < allMonths.length; j++) {
        if (!existingData[allMonths[j]]) toProcess.push(allMonths[j]);
      }
      if (lastMonthInSheet) {
        toProcess.unshift(lastMonthInSheet);
        Logger.log("[員工業績月報] 中斷續跑：先重算最後月份 " + lastMonthInSheet + " 再續跑");
      }
      Logger.log("[員工業績月報] toProcess=" + toProcess.length + " " + (toProcess.slice(0, 5).join(",")));
      if (toProcess.length === 0) {
        return jsonOut({ status: "ok", message: "所有月份已產出，無需處理", processed: [], remaining: [] });
      }
      var batch = toProcess.slice(0, batchSize);
      var startYm = batch[0];
      var endBatch = batch[batch.length - 1];
      Logger.log("[員工業績月報] buildReport " + startYm + "~" + endBatch);
      var data = (typeof buildEmployeeMonthlyPerformanceReport === "function")
        ? buildEmployeeMonthlyPerformanceReport(startYm, endBatch) : {};
      Logger.log("[員工業績月報] buildReport done, months=" + Object.keys(data).join(","));
      var writeResult = (typeof writeEmployeeMonthlyReportToSheet === "function")
        ? writeEmployeeMonthlyReportToSheet(ssId, data, { replaceMonths: batch }) : { ok: false };
      var remaining = toProcess.slice(batchSize);
      Logger.log("[員工業績月報] writeResult=" + JSON.stringify(writeResult));
      return jsonOut({
        status: writeResult.ok ? "ok" : "error",
        message: writeResult.ok ? ("已處理 " + batch.length + " 個月" + (remaining.length > 0 ? "，請再執行一次以繼續" : "")) : (writeResult.message || "寫入失敗"),
        processed: batch,
        remaining: remaining,
        rowCount: writeResult.rowCount || 0,
        _debug: writeResult.ok ? "" : ("writeResult=" + JSON.stringify(writeResult))
      });
    }

    return jsonOut({ status: "error", message: "mode 需為 full 或 lastMonth" });
  } catch (err) {
    var errMsg = (err && err.message) ? err.message : String(err);
    var errStack = (err && err.stack) ? err.stack : "";
    Logger.log("[員工業績月報] EXCEPTION: " + errMsg + "\n" + errStack);
    return jsonOut({
      status: "error",
      message: "執行錯誤: " + errMsg,
      _debug: "stack=" + errStack.slice(0, 500)
    });
  }
}

/**
 * 代為呼叫 LINE Reply API（供各店訊息一覽表等透過 Core API 發送挽留回覆）
 * 參數：replyToken, text, token（皆必填）
 */
function actionLineReply(params) {
  var replyToken = (params.replyToken != null) ? String(params.replyToken).trim() : "";
  var text = (params.text != null) ? String(params.text) : "";
  var token = (params.token != null) ? String(params.token).trim() : "";
  if (!replyToken || !token) {
    return jsonOut({ status: "error", message: "缺少 replyToken 或 token" });
  }
  try {
    if (params.messages != null) {
      var messages = params.messages;
      if (typeof messages === "string") {
        try {
          messages = JSON.parse(messages);
        } catch (eJson) {
          return jsonOut({ status: "error", message: "messages 解析失敗" });
        }
      }
      if (!Array.isArray(messages) || messages.length === 0) {
        return jsonOut({ status: "error", message: "messages 必須為非空陣列" });
      }
      sendLineReplyObj(replyToken, messages, token);
    } else {
      sendLineReply(replyToken, text, token);
    }
    return jsonOut({ status: "ok" });
  } catch (err) {
    return jsonOut({ status: "error", message: (err && err.message) ? err.message : String(err) });
  }
}

/**
 * Core API：取得 Odoo 發票/單據明細。
 * GET: ?key=密鑰&action=getOdooInvoice&id=12345
 */
function actionGetOdooInvoice(params) {
  var id = (params.id != null) ? String(params.id).trim() : "";
  if (!id) {
    return jsonOut({ status: "error", message: "請提供 id 參數（Odoo 發票/單據 ID）" });
  }
  try {
    var lines = getOdooInvoiceJSON(id);
    return jsonOut({ status: "ok", data: lines || [] });
  } catch (err) {
    return jsonOut({ status: "error", message: (err && err.message) ? err.message : String(err) });
  }
}

/**
 * Core API：開立 B2B 發票。
 * POST body: { key, action: "issueInvoice", storeInfo, odooNumber, buyType, items }
 */
function actionIssueInvoice(params) {
  var storeInfo = params.storeInfo;
  var odooNumber = (params.odooNumber != null) ? String(params.odooNumber) : "";
  var buyType = (params.buyType != null) ? String(params.buyType) : "請款";
  var items = params.items;
  if (!storeInfo || !Array.isArray(items)) {
    return jsonOut({ status: "error", message: "請提供 storeInfo 與 items 陣列" });
  }
  try {
    var result = issueInvoice(storeInfo, odooNumber, buyType, items);
    return jsonOut(result || { success: "false", msg: "無回傳" });
  } catch (err) {
    return jsonOut({ success: "false", msg: (err && err.message) ? err.message : String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// =============================================================================
// 神美日報：一次性 token + 報表資料輸出
// =============================================================================

function actionCreateReportToken(params) {
  var role = (params.role != null) ? String(params.role).trim() : "employee";
  var storeIds = [];
  if (params.storeIds != null) {
    String(params.storeIds).split(/[,、，]/).forEach(function (id) {
      var t = String(id || "").trim();
      if (t) storeIds.push(t);
    });
  }
  var userId = (params.userId != null) ? String(params.userId).trim() : "";
  var employeeCode = (params.employeeCode != null) ? String(params.employeeCode).trim() : "";
  if (!storeIds.length) {
    return jsonOut({ status: "error", message: "storeIds 必填" });
  }
  var token = Utilities.getUuid().replace(/-/g, "");
  var tz = (typeof REPORT_HELPERS_TZ !== "undefined") ? REPORT_HELPERS_TZ : "Asia/Taipei";
  var dateStr = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  var payload = {
    role: role,
    storeIds: storeIds,
    userId: userId,
    employeeCode: employeeCode,
    dateStr: dateStr,
    createdAt: Date.now()
  };
  var cache = CacheService.getScriptCache();
  cache.put("report_token_" + token, JSON.stringify(payload), 600);
  return jsonOut({ status: "ok", token: token, expiresIn: 600, dateStr: dateStr });
}

function actionConsumeReportToken(params) {
  var token = (params.token != null) ? String(params.token).trim() : "";
  if (!token) return jsonOut({ status: "error", message: "缺少 token" });
  var cache = CacheService.getScriptCache();
  var key = "report_token_" + token;
  var raw = cache.get(key);
  if (!raw) return jsonOut({ status: "error", message: "連結已失效" });
  cache.remove(key);
  var payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    return jsonOut({ status: "error", message: "token 格式錯誤" });
  }
  var role = payload.role || "employee";
  var storeIds = payload.storeIds || [];
  var dateStr = payload.dateStr;
  var result;
  // 管理者也改為只出單日（當天），避免當月整份資料跑太久
  result = buildDailyReportPayload(dateStr, storeIds);
  if (result && (!result.stores || result.stores.length === 0) && typeof syncDailyReportTransactions === "function") {
    try {
      syncDailyReportTransactions(dateStr);
      result = buildDailyReportPayload(dateStr, storeIds);
    } catch (eSync) {}
  }

  var top5 = buildDailyReportPayload(dateStr, null).topAvgTicketEmployees || [];
  var canShare = false;
  var shareSessionId = "";
  var shareInfo = null;
  if (payload.employeeCode) {
    for (var i = 0; i < top5.length; i++) {
      if (String(top5[i].employeeCode || "") === String(payload.employeeCode)) {
        canShare = true;
        shareInfo = top5[i];
        break;
      }
    }
  }
  if (canShare && shareInfo) {
    shareSessionId = Utilities.getUuid().replace(/-/g, "");
    var empName = "";
    try {
      var empMap = (typeof getEmployeeCodeToNameMap === "function") ? getEmployeeCodeToNameMap() : {};
      if (empMap && empMap[payload.employeeCode]) empName = empMap[payload.employeeCode];
    } catch (eMap) {}
    var storeId = storeIds.length ? String(storeIds[0]) : "";
    var storeName = "";
    if (result && result.stores && result.stores.length) {
      storeName = result.stores[0].storeName || "";
    }
    var sessionPayload = {
      dateStr: dateStr,
      employeeCode: payload.employeeCode,
      employeeName: empName,
      storeId: storeId,
      storeName: storeName,
      avgTicket: shareInfo.avgTicket || 0,
      orderCount: shareInfo.orderCount || 0,
      createdAt: Date.now()
    };
    cache.put("report_share_" + shareSessionId, JSON.stringify(sessionPayload), 3600);
  }

  try {
    var empNameForLog = "";
    var empMapLog = (typeof getEmployeeCodeToNameMap === "function") ? getEmployeeCodeToNameMap() : {};
    if (payload.employeeCode && empMapLog && empMapLog[payload.employeeCode]) {
      empNameForLog = empMapLog[payload.employeeCode];
    }
    if (typeof writeDailyReportAccessLog === "function") {
      writeDailyReportAccessLog({
        dateStr: dateStr,
        role: role,
        userId: payload.userId || "",
        employeeCode: payload.employeeCode || "",
        employeeName: empNameForLog,
        storeIds: storeIds
      });
    }
  } catch (eLog) {}

  var out = {
    status: "ok",
    role: role,
    dateStr: dateStr,
    data: result,
    topAvgTicketEmployees: top5,
    canShare: canShare,
    shareSessionId: shareSessionId
  };
  if (role === "manager") {
    var reportSessionId = Utilities.getUuid().replace(/-/g, "");
    cache.put("report_session_" + reportSessionId, JSON.stringify({ storeIds: storeIds, createdAt: Date.now() }), 600);
    out.reportSessionId = reportSessionId;
  }
  return jsonOut(out);
}

/**
 * 管理者切換日期：依 sessionId + date 回傳該日報表資料（不需 key，session 有效 10 分鐘）
 */
function actionGetReportByDate(params) {
  var sessionId = (params.sessionId != null) ? String(params.sessionId).trim() : "";
  var dateStr = (params.date != null) ? String(params.date).trim() : "";
  if (!sessionId) return jsonOut({ status: "error", message: "缺少 sessionId" });
  if (!dateStr) return jsonOut({ status: "error", message: "缺少 date" });
  var cache = CacheService.getScriptCache();
  var raw = cache.get("report_session_" + sessionId);
  if (!raw) return jsonOut({ status: "error", message: "連結已失效或逾時，請重新從 LINE 開啟日報。" });
  var session;
  try {
    session = JSON.parse(raw);
  } catch (e) {
    return jsonOut({ status: "error", message: "session 格式錯誤" });
  }
  var storeIds = session.storeIds || [];
  if (storeIds.length === 0) return jsonOut({ status: "error", message: "無門市資料" });
  var result = buildDailyReportPayload(dateStr, storeIds);
  var top5 = buildDailyReportPayload(dateStr, null).topAvgTicketEmployees || [];
  return jsonOut({
    status: "ok",
    dateStr: dateStr,
    data: result,
    topAvgTicketEmployees: top5
  });
}

/**
 * 網紅專屬連結追蹤（入口）：
 * - 不在此處累加，改回傳中間頁；由前端用 sessionStorage 判斷「同分頁只計數一次」，再呼叫 nearRecord 累加並導向。
 * - URL 範例：<Core Web App URL>?action=near&code=123
 */
function actionNearRedirect(params) {
  var code = (params.code != null) ? String(params.code).trim() : "";
  if (!code) {
    return redirectTo_("https://www.paopaomao.tw/near");
  }

  var ssId = (typeof NEAR_TRACKING_SS_ID !== "undefined") ? NEAR_TRACKING_SS_ID : "";
  var sheetName = (typeof NEAR_TRACKING_SHEET_NAME !== "undefined") ? NEAR_TRACKING_SHEET_NAME : "NearTracking";
  if (!ssId) {
    return redirectTo_("https://www.paopaomao.tw/near");
  }

  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return redirectTo_("https://www.paopaomao.tw/near");

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return redirectTo_("https://www.paopaomao.tw/near");

    var data = sheet.getRange(2, 1, lastRow, 5).getValues(); // A:E，含最後一列
    var targetUrl = "https://www.paopaomao.tw/near";
    for (var i = 0; i < data.length; i++) {
      var rowCode = (data[i][0] != null) ? String(data[i][0]).trim() : "";
      if (rowCode === code) {
        var u = (data[i][2] != null) ? String(data[i][2]).trim() : "";
        if (u) targetUrl = u;
        break;
      }
    }

    var baseUrl = (typeof ScriptApp !== "undefined" && ScriptApp.getService()) ? ScriptApp.getService().getUrl() : "";
    var html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body>Redirecting...</body><script>\n" +
      "(function(){ var c=" + JSON.stringify(code) + "; var u=" + JSON.stringify(targetUrl) + "; var b=" + JSON.stringify(baseUrl) + ";\n" +
      "if(sessionStorage.getItem('near_'+c)){ window.location.href=u; return; }\n" +
      "var x=new XMLHttpRequest(); x.open('GET', b+(b.indexOf('?')>=0?'&':'?')+'action=nearRecord&code='+encodeURIComponent(c), true);\n" +
      "x.onload=function(){ try{sessionStorage.setItem('near_'+c,'1');}catch(e){} window.location.href=u; };\n" +
      "x.onerror=function(){ window.location.href=u; };\n" +
      "x.send(); })();\n</script></html>";
    return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (e) {
    return redirectTo_("https://www.paopaomao.tw/near");
  }
}

/**
 * 網紅連結「只做累加」；由 near 的中間頁在「同分頁第一次」時呼叫，避免重整一直 +1。
 * 不需 key，公開呼叫。
 */
function actionNearRecord(params) {
  var code = (params.code != null) ? String(params.code).trim() : "";
  if (!code) return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT);

  var ssId = (typeof NEAR_TRACKING_SS_ID !== "undefined") ? NEAR_TRACKING_SS_ID : "";
  var sheetName = (typeof NEAR_TRACKING_SHEET_NAME !== "undefined") ? NEAR_TRACKING_SHEET_NAME : "NearTracking";
  if (!ssId) return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT);

  var lock = LockService.getScriptLock();
  try {
    lock.tryLock(5000);

    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT);

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT);

    var range = sheet.getRange(2, 1, lastRow, 5);
    var values = range.getValues();
    for (var i = 0; i < values.length; i++) {
      var rowCode = (values[i][0] != null) ? String(values[i][0]).trim() : "";
      if (rowCode === code) {
        var current = Number(values[i][3] || 0);
        if (isNaN(current)) current = 0;
        values[i][3] = current + 1;
        values[i][4] = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
        range.setValues(values);
        break;
      }
    }
  } catch (e) {}
  finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
  return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT);
}

/**
 * 網紅連結「記數 + 回傳導向網址」；用 JSONP 讓前端在站內呼叫，使用者不會跳轉到 script.google.com。
 * GET: action=nearHit&code=XXX&callback=函數名
 * 回傳：函數名({ "targetUrl": "https://..." })  (application/javascript)
 */
function actionNearHit(params) {
  var code = (params.code != null) ? String(params.code).trim() : "";
  var cb = (params.callback != null) ? String(params.callback).trim() : "";
  if (!cb) cb = "callback";
  var targetUrl = "https://www.paopaomao.tw/near";

  if (!code) {
    return ContentService.createTextOutput(cb + "(" + JSON.stringify({ targetUrl: targetUrl }) + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  var ssId = (typeof NEAR_TRACKING_SS_ID !== "undefined") ? NEAR_TRACKING_SS_ID : "";
  var sheetName = (typeof NEAR_TRACKING_SHEET_NAME !== "undefined") ? NEAR_TRACKING_SHEET_NAME : "NearTracking";
  if (!ssId) {
    return ContentService.createTextOutput(cb + "(" + JSON.stringify({ targetUrl: targetUrl }) + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  var lock = LockService.getScriptLock();
  var found = false;
  try {
    lock.tryLock(5000);
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      return ContentService.createTextOutput(cb + "(" + JSON.stringify({ targetUrl: targetUrl }) + ")")
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      var range = sheet.getRange(2, 1, lastRow, 5);
      var values = range.getValues();
      for (var i = 0; i < values.length; i++) {
        var rowCode = (values[i][0] != null) ? String(values[i][0]).trim() : "";
        if (rowCode === code) {
          found = true;
          var u = (values[i][2] != null) ? String(values[i][2]).trim() : "";
          if (u) targetUrl = u;
          var current = Number(values[i][3] || 0);
          if (isNaN(current)) current = 0;
          values[i][3] = current + 1;
          values[i][4] = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
          range.setValues(values);
          break;
        }
      }
    }
    // 找不到該 code 時自動新增一列：A=code, B=空, C=首頁, D=1, E=現在時間
    if (!found) {
      var nowStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
      sheet.appendRow([code, "", targetUrl, 1, nowStr]);
    }
  } catch (e) {}
  finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
  return ContentService.createTextOutput(cb + "(" + JSON.stringify({ targetUrl: targetUrl }) + ")")
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

/**
 * 門市列表 API
 * GET: action=storeList
 * 回傳：JSON 陣列 [{ name, address, lineUrl, lat, lng }, ...]
 */
function actionStoreList() {
  var data = getStoreListData();
  return jsonResponse(data);
}

function getStoreListData() {
  try {
    var ssId = (typeof LINE_HQ_SS_ID !== "undefined") ? LINE_HQ_SS_ID : "1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE";
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName("門市列表");
    if (!sheet) return storeListError("找不到工作表");
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return storeListError("試算表無資料");
    var headers = data[0].map(function(h) { return String(h); });
    var nameIdx = headers.findIndex(function(h) { return h.indexOf("店名") >= 0; });
    var addrIdx = headers.findIndex(function(h) { return h.indexOf("地址") >= 0; });
    var lineIdx = headers.findIndex(function(h) { return h.indexOf("line官方") >= 0 || h.indexOf("LINE官方") >= 0; });
    var locIdx = headers.findIndex(function(h) { return h.indexOf("經度") >= 0 || h.indexOf("緯度") >= 0; });
    if (nameIdx === -1) nameIdx = 0;
    if (addrIdx === -1) addrIdx = 1;
    if (locIdx === -1) locIdx = 39;
    var cleanStores = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var rawCoords = row[locIdx];
      var lat = 0, lng = 0;
      var hasValidCoord = false;
      if (rawCoords && typeof rawCoords === "string" && rawCoords.indexOf(",") >= 0) {
        var parts = rawCoords.split(",");
        lat = parseFloat(parts[0]);
        lng = parseFloat(parts[1]);
        if (!isNaN(lat) && !isNaN(lng) && lat !== 0) hasValidCoord = true;
      }
      var hasValidLine = false;
      var safeLine = "";
      if (lineIdx !== -1 && row[lineIdx]) {
        var rawLine = String(row[lineIdx]).trim();
        if (rawLine.length > 5 && rawLine !== "無" && rawLine !== "-" &&
            rawLine.toLowerCase() !== "null" && rawLine.toLowerCase() !== "none") {
          hasValidLine = true;
          safeLine = rawLine;
        }
      }
      if (hasValidCoord && hasValidLine) {
        var safeName = (row[nameIdx]) ? String(row[nameIdx]).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "") : "店名讀取中";
        var safeAddr = (row[addrIdx]) ? String(row[addrIdx]).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "") : "地址讀取中";
        cleanStores.push({ name: safeName, address: safeAddr, lineUrl: safeLine, lat: lat, lng: lng });
      }
    }
    return cleanStores;
  } catch (e) {
    return storeListError("後端錯誤: " + e.toString());
  }
}

function storeListError(msg) {
  return [{ name: msg, address: "請檢查後端", lineUrl: "", lat: 0, lng: 0 }];
}

/**
 * 簡單 HTML redirect（支援 meta refresh + JS）
 */
function redirectTo_(url) {
  var safeUrl = url || "https://www.paopaomao.tw/near";
  var html = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="refresh" content="0;url=' + safeUrl.replace(/"/g, "") + '">' +
    '<script>window.location.href = ' + JSON.stringify(safeUrl) + ';</script>' +
    '</head><body>Redirecting...</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function actionSubmitReportShare(params) {
  var sessionId = (params.sessionId != null) ? String(params.sessionId).trim() : "";
  var content = (params.content != null) ? String(params.content).trim() : "";
  if (!sessionId) return jsonOut({ status: "error", message: "缺少 sessionId" });
  if (!content) return jsonOut({ status: "error", message: "請輸入心得內容" });
  if (content.length > 1500) return jsonOut({ status: "error", message: "心得內容過長" });
  var cache = CacheService.getScriptCache();
  var raw = cache.get("report_share_" + sessionId);
  if (!raw) return jsonOut({ status: "error", message: "連結已失效" });
  var sessionData;
  try {
    sessionData = JSON.parse(raw);
  } catch (e) {
    return jsonOut({ status: "error", message: "session 格式錯誤" });
  }
  var result = writeDailyReportShare(sessionData, content);
  if (result && result.ok) {
    cache.remove("report_share_" + sessionId);
    return jsonOut({ status: "ok" });
  }
  return jsonOut({ status: "error", message: (result && result.message) ? result.message : "寫入失敗" });
}
