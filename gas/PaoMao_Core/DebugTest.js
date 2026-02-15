/**
 * 員工業績月報 actionEmployeeMonthlyPerformanceReport 除錯測試
 * 執行：在 Apps Script 編輯器選 debugEmployeeMonthlyPerformanceReport 執行
 * 檢視：執行紀錄（檢視 → 執行紀錄）
 * 可改 startYm、endYm 測試不同月份
 */
function debugEmployeeMonthlyPerformanceReport() {
  var startYm = "2025-07";  // 可改
  var endYm = "2025-07";    // 可改
  var ts = function () { return Utilities.formatDate(new Date(), "Asia/Taipei", "HH:mm:ss"); };
  Logger.log("=== debugEmployeeMonthlyPerformanceReport 開始 " + ts() + " ===");
  Logger.log("參數: startYm=" + startYm + " endYm=" + endYm);

  if (typeof buildEmployeeMonthlyPerformanceReport !== "function") {
    Logger.log("✗ buildEmployeeMonthlyPerformanceReport 不存在");
    return;
  }
  if (typeof buildEmployeeMonthlyReportRows !== "function") {
    Logger.log("✗ buildEmployeeMonthlyReportRows 不存在");
    return;
  }

  try {
    var t0 = new Date().getTime();
    var data = buildEmployeeMonthlyPerformanceReport(startYm, endYm);
    var elapsed = Math.round((new Date().getTime() - t0) / 1000);
    Logger.log("buildEmployeeMonthlyPerformanceReport 耗時 " + elapsed + " 秒");

    var months = Object.keys(data || {});
    Logger.log("回傳月份數: " + months.length + " [" + months.join(",") + "]");

    for (var i = 0; i < months.length; i++) {
      var ym = months[i];
      var byEmp = data[ym] || {};
      var codes = Object.keys(byEmp);
      Logger.log("  " + ym + ": 有業績員工 " + codes.length + " 人");
      for (var j = 0; j < Math.min(codes.length, 5); j++) {
        var c = codes[j];
        Logger.log("    " + c + ": " + byEmp[c]);
      }
      if (codes.length > 5) Logger.log("    ... 其餘 " + (codes.length - 5) + " 人");
    }

    var built = buildEmployeeMonthlyReportRows(data);
    var rows = built.rows || [];
    var rowMonths = built.months || [];
    Logger.log("buildEmployeeMonthlyReportRows: rows=" + rows.length + " months=" + rowMonths.join(","));

    if (rows.length > 0) {
      Logger.log("前 5 筆 rows 範例:");
      for (var r = 0; r < Math.min(5, rows.length); r++) {
        Logger.log("  [" + rows[r].join(", ") + "]");
      }
    }

    var out = { status: "ok", data: { rows: rows, months: rowMonths } };
    Logger.log("完整 output.data.rows 筆數: " + (out.data.rows ? out.data.rows.length : 0));
    Logger.log("=== debugEmployeeMonthlyPerformanceReport 結束 " + ts() + " ===");
    return out;
  } catch (e) {
    Logger.log("✗ 例外: " + (e && e.message ? e.message : e));
    if (e && e.stack) Logger.log("stack: " + e.stack);
    return { status: "error", message: String(e) };
  }
}

/**
 * PaoMao_Core - Debug / Test 入口
 * 執行方式：在專案目錄下 clasp run runDebugTest
 * 或在 Apps Script 編輯器選 runDebugTest 執行
 */
function runDebugTest() {
  const projectName = 'PaoMao_Core';
  const results = { project: projectName, checks: [], ok: true };

  try {
    // 檢查 getCoreConfig 是否存在並回傳設定鍵名（不輸出敏感值）
    if (typeof getCoreConfig === 'function') {
      const config = getCoreConfig();
      const keys = config ? Object.keys(config) : [];
      results.checks.push({ name: 'getCoreConfig', keys: keys, ok: keys.length > 0 });
    } else {
      results.checks.push({ name: 'getCoreConfig', error: 'function not found', ok: false });
      results.ok = false;
    }

    if (typeof getBankInfoMap === 'function') {
      results.checks.push({ name: 'getBankInfoMap', ok: true });
    }
    if (typeof getLineSayDouInfoMap === 'function') {
      results.checks.push({ name: 'getLineSayDouInfoMap', ok: true });
    }
    if (typeof getStoresInfo === 'function') {
      results.checks.push({ name: 'getStoresInfo', ok: true });
    }
    if (typeof clearMyCache === 'function') {
      results.checks.push({ name: 'clearMyCache', ok: true });
    }
  } catch (e) {
    results.checks.push({ name: 'runDebugTest', error: e.message, ok: false });
    results.ok = false;
  }

  Logger.log(JSON.stringify(results, null, 2));
  return results;
}
