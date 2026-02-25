/**
 * 泡泡貓相關 GAS 專案（gas/ 資料夾）：PaoMao_Core、各店訊息一覽表、日報表 產出、請款表單內容、
 * 每週三：顧客退費、泡泡貓 門市 預約表單 PAOPAO、泡泡貓拉廣告資料、泡泡貓 員工打卡 Line@
 *
 * 敏感值（LINE token、Odoo/Giveme 密碼）請只放在 GAS 指令碼屬性，勿寫入此檔。
 */
const LINE_TOKEN_PAOPAO = '';
const LINE_TOKEN_PAOSTAFF = '';

const EXTERNAL_SS_ID = '17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE'; // 請款單＿店家基本資訊表 ID
const DAILY_ACCOUNT_REPORT_SS_ID = '1ZMutegYTLZ51XQHCbfFZ7-iAj1qTZGgSo5VTThXPQ5U' // 泡泡貓日報表 ID
const DAILY_ACCOUNT_SHEET_NAME = '營收報表' // 泡泡貓日報表 ID
const LINE_STORE_SS_ID = '1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0' // 訊息一覽表＿店家基本資料 ID
const LINE_STAFF_SS_ID = '1GH2XbihFIY0AX8SMF9Tk6igrVKPpA_vMJVlkDkJjpe4' // 泡泡貓 員工打卡 line@
const LINE_HQ_SS_ID = '1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE' // 泡泡貓 門市資料
/** 網紅連結追蹤：請建立一份專用試算表後，把 ID 貼到這裡 */
const NEAR_TRACKING_SS_ID = '1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE';
/** 追蹤用工作表名稱（建議：NearTracking） */
const NEAR_TRACKING_SHEET_NAME = 'NearTracking';
/** 五星好評／小費表單回應試算表（Google 表單回應） */
const TIPS_FORM_SS_ID = '1GH2XbihFIY0AX8SMF9Tk6igrVKPpA_vMJVlkDkJjpe4'
const TIPS_FORM_SHEET_NAME = 'sheet1'
/** 表單回應所在工作表的 gid（與試算表網址 #gid= 一致）；有設定則依 gid 開表，否則依 TIPS_FORM_SHEET_NAME */
const TIPS_FORM_SHEET_GID = 1880863080
/** 小費表寫入目標：員工打卡試算表內的工作表 gid（#gid=1792957916） */
const TIP_TABLE_SHEET_GID = 1792957916
/** 小費統整表：每月 2 號同步問卷 A:M + 消費／儲值金，寫入此 gid（#gid=1727178779） */
const TIPS_CONSOLIDATED_SHEET_GID = 1727178779
/** 明日預約＋AI 簡略的 Web App URL（各店訊息一覽表部署後填寫，例：https://script.google.com/.../exec）；留空則用 Core 原明日報告 */
const TOMORROW_BRIEFING_WEB_APP_URL = ''

/**
 * SayDou Bearer Token（getToken）：
 * - 本專案 TokenWebApp.js 的 doGet(e) 以 ?key=密鑰 提供 token；本專案指令碼屬性需設 PAO_CAT_SECRET_KEY。
 * - 使用 Core 的其他專案（各店訊息一覽表、泡泡貓 員工打卡 Line@ 等）：指令碼屬性設 PAO_CAT_TOKEN_API_URL（PaoMao_Core「網路應用程式」部署網址，結尾 /exec）、PAO_CAT_SECRET_KEY（與 Core 相同密鑰），則 getBearerTokenFromSheet() 會改由 API 取得 token，無需讀取試算表。
 */
// 以上為指令碼屬性鍵名，勿在程式碼寫入密鑰或網址。

const ODOO_CONFIG_DEFAULT = {
  url: "https://paomao.odoo.com",
  db: "paomao",
  username: "",
  password: ""
};

const GIVEME_CONFIG_DEFAULT = {
  UNCODE: "",
  IDNO: "",
  PASSWORD: "",
  VM_PROXY_URL: "", // 已改為 Cloud Run 固定出口，建議改設 GCP_CORE_API_URL 由 GCP 代開
  API_URL_B2B: "https://www.giveme.com.tw/invoice.do?action=addB2B",
};

/**
 * 以 Core API 取得 Odoo 設定。
 * 您可於 PaoMao_Core 專案：檔案 → 專案設定 → 指令碼屬性 新增：
 *   ODOO_URL（例：https://paomao.odoo.com）、ODOO_DB、ODOO_USERNAME、ODOO_PASSWORD
 */
function getOdooConfig() {
  const p = typeof PropertiesService !== "undefined" ? PropertiesService.getScriptProperties() : null;
  const d = ODOO_CONFIG_DEFAULT;
  if (!p) return Object.assign({}, d);
  return {
    url: (p.getProperty("ODOO_URL") || d.url).trim(),
    db: p.getProperty("ODOO_DB") || d.db,
    username: p.getProperty("ODOO_USERNAME") || d.username,
    password: p.getProperty("ODOO_PASSWORD") || d.password,
  };
}

/**
 * 以 Core API 取得 Giveme 設定。
 * 指令碼屬性可設：GIVEME_UNCODE、GIVEME_IDNO、GIVEME_PASSWORD、GIVEME_PROXY_URL（若仍用 VM）。
 * 建議改設 GCP_CORE_API_URL + GCP_CORE_SECRET_KEY，由 GCP 固定 IP 代開（見 Invoice.js）。
 */
function getGivemeConfig() {
  const p = typeof PropertiesService !== "undefined" ? PropertiesService.getScriptProperties() : null;
  const d = GIVEME_CONFIG_DEFAULT;
  if (!p) return Object.assign({}, d);
  return {
    UNCODE: p.getProperty("GIVEME_UNCODE") || d.UNCODE,
    IDNO: p.getProperty("GIVEME_IDNO") || d.IDNO,
    PASSWORD: p.getProperty("GIVEME_PASSWORD") || d.PASSWORD,
    VM_PROXY_URL: (p.getProperty("GIVEME_PROXY_URL") || d.VM_PROXY_URL).trim(),
    API_URL_B2B: (p.getProperty("GIVEME_API_URL_B2B") || d.API_URL_B2B).trim(),
  };
}

/** 若設 GCP_CORE_API_URL、GCP_CORE_SECRET_KEY，issueInvoice 改由 GCP /core 代開（固定出口 IP） */
function getGcpCoreApiParams() {
  const p = typeof PropertiesService !== "undefined" ? PropertiesService.getScriptProperties() : null;
  if (!p) return { url: "", key: "" };
  const url = (p.getProperty("GCP_CORE_API_URL") || p.getProperty("PAO_CAT_CORE_API_URL") || "").trim();
  const key = (p.getProperty("GCP_CORE_SECRET_KEY") || p.getProperty("PAO_CAT_SECRET_KEY") || "").trim();
  return { url: url, key: key };
}

const ODOO_CONFIG = ODOO_CONFIG_DEFAULT;
const GIVEME_CONFIG = GIVEME_CONFIG_DEFAULT;

// === 以 Core API 取得設定（含 URL）；請款表單等可呼叫 Core.getCoreConfig()，URL 可於 Core 指令碼屬性新增 ===
// LINE token 請在指令碼屬性設定 LINE_TOKEN_PAOPAO、LINE_TOKEN_PAOSTAFF
function getCoreConfig() {
  var p = (typeof PropertiesService !== "undefined") ? PropertiesService.getScriptProperties() : null;
  var adminLineUserId = (p && p.getProperty("ADMIN_LINE_USER_ID")) ? String(p.getProperty("ADMIN_LINE_USER_ID")).trim() : "";
  var lineTokenPaopao = (p && p.getProperty("LINE_TOKEN_PAOPAO")) ? p.getProperty("LINE_TOKEN_PAOPAO").trim() : LINE_TOKEN_PAOPAO;
  var lineTokenPaostaff = (p && p.getProperty("LINE_TOKEN_PAOSTAFF")) ? p.getProperty("LINE_TOKEN_PAOSTAFF").trim() : LINE_TOKEN_PAOSTAFF;
  return {
    LINE_TOKEN_PAOPAO: lineTokenPaopao,
    EXTERNAL_SS_ID: EXTERNAL_SS_ID,
    ADMIN_LINE_USER_ID: adminLineUserId,
    ODOO_CONFIG: getOdooConfig(),
    GIVEME_CONFIG: getGivemeConfig(),
    DAILY_ACCOUNT_REPORT_SS_ID: DAILY_ACCOUNT_REPORT_SS_ID,
    LINE_STORE_SS_ID: LINE_STORE_SS_ID,
    LINE_TOKEN_PAOSTAFF: lineTokenPaostaff,
    LINE_STAFF_SS_ID: LINE_STAFF_SS_ID,
    LINE_HQ_SS_ID: LINE_HQ_SS_ID,
    TOMORROW_BRIEFING_WEB_APP_URL: typeof TOMORROW_BRIEFING_WEB_APP_URL !== "undefined" ? TOMORROW_BRIEFING_WEB_APP_URL : "",
    TIPS_FORM_SS_ID: typeof TIPS_FORM_SS_ID !== "undefined" ? TIPS_FORM_SS_ID : "",
    TIPS_FORM_SHEET_NAME: typeof TIPS_FORM_SHEET_NAME !== "undefined" ? TIPS_FORM_SHEET_NAME : "sheet1",
    TIPS_FORM_SHEET_GID: typeof TIPS_FORM_SHEET_GID !== "undefined" ? TIPS_FORM_SHEET_GID : null,
    TIP_TABLE_SHEET_GID: typeof TIP_TABLE_SHEET_GID !== "undefined" ? TIP_TABLE_SHEET_GID : 1792957916,
    TIPS_CONSOLIDATED_SHEET_GID: typeof TIPS_CONSOLIDATED_SHEET_GID !== "undefined" ? TIPS_CONSOLIDATED_SHEET_GID : 1727178779,
    NEAR_TRACKING_SS_ID: typeof NEAR_TRACKING_SS_ID !== "undefined" ? NEAR_TRACKING_SS_ID : "",
    NEAR_TRACKING_SHEET_NAME: typeof NEAR_TRACKING_SHEET_NAME !== "undefined" ? NEAR_TRACKING_SHEET_NAME : "NearTracking",
  };
}

function clearMyCache() {
  const cache = CacheService.getScriptCache();
  // 移除指定的 Key
  cache.remove("MAP_SAYDOU_INFO");
  console.log("✅ 快取已清除，下次執行會重新抓取資料表");
}
