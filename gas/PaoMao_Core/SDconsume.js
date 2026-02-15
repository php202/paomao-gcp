/**
 * 收費定義與「日報表 產出」一致（fetchDailyIncome totalRow）：
 * - 現金 = sum_paymentMethod[0]（單筆 t.cash + t.cashpay）
 * - LINE = sum_paymentMethod[2]（單筆 t.linepay）
 * - 轉帳 = sum_paymentMethod[9]（單筆 t.transfer 或 t.bank）
 * - 儲值金 = rpcash（不計入日帳營收，但單筆需顯示）
 */

// 從 transaction 物件組出結帳方式字串（與日帳表三類一致：現金、LINE、轉帳，另加儲值金／其他）
function formatTransactionPayment(t) {
  if (!t) return "";
  var labels = [];
  var cashVal = (t.cash != null ? t.cash : 0) + (t.cashpay != null ? t.cashpay : 0);
  if (cashVal > 0) labels.push("現金");
  if (t.linepay > 0) labels.push("LINE");
  var transferVal = (t.transfer != null ? t.transfer : 0) || (t.bank != null ? t.bank : 0);
  if (transferVal > 0) labels.push("轉帳");
  if (t.rpcash > 0) labels.push("儲值金");
  if (t.creditcard > 0 || t.card > 0) labels.push("信用卡");
  if (t.voucher > 0 || t.ticket > 0) labels.push("券");
  if (t.give > 0) labels.push("贈送");
  if (t.free > 0) labels.push("免費");
  if (t.wechatpay > 0) labels.push("WeChat");
  if (t.alipay > 0) labels.push("Alipay");
  if (t.applepay > 0) labels.push("Apple Pay");
  if (t.jkopay > 0) labels.push("街口");
  if (t.googlepay > 0) labels.push("Google Pay");
  if (t.taiwanpay > 0) labels.push("台灣 Pay");
  return labels.length ? labels.join("+") : "";
}

// 帳務：顯示明確金額（與日帳表一致：現金、LINE、轉帳、儲值金優先；其餘有值才列）
function formatTransactionPaymentAmounts(t) {
  if (!t) return "";
  var parts = [];
  var cashVal = (t.cash != null ? t.cash : 0) + (t.cashpay != null ? t.cashpay : 0);
  if (cashVal > 0) parts.push("現金 " + cashVal);
  if (t.linepay > 0) parts.push("LINE " + t.linepay);
  var transferVal = (t.transfer != null ? t.transfer : 0) || (t.bank != null ? t.bank : 0);
  if (transferVal > 0) parts.push("轉帳 " + transferVal);
  var rpcashVal = t.rpcash != null ? t.rpcash : 0;
  if (rpcashVal > 0) parts.push("儲值金 " + rpcashVal);
  if (t.card > 0 || (t.creditcard != null && t.creditcard > 0)) parts.push("信用卡 " + (t.creditcard != null ? t.creditcard : t.card));
  if (t.ticket > 0) parts.push("券 " + t.ticket);
  if (t.give > 0) parts.push("贈送 " + t.give);
  if (t.free > 0) parts.push("免費 " + t.free);
  if (t.voucher > 0) parts.push("兌換券 " + t.voucher);
  return parts.length ? parts.join(" ") : "";
}

// 找出神美這個客人的消費紀錄摘要（供客人消費狀態／AI 歷程用）
// 依手機 → getMemApi 取得 membid → getAllTransactionsByMembid 全筆拉取 → 回傳摘要（含 remark、結帳方式）
function getMemberHistorySummary(phone) {
  if (!phone) return null;
  var member = getMemApi(phone);
  if (!member || !member.membid) return null;
  var transactions = getAllTransactionsByMembid(member.membid, 20);
  if (!transactions || transactions.length === 0) {
    return { items: [], lastDate: null, count: 0 };
  }
  var lastDate = transactions[0].rectim || transactions[0].cretim || null;
  var lines = [];
  var maxShow = 10;
  for (var i = 0; i < Math.min(transactions.length, maxShow); i++) {
    var t = transactions[i];
    var dateStr = t.rectim || t.cretim || "";
    var store = (t.stor && t.stor.stonam) ? t.stor.stonam : "";
    var price = t.price_ != null ? t.price_ : (t.rprice != null ? t.rprice : 0);
    var detail = (t.ordds && t.ordds[0]) ? t.ordds[0].godnam : "";
    var remark = t.remark ? String(t.remark).trim() : "";
    var paymentAmounts = formatTransactionPaymentAmounts(t);
    var extra = [];
    if (remark) {
      var empMap = (typeof getEmployeeCodeToNameMap === "function") ? getEmployeeCodeToNameMap() : {};
      var empName = empMap[remark];
      extra.push("備註:" + remark + (empName ? " (" + empName + ")" : ""));
    }
    var paymentPart = paymentAmounts ? " " + paymentAmounts : "";
    var suffix = extra.length ? " [" + extra.join(" ") + "]" : "";
    lines.push(dateStr + " " + store + " $" + price + " " + detail + paymentPart + suffix);
  }
  if (transactions.length > maxShow) lines.push("…共 " + transactions.length + " 筆");
  var summaryText = lines.join("\n");
  return { items: summaryText, lastDate: lastDate, count: transactions.length };
}

/**
 * 依手機取得最近 N 筆消費明細（供 AI 戰報用），每筆含日期、門店、項目、金額、備註
 * @param {string} phone 手機號碼
 * @param {number} limit 筆數，預設 5
 * @returns {Array<{date:string, store:string, item:string, amount:number, payment:string, remark:string}>}
 */
function getMemberRecentTransactionsForPrompt(phone, limit) {
  if (!phone) return [];
  var member = getMemApi(phone);
  if (!member || !member.membid) return [];
  var transactions = getAllTransactionsByMembid(member.membid, limit || 20);
  if (!transactions || transactions.length === 0) return [];
  var n = Math.min(transactions.length, limit || 5);
  var out = [];
  for (var i = 0; i < n; i++) {
    var t = transactions[i];
    out.push({
      date: t.rectim || t.cretim || "",
      store: (t.stor && t.stor.stonam) ? t.stor.stonam : "",
      item: (t.ordds && t.ordds[0]) ? t.ordds[0].godnam : "",
      amount: t.price_ != null ? t.price_ : (t.rprice != null ? t.rprice : 0),
      payment: formatTransactionPaymentAmounts(t) || "",
      remark: t.remark ? String(t.remark).trim() : ""
    });
  }
  return out;
}

/**
 * 從消費紀錄計算平均消費間隔天數（排除小費）
 * @param {Array} transactions - transaction 陣列（由近到遠）
 * @returns {number} 平均間隔天數，至少 7 天；不足 2 筆則回傳 30
 */
function calculateConsumptionFrequency(transactions) {
  if (!transactions || transactions.length < 2) return 30;
  var dayMs = 24 * 60 * 60 * 1000;
  var parseDate = function (s) {
    if (s == null || s === '') return null;
    var str = String(s).trim();
    if (str.length >= 10) str = str.slice(0, 10);
    var d = new Date(str + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
  };
  var dates = [];
  for (var i = 0; i < transactions.length; i++) {
    var t = transactions[i];
    var remark = (t.remark != null) ? String(t.remark) : '';
    if (remark.indexOf('小費') >= 0) continue;
    var hasXiaofei = false;
    if (t.ordds && t.ordds.length) {
      for (var j = 0; j < t.ordds.length; j++) {
        var godnam = (t.ordds[j].godnam != null) ? String(t.ordds[j].godnam) : '';
        if (godnam.indexOf('小費') >= 0) { hasXiaofei = true; break; }
      }
    }
    if (hasXiaofei) continue;
    var d = parseDate(t.rectim || t.cretim);
    if (d) dates.push(d);
  }
  if (dates.length < 2) return 30;
  dates.sort(function (a, b) { return b.getTime() - a.getTime(); });
  var gaps = [];
  for (var k = 0; k < dates.length - 1; k++) {
    var gap = Math.round((dates[k].getTime() - dates[k + 1].getTime()) / dayMs);
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 30;
  var sum = 0;
  for (var m = 0; m < gaps.length; m++) sum += gaps[m];
  var avg = Math.round(sum / gaps.length);
  return avg < 7 ? 7 : avg;
}

/**
 * 根據上次消費日期與平均消費間隔，計算建議下次回訪日
 * @param {string} lastVisitDate - 上次消費日期，如 "2026-01-01" 或 "2026-01-01 12:00:00"
 * @param {number} avgFrequencyDays - 平均消費間隔天數
 * @returns {string} yyyy-MM-dd 格式的建議回訪日
 */
function calculateSuggestedNextVisit(lastVisitDate, avgFrequencyDays) {
  if (!lastVisitDate || avgFrequencyDays == null) return '';
  var str = String(lastVisitDate).trim();
  if (str.length >= 10) str = str.slice(0, 10);
  var d = new Date(str + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + (avgFrequencyDays || 30));
  return Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd');
}