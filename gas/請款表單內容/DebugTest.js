/**
 * 請款表單內容 - Debug / Test 入口（本專案已改為 Core API 客戶端，不依賴 Core 程式庫）
 * 執行方式：clasp run runDebugTest 或在編輯器選 runDebugTest 執行
 */
function runDebugTest() {
  const projectName = '請款表單內容';
  const results = { project: projectName, checks: [], ok: true };

  try {
    // === Core API 客戶端（CoreApiClient.js）===
    const coreFns = ['getCoreConfig', 'getBankInfoMap', 'getTransferDate', 'cleanupTempSheets'];
    if (typeof Core !== 'undefined') {
      coreFns.forEach(function (fn) {
        const ok = typeof Core[fn] === 'function';
        results.checks.push({ name: 'Core.' + fn, ok: ok });
        if (!ok) results.ok = false;
      });
      if (typeof Core.getCoreConfig === 'function') {
        try {
          const config = Core.getCoreConfig();
          results.checks.push({ name: 'Core.getCoreConfig 回傳鍵', keys: config ? Object.keys(config) : [], ok: config && config.EXTERNAL_SS_ID });
        } catch (e) {
          results.checks.push({ name: 'Core.getCoreConfig', ok: false, error: e.message });
          results.ok = false;
        }
      }
    } else {
      results.checks.push({ name: 'Core', note: 'Core API 客戶端未載入（請確認 CoreApiClient.js）', ok: false });
      results.ok = false;
    }

    // 指令碼屬性（開發票與 getBankInfoMap 需 Core API）
    const p = PropertiesService.getScriptProperties();
    const hasUrl = (p.getProperty('PAO_CAT_CORE_API_URL') || '').trim().length > 0;
    const hasKey = (p.getProperty('PAO_CAT_SECRET_KEY') || '').trim().length > 0;
    results.checks.push({ name: 'PAO_CAT_CORE_API_URL 已設定', ok: hasUrl });
    results.checks.push({ name: 'PAO_CAT_SECRET_KEY 已設定', ok: hasKey });
    if (!hasUrl || !hasKey) results.ok = false;

    if (typeof getCoreApiParams === 'function') results.checks.push({ name: 'getCoreApiParams', ok: true });
    if (typeof fetchOdooInvoiceFromCoreApi === 'function') results.checks.push({ name: 'fetchOdooInvoiceFromCoreApi', ok: true });
    if (typeof issueInvoiceViaCoreApi === 'function') results.checks.push({ name: 'issueInvoiceViaCoreApi', ok: true });
    if (typeof issueInvoice === 'function') results.checks.push({ name: 'issueInvoice', ok: true });
    if (typeof main === 'function') results.checks.push({ name: 'main', ok: true });
    if (typeof cleanupTempSheets === 'function') results.checks.push({ name: 'cleanupTempSheets', ok: true });
  } catch (e) {
    results.checks.push({ name: 'runDebugTest', error: e.message, ok: false });
    results.ok = false;
  }

  Logger.log(JSON.stringify(results, null, 2));
  return results;
}
