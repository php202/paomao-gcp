/**
 * 各店訊息一覽表 - Debug / Test 入口
 * 執行方式：clasp run runDebugTest 或在編輯器選 runDebugTest 執行
 */
function runDebugTest() {
  const projectName = '各店訊息一覽表';
  const results = { project: projectName, checks: [], ok: true };

  try {
    // === Core 程式庫：驗證是否有拉到 ===
    const coreFns = ['getCoreConfig', 'getLineSayDouInfoMap', 'getStoresInfo', 'jsonResponse', 'fetchReservationData', 'oldNewA', 'fetchTodayReservationData', 'getMemApi', 'getMemberViewByMembid', 'getAllTransactionsByMembid', 'getAllStorecashUseRecordByMembid', 'getAllStorecashAddRecordByMembid', 'normalizePhone'];
    if (typeof Core !== 'undefined') {
      coreFns.forEach(function (fn) {
        const ok = typeof Core[fn] === 'function';
        results.checks.push({ name: 'Core.' + fn, ok: ok });
        if (!ok) results.ok = false;
      });
      if (typeof Core.getCoreConfig === 'function') {
        const config = Core.getCoreConfig();
        results.checks.push({ name: 'Core.getCoreConfig 回傳鍵', keys: config ? Object.keys(config) : [], ok: config ? Object.keys(config).length > 0 : false });
      }
    } else {
      results.checks.push({ name: 'Core', note: 'Core 程式庫未載入', ok: false });
      results.ok = false;
    }

    if (typeof todayReservation === 'function') {
      results.checks.push({ name: 'todayReservation', ok: true });
    }
    if (typeof appointmentLists === 'function') {
      results.checks.push({ name: 'appointmentLists', ok: true });
    }
    if (typeof onOpen === 'function') {
      results.checks.push({ name: 'onOpen', ok: true });
    }

    // === SayDou 全貌：用 0975513172 實際抓一筆 ===
    const TEST_PHONE = '0975513172';
    if (typeof pullSayDouFullByPhone === 'function') {
      try {
        const pullResult = pullSayDouFullByPhone(TEST_PHONE);
        results.checks.push({
          name: 'pullSayDouFullByPhone(0975513172)',
          ok: pullResult && pullResult.success === true,
          success: pullResult ? pullResult.success : false,
          msg: pullResult ? pullResult.msg : '',
          membid: pullResult ? pullResult.membid : null,
          row: pullResult ? pullResult.row : null
        });
        if (!pullResult || !pullResult.success) results.ok = false;
      } catch (e) {
        results.checks.push({ name: 'pullSayDouFullByPhone(0975513172)', ok: false, error: (e && e.message) || String(e) });
        results.ok = false;
      }
    } else {
      results.checks.push({ name: 'pullSayDouFullByPhone', note: '函式未載入（SayDouFullProfile.js）', ok: false });
      results.ok = false;
    }
  } catch (e) {
    results.checks.push({ name: 'runDebugTest', error: e.message, ok: false });
    results.ok = false;
  }

  Logger.log(JSON.stringify(results, null, 2));
  return results;
}

/**
 * 檢查整合／SayDou 全貌用到的試算表是否都有權限開啟。
 * 若出現 "You do not have permission to access the requested document" 時可執行此函式，看哪一個試算表失敗。
 * 執行後請看「檢視 → 紀錄」。
 */
function checkSpreadsheetPermissions() {
  const list = [
    { name: '客人消費問卷（客人消費狀態、SayDou會員全貌）', id: '1wAfl4Dipag6Eh8msOYUc0ZUepaeQR_HnQNEcxIVUt3M' },
    { name: '員工填寫（LINE 訊息一覽表）', id: '1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0' },
    { name: 'Core Token（預約表單，讀 Bearer Token）', id: '1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE' }
  ];
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    try {
      const ss = SpreadsheetApp.openById(item.id);
      const title = ss.getName();
      results.push({ name: item.name, id: item.id, ok: true, title: title });
      Logger.log('OK: ' + item.name + ' → ' + title);
    } catch (e) {
      results.push({ name: item.name, id: item.id, ok: false, error: (e && e.message) || String(e) });
      Logger.log('FAIL: ' + item.name + ' → ' + ((e && e.message) || String(e)));
    }
  }
  Logger.log(JSON.stringify(results, null, 2));
  return results;
}

/**
 * 取得「客人消費狀態」與「SayDou會員全貌」兩張工作表的快照（表頭 + 前 3 列資料）。
 * 在 Apps Script 編輯器選此函式執行後，到「檢視 → 紀錄」複製 JSON，
 * 可貼到本機 gas/samples/actual_snapshots.json 方便查看或讓我對照。
 */
function debug_GetSheetSnapshots() {
  var out = { integrated: null, saydouFull: null };
  try {
    var ssInt = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
    var sheetInt = ssInt.getSheetByName(CONFIG.INTEGRATED_SHEET_NAME);
    if (sheetInt) {
      var lastRow = sheetInt.getLastRow();
      var lastCol = sheetInt.getLastColumn();
      if (lastRow >= 1 && lastCol >= 1) {
        var rangeInt = sheetInt.getRange(1, 1, Math.min(lastRow, 4), lastCol);
        var valuesInt = rangeInt.getValues();
        out.integrated = { sheetName: CONFIG.INTEGRATED_SHEET_NAME, headers: valuesInt[0], rows: valuesInt.slice(1) };
      } else {
        out.integrated = { sheetName: CONFIG.INTEGRATED_SHEET_NAME, headers: [], rows: [] };
      }
    } else {
      out.integrated = { error: '工作表不存在：' + CONFIG.INTEGRATED_SHEET_NAME };
    }
  } catch (e) {
    out.integrated = { error: (e && e.message) || String(e) };
  }
  try {
    var ssSd = SpreadsheetApp.openById(SAYDOU_FULL_CONFIG.SHEET_ID);
    var sheetSd = ssSd.getSheetByName(SAYDOU_FULL_CONFIG.SHEET_NAME);
    if (sheetSd) {
      var lastRow = sheetSd.getLastRow();
      var lastCol = sheetSd.getLastColumn();
      if (lastRow >= 1 && lastCol >= 1) {
        var rangeSd = sheetSd.getRange(1, 1, Math.min(lastRow, 4), lastCol);
        var valuesSd = rangeSd.getValues();
        out.saydouFull = { sheetName: SAYDOU_FULL_CONFIG.SHEET_NAME, headers: valuesSd[0], rows: valuesSd.slice(1) };
      } else {
        out.saydouFull = { sheetName: SAYDOU_FULL_CONFIG.SHEET_NAME, headers: [], rows: [] };
      }
    } else {
      out.saydouFull = { error: '工作表不存在：' + SAYDOU_FULL_CONFIG.SHEET_NAME };
    }
  } catch (e) {
    out.saydouFull = { error: (e && e.message) || String(e) };
  }
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}
