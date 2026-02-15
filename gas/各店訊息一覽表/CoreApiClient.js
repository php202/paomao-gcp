/**
 * Core API 客戶端：取得 Bearer Token 等，供 Action-getSlots 等使用。
 * 指令碼屬性：PAO_CAT_CORE_API_URL（或 PAO_CAT_TOKEN_API_URL）= PaoMao_Core「網路應用程式」部署網址（結尾 /exec）、PAO_CAT_SECRET_KEY
 */
var CoreApi = (function () {
  function getConfig() {
    var props = PropertiesService.getScriptProperties();
    var url = props.getProperty("PAO_CAT_CORE_API_URL") || props.getProperty("PAO_CAT_TOKEN_API_URL") || "";
    var key = props.getProperty("PAO_CAT_SECRET_KEY") || "";
    return { url: url.trim(), key: key.trim() };
  }

  function callGetToken() {
    var c = getConfig();
    if (!c.url || !c.key) throw new Error("請在指令碼屬性設定 PAO_CAT_CORE_API_URL 與 PAO_CAT_SECRET_KEY");
    var fullUrl = c.url + (c.url.indexOf("?") >= 0 ? "&" : "?") + "key=" + encodeURIComponent(c.key) + "&action=token";
    var res = UrlFetchApp.fetch(fullUrl, { muteHttpExceptions: true, timeout: 90 });
    var text = res.getContentText();
    var code = res.getResponseCode();
    if (code !== 200) {
      if (code === 404) throw new Error("Core API 404：請在本專案指令碼屬性將 PAO_CAT_CORE_API_URL 設為 https://script.google.com/macros/s/AKfycby5ibTcUxvPD-Xj1-lOHOJ5oI27CbyyaHv2K3cvNd1PwMiPvwGCpjlzi6UbW4fwip2UaA/exec（結尾 /exec，勿用測試部署）。");
      throw new Error("Core API 錯誤: " + code + " " + text.slice(0, 150));
    }
    return text.trim();
  }

  return {
    getBearerToken: function () {
      return callGetToken();
    }
  };
})();
