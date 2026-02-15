/**
 * 日報表 產出 - Debug / Test 入口
 * 本專案不再使用 Core 程式庫，改由 Core API URL 取得資料。
 * 執行方式：在專案目錄下 clasp run runDebugTest 或在編輯器選 runDebugTest 執行
 */
function runDebugTest() {
  const projectName = '日報表 產出';
  const results = { project: projectName, checks: [], ok: true };

  try {
    // === Core API 設定（指令碼屬性）===
    const { url, key, useApi } = getCoreApiParams();
    results.checks.push({ name: 'PAO_CAT_CORE_API_URL 已設定', ok: url.length > 0 });
    results.checks.push({ name: 'PAO_CAT_SECRET_KEY 已設定', ok: key.length > 0 });
    results.checks.push({ name: 'useApi（可呼叫 Core API）', ok: useApi });
    if (!useApi) results.ok = false;

    // === 本專案函式存在 ===
    const fns = ['getCoreApiParams', 'callCoreApi', 'runAccNeed', 'doGet', 'doPost', 'handleReportApiRequest', 'jsonReportOut'];
    fns.forEach(function (fn) {
      const ok = typeof globalThis[fn] === 'function';
      results.checks.push({ name: fn, ok: ok });
      if (!ok) results.ok = false;
    });

    // 可選：若 useApi 為 true，可打一次 getCoreConfig 驗證連線（不寫入試算表）
    if (useApi && typeof callCoreApi === 'function') {
      const res = callCoreApi(url, key, 'getCoreConfig', {});
      const configOk = res && res.status === 'ok' && res.data && res.data.DAILY_ACCOUNT_REPORT_SS_ID;
      results.checks.push({ name: 'Core API getCoreConfig 連線', ok: configOk });
      if (!configOk) results.ok = false;
    }
  } catch (e) {
    results.checks.push({ name: 'runDebugTest', error: (e && e.message) ? e.message : String(e), ok: false });
    results.ok = false;
  }

  Logger.log(JSON.stringify(results, null, 2));
  return results;
}
