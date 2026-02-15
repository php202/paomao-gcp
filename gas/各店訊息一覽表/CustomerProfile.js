/**
 * 各店訊息一覽表 - CRM 整合：以「手機」為唯一 key，彙整多來源 → 一表 + AI 歷程（給 Google AI 產出接待話語）
 *
 * 兩塊資料來源：
 * 1. 員工填寫：泡泡貓｜line@訊息回覆一覽表
 * 2. 客人填寫：客人的消費問卷
 *
 * 整合內容：員工寫的、客人消費完的問卷、客人訊息、消費紀錄、儲值紀錄… → 做成「客人消費狀態」表，
 * AI專用Prompt 欄 = 該客人的完整歷程，傳給 Google AI 可產出「員工可用的接待話語」。
 */

const CONFIG = {
  // ---- 客人問卷（客人消費狀態 D 欄）：試算表 1wAfl4Dipag6Eh8msOYUc0ZUepaeQR_HnQNEcxIVUt3M ----
  CUSTOMER_SHEET_ID: "1wAfl4Dipag6Eh8msOYUc0ZUepaeQR_HnQNEcxIVUt3M",
  CUSTOMER_HISTORY_SHEET_NAME: "sheet1",      // 單一表時使用（若設了 CUSTOMER_HISTORY_SHEET_NAMES 則改從多表拉）
  CUSTOMER_HISTORY_SHEET_NAMES: ["sheet1", "2025前"],  // 兩個工作表，皆以 B 欄（手機號碼）比對
  CUSTOMER_PHONE_COL_IDX: 1,                  // B 欄 = 手機號碼（兩表皆同）
  CUSTOMER_DATE_COL_IDX: 0,

  // ---- 員工填寫：泡泡貓｜line@訊息回覆一覽表（員工幫客人寫的消費完狀態）----
  EMPLOYEE_SHEET_ID: "1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0",
  EMPLOYEE_NOTES_SHEET_NAME: "表單回覆 3",     // 員工填寫的工作表名稱；以「客人手機」欄位做合併
  EMPLOYEE_PHONE_COL_IDX: 1,                  // 該表中「客人手機」在第幾欄 (0=A, 1=B...)
  EMPLOYEE_DATE_COL_IDX: 0,
  EMPLOYEE_MSG_SHEET_NAME: "",                // 若有「客人訊息」專用表可填名稱，留空則不撈

  // ---- 訊息一覽：LINE 對話從此表拉取，欄位 時間 / lineUserId / 店家 / 名字 / 訊息 / 狀態 / 處理人員（可選 手機）----
  MSG_LIST_SHEET_NAME: "訊息一覽",
  MSG_LIST_DATE_COL_IDX: 0,                  // 時間 (0=A)
  MSG_LIST_USERID_COL_IDX: 1,                // lineUserId (1=B)
  MSG_LIST_STORE_COL_IDX: 2,                 // 店家 (2=C)
  MSG_LIST_NAME_COL_IDX: 3,                  // 名字 (3=D)
  MSG_LIST_MSG_COL_IDX: 4,                   // 訊息 (4=E)
  MSG_LIST_STATUS_COL_IDX: 5,                // 狀態 (5=F)
  MSG_LIST_HANDLER_COL_IDX: 6,               // 處理人員 (6=G)
  MSG_LIST_PHONE_COL_IDX: 7,                 // 手機 (7=H)；有填時會掃街寫入客人消費狀態的 lineUserId。若表無此欄設 -1 即不掃

  // ---- 整合表「客人消費狀態」寫入此試算表 ----
  INTEGRATED_SHEET_SS_ID: "1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0",  // 泡泡貓｜line@訊息回覆一覽表
  INTEGRATED_SHEET_NAME: "客人消費狀態",
  INTEGRATED_PHONE_COL: 1,                   // 手機在第幾欄 (0-based)，對應 B 欄
  INTEGRATED_HEADERS: [
    "時間", "手機", "員工填寫", "客人問卷", "line對話", "消費紀錄", "儲值紀錄",
    "saydouUserId", "ai prompt", "lineUserId", "AI分析結果", "ai調整建議",
    "預約記錄", "建議下次回訪日", "最後推播時間", "推播次數", "點擊積分", "連續未點擊", "客戶類型"
  ]
};

// ---------------------------------------------------------------------------
// 訊息一覽：從訊息文字中擷取手機號碼（台灣 09xxxxxxxx），供寫入 H 欄並同步 lineUserId
// ---------------------------------------------------------------------------

/**
 * 從文字中擷取第一個台灣手機號碼（09 開頭），正規化後回傳；無則回傳 null。
 * @param {string} text 訊息內容
 * @returns {string|null} 正規化後手機，例 "0912345678"
 */
function extractPhoneFromText(text) {
  if (text == null || String(text).trim() === "") return null;
  var match = String(text).match(/09[\d\s\-]{8,}/);
  if (!match) return null;
  var digits = match[0].replace(/\D/g, "");
  if (digits.length < 10) return null;
  var raw = digits.slice(0, 10);
  return Core.normalizePhone(raw) || null;
}

/**
 * 將一筆 (手機, lineUserId) 同步到「客人消費狀態」：找到該手機的列，把 lineUserId 合併寫入 lineUserId 欄。
 * 用途：訊息中有提到手機時，寫入訊息一覽 H 欄後呼叫此函式，之後問卷填寫時即可用該手機比對出 lineUserId。
 * @param {string} phone 手機（可未正規化）
 * @param {string} lineUserId LINE 用戶 ID
 */
function syncLineUserIdForPhoneToCustomerState(phone, lineUserId) {
  if (!phone || !lineUserId) return;
  var normalized = Core.normalizePhone(String(phone).trim());
  if (!normalized) return;
  var ss = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
  var sheet = getOrCreateIntegratedSheet(ss);
  var rowIndex = findRowIndexByPhone(sheet, normalized, CONFIG.INTEGRATED_PHONE_COL);
  if (rowIndex === null) return;
  var lineUserIdCol = CONFIG.INTEGRATED_HEADERS.indexOf("lineUserId") + 1;
  if (lineUserIdCol < 1) return;
  var existing = sheet.getRange(rowIndex, lineUserIdCol).getValue();
  existing = (existing != null ? String(existing).trim() : "") || "";
  var ids = parseLineUserIds(existing);
  var set = {};
  ids.forEach(function (id) { set[id] = true; });
  if (!set[lineUserId]) {
    ids.push(lineUserId);
    sheet.getRange(rowIndex, lineUserIdCol).setValue(ids.join(","));
  }
}

// ---------------------------------------------------------------------------
// 1. Upsert：以手機為唯一鍵
// ---------------------------------------------------------------------------

/** 從客人消費狀態某一列讀取既有回訪追蹤欄位（供 buildIntegratedRow 保留） */
function getExistingReengagementFromRow(sheet, rowIndex) {
  if (!sheet || !rowIndex) return null;
  var h = CONFIG.INTEGRATED_HEADERS;
  var lastPushIdx = h.indexOf("最後推播時間") + 1;
  var pushCountIdx = h.indexOf("推播次數") + 1;
  var clickScoreIdx = h.indexOf("點擊積分") + 1;
  var consecutiveIdx = h.indexOf("連續未點擊") + 1;
  var customerTypeIdx = h.indexOf("客戶類型") + 1;
  if (lastPushIdx < 1 || pushCountIdx < 1) return null;
  try {
    var lastPushTime = sheet.getRange(rowIndex, lastPushIdx).getValue();
    var pushCount = sheet.getRange(rowIndex, pushCountIdx).getValue();
    var clickScore = sheet.getRange(rowIndex, clickScoreIdx).getValue();
    var consecutiveNoClick = sheet.getRange(rowIndex, consecutiveIdx).getValue();
    var customerType = sheet.getRange(rowIndex, customerTypeIdx).getValue();
    return {
      lastPushTime: lastPushTime != null ? String(lastPushTime).trim() : "",
      pushCount: pushCount != null ? String(pushCount).trim() : "",
      clickScore: clickScore != null ? String(clickScore).trim() : "",
      consecutiveNoClick: consecutiveNoClick != null ? String(consecutiveNoClick).trim() : "",
      customerType: customerType != null ? String(customerType).trim() : "自動提醒"
    };
  } catch (e) { return null; }
}

function findRowIndexByPhone(sheet, phone, phoneColIdx) {
  if (!sheet || !phone) return null;
  const phoneCol = (phoneColIdx !== undefined ? phoneColIdx : CONFIG.INTEGRATED_PHONE_COL) + 1;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const colValues = sheet.getRange(2, phoneCol, lastRow, phoneCol).getValues().map(function (r) { return r[0]; });
  const normalized = Core.normalizePhone(phone);
  if (!normalized) return null;
  for (let i = 0; i < colValues.length; i++) {
    if (Core.normalizePhone(String(colValues[i])) === normalized) return i + 2;
  }
  return null;
}

function getOrCreateIntegratedSheet(ss) {
  let sheet = ss.getSheetByName(CONFIG.INTEGRATED_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.INTEGRATED_SHEET_NAME);
    sheet.appendRow(CONFIG.INTEGRATED_HEADERS);
  } else if (sheet.getLastColumn() < CONFIG.INTEGRATED_HEADERS.length) {
    sheet.getRange(1, 1, 1, CONFIG.INTEGRATED_HEADERS.length).setValues([CONFIG.INTEGRATED_HEADERS]);
  }
  return sheet;
}

/**
 * Upsert 一筆整合資料：依手機，有則更新該列，無則新增
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss 客人問卷試算表（整合表寫在這裡）
 * @param {string} phone 正規化後手機
 * @param {Array} rowData 一列，順序同 INTEGRATED_HEADERS
 */
function upsertCustomerRow(ss, phone, rowData) {
  const sheet = getOrCreateIntegratedSheet(ss);
  const numCols = CONFIG.INTEGRATED_HEADERS.length;
  const row = rowData.length >= numCols
    ? rowData.slice(0, numCols)
    : rowData.concat(Array(numCols - rowData.length).fill(""));
  const rowIndex = findRowIndexByPhone(sheet, phone, CONFIG.INTEGRATED_PHONE_COL);
  if (rowIndex !== null) {
    var lineUserIdIdx = CONFIG.INTEGRATED_HEADERS.indexOf("lineUserId");
    if (lineUserIdIdx >= 0 && (!row[lineUserIdIdx] || String(row[lineUserIdIdx]).trim() === "")) {
      var existing = sheet.getRange(rowIndex, lineUserIdIdx + 1).getValue();
      if (existing != null && String(existing).trim() !== "") row[lineUserIdIdx] = String(existing).trim();
    }
    sheet.getRange(rowIndex, 1, 1, numCols).setValues([row]);
    console.log("客人消費狀態：已更新列 " + rowIndex + "（手機 " + phone + "）");
  } else {
    sheet.appendRow(row);
    console.log("客人消費狀態：已新增一列（手機 " + phone + "）");
  }
}

// ---------------------------------------------------------------------------
// 2. 撈取「客人問卷」全歷史（客人填寫的試算表；可從多個工作表拉，含 name 2025 及 2025 前）
// ---------------------------------------------------------------------------

/**
 * 從單一工作表撈出該手機的問卷列（不排序）
 */
function getQuestionnaireRowsFromSheet(sheet, phone, phoneIdx, dateIdx) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const normalized = Core.normalizePhone(phone);
  if (!normalized) return [];
  const data = sheet.getRange(2, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  return data.filter(function (row) {
    return Core.normalizePhone(String(row[phoneIdx] || "")) === normalized;
  });
}

/**
 * 從客人填寫問卷試算表拉取該手機的全歷史；若設有 CUSTOMER_HISTORY_SHEET_NAMES 則從多表拉（含 2025 及 2025 前）
 */
function getAllQuestionnaireHistoryByPhone(ss, phone) {
  const normalized = Core.normalizePhone(phone);
  if (!normalized) return [];
  const phoneIdx = CONFIG.CUSTOMER_PHONE_COL_IDX;
  const dateIdx = CONFIG.CUSTOMER_DATE_COL_IDX;
  let all = [];

  if (CONFIG.CUSTOMER_HISTORY_SHEET_NAMES && CONFIG.CUSTOMER_HISTORY_SHEET_NAMES.length > 0) {
    CONFIG.CUSTOMER_HISTORY_SHEET_NAMES.forEach(function (sheetName) {
      const sheet = ss.getSheetByName(sheetName);
      if (sheet) {
        const rows = getQuestionnaireRowsFromSheet(sheet, phone, phoneIdx, dateIdx);
        all = all.concat(rows);
      }
    });
  } else {
    const sheet = ss.getSheetByName(CONFIG.CUSTOMER_HISTORY_SHEET_NAME);
    all = getQuestionnaireRowsFromSheet(sheet, phone, phoneIdx, dateIdx);
  }

  all.sort(function (a, b) {
    return (new Date(a[dateIdx] || 0).getTime()) - (new Date(b[dateIdx] || 0).getTime());
  });
  return all;
}

// ---------------------------------------------------------------------------
// 3. 撈取「員工填寫」紀錄（員工試算表）
// ---------------------------------------------------------------------------

/**
 * 從員工試算表撈出該手機的所有員工填寫紀錄（依時間排序）
 * @returns {Array<Array>} 每筆一列
 */
function getAllEmployeeNotesByPhone(phone) {
  const ss = SpreadsheetApp.openById(CONFIG.EMPLOYEE_SHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.EMPLOYEE_NOTES_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const normalized = Core.normalizePhone(phone);
  if (!normalized) return [];
  const data = sheet.getRange(2, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const phoneIdx = CONFIG.EMPLOYEE_PHONE_COL_IDX;
  const dateIdx = CONFIG.EMPLOYEE_DATE_COL_IDX;
  const filtered = data.filter(function (row) {
    return Core.normalizePhone(String(row[phoneIdx] || "")) === normalized;
  });
  filtered.sort(function (a, b) {
    return (new Date(a[dateIdx] || 0).getTime()) - (new Date(b[dateIdx] || 0).getTime());
  });
  return filtered;
}

/**
 * 取得員工填寫工作表（表單回覆 3）第 1 列的欄位名稱，供細項字串與統計用
 * @returns {string[]} 欄位名稱陣列
 */
function getEmployeeNoteHeaders() {
  try {
    const ss = SpreadsheetApp.openById(CONFIG.EMPLOYEE_SHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.EMPLOYEE_NOTES_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 1) return [];
    const lastCol = sheet.getLastColumn();
    if (lastCol < 1) return [];
    const row1 = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    return row1.map(function (cell) { return (cell != null ? String(cell).trim() : "") || ""; });
  } catch (e) {
    return [];
  }
}

/**
 * 將一筆員工填寫列格式化成「欄位名: 值」字串，方便後續統計
 * @param {Array} row - 一列資料
 * @param {string[]} headers - 欄位名稱（與 row 同長度或更長）
 * @returns {string}
 */
function formatEmployeeRowAsDetailString(row, headers) {
  if (!row || row.length === 0) return "";
  const parts = [];
  for (let i = 0; i < row.length; i++) {
    const label = (headers && headers[i]) ? headers[i] : "欄位" + i;
    const val = row[i] != null ? String(row[i]).trim() : "";
    if (label) parts.push(label + ": " + val);
  }
  return parts.join(" | ");
}

/**
 * 解析 lineUserId 字串為陣列（同一客人可能來自不同 line@，填寫為 "U1,U2" 或 "U1;U2"）
 * @param {string} s 例："U123,U456" 或 "U123; U456"
 * @returns {string[]} 例：["U123","U456"]
 */
function parseLineUserIds(s) {
  if (s == null || String(s).trim() === "") return [];
  return String(s).split(/[,;]/).map(function (x) { return x.trim(); }).filter(Boolean);
}

/**
 * 從「訊息一覽」依 LINE 用戶 ID 陣列 [a,b,...] 拉取訊息（同一客人可能有多個 line@ ID）
 * @param {string[]} userIds 例：["U123","U456"]
 * @returns {Array<Array>} 每筆一列；無表或無資料則回傳 []
 */
function getCustomerMessagesByUserIds(userIds) {
  if (!userIds || userIds.length === 0) return [];
  if (!CONFIG.MSG_LIST_SHEET_NAME) return [];
  const ss = SpreadsheetApp.openById(CONFIG.EMPLOYEE_SHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.MSG_LIST_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getRange(2, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const uidIdx = CONFIG.MSG_LIST_USERID_COL_IDX;
  const dateIdx = CONFIG.MSG_LIST_DATE_COL_IDX;
  const idSet = {};
  userIds.forEach(function (id) { idSet[String(id).trim()] = true; });
  const filtered = data.filter(function (row) {
    const val = String(row[uidIdx] || "").trim();
    return idSet[val];
  });
  filtered.sort(function (a, b) {
    return (new Date(a[dateIdx] || 0).getTime()) - (new Date(b[dateIdx] || 0).getTime());
  });
  return filtered;
}

/**
 * 將訊息一覽的列格式化成【客人訊息】區塊文字（時間 / lineUserId / 店家 / 名字 / 訊息 / 狀態 / 處理人員）
 * @param {Array<Array>} rows 每筆一列，欄位依 CONFIG.MSG_LIST_* 索引
 * @returns {string}
 */
function formatMessageRowsForPrompt(rows) {
  if (!rows || rows.length === 0) return "（尚無）";
  const dateIdx = CONFIG.MSG_LIST_DATE_COL_IDX;
  const uidIdx = CONFIG.MSG_LIST_USERID_COL_IDX;
  const storeIdx = CONFIG.MSG_LIST_STORE_COL_IDX;
  const nameIdx = CONFIG.MSG_LIST_NAME_COL_IDX;
  const msgIdx = CONFIG.MSG_LIST_MSG_COL_IDX;
  const statusIdx = CONFIG.MSG_LIST_STATUS_COL_IDX != null ? CONFIG.MSG_LIST_STATUS_COL_IDX : -1;
  const handlerIdx = CONFIG.MSG_LIST_HANDLER_COL_IDX != null ? CONFIG.MSG_LIST_HANDLER_COL_IDX : -1;
  const lines = [];
  rows.forEach(function (row, i) {
    const timeStr = row[dateIdx] != null ? String(row[dateIdx]).trim() : "";
    const uid = row[uidIdx] != null ? String(row[uidIdx]).trim() : "";
    const store = row[storeIdx] != null ? String(row[storeIdx]).trim() : "";
    const name = row[nameIdx] != null ? String(row[nameIdx]).trim() : "";
    const msg = row[msgIdx] != null ? String(row[msgIdx]).trim() : "";
    const parts = [timeStr, uid, store, name, msg];
    if (statusIdx >= 0 && row[statusIdx] != null) parts.push(String(row[statusIdx]).trim());
    if (handlerIdx >= 0 && row[handlerIdx] != null) parts.push(String(row[handlerIdx]).trim());
    lines.push("--- " + (i + 1) + " ---");
    lines.push(parts.filter(Boolean).join("\t"));
  });
  return lines.join("\n");
}

/**
 * 將訊息一覽的列格式化成「客人訊息摘要」儲存格文字（有 lineUserId 時顯示該 ID 講過的話）
 * @param {Array<Array>} rows 每筆一列
 * @returns {string}
 */
function formatMessagesForSummary(rows) {
  if (!rows || rows.length === 0) return "—";
  const maxLen = 8000;
  const text = formatMessageRowsForPrompt(rows);
  if (text.length > maxLen) {
    return text.slice(0, maxLen) + "\n…（詳見 AI專用Prompt）";
  }
  return text;
}

/**
 * 將現有 AI專用Prompt 中的【客人訊息】區塊替換成新內容（其餘不變）
 * @param {string} currentPrompt 現有 AI專用Prompt 全文
 * @param {string} newMessagesBlock 新的【客人訊息】區塊內容（不含標題行）
 * @returns {string}
 */
function replaceMessagesSectionInPrompt(currentPrompt, newMessagesBlock) {
  if (!currentPrompt || typeof currentPrompt !== "string") return currentPrompt;
  const marker = "【客人訊息】";
  const idx = currentPrompt.indexOf(marker);
  if (idx === -1) {
    return currentPrompt + "\n\n" + marker + "\n" + newMessagesBlock;
  }
  const afterMarker = idx + marker.length;
  const nextSection = currentPrompt.indexOf("【", afterMarker);
  const end = nextSection === -1 ? currentPrompt.length : nextSection;
  const before = currentPrompt.slice(0, afterMarker);
  const after = currentPrompt.slice(end);
  return before + "\n" + newMessagesBlock + (after ? "\n\n" + after : "");
}

/**
 * 若有「客人訊息」表（舊：依手機），撈出該手機的訊息紀錄
 * @returns {Array<Array>} 每筆一列；無表或無欄位則回傳 []
 */
function getCustomerMessagesByPhone(phone) {
  if (!CONFIG.EMPLOYEE_MSG_SHEET_NAME) return [];
  const ss = SpreadsheetApp.openById(CONFIG.EMPLOYEE_SHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.EMPLOYEE_MSG_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const normalized = Core.normalizePhone(phone);
  if (!normalized) return [];
  const data = sheet.getRange(2, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const phoneIdx = CONFIG.EMPLOYEE_PHONE_COL_IDX;
  const dateIdx = 0;
  const filtered = data.filter(function (row) {
    return Core.normalizePhone(String(row[phoneIdx] || "")) === normalized;
  });
  filtered.sort(function (a, b) {
    return (new Date(a[dateIdx] || 0).getTime()) - (new Date(b[dateIdx] || 0).getTime());
  });
  return filtered;
}

// ---------------------------------------------------------------------------
// 4. SayDou：消費／儲值摘要（Core）
// ---------------------------------------------------------------------------

/**
 * 取得該手機的 SayDou 消費與儲值摘要（供表格與 AI 使用）
 * 消費紀錄由 Core.getMemberHistorySummary 產出，每筆含：日期、門店、金額、項目、付費方式（現金/LINE/轉帳/儲值金/信用卡等）、備註。
 * @returns {{ consumeText: string, storeText: string, member: object|null }}
 */
var CONSUME_TEXT_MAX_LEN = 5000; // F 欄「消費紀錄」顯示字數上限（含付費方式，勿過短以免截掉每行結尾的付費解析）

function getSayDouSummary(phone) {
  let consumeText = "—";
  let storeText = "—";
  let member = null;
  if (typeof Core.getMemberHistorySummary === "function") {
    try {
      const summary = Core.getMemberHistorySummary(phone);
      if (summary && summary.items) consumeText = String(summary.items).slice(0, CONSUME_TEXT_MAX_LEN);
      if (summary && summary.lastDate) consumeText = (consumeText === "—" ? "" : consumeText + " | ") + "最近：" + summary.lastDate;
    } catch (e) { console.warn("getMemberHistorySummary:", e); }
  }
  if (typeof Core.getMemApi === "function") {
    try {
      member = Core.getMemApi(phone);
      if (member) {
        if (member.stcash != null) storeText = "儲值 " + member.stcash;
        if (member.memnam) storeText = (storeText === "—" ? "" : storeText + " | ") + member.memnam;
      }
    } catch (e) { console.warn("getMemApi:", e); }
  }
  return { consumeText: consumeText, storeText: storeText, member: member };
}

/**
 * 取得「儲值紀錄」(加值) ＋「儲值金消費紀錄」(使用) 合併後的文字（供 AI 專用 Prompt 列出）
 * @param {number} membid SayDou 會員 ID
 * @returns {string}
 */
function getStorecashMergedSummary(membid) {
  if (!membid || typeof Core.getAllStorecashAddRecordByMembid !== "function" || typeof Core.getAllStorecashUseRecordByMembid !== "function") return "（尚無）";
  let addItems = [];
  let useItems = [];
  try {
    addItems = Core.getAllStorecashAddRecordByMembid(membid, 20) || [];
    useItems = Core.getAllStorecashUseRecordByMembid(membid, 20) || [];
  } catch (e) {
    console.warn("getStorecashMergedSummary:", e);
    return "（尚無）";
  }
  const list = [];
  if (addItems.length > 0) {
    addItems.forEach(function (o) {
      list.push({
        rectim: o.rectim || o.cretim || "",
        typeLabel: "儲值",
        stonam: o.stonam || (o.stor && o.stor.stonam) || "",
        amount: o.price_ != null ? o.price_ : (o.stoval != null ? o.stoval : 0),
        remark: o.sremark || o.remark || ""
      });
    });
  }
  if (useItems.length > 0) {
    useItems.forEach(function (o) {
      list.push({
        rectim: o.rectim || o.cretim || "",
        typeLabel: "使用",
        stonam: (o.stor && o.stor.stonam) ? o.stor.stonam : "",
        amount: o.stoval != null ? o.stoval : 0,
        remark: o.remark || ""
      });
    });
  }
  list.sort(function (a, b) {
    return (new Date(b.rectim || 0).getTime()) - (new Date(a.rectim || 0).getTime());
  });
  if (list.length === 0) return "（尚無）";
  const lines = [];
  const maxShow = 30;
  for (let i = 0; i < Math.min(list.length, maxShow); i++) {
    const o = list[i];
    const dateStr = o.rectim || "";
    const typeLabel = o.typeLabel || "—";
    const store = o.stonam || "";
    const amount = o.amount != null ? o.amount : 0;
    const remark = o.remark ? " " + o.remark : "";
    lines.push(dateStr + " " + typeLabel + " " + store + " $" + amount + remark);
  }
  if (list.length > maxShow) lines.push("…共 " + list.length + " 筆");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 5. 資料整合：aggregateCustomerData(phone) → 給 AI 戰報用的 Prompt 上下文
// ---------------------------------------------------------------------------

/** 過濾太短的 Line 訊息（如 "ok"、"好"），最小字元數 */
var AGGREGATE_MSG_MIN_LEN = 2;
/** 視為雜訊的短訊息關鍵字（不分大小寫） */
var AGGREGATE_MSG_NOISE = ["ok", "好", "嗯", "是", "喔", "收到", "好喔"];

/**
 * 從最近幾筆消費紀錄計算「消費間隔」（本次距上次、歷次回訪間隔），供 AI 在剛結帳（間隔 0 天）時另依歷次節奏關心最近保養狀況。
 * @param {Array<{date:string}>} consumeItems 最近 N 筆消費（每筆含 date，由近到遠）
 * @param {string} todayStr 今天日期 yyyy-MM-dd
 * @returns {string} 一段文字，無則回傳 ""
 */
function buildConsumptionIntervalsForPrompt(consumeItems, todayStr) {
  if (!consumeItems || consumeItems.length === 0) return "";
  var parseDate = function (s) {
    if (s == null || s === "") return null;
    var str = String(s).trim();
    if (str.length >= 10) str = str.slice(0, 10);
    var d = new Date(str + "T00:00:00");
    return isNaN(d.getTime()) ? null : d;
  };
  var today = parseDate(todayStr);
  if (!today) return "";
  var dayMs = 24 * 60 * 60 * 1000;
  var dates = [];
  for (var i = 0; i < consumeItems.length; i++) {
    var d = parseDate(consumeItems[i].date);
    if (d) dates.push(d);
  }
  if (dates.length === 0) return "";
  var parts = [];
  var daysToLast = Math.round((today.getTime() - dates[0].getTime()) / dayMs);
  parts.push("本次距上次消費：" + daysToLast + " 天" + (daysToLast === 0 ? "（剛結帳／剛填表單）" : ""));
  if (dates.length >= 2) {
    var gaps = [];
    for (var j = 0; j < dates.length - 1; j++) {
      var gap = Math.round((dates[j].getTime() - dates[j + 1].getTime()) / dayMs);
      gaps.push(gap);
    }
    parts.push("歷次回訪間隔（天）：" + gaps.join("、"));
    parts.push("可據此關心最近保養狀況與回訪節奏；若為剛結帳可提醒居家保養與下次預約。");
  }
  return "【消費間隔】" + parts.join("；") + "。";
}

/**
 * 以手機為 key 聚合多來源資料，產出給 AI 的 Prompt 上下文字串（含問卷最新一筆、消費最近 5 筆含備註、Line 最近 10 筆過濾短訊＋時間戳記）
 * @param {string} phone 客人手機（會正規化）
 * @returns {string} 包含【主表】、【問卷】、【消費紀錄】、【Line訊息】的完整字串，供傳送給 OpenAI/Gemini 分析
 */
function aggregateCustomerData(phone) {
  const normalized = Core.normalizePhone(phone);
  if (!normalized) return "";

  const customerSs = SpreadsheetApp.openById(CONFIG.CUSTOMER_SHEET_ID);
  const integratedSs = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
  const sheet = getOrCreateIntegratedSheet(integratedSs);
  const rowIndex = findRowIndexByPhone(sheet, normalized, CONFIG.INTEGRATED_PHONE_COL);
  const headers = CONFIG.INTEGRATED_HEADERS;
  const lineUserIdCol = headers.indexOf("lineUserId") + 1;

  let existingLineUserId = "";
  if (rowIndex !== null) {
    try {
      const val = sheet.getRange(rowIndex, lineUserIdCol).getValue();
      existingLineUserId = (val != null && String(val).trim() !== "") ? String(val).trim() : "";
    } catch (e) {}
  }

  const lines = [];

  lines.push("【主表：客人消費狀態】");
  lines.push("手機：" + normalized);
  if (rowIndex !== null) {
    const timeCol = 1;
    const phoneCol = 2;
    const empCol = headers.indexOf("員工填寫") + 1;
    const questCol = headers.indexOf("客人問卷") + 1;
    const consumeCol = headers.indexOf("消費紀錄") + 1;
    const aiPromptCol = headers.indexOf("ai prompt") + 1;
    lines.push("更新時間：" + (sheet.getRange(rowIndex, timeCol).getValue() || "—"));
    lines.push("員工填寫摘要：" + (sheet.getRange(rowIndex, empCol).getValue() || "—").toString().slice(0, 500));
    lines.push("客人問卷摘要：" + (sheet.getRange(rowIndex, questCol).getValue() || "—").toString().slice(0, 500));
    lines.push("消費紀錄摘要：" + (sheet.getRange(rowIndex, consumeCol).getValue() || "—").toString().slice(0, 500));
    const fullPrompt = sheet.getRange(rowIndex, aiPromptCol).getValue();
    if (fullPrompt && String(fullPrompt).trim()) {
      lines.push("ai prompt（節錄）：" + String(fullPrompt).trim().slice(0, 1500));
    }
  } else {
    lines.push("（此手機尚無整合列）");
  }

  lines.push("");
  lines.push("【問卷表：該手機最新一筆問卷】");
  const questionnaireHistory = getAllQuestionnaireHistoryByPhone(customerSs, normalized);
  if (questionnaireHistory && questionnaireHistory.length > 0) {
    const last = questionnaireHistory[questionnaireHistory.length - 1];
    const dateIdx = CONFIG.CUSTOMER_DATE_COL_IDX;
    const dateStr = last[dateIdx] ? Utilities.formatDate(new Date(last[dateIdx]), "Asia/Taipei", "yyyy/MM/dd") : "";
    lines.push("日期：" + dateStr);
    lines.push("內容：" + last.join(" | "));
  } else {
    lines.push("（尚無）");
  }

  lines.push("");
  lines.push("【消費紀錄表：SayDou 最近 5 筆（日期、項目、金額、備註）】");
  let consumeItems = [];
  if (typeof Core.getMemberRecentTransactionsForPrompt === "function") {
    try {
      consumeItems = Core.getMemberRecentTransactionsForPrompt(normalized, 5);
    } catch (e) { console.warn("getMemberRecentTransactionsForPrompt:", e); }
  }
  if (consumeItems && consumeItems.length > 0) {
    consumeItems.forEach(function (o, i) {
      const paymentPart = o.payment ? " " + o.payment : "";
      const remarkPart = o.remark ? " 備註：" + o.remark : "";
      lines.push((i + 1) + ". " + o.date + " " + o.store + " " + o.item + " $" + o.amount + paymentPart + remarkPart);
    });
  } else {
    lines.push("（尚無）");
  }

  lines.push("");
  lines.push("【AI 用：今日與上次消費／客群推斷】");
  var todayStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd");
  lines.push("今天日期：" + todayStr);
  if (consumeItems && consumeItems.length > 0) {
    var lastConsumeDate = consumeItems[0].date;
    if (lastConsumeDate) {
      var d = String(lastConsumeDate).trim();
      if (d.length >= 10) d = d.slice(0, 10);
      lines.push("上次消費日期：" + d);
    } else {
      lines.push("上次消費日期：（無）");
    }
    // 針對每次消費做時間長短觀察：填表單可能剛結完帳（間隔 0 天），另提供歷次回訪間隔供 AI 關心最近保養狀況
    var intervalBlock = buildConsumptionIntervalsForPrompt(consumeItems, todayStr);
    if (intervalBlock) lines.push(intervalBlock);
  } else {
    lines.push("上次消費日期：（無）");
  }
  lines.push("請從上述問卷與員工填寫中推斷：年齡層（如 20-25、26-35、30-45 歲）、性別（男/女）、特殊標籤（有小孩、學生、上班族、主婦等）。若 SayDou 會員資料有年齡也請納入。（提醒：在 SayDou 拉會員時填寫年齡，以便 AI 話題客製化。）");

  lines.push("");
  lines.push("【Line 訊息表：該 UserID 最近 10 筆（已過濾太短訊息，含時間戳記）】");
  const lineIds = parseLineUserIds(existingLineUserId);
  let messageRows = [];
  if (lineIds.length > 0) {
    messageRows = getCustomerMessagesByUserIds(lineIds);
  }
  const dateIdx = CONFIG.MSG_LIST_DATE_COL_IDX;
  const uidIdx = CONFIG.MSG_LIST_USERID_COL_IDX;
  const nameIdx = CONFIG.MSG_LIST_NAME_COL_IDX;
  const msgIdx = CONFIG.MSG_LIST_MSG_COL_IDX;
  const msgFiltered = (messageRows || []).filter(function (row) {
    const msg = (row[msgIdx] != null ? String(row[msgIdx]).trim() : "");
    if (msg.length < AGGREGATE_MSG_MIN_LEN) return false;
    const lower = msg.toLowerCase();
    if (AGGREGATE_MSG_NOISE.some(function (n) { return lower === n || lower === n.trim(); })) return false;
    return true;
  });
  const last10 = msgFiltered.slice(-10);
  if (last10.length > 0) {
    last10.forEach(function (row, i) {
      const timeStr = row[dateIdx] != null ? String(row[dateIdx]).trim() : "";
      const uid = row[uidIdx] != null ? String(row[uidIdx]).trim() : "";
      const name = row[nameIdx] != null ? String(row[nameIdx]).trim() : "";
      const msg = row[msgIdx] != null ? String(row[msgIdx]).trim() : "";
      lines.push((i + 1) + ". " + timeStr + " | " + uid + " | " + name + " | " + msg);
    });
  } else {
    lines.push("（尚無或已過濾）");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 6. 組合成「給 Google AI 的完整歷程」文本（可再傳給 AI 產出接待話語）
// ---------------------------------------------------------------------------

/**
 * 將多來源組合成一段「客人歷程」文本，寫入 AI專用Prompt，供 Google AI 產出接待話語
 * @param {string} [storecashRecordText] 儲值紀錄＋儲值金消費紀錄合併文字（由 getStorecashMergedSummary 產出）
 */
function buildIntegratedAIPrompt(employeeNotes, questionnaireHistory, messages, saydouSummary, currentSubmission, storecashRecordText) {
  const lines = [];

  lines.push("【員工填寫紀錄】");
  if (employeeNotes && employeeNotes.length > 0) {
    const empHeaders = getEmployeeNoteHeaders();
    employeeNotes.forEach(function (row, i) {
      const date = row[CONFIG.EMPLOYEE_DATE_COL_IDX];
      const dateStr = date ? Utilities.formatDate(new Date(date), "Asia/Taipei", "yyyy/MM/dd") : "";
      lines.push("--- 第" + (i + 1) + "次 " + dateStr + " ---");
      lines.push(formatEmployeeRowAsDetailString(row, empHeaders));
    });
  } else {
    lines.push("（尚無）");
  }

  lines.push("");
  lines.push("【客人問卷演變】");
  if (questionnaireHistory && questionnaireHistory.length > 0) {
    questionnaireHistory.forEach(function (row, i) {
      const date = row[CONFIG.CUSTOMER_DATE_COL_IDX];
      const dateStr = date ? Utilities.formatDate(new Date(date), "Asia/Taipei", "yyyy/MM/dd") : "";
      lines.push("--- 第" + (i + 1) + "次 " + dateStr + " ---");
      lines.push(row.join(" | "));
    });
  } else {
    lines.push("（尚無）");
  }

  if (currentSubmission && Object.keys(currentSubmission).length > 0) {
    lines.push("【本次問卷】");
    if (currentSubmission.score) lines.push("喜好度：" + currentSubmission.score + "/5");
    if (currentSubmission.skinType) lines.push("肌膚類型：" + currentSubmission.skinType);
    if (currentSubmission.recommend) lines.push("推薦項目：" + currentSubmission.recommend);
    if (currentSubmission.note) lines.push("產品/備註：" + currentSubmission.note);
    if (currentSubmission.gossip) lines.push("今日紀錄：" + currentSubmission.gossip);
  }

  if (messages && messages.length > 0) {
    lines.push("");
    lines.push("【客人訊息】");
    messages.forEach(function (row, i) {
      lines.push("--- " + (i + 1) + " ---");
      lines.push(row.join(" | "));
    });
  }

  lines.push("");
  lines.push("【SayDou 消費／儲值】");
  lines.push("消費：" + (saydouSummary.consumeText || "—"));
  lines.push("儲值：" + (saydouSummary.storeText || "—"));
  lines.push("");
  lines.push("【SayDou 儲值紀錄／儲值金消費紀錄】");
  lines.push(storecashRecordText && storecashRecordText.trim() ? storecashRecordText : "（尚無）");

  return lines.join("\n");
}

/** 將員工填寫紀錄格式化成一段文字（細項為「欄位名: 值」字串），供寫入「員工填寫摘要」C 欄與後續統計（過長則截斷） */
function formatEmployeeNotesForSummary(employeeNotes) {
  if (!employeeNotes || employeeNotes.length === 0) return "—";
  const maxLen = 8000;
  const empHeaders = getEmployeeNoteHeaders();
  const lines = [];
  employeeNotes.forEach(function (row, i) {
    const date = row[CONFIG.EMPLOYEE_DATE_COL_IDX];
    const dateStr = date ? Utilities.formatDate(new Date(date), "Asia/Taipei", "yyyy/MM/dd") : "";
    lines.push("--- 第" + (i + 1) + "次 " + dateStr + " ---");
    lines.push(formatEmployeeRowAsDetailString(row, empHeaders));
  });
  const text = lines.join("\n");
  if (text.length > maxLen) {
    return text.slice(0, maxLen) + "\n…（詳見 AI專用Prompt）";
  }
  return text;
}

/** 將客人問卷紀錄格式化成一段文字，供寫入「客人問卷摘要」D 欄（sheet1、2025前 拉取的資料，過長則截斷） */
function formatQuestionnaireForSummary(questionnaireHistory) {
  if (!questionnaireHistory || questionnaireHistory.length === 0) return "—";
  const maxLen = 8000;
  const lines = [];
  questionnaireHistory.forEach(function (row, i) {
    const date = row[CONFIG.CUSTOMER_DATE_COL_IDX];
    const dateStr = date ? Utilities.formatDate(new Date(date), "Asia/Taipei", "yyyy/MM/dd") : "";
    lines.push("--- 第" + (i + 1) + "次 " + dateStr + " ---");
    lines.push(row.join(" | "));
  });
  const text = lines.join("\n");
  if (text.length > maxLen) {
    return text.slice(0, maxLen) + "\n…（詳見 AI專用Prompt）";
  }
  return text;
}

/**
 * 依手機彙整所有來源，回傳一列整合資料（順序同 INTEGRATED_HEADERS）
 * @param {string} phone 正規化後手機
 * @param {string} timestamp 更新時間
 * @param {object|null} currentSubmission 本次問卷（可 null）
 * @param {string} [existingLineUserId] 既有 lineUserId（可多個，逗號或分號分隔），用 [a,b,...] 從訊息一覽拉取；更新時保留此欄
 * @param {object} [existingReengagement] 既有回訪追蹤欄位，更新時保留
 */
function buildIntegratedRow(phone, timestamp, currentSubmission, existingLineUserId, existingReengagement) {
  const customerSs = SpreadsheetApp.openById(CONFIG.CUSTOMER_SHEET_ID);
  const questionnaireHistory = getAllQuestionnaireHistoryByPhone(customerSs, phone);
  const employeeNotes = getAllEmployeeNotesByPhone(phone);
  // 若有既有 lineUserId，用 [a,b,...] 從「訊息一覽」拉取 LINE 對話；否則不撈
  const lineIds = parseLineUserIds(existingLineUserId);
  const messages = lineIds.length > 0 ? getCustomerMessagesByUserIds(lineIds) : [];
  const saydouSummary = getSayDouSummary(phone);
  const storecashRecordText = saydouSummary.member && saydouSummary.member.membid
    ? getStorecashMergedSummary(saydouSummary.member.membid)
    : "（尚無）";

  const aiPromptText = buildIntegratedAIPrompt(
    employeeNotes,
    questionnaireHistory,
    messages,
    saydouSummary,
    currentSubmission,
    storecashRecordText
  );

  const employeeSummary = formatEmployeeNotesForSummary(employeeNotes);
  const questionnaireSummary = formatQuestionnaireForSummary(questionnaireHistory);
  // 有 lineUserId 時，從「訊息一覽」拉取該 ID 講過的話，寫入客人訊息摘要
  const msgSummary = formatMessagesForSummary(messages);

  const saydouUserId = saydouSummary.member && saydouSummary.member.membid ? String(saydouSummary.member.membid) : "—";
  const lineUserIdVal = (existingLineUserId != null && String(existingLineUserId).trim() !== "") ? String(existingLineUserId).trim() : "";
  // G 欄「SayDou儲值」：顯示儲值紀錄＋儲值金消費紀錄（與 AI專用Prompt 同內容）；過長則截斷
  const storecashForG = storecashRecordText && storecashRecordText.trim() && storecashRecordText !== "（尚無）"
    ? (storecashRecordText.length > 8000 ? storecashRecordText.slice(0, 8000) + "\n…（詳見 AI專用Prompt）" : storecashRecordText)
    : (saydouSummary.storeText || "—");

  // 預約記錄、建議下次回訪日（由 Core API 計算）
  var reservationRecordText = "—";
  var suggestedNextVisit = "";
  if (saydouSummary.member && saydouSummary.member.membid) {
    try {
      var reservations = typeof Core.getReservationRecordByMembid === "function"
        ? Core.getReservationRecordByMembid(saydouSummary.member.membid) : [];
      if (reservations && reservations.length > 0) {
        reservationRecordText = reservations.map(function (r) {
          var d = (r.rsvtim || "").slice(0, 16);
          return d + " " + (r.stonam || "");
        }).join("\n");
      }
    } catch (e) { console.warn("getReservationRecordByMembid:", e); }
    try {
      var transactions = typeof Core.getAllTransactionsByMembid === "function"
        ? Core.getAllTransactionsByMembid(saydouSummary.member.membid, 50) : [];
      if (transactions && transactions.length > 0) {
        var freq = typeof Core.calculateConsumptionFrequency === "function"
          ? Core.calculateConsumptionFrequency(transactions) : 30;
        var lastDate = transactions[0].rectim || transactions[0].cretim || "";
        suggestedNextVisit = typeof Core.calculateSuggestedNextVisit === "function"
          ? Core.calculateSuggestedNextVisit(lastDate, freq) : "";
      }
    } catch (e) { console.warn("calculateSuggestedNextVisit:", e); }
  }

  var re = existingReengagement || {};
  var lastPushTime = re.lastPushTime != null ? String(re.lastPushTime) : "";
  var pushCount = re.pushCount != null ? String(re.pushCount) : "";
  var clickScore = re.clickScore != null ? String(re.clickScore) : "";
  var consecutiveNoClick = re.consecutiveNoClick != null ? String(re.consecutiveNoClick) : "";
  var customerType = re.customerType != null ? String(re.customerType) : "自動提醒";

  return [
    timestamp,
    phone,
    employeeSummary,
    questionnaireSummary,
    msgSummary,
    saydouSummary.consumeText,
    storecashForG,
    saydouUserId,
    aiPromptText,
    lineUserIdVal,
    "",  // AI分析結果（由 AI 戰報函式寫入）
    reservationRecordText,
    suggestedNextVisit,
    lastPushTime,
    pushCount,
    clickScore,
    consecutiveNoClick,
    customerType
  ];
}

// ---------------------------------------------------------------------------
// 6. 表單送出時：彙整兩塊 + SayDou → Upsert 到「客人消費狀態」
// ---------------------------------------------------------------------------

function onFormSubmit_Survey(e) {
  try {
    const responses = e.namedValues;
    const timestamp = responses["時間戳記"] ? responses["時間戳記"][0] : Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm:ss");
    const phoneRaw = responses["客人手機"] ? responses["客人手機"][0] : "";
    const score = responses["本次客人與您互動喜好度（5最高分＝喜歡這客人）"] ? responses["本次客人與您互動喜好度（5最高分＝喜歡這客人）"][0] : "";
    const skinType = responses["肌膚類型（可複選）"] ? responses["肌膚類型（可複選）"][0] : "";
    const recommend = responses["本次推薦項目（可複選）"] ? responses["本次推薦項目（可複選）"][0] : "";
    const note = responses["使用產品/特殊狀況備註"] ? responses["使用產品/特殊狀況備註"][0] : "";
    const gossip = responses["今天客人有什麼特別需要紀錄"] ? responses["今天客人有什麼特別需要紀錄"][0] : "";
    
    const phone = Core.normalizePhone(phoneRaw);
    if (!phone) return;

    const integratedSs = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
    const sheet = getOrCreateIntegratedSheet(integratedSs);
    const rowIndex = findRowIndexByPhone(sheet, phone, CONFIG.INTEGRATED_PHONE_COL);
    const lineUserIdCol = CONFIG.INTEGRATED_HEADERS.indexOf("lineUserId") + 1;
    let existingLineUserId = "";
    var existingReengagement = null;
    if (rowIndex !== null && lineUserIdCol >= 1) {
      try { existingLineUserId = sheet.getRange(rowIndex, lineUserIdCol).getValue(); } catch (e) {}
      if (existingLineUserId == null) existingLineUserId = "";
      else existingLineUserId = String(existingLineUserId).trim();
      existingReengagement = getExistingReengagementFromRow(sheet, rowIndex);
    }

    const currentSubmission = { score: score, skinType: skinType, recommend: recommend, note: note, gossip: gossip };
    const rowData = buildIntegratedRow(phone, timestamp, currentSubmission, existingLineUserId, existingReengagement);
    upsertCustomerRow(integratedSs, phone, rowData);
    // 本筆剛更新 A 欄時間戳記，故跑 AI 並寫入 AI分析結果
    var aiResultCol = CONFIG.INTEGRATED_HEADERS.indexOf("AI分析結果") + 1;
    if (aiResultCol >= 1 && typeof callAI === "function" && typeof aggregateCustomerData === "function") {
      var rowIdx = findRowIndexByPhone(sheet, phone, CONFIG.INTEGRATED_PHONE_COL);
      if (rowIdx !== null) {
        try {
          var ctx = aggregateCustomerData(phone);
          if (ctx && ctx.trim()) {
            var aiResult = callAI(ctx);
            if (aiResult) sheet.getRange(rowIdx, aiResultCol).setValue(aiResult);
          }
        } catch (e) {
          console.warn("表單送出後 AI 更新略過或失敗: " + (e && e.message));
        }
      }
    }
    console.log("已整合客戶 " + phone + "（員工+客人問卷+訊息+SayDou → 客人消費狀態，AI專用Prompt 已更新）。");
  } catch (err) {
    console.error("整合失敗:", err);
  }
}

// ---------------------------------------------------------------------------
// 7. 手動重整：依手機重新彙整並更新該列（可排程或選單觸發）
// ---------------------------------------------------------------------------

/**
 * 每日排程：巡航「客人消費狀態」每一列的 lineUserId，從「訊息一覽」拉取該客人講過的話，
 * 更新「客人訊息摘要」E 欄與 AI專用Prompt 的【客人訊息】區塊（不重跑整個整合）。
 * 觸發：Apps Script 編輯器 → 觸發條件 → 時間驅動 → 日計時器 → 每天 晚上 9 時至 10 時 → 函式選 scheduledDailyRefreshLineMessages
 */
function scheduledDailyRefreshLineMessages() {
  const integratedSs = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
  const sheet = getOrCreateIntegratedSheet(integratedSs);
  const lastRow = sheet.getLastRow();
  const headers = CONFIG.INTEGRATED_HEADERS;
  const msgSummaryCol = headers.indexOf("line對話") + 1;   // 1-based，E 欄
  const aiPromptCol = headers.indexOf("ai prompt") + 1;
  const lineUserIdCol = headers.indexOf("lineUserId") + 1;
  if (msgSummaryCol < 1 || aiPromptCol < 1 || lineUserIdCol < 1) {
    console.warn("scheduledDailyRefreshLineMessages: 找不到欄位");
    return;
  }
  // 第 1 列為標題時從第 2 列開始
  const headerLineUserId = lastRow >= 1 ? sheet.getRange(1, lineUserIdCol).getValue() : "";
  const dataStartRow = (headerLineUserId === "lineUserId") ? 2 : 1;
  if (lastRow < dataStartRow) {
    console.log("scheduledDailyRefreshLineMessages: 無資料列，略過");
    return;
  }
  let done = 0;
  let err = 0;
  for (let r = dataStartRow; r <= lastRow; r++) {
    const lineUserIdRaw = sheet.getRange(r, lineUserIdCol).getValue();
    if (lineUserIdRaw == null || String(lineUserIdRaw).trim() === "") continue;
    const userIds = parseLineUserIds(String(lineUserIdRaw));
    if (userIds.length === 0) continue;
    try {
      const messages = getCustomerMessagesByUserIds(userIds);
      const msgSummary = formatMessagesForSummary(messages);
      const newMessagesBlock = formatMessageRowsForPrompt(messages);
      const currentPrompt = sheet.getRange(r, aiPromptCol).getValue();
      const newPrompt = replaceMessagesSectionInPrompt(currentPrompt != null ? String(currentPrompt) : "", newMessagesBlock);
      sheet.getRange(r, msgSummaryCol).setValue(msgSummary);
      sheet.getRange(r, aiPromptCol).setValue(newPrompt);
      done++;
    } catch (e) {
      console.warn("scheduledDailyRefreshLineMessages 列 " + r + " 失敗: " + (e && e.message));
      err++;
    }
  }
  console.log("scheduledDailyRefreshLineMessages: 已從訊息一覽更新 " + done + " 筆（lineUserId 有填的列），失敗 " + err + " 筆");
}

/**
 * 掃「訊息一覽」：有填手機的列，用該手機在「客人消費狀態」找到對應列，把該列的 lineUserId 寫入（或合併）。
 * 用途：員工在訊息一覽補上手機後，跑此函式即可把 lineUserId 對到客人消費狀態，之後排程/重整就會帶出該客人的 LINE 對話。
 * 執行方式：手動執行或排程（例如每日一次）。需在訊息一覽表有「手機」欄（CONFIG.MSG_LIST_PHONE_COL_IDX，預設 7=H）。
 */
function scanMessageListAndSyncLineUserIdToCustomerState() {
  const phoneColIdx = CONFIG.MSG_LIST_PHONE_COL_IDX;
  if (phoneColIdx == null || phoneColIdx < 0) {
    console.log("scanMessageListAndSyncLineUserIdToCustomerState: MSG_LIST_PHONE_COL_IDX 未設或 <0，略過掃街");
    return { updated: 0, skipped: 0, errors: 0 };
  }
  const ss = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
  const msgSheet = ss.getSheetByName(CONFIG.MSG_LIST_SHEET_NAME);
  if (!msgSheet || msgSheet.getLastRow() < 2) {
    console.log("scanMessageListAndSyncLineUserIdToCustomerState: 訊息一覽無資料");
    return { updated: 0, skipped: 0, errors: 0 };
  }
  const integratedSheet = getOrCreateIntegratedSheet(ss);
  const uidIdx = CONFIG.MSG_LIST_USERID_COL_IDX;
  const lastRow = msgSheet.getLastRow();
  const numCols = Math.max(msgSheet.getLastColumn(), phoneColIdx + 1);
  const data = msgSheet.getRange(2, 1, lastRow, numCols).getValues();
  const lineUserIdCol = CONFIG.INTEGRATED_HEADERS.indexOf("lineUserId") + 1;
  if (lineUserIdCol < 1) return { updated: 0, skipped: 0, errors: 0 };
  let updated = 0, skipped = 0, errors = 0;
  const seen = {}; // 同一 (phone, lineUserId) 只處理一次

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const lineUserId = row[uidIdx] != null ? String(row[uidIdx]).trim() : "";
    const phoneRaw = row[phoneColIdx] != null ? String(row[phoneColIdx]).trim() : "";
    if (!lineUserId || !phoneRaw) {
      skipped++;
      continue;
    }
    const normalized = Core.normalizePhone(phoneRaw);
    if (!normalized) {
      skipped++;
      continue;
    }
    const key = normalized + "\t" + lineUserId;
    if (seen[key]) continue;
    seen[key] = true;

    const rowIndex = findRowIndexByPhone(integratedSheet, normalized, CONFIG.INTEGRATED_PHONE_COL);
    if (rowIndex === null) {
      skipped++;
      continue;
    }
    try {
      let existing = integratedSheet.getRange(rowIndex, lineUserIdCol).getValue();
      existing = existing != null ? String(existing).trim() : "";
      const ids = parseLineUserIds(existing);
      const set = {};
      ids.forEach(function (id) { set[id] = true; });
      if (!set[lineUserId]) {
        ids.push(lineUserId);
        integratedSheet.getRange(rowIndex, lineUserIdCol).setValue(ids.join(","));
        updated++;
      }
    } catch (e) {
      console.warn("scanMessageListAndSyncLineUserIdToCustomerState 列 " + (i + 2) + " 失敗: " + (e && e.message));
      errors++;
    }
  }
  console.log("scanMessageListAndSyncLineUserIdToCustomerState: 已寫入 " + updated + " 筆，略過 " + skipped + "，錯誤 " + errors);
  return { updated: updated, skipped: skipped, errors: errors };
}

/**
 * 依手機重新撈取所有來源並 Upsert 一列（不依賴表單事件）
 * @param {string} phone 正規化後手機
 * @param {{ skipAI?: boolean, leaveEmployeeEmpty?: boolean }} [options] 選項；skipAI: true 時不呼叫 AI；leaveEmployeeEmpty: true 時「員工填寫」欄留空
 */
function refreshCustomerByPhone(phone, options) {
  if (phone == null || typeof phone === "undefined") {
    console.warn("refreshCustomerByPhone: 無效手機（空值或 undefined）");
    return;
  }
  const raw = String(phone).trim();
  if (raw === "" || raw.toLowerCase() === "undefined") {
    console.warn("refreshCustomerByPhone: 無效手機（空字串或字串 undefined）");
    return;
  }
  const normalized = Core.normalizePhone(raw);
  if (!normalized) {
    console.warn("refreshCustomerByPhone: 無效手機 " + raw);
    return;
  }
  const skipAI = options && options.skipAI === true;
  const leaveEmployeeEmpty = options && options.leaveEmployeeEmpty === true;
  const integratedSs = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
  const sheet = getOrCreateIntegratedSheet(integratedSs);
  const rowIndex = findRowIndexByPhone(sheet, normalized, CONFIG.INTEGRATED_PHONE_COL);
  const lineUserIdCol = CONFIG.INTEGRATED_HEADERS.indexOf("lineUserId") + 1;
  let existingLineUserId = "";
  var existingReengagement = null;
  if (rowIndex !== null && lineUserIdCol >= 1) {
    try { existingLineUserId = sheet.getRange(rowIndex, lineUserIdCol).getValue(); } catch (e) {}
    if (existingLineUserId == null) existingLineUserId = "";
    else existingLineUserId = String(existingLineUserId).trim();
    existingReengagement = getExistingReengagementFromRow(sheet, rowIndex);
  }

  const timestamp = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm:ss");
  const rowData = buildIntegratedRow(normalized, timestamp, null, existingLineUserId, existingReengagement);
  if (leaveEmployeeEmpty && rowData.length > 2) rowData[2] = "";  // 員工填寫欄留空
  upsertCustomerRow(integratedSs, normalized, rowData);
  // 僅在未 skipAI 時跑 AI 並寫入 AI分析結果（整表更新時 skipAI 可大幅縮短時間、避免逾時）
  if (!skipAI) {
    var aiResultCol = CONFIG.INTEGRATED_HEADERS.indexOf("AI分析結果") + 1;
    if (aiResultCol >= 1 && typeof callAI === "function" && typeof aggregateCustomerData === "function") {
      var rowIdx = findRowIndexByPhone(sheet, normalized, CONFIG.INTEGRATED_PHONE_COL);
      if (rowIdx !== null) {
        try {
          var ctx = aggregateCustomerData(normalized);
          if (ctx && ctx.trim()) {
            var aiResult = callAI(ctx);
            if (aiResult) sheet.getRange(rowIdx, aiResultCol).setValue(aiResult);
          }
        } catch (e) {
          console.warn("AI 更新略過或失敗: " + (e && e.message));
        }
      }
    }
  }
  console.log("已重整客戶 " + normalized);
}

/**
 * 針對「明日預約」的客人，依手機執行客人消費狀態重整（供 22:00 排程呼叫）。
 * 取得明日預約清單 → 抽出所有手機 → 對每支手機執行 refreshCustomerByPhone。
 * 依賴：getTomorrowReservationsByStore（TomorrowReservationReport.js）、Core（PaoMao_Core）。
 * 執行方式：手動或排程（建議每日 22:00 台北時間）。
 * @returns {{ dateStr: string, phones: string[], done: number, errors: number }}
 */
function refreshCustomersByTomorrowReservations() {
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  var dateStr = Utilities.formatDate(tomorrow, "Asia/Taipei", "yyyy-MM-dd");
  if (typeof Core === "undefined") {
    console.warn("refreshCustomersByTomorrowReservations: Core 未定義，請在專案中連結 PaoMao_Core 程式庫（userSymbol: Core）");
    return { dateStr: dateStr, phones: [], done: 0, errors: 0 };
  }
  var byStore = [];
  try {
    byStore = typeof getTomorrowReservationsByStore === "function" ? getTomorrowReservationsByStore(dateStr) : [];
  } catch (e) {
    console.warn("refreshCustomersByTomorrowReservations: getTomorrowReservationsByStore 失敗: " + (e && e.message));
    return { dateStr: dateStr, phones: [], done: 0, errors: 0 };
  }
  var phoneSet = {};
  for (var i = 0; i < byStore.length; i++) {
    var items = byStore[i].items || [];
    for (var j = 0; j < items.length; j++) {
      var phone = items[j].phone;
      if (phone == null || String(phone).trim() === "") continue;
      try {
        var normalized = Core.normalizePhone(phone);
        if (normalized) phoneSet[normalized] = true;
      } catch (e2) {
        console.warn("refreshCustomersByTomorrowReservations: 手機正規化略過 " + phone + ": " + (e2 && e2.message));
      }
    }
  }
  var phones = Object.keys(phoneSet);
  var done = 0;
  var err = 0;
  for (var k = 0; k < phones.length; k++) {
    try {
      refreshCustomerByPhone(phones[k]);
      done++;
    } catch (e) {
      console.warn("refreshCustomersByTomorrowReservations 手機 " + phones[k] + " 失敗: " + (e && e.message));
      err++;
    }
  }
  console.log("refreshCustomersByTomorrowReservations: 明日 " + dateStr + " 預約 " + phones.length + " 人，已重整 " + done + " 筆，失敗 " + err + " 筆");
  return { dateStr: dateStr, phones: phones, done: done, errors: err };
}

/** 整表更新逾時保護：單次最長執行秒數（GAS 上限約 6 分鐘，留餘裕） */
var REFRESH_ALL_MAX_SECONDS = 280;

/**
 * 針對「客人消費狀態」整張表，依每一列的手機號碼重新跑過全部整合（員工填寫、客人問卷、訊息一覽、SayDou、儲值紀錄）。
 * 為避免 Exceeded maximum execution time：
 * - 整表更新時不跑 AI（skipAI），僅更新資料；AI 可由每日排程／明日預約／表單送出時更新。
 * - 單次執行超過約 4.5 分鐘會中斷並把「下一列」存到指令碼屬性，再次執行會從該列續跑，跑完會清除屬性。
 * 執行方式：Apps Script 編輯器選此函式 → 執行；若逾時請再執行一次即可繼續。
 */
function refreshAllCustomersByPhone() {
  const props = PropertiesService.getScriptProperties();
  const integratedSs = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
  const sheet = getOrCreateIntegratedSheet(integratedSs);
  const lastRow = sheet.getLastRow();
  const phoneCol = CONFIG.INTEGRATED_PHONE_COL + 1;  // 1-based，B 欄
  const headerB = lastRow >= 1 ? sheet.getRange(1, phoneCol).getValue() : "";
  const dataStartRow = (headerB === "手機" || headerB === "手機號碼") ? 2 : 1;
  if (lastRow < dataStartRow) {
    props.deleteProperty("REFRESH_ALL_NEXT_ROW");
    console.log("refreshAllCustomersByPhone: 無資料列，略過");
    return;
  }
  let startRow = dataStartRow;
  const savedNext = props.getProperty("REFRESH_ALL_NEXT_ROW");
  if (savedNext != null && savedNext !== "") {
    const n = parseInt(savedNext, 10);
    if (n >= dataStartRow && n <= lastRow + 1) startRow = n;
    if (startRow > lastRow) {
      props.deleteProperty("REFRESH_ALL_NEXT_ROW");
      console.log("refreshAllCustomersByPhone: 已從上次進度續跑完成，無剩餘列");
      return;
    }
    console.log("refreshAllCustomersByPhone: 從第 " + startRow + " 列續跑（上次逾時中斷）");
  }
  const startTime = Date.now();
  let done = 0;
  let err = 0;
  for (let r = startRow; r <= lastRow; r++) {
    if (Date.now() - startTime > REFRESH_ALL_MAX_SECONDS * 1000) {
      props.setProperty("REFRESH_ALL_NEXT_ROW", String(r));
      console.log("refreshAllCustomersByPhone: 逾時保護，已處理 " + done + " 筆。請再次執行以從第 " + r + " 列繼續。");
      return;
    }
    const phoneRaw = sheet.getRange(r, phoneCol).getValue();
    const phone = (phoneRaw != null && phoneRaw !== undefined ? String(phoneRaw) : "").trim();
    if (!phone || phone.toLowerCase() === "undefined") continue;
    const normalized = Core.normalizePhone(phone);
    if (!normalized) continue;
    try {
      refreshCustomerByPhone(normalized, { skipAI: true });
      done++;
    } catch (e) {
      console.warn("refreshAllCustomersByPhone 列 " + r + " 手機 " + phone + " 失敗: " + (e && e.message));
      err++;
    }
  }
  props.deleteProperty("REFRESH_ALL_NEXT_ROW");
  console.log("refreshAllCustomersByPhone: 已依手機重跑整表 " + done + " 筆，失敗 " + err + " 筆（整表未跑 AI，AI 由每日／明日預約／表單送出更新）");
}

/**
 * 每日更新客人消費：掃訊息一覽對 lineUserId → 依手機重整客人消費狀態 → 更新 LINE 訊息摘要。
 * 執行方式：手動或排程（建議每日 21:00–22:00）。完成後可選寫入「客人樣貌摘要」。
 */
function runDailyCustomerUpdate() {
  console.log("runDailyCustomerUpdate: 開始");
  var r1 = scanMessageListAndSyncLineUserIdToCustomerState();
  console.log("scanMessageListAndSyncLineUserIdToCustomerState: updated=" + r1.updated + ", skipped=" + r1.skipped + ", errors=" + r1.errors);
  refreshAllCustomersByPhone();
  scheduledDailyRefreshLineMessages();
  buildCustomerProfileSummarySheet();
  console.log("runDailyCustomerUpdate: 完成");
}

/**
 * 從「客人消費狀態」產出「客人樣貌摘要」工作表：手機、最後更新時間、有無LINE、消費紀錄摘要、儲值摘要。
 * 方便一眼看客人樣貌，不另拉 API。
 */
function buildCustomerProfileSummarySheet() {
  const ss = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
  const sheet = getOrCreateIntegratedSheet(ss);
  const lastRow = sheet.getLastRow();
  const headers = CONFIG.INTEGRATED_HEADERS;
  const phoneCol = 2;  // B
  const timeCol = 1;   // A
  const consumeCol = headers.indexOf("消費紀錄") + 1;
  const storecashCol = headers.indexOf("儲值紀錄") + 1;
  const lineUserIdCol = headers.indexOf("lineUserId") + 1;
  const dataStartRow = (lastRow >= 1 && lineUserIdCol >= 1 && sheet.getRange(1, lineUserIdCol).getValue() === "lineUserId") ? 2 : 1;
  if (lastRow < dataStartRow) return;

  const summaryHeaders = ["手機", "最後更新時間", "有無LINE", "消費紀錄摘要", "儲值摘要"];
  let summarySheet = ss.getSheetByName("客人樣貌摘要");
  if (!summarySheet) {
    summarySheet = ss.insertSheet("客人樣貌摘要");
    summarySheet.appendRow(summaryHeaders);
  } else {
    summarySheet.clear();
    summarySheet.appendRow(summaryHeaders);
  }
  const maxSummaryLen = 200;
  for (let r = dataStartRow; r <= lastRow; r++) {
    const phone = sheet.getRange(r, phoneCol).getValue();
    const timeVal = sheet.getRange(r, timeCol).getValue();
    const lineRaw = sheet.getRange(r, lineUserIdCol).getValue();
    const consumeRaw = sheet.getRange(r, consumeCol).getValue();
    const storeRaw = sheet.getRange(r, storecashCol).getValue();
    const hasLine = (lineRaw != null && String(lineRaw).trim() !== "") ? "有" : "—";
    const consumeSummary = (consumeRaw != null && String(consumeRaw).trim() !== "") ? String(consumeRaw).trim().slice(0, maxSummaryLen) + (String(consumeRaw).length > maxSummaryLen ? "…" : "") : "—";
    const storeSummary = (storeRaw != null && String(storeRaw).trim() !== "") ? String(storeRaw).trim().slice(0, maxSummaryLen) + (String(storeRaw).length > maxSummaryLen ? "…" : "") : "—";
    summarySheet.appendRow([phone != null ? String(phone) : "", timeVal != null ? String(timeVal) : "", hasLine, consumeSummary, storeSummary]);
  }
  console.log("buildCustomerProfileSummarySheet: 已寫入 " + (lastRow - dataStartRow + 1) + " 筆至「客人樣貌摘要」");
}

// ---------------------------------------------------------------------------
// 回訪提醒：封測設定與掃描
// ---------------------------------------------------------------------------

var REENGAGEMENT_CONFIG = {
  betaUserIds: ["Ue79f58dabfdeb9d23cdf7b56b3742664"],
  enablePush: false,
  enableReply: false
};

function isReengagementBetaUser(lineUserId) {
  if (!lineUserId) return false;
  var ids = parseLineUserIds(lineUserId);
  var allowed = REENGAGEMENT_CONFIG.betaUserIds || [];
  return ids.some(function (id) {
    return allowed.indexOf(String(id).trim()) >= 0;
  });
}

function getAvailableSlotsForDate(sayId, dateStr) {
  if (!sayId || !dateStr || typeof Core.findAvailableSlots !== "function") return [];
  try {
    var result = Core.findAvailableSlots(sayId, dateStr, dateStr, 1, 90, {});
    var data = (result && result.data) ? result.data : [];
    if (data.length > 0 && data[0].times) return Array.isArray(data[0].times) ? data[0].times : [String(data[0].times)];
    return [];
  } catch (e) {
    console.warn("getAvailableSlotsForDate:", e);
    return [];
  }
}

function getLastStoreFromMembid(membid) {
  if (!membid || typeof Core.getAllTransactionsByMembid !== "function") return { storid: null, stonam: "" };
  try {
    var tx = Core.getAllTransactionsByMembid(membid, 5);
    if (!tx || tx.length === 0) return { storid: null, stonam: "" };
    var t = tx[0];
    var storid = (t.storid != null) ? String(t.storid) : ((t.stor && t.stor.storid != null) ? String(t.stor.storid) : null);
    var stonam = (t.stor && t.stor.stonam) ? t.stor.stonam : "";
    return { storid: storid, stonam: stonam };
  } catch (e) {
    return { storid: null, stonam: "" };
  }
}

function scanAndSendReengagementNotifications() {
  var ss = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
  var sheet = getOrCreateIntegratedSheet(ss);
  var lastRow = sheet.getLastRow();
  var h = CONFIG.INTEGRATED_HEADERS;
  var phoneCol = CONFIG.INTEGRATED_PHONE_COL + 1;
  var lineUserIdCol = h.indexOf("lineUserId") + 1;
  var saydouUserIdCol = h.indexOf("saydouUserId") + 1;
  var reservationCol = h.indexOf("預約記錄") + 1;
  var suggestedCol = h.indexOf("建議下次回訪日") + 1;
  var lastPushCol = h.indexOf("最後推播時間") + 1;
  var pushCountCol = h.indexOf("推播次數") + 1;
  var consecutiveCol = h.indexOf("連續未點擊") + 1;
  var customerTypeCol = h.indexOf("客戶類型") + 1;

  if (lineUserIdCol < 1 || suggestedCol < 1) {
    console.warn("scanAndSendReengagementNotifications: 缺少必要欄位");
    return { scanned: 0, pushed: 0, skipped: 0 };
  }

  var headerB = lastRow >= 1 ? sheet.getRange(1, phoneCol).getValue() : "";
  var dataStartRow = (headerB === "手機" || headerB === "手機號碼") ? 2 : 1;
  if (lastRow < dataStartRow) return { scanned: 0, pushed: 0, skipped: 0 };

  var todayStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd");
  var sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  var token = (typeof Core !== "undefined" && typeof Core.getCoreConfig === "function") ? (Core.getCoreConfig().LINE_TOKEN_PAOPAO || "") : "";
  var enablePush = REENGAGEMENT_CONFIG.enablePush === true;
  var scanned = 0, pushed = 0, skipped = 0;

  for (var r = dataStartRow; r <= lastRow; r++) {
    scanned++;
    var lineUserIdRaw = sheet.getRange(r, lineUserIdCol).getValue();
    if (!lineUserIdRaw || String(lineUserIdRaw).trim() === "") { skipped++; continue; }
    if (!isReengagementBetaUser(String(lineUserIdRaw))) { skipped++; continue; }

    var customerType = sheet.getRange(r, customerTypeCol).getValue();
    if (customerType != null && String(customerType).trim() === "需人工跟進") { skipped++; continue; }

    var reservationText = sheet.getRange(r, reservationCol).getValue();
    if (reservationText != null && String(reservationText).trim() !== "" && String(reservationText).trim() !== "—") {
      skipped++;
      continue;
    }

    var suggestedDate = sheet.getRange(r, suggestedCol).getValue();
    if (!suggestedDate || String(suggestedDate).trim() === "") { skipped++; continue; }
    var suggestedStr = String(suggestedDate).trim().slice(0, 10);
    if (suggestedStr > todayStr) { skipped++; continue; }

    var lastPushVal = sheet.getRange(r, lastPushCol).getValue();
    if (lastPushVal && !isNaN(new Date(lastPushVal).getTime()) && new Date(lastPushVal) > sevenDaysAgo) {
      skipped++;
      continue;
    }

    var saydouUserId = sheet.getRange(r, saydouUserIdCol).getValue();
    if (!saydouUserId || String(saydouUserId).trim() === "" || String(saydouUserId).trim() === "—") { skipped++; continue; }

    var phone = sheet.getRange(r, phoneCol).getValue();
    var storeInfo = getLastStoreFromMembid(saydouUserId);
    if (!storeInfo.storid) { skipped++; continue; }

    var slots = getAvailableSlotsForDate(storeInfo.storid, suggestedStr);
    var consumeText = sheet.getRange(r, h.indexOf("消費紀錄") + 1).getValue();
    var lastVisitDate = "—";
    var daysSince = 0;
    if (consumeText && String(consumeText).indexOf("最近：") >= 0) {
      var m = String(consumeText).match(/最近：([^\s|]+)/);
      if (m) {
        lastVisitDate = m[1].slice(5).replace(/-/g, "/");
        var lastD = new Date(m[1].slice(0, 10));
        if (!isNaN(lastD.getTime())) daysSince = Math.floor((new Date() - lastD) / (24 * 60 * 60 * 1000));
      }
    }

    if (enablePush && token && typeof Core.sendReengagementFlexMessage === "function") {
      var sent = Core.sendReengagementFlexMessage(
        String(lineUserIdRaw).split(/[,;]/)[0].trim(),
        "",
        lastVisitDate,
        daysSince,
        suggestedStr,
        slots,
        phone,
        storeInfo.storid,
        storeInfo.stonam,
        token
      );
      if (sent) pushed++;
    } else {
      console.log("[Reengagement] 封測不發送: " + phone + " lineUserId=" + lineUserIdRaw);
    }

    if (enablePush) {
      var nowStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm:ss");
      sheet.getRange(r, lastPushCol).setValue(nowStr);
      var pc = parseInt(sheet.getRange(r, pushCountCol).getValue() || 0, 10);
      sheet.getRange(r, pushCountCol).setValue(pc + 1);
      var cn = parseInt(sheet.getRange(r, consecutiveCol).getValue() || 0, 10);
      sheet.getRange(r, consecutiveCol).setValue(cn + 1);
      if (cn + 1 >= 2) sheet.getRange(r, customerTypeCol).setValue("需人工跟進");
    }
  }

  console.log("scanAndSendReengagementNotifications: 掃描 " + scanned + "，推播 " + pushed + "，略過 " + skipped);
  return { scanned: scanned, pushed: pushed, skipped: skipped };
}

function updateReengagementClickScore(phone) {
  if (!phone) return;
  var ss = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
  var sheet = getOrCreateIntegratedSheet(ss);
  var rowIndex = findRowIndexByPhone(sheet, Core.normalizePhone(phone), CONFIG.INTEGRATED_PHONE_COL);
  if (rowIndex === null) return;
  var h = CONFIG.INTEGRATED_HEADERS;
  var clickCol = h.indexOf("點擊積分") + 1;
  var consecutiveCol = h.indexOf("連續未點擊") + 1;
  var typeCol = h.indexOf("客戶類型") + 1;
  if (clickCol < 1) return;
  var score = parseInt(sheet.getRange(rowIndex, clickCol).getValue() || 0, 10);
  sheet.getRange(rowIndex, clickCol).setValue(score + 1);
  sheet.getRange(rowIndex, consecutiveCol).setValue(0);
  sheet.getRange(rowIndex, typeCol).setValue("自動提醒");
}

function parsePostbackParams(dataStr) {
  var out = {};
  if (!dataStr) return out;
  var parts = dataStr.split("&");
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].split("=");
    if (kv.length >= 2) {
      out[decodeURIComponent(kv[0])] = decodeURIComponent(kv.slice(1).join("=").replace(/\+/g, " "));
    }
  }
  return out;
}

function handleReengagementBooking(postbackData, lineUserId, replyToken, token) {
  var params = parsePostbackParams(postbackData);
  if (params.action !== "book_reengagement") return;
  if (!isReengagementBetaUser(lineUserId)) return;

  var phone = Core.normalizePhone(params.phone || "");
  var storeId = params.storeId || "";
  var slot = params.slot || "";
  var suggestedDate = params.suggestedDate || "";

  updateReengagementClickScore(phone);

  var bookingSuccess = false;
  if (phone && storeId && slot && suggestedDate && typeof createReservation === "function") {
    try {
      createReservation(phone, suggestedDate, slot, 1.5, "回訪提醒一鍵預約", storeId, 1);
      bookingSuccess = true;
    } catch (e) {
      console.warn("handleReengagementBooking createReservation:", e);
    }
  }

  if (!REENGAGEMENT_CONFIG.enableReply || !replyToken || !token) return;

  var replyText = bookingSuccess
    ? "已為您預約 " + suggestedDate + " " + slot + "，請準時到店喔！"
    : "預約時發生問題，請直接聯繫門市協助預約，謝謝！";

  if (typeof Core !== "undefined" && typeof Core.sendLineReply === "function") {
    Core.sendLineReply(replyToken, replyText, token);
  }
}

/**
 * 設定回訪提醒每日觸發器（手動執行一次即可）
 * 建議每日 10:00 執行 scanAndSendReengagementNotifications
 */
function setupReengagementTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "scanAndSendReengagementNotifications") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("scanAndSendReengagementNotifications")
    .timeBased()
    .everyDays(1)
    .atHour(10)
    .create();
  console.log("已設定回訪提醒每日觸發器（10:00）");
}

// ---------------------------------------------------------------------------
// 測試
// ---------------------------------------------------------------------------

function debug_SimulateFormSubmit() {
  console.log("🚀 模擬客人問卷送出 → 彙整兩塊試算表 + SayDou → Upsert ...");
  const TEST_PHONE = "0975513172";
  const mockEvent = {
    namedValues: {
      "時間戳記": [Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm:ss")],
      "客人手機": [TEST_PHONE],
      "本次客人與您互動喜好度（5最高分＝喜歡這客人）": ["5"],
      "肌膚類型（可複選）": ["乾性", "敏感"],
      "本次推薦項目（可複選）": ["皮秒雷射", "保濕導入"],
      "使用產品/特殊狀況備註": ["上次做完臉有點紅，這次要注意"],
      "今天客人有什麼特別需要紀錄": ["剛生完小孩，想睡覺，少聊天"]
    }
  };
  try {
    onFormSubmit_Survey(mockEvent);
    // 資料寫在 INTEGRATED_SHEET_SS_ID 試算表，工作表「客人消費狀態」；印出連結方便開啟
    const ss = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
    const sheet = ss.getSheetByName(CONFIG.INTEGRATED_SHEET_NAME);
    const url = sheet ? ss.getUrl() + "#gid=" + sheet.getSheetId() : ss.getUrl();
    console.log("✅ 請到「客人消費狀態」查看：AI專用Prompt 應含員工填寫+客人問卷+SayDou 歷程。");
    console.log("👉 試算表連結：" + url);
  } catch (error) {
    console.error("❌ 測試錯誤:", error.toString());
  }
}
