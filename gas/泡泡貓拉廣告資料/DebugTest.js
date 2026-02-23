/**
 * 403 排查：檢查本專案使用的 Core API 網址，並用「不需 key」的 action=storeList 測試是否被擋。
 * 執行後看「執行紀錄」：若 testCode 為 200 表示部署端已開放；若 403 表示 PaoMao_Core 該筆部署的「誰可以存取」仍非「任何人」。
 */
function runCoreApi403Check() {
  var url = typeof CoreApi !== "undefined" && CoreApi.getCoreApiUrlForCheck
    ? CoreApi.getCoreApiUrlForCheck()
    : (PropertiesService.getScriptProperties().getProperty("PAO_CAT_CORE_API_URL") || "").trim();
  if (!url) {
    Logger.log("PAO_CAT_CORE_API_URL 未設定");
    return;
  }
  var testUrl = url + (url.indexOf("?") >= 0 ? "&" : "?") + "action=storeList";
  Logger.log("本專案設定的 Core API 網址（請與 PaoMao_Core 管理部署中「網路應用程式」那筆對照）：");
  Logger.log(url);
  Logger.log("---");
  var res;
  try {
    res = UrlFetchApp.fetch(testUrl, { muteHttpExceptions: true, timeout: 15 });
  } catch (e) {
    Logger.log("請求失敗: " + (e.message || e));
    return;
  }
  var code = res.getResponseCode();
  var text = res.getContentText();
  Logger.log("以 ?action=storeList 測試結果：HTTP " + code);
  if (code === 403) {
    Logger.log("→ 仍是 403：請在 PaoMao_Core 專案確認「管理部署」裡「網址為上述 URL 的那一筆」的「誰可以存取」為「任何人」，並按「部署」儲存。勿改到「測試部署」或別筆。");
  } else if (code === 200) {
    Logger.log("→ 200 OK，部署端已開放。若 getStoresInfo 仍 403，請確認 PAO_CAT_CORE_API_URL 與 PaoMao_Core 管理部署中的 URL 完全一致（含 /exec、無 /dev）。");
  } else {
    Logger.log("回應前 200 字: " + (text || "").slice(0, 200));
  }
}

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
