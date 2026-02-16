/**
 * Staff（員工打卡）關鍵字 → handler 對照表，與 GAS main.js + sendAtt.js 順序一致。
 * 單一來源：改關鍵字或權限只改此表，handler 實作不重複寫 if/順序。
 *
 * GAS 來源：gas/泡泡貓 員工打卡 Line@/main.js, sendAtt.js
 */

/** 匹配類型：exact = 完全一致，includes = 包含即觸發 */
export const MATCH_EXACT = 'exact';
export const MATCH_INCLUDES = 'includes';

/** 權限：all = 已開通即可，manager_only = 僅管理者清單 */
export const PERM_ALL = 'all';
export const PERM_MANAGER_ONLY = 'manager_only';

/**
 * 出勤六關鍵字（GAS attKeywords），完全匹配後由 sendAtt 分派：
 * - 本月出勤：employee → 本人本月 formatAtt；manager → 等同店家今天出勤
 * - 上月出勤：employee → 本人上月 formatAtt；manager → 回「請改用店家上月出勤取得上月出勤 Excel」
 * - 店家今天/本月/上月出勤、店家可預約時間：僅 manager；無 managedStores →「您目前尚未有管理的店家」
 * - 非 manager 打 店家* →「您尚無本行動權限」
 */
export const ATT_KEYWORDS = new Set([
  '店家今天出勤',
  '店家本月出勤',
  '店家上月出勤',
  '本月出勤',
  '上月出勤',
  '店家可預約時間',
]);

/** 非 manager 使用 店家* 時的回覆（與 GAS sendAtt fallback 一致） */
export const MSG_NO_ACTION_PERMISSION = '您尚無本行動權限';

/** 管理者無 managedStores 時的回覆 */
export const MSG_NO_MANAGED_STORES = '您目前尚未有管理的店家';

/** 管理者打「上月出勤」時引導改用店家上月出勤 */
export const MSG_USE_STORE_LAST_MONTH = '請改用「店家上月出勤」取得上月出勤 Excel。';

/**
 * GAS 順序的關鍵字路由表（僅供文件與順序對照，實際 dispatch 在 line-staff-handler）
 * 順序會影響行為（先匹配先處理）。
 */
export const ROUTE_ORDER = [
  { order: 1, match: MATCH_INCLUDES, keyword: '我要了解客人', permission: PERM_ALL },
  { order: 2, match: MATCH_EXACT, keyword: '我要打卡', permission: PERM_ALL }, // server 先攔截
  { order: 2, match: MATCH_EXACT, keyword: '查詢打卡記錄', permission: PERM_ALL },
  { order: 2, match: MATCH_EXACT, keyword: '最新活動', permission: PERM_ALL },
  { order: 2, match: MATCH_EXACT, keyword: '我要開店', permission: PERM_ALL },
  { order: 2, match: MATCH_EXACT, keyword: '特約商店', permission: PERM_ALL },
  { order: 3, match: MATCH_EXACT, keyword: null, permission: PERM_ALL, attKeywords: true },
  { order: 4, match: MATCH_INCLUDES, keyword: '補打卡', permission: PERM_ALL },
  { order: 4, match: MATCH_INCLUDES, keyword: 'Line問題集', permission: PERM_ALL },
  { order: 5, match: MATCH_EXACT, keyword: '神美日報', permission: PERM_ALL },
  { order: 6, match: MATCH_EXACT, keyword: '明日預約', permission: PERM_ALL },
  { order: 7, match: MATCH_EXACT, keyword: '明天預約清單', permission: PERM_ALL },
  { order: 7, match: MATCH_EXACT, keyword: '明日預約清單', permission: PERM_ALL },
  { order: 8, match: MATCH_INCLUDES, keyword: '上月小費', permission: PERM_ALL },
  { order: 9, match: MATCH_INCLUDES, keyword: '店家回覆狀態', permission: PERM_MANAGER_ONLY },
  { order: 10, match: MATCH_EXACT, keyword: null, permission: PERM_MANAGER_ONLY, reportKeyword: true },
  { order: 11, match: MATCH_EXACT, keyword: null, permission: PERM_ALL, workflowLink: true },
];

/** 完全匹配的 switch 關鍵字（GAS main.js switch） */
export const EXACT_SWITCH_KEYWORDS = new Set([
  '我要打卡',
  '查詢打卡記錄',
  '最新活動',
  '我要開店',
  '特約商店',
]);
