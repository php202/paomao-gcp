/**
 * 泡泡貓拉廣告資料 - Debug / Test 入口
 * 執行方式：clasp run runDebugTest 或在編輯器選 runDebugTest 執行
 */
function runDebugTest() {
  const projectName = '泡泡貓拉廣告資料';
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
  } catch (e) {
    results.checks.push({ name: 'runDebugTest', error: e.message, ok: false });
    results.ok = false;
  }

  Logger.log(JSON.stringify(results, null, 2));
  return results;
}
