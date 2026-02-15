/**
 * PaoMao Core API 客戶端：取代 Core 程式庫，改由 HTTP 呼叫 PaoMao_Core Web App。
 * 指令碼屬性：PAO_CAT_CORE_API_URL（PaoMao_Core 網路應用程式部署網址，結尾 /exec）、PAO_CAT_SECRET_KEY
 * 對外以 Core 物件提供相同介面，現有程式碼 Core.xxx 不需改動。
 */
var CoreApi = (function () {
  var _configCache = null;
  var _lastDebugResult = null;
  /** getCoreConfig 快取鍵與 TTL（秒），降低每日 UrlFetch 用量，避免觸及 GAS 限制 */
  var CORE_CONFIG_CACHE_KEY = "CoreApi_getCoreConfig";
  var CORE_CONFIG_CACHE_TTL = 1800; // 30 分鐘
  /** urlfetch 額度用盡時，改回傳此長期快取（6 小時），避免整日掛掉 */
  var CORE_CONFIG_FALLBACK_KEY = "CoreApi_getCoreConfig_fb";
  var CORE_CONFIG_FALLBACK_TTL = 21600; // 6 小時（GAS ScriptCache 上限）
  /** Script Properties 備援鍵（讀取不耗 UrlFetch）。額度用盡時可手動設定：專案設定→指令碼屬性→新增此鍵，值為 getCoreConfig 的 data JSON 字串 */
  var CORE_CONFIG_PROPS_KEY = "CoreApi_getCoreConfig_backup";

  function getApiConfig() {
    var props = PropertiesService.getScriptProperties();
    var url = (props.getProperty("PAO_CAT_CORE_API_URL") || "").trim();
    var key = (props.getProperty("PAO_CAT_SECRET_KEY") || "").trim();
    if (url && (url.indexOf("/dev") !== -1 || url.indexOf("/exec") === -1)) {
      throw new Error("PAO_CAT_CORE_API_URL 請填「管理部署」的網址（部署→管理部署→複製網址，須含 /exec），勿用測試部署（/dev），外部呼叫才能通過。");
    }
    return { url: url, key: key };
  }

  function buildQuery(action, params) {
    var c = getApiConfig();
    if (!c.url || !c.key) throw new Error("請在指令碼屬性設定 PAO_CAT_CORE_API_URL 與 PAO_CAT_SECRET_KEY");
    var q = ["key=" + encodeURIComponent(c.key), "action=" + encodeURIComponent(action)];
    if (params) {
      Object.keys(params).forEach(function (k) {
        if (params[k] != null && params[k] !== "") {
          var v = params[k];
          q.push(encodeURIComponent(k) + "=" + encodeURIComponent(typeof v === "object" ? JSON.stringify(v) : String(v)));
        }
      });
    }
    return c.url + (c.url.indexOf("?") >= 0 ? "&" : "?") + q.join("&");
  }

  function callGet(action, params) {
    var url = buildQuery(action, params);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, timeout: 90, followRedirects: true });
    var code = res.getResponseCode();
    var text = res.getContentText();
    if (code !== 200) {
      if (code === 302 || code === 403 || (text && (text.indexOf("<") === 0 || text.indexOf("<!") === 0))) {
        throw new Error("Core API 回傳 " + code + "（可能為登入頁或無權限）。請確認：1) PAO_CAT_CORE_API_URL 為「管理部署」網址（結尾 /exec），勿用測試部署。2) PaoMao_Core 部署→管理部署→該 Web App 右側編輯→「誰可以存取」為「任何人」。");
      }
      throw new Error("Core API 錯誤: " + code + " " + (text ? text.slice(0, 150) : ""));
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      if (text && text.indexOf("<") === 0) {
        throw new Error("Core API 回傳 HTML（登入頁）。請將 PAO_CAT_CORE_API_URL 改為「管理部署」的網址（結尾 /exec），並確認「誰可以存取」為「任何人」。");
      }
      throw new Error("Core API 回傳非 JSON: " + (text ? text.slice(0, 200) : ""));
    }
  }

  function callPost(payload) {
    var c = getApiConfig();
    if (!c.url || !c.key) throw new Error("請在指令碼屬性設定 PAO_CAT_CORE_API_URL 與 PAO_CAT_SECRET_KEY");
    payload.key = c.key;
    if (!payload.action) payload.action = "token";
    var res = UrlFetchApp.fetch(c.url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      timeout: 90,
      followRedirects: true
    });
    var code = res.getResponseCode();
    var text = res.getContentText();
    if (code !== 200) {
      if (code === 302 || code === 403 || (text && (text.indexOf("<") === 0 || text.indexOf("<!") === 0))) {
        throw new Error("Core API 回傳 " + code + "（可能為登入頁或無權限）。請確認 PAO_CAT_CORE_API_URL 為「管理部署」網址（結尾 /exec），且「誰可以存取」為「任何人」。");
      }
      throw new Error("Core API 錯誤: " + code + " " + (text ? text.slice(0, 150) : ""));
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      if (text && text.indexOf("<") === 0) {
        throw new Error("Core API 回傳 HTML（登入頁）。請將 PAO_CAT_CORE_API_URL 改為「管理部署」的網址（結尾 /exec）。");
      }
      throw new Error("Core API 回傳非 JSON: " + (text ? text.slice(0, 200) : ""));
    }
  }

  function getScriptCacheSafe() {
    try {
      return CacheService.getScriptCache();
    } catch (e) {
      return null;
    }
  }

  /** 從快取讀取 config（含 fallback 鍵），回傳 parsed 或 null */
  function readConfigFromCache(scriptCache) {
    if (!scriptCache) return null;
    try {
      var raw = scriptCache.get(CORE_CONFIG_CACHE_KEY) || scriptCache.get(CORE_CONFIG_FALLBACK_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  /** 成功取得 config 後寫入快取與 Properties 備援（Properties 讀取不耗 UrlFetch） */
  function saveConfigToBackups(data, scriptCache) {
    var json = JSON.stringify(data);
    if (scriptCache) {
      try {
        scriptCache.put(CORE_CONFIG_CACHE_KEY, json, CORE_CONFIG_CACHE_TTL);
        scriptCache.put(CORE_CONFIG_FALLBACK_KEY, json, CORE_CONFIG_FALLBACK_TTL);
      } catch (e) { /* 忽略 */ }
    }
    try {
      if (json.length <= 8000) PropertiesService.getScriptProperties().setProperty(CORE_CONFIG_PROPS_KEY, json);
    } catch (e) { /* 單鍵約 9KB 上限，略過 */ }
  }

  /** 從 Script Properties 讀取備援 config（不耗 UrlFetch） */
  function readConfigFromProperties() {
    try {
      var raw = PropertiesService.getScriptProperties().getProperty(CORE_CONFIG_PROPS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  return {
    getCoreConfig: function () {
      if (_configCache) return _configCache;
      var scriptCache = getScriptCacheSafe();
      var cached = readConfigFromCache(scriptCache);
      if (cached) {
        _configCache = cached;
        return _configCache;
      }
      // 先試 Properties（不耗 UrlFetch）；手動設定備援後可當日恢復，無須等額度重置
      cached = readConfigFromProperties();
      if (cached) {
        _configCache = cached;
        return _configCache;
      }
      // 快取為空時用 Lock 讓「只有一個執行」打 API，避免同時大量 UrlFetch（thundering herd）
      var lock = LockService.getScriptLock();
      var gotLock = false;
      try {
        gotLock = lock.tryLock(10000); // 最多等 10 秒
        if (gotLock) {
          cached = readConfigFromCache(scriptCache); // double-check：等待期間可能已被其他執行寫入
          if (cached) {
            _configCache = cached;
            return _configCache;
          }
          var r = callGet("getCoreConfig", {});
          if (r.status === "ok" && r.data) {
            _configCache = r.data;
            saveConfigToBackups(r.data, scriptCache);
            return _configCache;
          }
          throw new Error(r.message || "getCoreConfig 失敗");
        }
        // 沒拿到 lock：等別人寫入快取後再讀
        for (var w = 0; w < 4; w++) {
          Utilities.sleep(1500);
          cached = readConfigFromCache(scriptCache);
          if (cached) {
            _configCache = cached;
            return _configCache;
          }
        }
        // 最後手段：自己打 API（避免無限期等待）
        var r = callGet("getCoreConfig", {});
        if (r.status === "ok" && r.data) {
          _configCache = r.data;
          saveConfigToBackups(r.data, scriptCache);
          return _configCache;
        }
        throw new Error(r.message || "getCoreConfig 失敗");
      } catch (fetchErr) {
        if (gotLock) try { lock.releaseLock(); } catch (e) {}
        cached = readConfigFromCache(scriptCache);
        if (cached) {
          _configCache = cached;
          console.warn("[CoreApiClient] getCoreConfig 使用快取（API 失敗: " + (fetchErr.message || fetchErr) + "）");
          return _configCache;
        }
        // 快取也空時改用 Script Properties 備援（讀取不耗 UrlFetch，當日額度用盡仍可回覆）
        cached = readConfigFromProperties();
        if (cached) {
          _configCache = cached;
          console.warn("[CoreApiClient] getCoreConfig 使用 Properties 備援（API 失敗: " + (fetchErr.message || fetchErr) + "）");
          return _configCache;
        }
        throw fetchErr;
      } finally {
        if (gotLock) try { lock.releaseLock(); } catch (e) {}
      }
    },
    sendLineReply: function (replyToken, text, token) {
      var r = callPost({ action: "lineReply", replyToken: replyToken, text: text || "", token: token });
      if (r.status !== "ok") throw new Error(r.message || "lineReply 失敗");
    },
    sendLineReplyObj: function (replyToken, messages, token) {
      var r = callPost({ action: "lineReply", replyToken: replyToken, messages: Array.isArray(messages) ? messages : [messages], token: token });
      if (r.status !== "ok") throw new Error(r.message || "lineReply 失敗");
    },
    jsonResponse: function (data) {
      return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
    },
    getReportHandlerFromKeyword: function (text) {
      var r = callGet("getReportHandlerFromKeyword", { text: text });
      return (r.status === "ok" && r.handler !== undefined) ? r.handler : null;
    },
    getReportTextForKeyword: function (handler, options) {
      options = options || {};
      var managedStoreIds = options.managedStoreIds || [];
      var idsStr = Array.isArray(managedStoreIds) ? managedStoreIds.join(",") : (managedStoreIds || "");
      var r = callGet("getReportTextForKeyword", { handler: handler, managedStoreIds: idsStr });
      if (r.status !== "ok") return { text: r.message || "報告取得失敗", sheetLink: undefined };
      return { text: r.text || "", sheetLink: r.sheetLink };
    },
    getWorkflowLink: function (keyword) {
      var r = callGet("getWorkflowLink", { keyword: keyword });
      return (r.status === "ok" && r.url != null) ? r.url : null;
    },
    getDirectStoreReplyStatusText: function () {
      var r = callGet("getDirectStoreReplyStatusText", {});
      if (r.status === "ok" && r.ok) return { ok: true, text: r.text || "" };
      return { ok: false, message: r.message || "無法取得店家回覆狀態" };
    },
    getLineSayDouInfoMap: function () {
      var r = callGet("getLineSayDouInfoMap", {});
      if (r.status === "ok" && r.data) return r.data;
      return {};
    },
    findAvailableSlots: function (sayId, startDate, endDate, needPeople, durationMin, options) {
      options = options || {};
      var params = { sayId: sayId, startDate: startDate, endDate: endDate, needPeople: needPeople || 1, durationMin: durationMin || 90 };
      if (options.weekDays) params.weekDays = JSON.stringify(options.weekDays);
      if (options.timeStart) params.timeStart = options.timeStart;
      if (options.timeEnd) params.timeEnd = options.timeEnd;
      if (options.token) params.token = options.token;
      var r = callGet("findAvailableSlots", params);
      if (r.status === "ok" && r.result) return r.result;
      return { status: false, error: r.message || "查詢失敗", data: [] };
    },
    // 【勿改】取不到時回傳 ""，不要回傳「未知用戶」（產品要求留空）
    getUserDisplayName: function (userId, groupId, roomId, token) {
      var r = callGet("getUserDisplayName", { userId: userId, token: token, groupId: groupId || "", roomId: roomId || "" });
      if (r.status === "ok" && r.displayName != null) return r.displayName;
      return "";
    },
    syncLastMonthTipsConsolidated: function () {
      var r = callGet("syncLastMonthTipsConsolidated", {});
      if (r.status && r.status !== "ok" && r.ok !== true) {
        throw new Error(r.message || "syncLastMonthTipsConsolidated 失敗");
      }
      return r;
    },
    // Debug helper: 測試 Core API 連線與 action 是否可用
    debugTest: function () {
      var out = {
        ok: false,
        time: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"),
        url: "",
        actions: {},
        error: ""
      };
      try {
        var cfg = getApiConfig();
        out.url = cfg.url || "";
      } catch (eCfg) {
        out.error = eCfg && eCfg.message ? eCfg.message : String(eCfg);
        _lastDebugResult = out;
        return out;
      }
      try {
        out.actions.getCoreConfig = callGet("getCoreConfig", {});
      } catch (eCore) {
        out.actions.getCoreConfig = { status: "error", message: eCore && eCore.message ? eCore.message : String(eCore) };
      }
      try {
        out.actions.token = callGet("token", {});
      } catch (eTok) {
        out.actions.token = { status: "error", message: eTok && eTok.message ? eTok.message : String(eTok) };
      }
      out.ok = !!(out.actions.getCoreConfig && out.actions.getCoreConfig.status === "ok");
      _lastDebugResult = out;
      return out;
    },
    getLastDebugResult: function () {
      return _lastDebugResult;
    }
  };
})();

// 對外以 Core 提供相同介面，現有程式碼不需改動
var Core = CoreApi;
