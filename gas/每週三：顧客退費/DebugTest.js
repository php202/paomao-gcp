/**
 * 每週三：顧客退費 - Debug / Test 入口
 * 執行方式：clasp run runDebugTest 或在編輯器選 runDebugTest 執行
 */
function runDebugTest() {
  const projectName = '每週三：顧客退費';
  const results = { project: projectName, checks: [], ok: true };

  try {
    // === Core API 設定（本專案已改為使用 Core API，不再使用 Core 程式庫）===
    if (typeof getCoreApiParams === 'function') {
      const params = getCoreApiParams();
      results.checks.push({ name: 'PAO_CAT_CORE_API_URL 已設定', ok: (params.url || '').length > 0 });
      results.checks.push({ name: 'PAO_CAT_SECRET_KEY 已設定', ok: (params.key || '').length > 0 });
      results.checks.push({ name: 'useApi 可用', ok: params.useApi === true });
    } else {
      results.checks.push({ name: 'getCoreApiParams', ok: false });
      results.ok = false;
    }

    if (typeof onOpen === 'function') results.checks.push({ name: 'onOpen', ok: true });
    if (typeof refund === 'function') results.checks.push({ name: 'refund', ok: true });
    if (typeof getPhonesFromSheet === 'function') results.checks.push({ name: 'getPhonesFromSheet', ok: true });
    if (typeof exportToExcelWithFilter === 'function') results.checks.push({ name: 'exportToExcelWithFilter', ok: true });
    if (typeof cleanupTempSheets === 'function') results.checks.push({ name: 'cleanupTempSheets', ok: true });
  } catch (e) {
    results.checks.push({ name: 'runDebugTest', error: e.message, ok: false });
    results.ok = false;
  }

  Logger.log(JSON.stringify(results, null, 2));
  return results;
}
