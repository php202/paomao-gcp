/**
 * 請款表單內容 - Core API 客戶端：不依賴 Core 程式庫，改由 Core API + 本機試算表讀取提供相同介面。
 * 指令碼屬性：PAO_CAT_CORE_API_URL（結尾 /exec）、PAO_CAT_SECRET_KEY
 * 對外以 Core 物件提供 getBankInfoMap、getTransferDate、cleanupTempSheets，其餘開發票改由 main.js 的 API 函式。
 */
var CoreApi = (function () {
  var _configCache = null;

  function getApiConfig() {
    var props = PropertiesService.getScriptProperties();
    var url = (props.getProperty("PAO_CAT_CORE_API_URL") || "").trim();
    var key = (props.getProperty("PAO_CAT_SECRET_KEY") || "").trim();
    return { url: url, key: key };
  }

  function callGet(action, params) {
    var c = getApiConfig();
    if (!c.url || !c.key) throw new Error("請在指令碼屬性設定 PAO_CAT_CORE_API_URL 與 PAO_CAT_SECRET_KEY");
    var q = ["key=" + encodeURIComponent(c.key), "action=" + encodeURIComponent(action)];
    if (params) {
      Object.keys(params).forEach(function (k) {
        if (params[k] != null && params[k] !== "") {
          q.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])));
        }
      });
    }
    var fullUrl = c.url + (c.url.indexOf("?") >= 0 ? "&" : "?") + q.join("&");
    var res = UrlFetchApp.fetch(fullUrl, { muteHttpExceptions: true, timeout: 90, followRedirects: true });
    var code = res.getResponseCode();
    var text = res.getContentText();
    if (code !== 200) throw new Error("Core API 錯誤: " + code + " " + (text ? text.slice(0, 150) : ""));
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error("Core API 回傳非 JSON: " + (text ? text.slice(0, 200) : ""));
    }
  }

  /** 從 Core API 取得設定（含 EXTERNAL_SS_ID），供本機讀取店家基本資訊用 */
  function getCoreConfig() {
    if (_configCache) return _configCache;
    var r = callGet("getCoreConfig", {});
    if (r.status === "ok" && r.data) {
      _configCache = r.data;
      return _configCache;
    }
    throw new Error(r.message || "getCoreConfig 失敗");
  }

  /**
   * 取得店家銀行帳號對應表：先從 Core API 拿 EXTERNAL_SS_ID，再開試算表讀「店家基本資訊」。
   */
  function getBankInfoMap() {
    var config = getCoreConfig();
    var ssId = (config && config.EXTERNAL_SS_ID) ? String(config.EXTERNAL_SS_ID).trim() : "";
    if (!ssId) throw new Error("Core API getCoreConfig 未回傳 EXTERNAL_SS_ID");
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName("店家基本資訊");
    if (!sheet) return new Map();
    var data = sheet.getRange("A2:K" + sheet.getLastRow()).getValues();
    var map = new Map();
    data.forEach(function (row) {
      var no = row[0], code = row[1], bankAccount = row[2], branch = row[3], name = row[4], store = row[5], companyName = row[6], pinCode = row[7], email = row[8], groupId = row[9], pin = row[10];
      if (code) {
        var pinStr = String(pinCode).trim().padStart(8, "0");
        map.set(String(code).trim(), {
          no: no,
          bankAccount: String(bankAccount).trim(),
          branch: String(branch).trim(),
          name: String(name).trim(),
          pinCode: pinStr,
          companyName: String(companyName).trim(),
          email: String(email).trim(),
          groupId: String(groupId).trim(),
          pin: String(pin).trim(),
          store: store
        });
      }
    });
    return map;
  }

  /**
   * 依預計匯款日計算實際匯款日（與 PaoMao_Core/Utils.js getTransferDate 邏輯一致）
   */
  function getTransferDate(rowTransferDate) {
    var timeZone = "Asia/Taipei";
    var now = new Date();
    var nowHourMinute = parseInt(Utilities.formatDate(now, timeZone, "HHmm"), 10);
    var literalTodayYMD = Utilities.formatDate(now, timeZone, "yyyyMMdd");
    var rowDateObj = new Date(rowTransferDate);
    if (isNaN(rowDateObj.getTime())) rowDateObj = now;
    var rowTransferDateYMD = Utilities.formatDate(rowDateObj, timeZone, "yyyyMMdd");
    var newTransferDate;
    if (rowTransferDateYMD <= literalTodayYMD) {
      if (nowHourMinute > 1510) {
        var tomorrow = new Date(now.getTime());
        tomorrow.setDate(tomorrow.getDate() + 1);
        newTransferDate = tomorrow;
      } else {
        newTransferDate = now;
      }
    } else {
      newTransferDate = rowDateObj;
    }
    return Utilities.formatDate(newTransferDate, timeZone, "yyyyMMdd");
  }

  /**
   * 刪除指定試算表內名稱前綴符合的暫存工作表
   */
  function cleanupTempSheets(id, del_name) {
    var ss = SpreadsheetApp.openById(id);
    var sheets = ss.getSheets();
    var count = 0;
    sheets.forEach(function (sheet) {
      var name = sheet.getName();
      if (name.indexOf("TEMP_EXPORT_") === 0 || name.indexOf(del_name) === 0) {
        ss.deleteSheet(sheet);
        count++;
      }
    });
    if (count > 0) {
      SpreadsheetApp.getUi().alert("已成功刪除 " + count + " 個暫存工作表。");
    } else {
      SpreadsheetApp.getUi().alert("沒有找到任何暫存工作表（名稱需包含 Export 或 " + del_name + "）。");
    }
  }

  return {
    getCoreConfig: getCoreConfig,
    getBankInfoMap: getBankInfoMap,
    getTransferDate: getTransferDate,
    cleanupTempSheets: cleanupTempSheets
  };
})();

// 對外以 Core 提供相同介面，現有程式碼 Core.xxx 不需改動
var Core = CoreApi;
