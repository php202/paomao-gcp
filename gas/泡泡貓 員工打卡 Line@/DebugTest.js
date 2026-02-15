/**
 * 泡泡貓 員工打卡 Line@ - Debug / Test 入口
 * 執行方式：clasp run runDebugTest 或在編輯器選 runDebugTest 執行
 */
function runDebugTest() {
  const projectName = '泡泡貓 員工打卡 Line@';
  const results = { project: projectName, checks: [], ok: true };

  try {
    // === Core 程式庫：驗證是否有拉到 ===
    const coreFns = ['getCoreConfig', 'getLineSayDouInfoMap', 'getStoresInfo', 'jsonResponse', 'getBankInfoMap', 'getBearerTokenFromSheet', 'sendLineReply', 'sendLineReplyObj'];
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

    if (typeof onOpen === 'function') {
      results.checks.push({ name: 'onOpen', ok: true });
    }
    if (typeof runAccNeed === 'function') {
      results.checks.push({ name: 'runAccNeed', ok: true });
    }
    results.checks.push({ name: 'doPost', note: 'Web App entry, test via HTTP', ok: true });
  } catch (e) {
    results.checks.push({ name: 'runDebugTest', error: e.message, ok: false });
    results.ok = false;
  }

  Logger.log(JSON.stringify(results, null, 2));
  return results;
}

/**
 * 測試員工編號：讀取員工清單，列出 D 欄 UserId 與 L 欄 員工編號 的對應。
 * 執行方式：clasp run testEmployeeCode 或在編輯器選 testEmployeeCode 執行
 */
function testEmployeeCode() {
  const ssId = typeof LINE_STAFF_SS_ID !== 'undefined' ? LINE_STAFF_SS_ID : (typeof Core !== 'undefined' && typeof Core.getCoreConfig === 'function' ? (Core.getCoreConfig() || {}).LINE_STAFF_SS_ID : '');
  if (!ssId) {
    Logger.log('錯誤：找不到 LINE_STAFF_SS_ID（請確認 main 或 Core 已載入）');
    return;
  }
  const ss = SpreadsheetApp.openById(ssId);
  const emSheet = ss.getSheetByName('員工清單');
  if (!emSheet) {
    Logger.log('錯誤：找不到「員工清單」工作表');
    return;
  }
  const data = emSheet.getDataRange().getValues();
  const header = (data[0] || []).map(function (h) { return h != null ? String(h) : ''; });
  Logger.log('員工清單欄位（前 12 欄）: ' + header.slice(0, 12).join(' | '));
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const userId = row[3] != null ? String(row[3]).trim() : '';
    const employeeCode = row[11] != null ? String(row[11]).trim() : '';
    out.push({ row: i + 1, userId: userId, employeeCode: employeeCode });
  }
  Logger.log('員工編號對應（L 欄 = index 11）:');
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}
