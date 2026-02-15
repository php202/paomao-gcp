/**
 * Core API 客戶端：runReservationReport 透過中央 API 取得 token 與店家列表。
 * 指令碼屬性：PAO_CAT_CORE_API_URL = PaoMao_Core「網路應用程式」部署網址（結尾 /exec）、PAO_CAT_SECRET_KEY
 */
var CoreApi = (function () {
  function getConfig() {
    var props = PropertiesService.getScriptProperties();
    var url = props.getProperty("PAO_CAT_CORE_API_URL") || props.getProperty("PAO_CAT_TOKEN_API_URL") || "";
    var key = props.getProperty("PAO_CAT_SECRET_KEY") || "";
    return { url: url.trim(), key: key.trim() };
  }

  function callGet(action, params) {
    var c = getConfig();
    if (!c.url || !c.key) throw new Error("請在指令碼屬性設定 PAO_CAT_CORE_API_URL 與 PAO_CAT_SECRET_KEY");
    var query = ["key=" + encodeURIComponent(c.key), "action=" + encodeURIComponent(action)];
    if (params) {
      Object.keys(params).forEach(function (k) {
        if (params[k] != null && params[k] !== "") query.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])));
      });
    }
    var fullUrl = c.url + (c.url.indexOf("?") >= 0 ? "&" : "?") + query.join("&");
    var res = UrlFetchApp.fetch(fullUrl, { muteHttpExceptions: true, timeout: 90 });
    var text = res.getContentText();
    var code = res.getResponseCode();
    if (code !== 200) {
      if (code === 404) throw new Error("Core API 404：請在本專案指令碼屬性將 PAO_CAT_CORE_API_URL 設為 https://script.google.com/macros/s/AKfycby5ibTcUxvPD-Xj1-lOHOJ5oI27CbyyaHv2K3cvNd1PwMiPvwGCpjlzi6UbW4fwip2UaA/exec（結尾 /exec，勿用測試部署）。");
      throw new Error("Core API 錯誤: " + code + " " + text.slice(0, 150));
    }
    return text;
  }

  return {
    getBearerToken: function () {
      return callGet("token", {}).trim();
    },
    getStoresInfo: function () {
      var text = callGet("getStoresInfo", {});
      var r;
      try { r = JSON.parse(text); } catch (e) { throw new Error("Core API 回傳非 JSON: " + text.slice(0, 200)); }
      if (r.status !== "ok" || !Array.isArray(r.data)) throw new Error(r.message || "getStoresInfo 失敗");
      return r.data;
    }
  };
})();
