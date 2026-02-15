/**
 * SayDou 會員全貌：用手機 → Core.getMemApi 取得 membid → 拉取
 * 1. 會員個人資料 (crm/member/{membid}?type=view)
 * 2. 會員消費紀錄全筆 (finance/transaction，分頁全拉)
 * 3. 會員儲值金紀錄全筆 (unearn/storecashUseRecord，分頁全拉)
 * 寫入試算表「SayDou會員全貌」，含「備註(Update)」欄位供員工標記。
 */

var SAYDOU_FULL_CONFIG = {
  SHEET_ID: "1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0",  // 與客人消費狀態同試算表（泡泡貓｜line@訊息回覆一覽表）
  SHEET_NAME: "SayDou會員全貌",
  PHONE_COL: 1,  // 手機在第幾欄 (0-based)，B 欄
  HEADERS: [
    "更新時間", "手機", "membid", "會員姓名", "消費筆數", "儲值金筆數",
    "個人資料摘要", "消費紀錄摘要", "儲值紀錄摘要", "備註(Update)"
  ]
};

// ---------------------------------------------------------------------------
// 工作表取得／建立、依手機查列
// ---------------------------------------------------------------------------

function getOrCreateSayDouFullSheet() {
  var ss = SpreadsheetApp.openById(SAYDOU_FULL_CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SAYDOU_FULL_CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SAYDOU_FULL_CONFIG.SHEET_NAME);
    sheet.appendRow(SAYDOU_FULL_CONFIG.HEADERS);
  }
  return sheet;
}

function findSayDouFullRowByPhone(sheet, phone) {
  if (!sheet || !phone) return null;
  var phoneCol = SAYDOU_FULL_CONFIG.PHONE_COL + 1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var normalized = Core.normalizePhone(phone);
  if (!normalized) return null;
  var colValues = sheet.getRange(2, phoneCol, lastRow, phoneCol).getValues().map(function (r) { return r[0]; });
  for (var i = 0; i < colValues.length; i++) {
    if (Core.normalizePhone(String(colValues[i])) === normalized) return i + 2;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 摘要文字：個人資料 / 消費 / 儲值
// ---------------------------------------------------------------------------

function summarizeMemberView(view) {
  if (!view) return "—";
  var parts = [];
  if (view.memnam) parts.push("姓名：" + view.memnam);
  if (view.phone_) parts.push("手機：" + view.phone_);
  if (view.points != null) parts.push("點數：" + view.points);
  if (view.buysum != null) parts.push("累計消費：" + view.buysum);
  if (view.cshsum != null) parts.push("累計儲值：" + view.cshsum);
  if (view.storecard && view.storecard.stcash != null) parts.push("儲值金餘額：" + view.storecard.stcash);
  if (view.stor && view.stor.stonam) parts.push("所屬店：" + view.stor.stonam);
  if (view.nxttim) parts.push("下次預約：" + view.nxttim);
  if (view.bthday) parts.push("生日：" + view.bthday);
  return parts.length ? parts.join("；") : "—";
}

/** 帳務：顯示明確金額（現金 xxx 儲值金 xxx；有值的才列） */
function formatPaymentAmountsForTransaction(t) {
  if (!t) return "";
  var parts = [];
  var cashVal = (t.cash != null ? t.cash : 0) + (t.cashpay != null ? t.cashpay : 0);
  if (cashVal > 0) parts.push("現金 " + cashVal);
  var rpcashVal = t.rpcash != null ? t.rpcash : 0;
  if (rpcashVal > 0) parts.push("儲值金 " + rpcashVal);
  if (t.card > 0 || (t.creditcard != null && t.creditcard > 0)) parts.push("信用卡 " + (t.creditcard != null ? t.creditcard : t.card));
  if (t.linepay > 0) parts.push("Line Pay " + t.linepay);
  if (t.ticket > 0) parts.push("券 " + t.ticket);
  if (t.give > 0) parts.push("贈送 " + t.give);
  if (t.free > 0) parts.push("免費 " + t.free);
  if (t.voucher > 0) parts.push("兌換券 " + t.voucher);
  return parts.length ? parts.join(" ") : "";
}

function summarizeTransactions(items) {
  if (!items || items.length === 0) return "（無）";
  var lines = [];
  var maxShow = 50;
  for (var i = 0; i < Math.min(items.length, maxShow); i++) {
    var o = items[i];
    var dateStr = o.rectim || o.cretim || "";
    var store = (o.stor && o.stor.stonam) ? o.stor.stonam : "";
    var price = o.price_ != null ? o.price_ : o.rprice;
    var remark = o.remark ? String(o.remark).trim() : "";
    var detail = (o.ordds && o.ordds[0]) ? o.ordds[0].godnam : "";
    var paymentAmounts = formatPaymentAmountsForTransaction(o);
    var extra = [];
    if (remark) {
      var empName = (typeof Core !== "undefined" && typeof Core.getEmployeeCodeToNameMap === "function") ? Core.getEmployeeCodeToNameMap()[remark] : null;
      extra.push("備註:" + remark + (empName ? " (" + empName + ")" : ""));
    }
    if (paymentAmounts) extra.push(paymentAmounts);
    var suffix = extra.length ? " [" + extra.join(" ") + "]" : "";
    lines.push(dateStr + " " + store + " $" + (price || 0) + " " + detail + suffix);
  }
  if (items.length > maxShow) lines.push("…共 " + items.length + " 筆");
  return lines.join("\n");
}

/**
 * 合併「儲值紀錄」(加值) 與「儲值使用紀錄」(使用)，依 rectim 排序後回傳統一格式陣列
 * 每筆 { rectim, typeLabel: "儲值"|"使用", stonam, amount, remark }
 */
function mergeStorecashRecords(addItems, useItems) {
  var list = [];
  if (addItems && addItems.length > 0) {
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
  if (useItems && useItems.length > 0) {
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
  return list;
}

function summarizeStorecash(combinedItems) {
  if (!combinedItems || combinedItems.length === 0) return "（無）";
  var lines = [];
  var maxShow = 30;
  for (var i = 0; i < Math.min(combinedItems.length, maxShow); i++) {
    var o = combinedItems[i];
    var dateStr = o.rectim || "";
    var typeLabel = o.typeLabel || "—";
    var store = o.stonam || "";
    var amount = o.amount != null ? o.amount : 0;
    var remark = o.remark ? " " + o.remark : "";
    lines.push(dateStr + " " + typeLabel + " " + store + " $" + amount + remark);
  }
  if (combinedItems.length > maxShow) lines.push("…共 " + combinedItems.length + " 筆");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 主流程：依手機拉 SayDou 全貌並寫入／更新試算表
// ---------------------------------------------------------------------------

/**
 * 依手機拉取 SayDou 全貌（會員 view + 消費全筆 + 儲值金全筆）並 Upsert 到「SayDou會員全貌」
 * 備註(Update) 欄：更新時保留原值，新增時留空（供員工填寫「已更新」等）
 * @param {string} phone 手機號碼（會正規化）
 * @returns {object} { success: boolean, msg: string, membid: number|null, row: number|null }
 */
function pullSayDouFullByPhone(phone) {
  var normalized = Core.normalizePhone(phone);
  if (!normalized) {
    return { success: false, msg: "無效手機", membid: null, row: null };
  }

  var member = Core.getMemApi(normalized);
  if (!member || !member.membid) {
    return { success: false, msg: "SayDou 找不到此會員", membid: null, row: null };
  }

  var membid = member.membid;
  var view = Core.getMemberViewByMembid(membid);
  var transactions = Core.getAllTransactionsByMembid(membid, 20);
  var storecashUse = Core.getAllStorecashUseRecordByMembid(membid, 20);
  var storecashAdd = Core.getAllStorecashAddRecordByMembid(membid, 20);
  var storecashMerged = mergeStorecashRecords(storecashAdd, storecashUse);

  var timestamp = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm:ss");
  var memnam = (view && view.memnam) ? view.memnam : (member.memnam || "—");
  var profileSummary = summarizeMemberView(view);
  var transSummary = summarizeTransactions(transactions);
  var storeSummary = summarizeStorecash(storecashMerged);

  var sheet = getOrCreateSayDouFullSheet();
  var rowIndex = findSayDouFullRowByPhone(sheet, normalized);
  var noteCol = SAYDOU_FULL_CONFIG.HEADERS.length;  // 最後一欄是備註(Update)，更新時保留原值
  var existingNote = "";
  if (rowIndex !== null) {
    try {
      var v = sheet.getRange(rowIndex, noteCol).getValue();
      existingNote = (v != null && v !== "") ? String(v) : "";
    } catch (e) { existingNote = ""; }
  }

  var rowData = [
    timestamp,
    normalized,
    membid,
    memnam,
    transactions.length,
    storecashMerged.length,
    profileSummary,
    transSummary,
    storeSummary,
    existingNote
  ];

  if (rowIndex !== null) {
    sheet.getRange(rowIndex, 1, 1, rowData.length).setValues([rowData]);
    console.log("SayDou會員全貌：已更新列 " + rowIndex + "（手機 " + normalized + "，membid " + membid + "）");
    return { success: true, msg: "已更新", membid: membid, row: rowIndex };
  } else {
    sheet.appendRow(rowData);
    var newRow = sheet.getLastRow();
    console.log("SayDou會員全貌：已新增列 " + newRow + "（手機 " + normalized + "，membid " + membid + "）");
    return { success: true, msg: "已新增", membid: membid, row: newRow };
  }
}

/**
 * 手動測試：拉取單一手機的 SayDou 全貌
 */
function debug_PullSayDouFull() {
  var TEST_PHONE = "0975513172";
  console.log("拉取 " + TEST_PHONE + " 的 SayDou 全貌…");
  var result = pullSayDouFullByPhone(TEST_PHONE);
  console.log(JSON.stringify(result));
  if (result.success) {
    console.log("請到試算表「SayDou會員全貌」查看；備註(Update) 欄可自行填寫「已更新」等。");
  }
}
