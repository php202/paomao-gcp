/**
 * 一鍵建立各店訊息一覽表的排程觸發。
 * 執行方式：Apps Script 編輯器選 setupAllTriggers → 執行（需授權一次）。
 * 執行後會建立：每日 21:00 客人更新、每日 8:00 明日/昨日報告、每月 1 號 8:00 月報。
 * 表單送出觸發需另在「表單回應的試算表」綁定或手動加一次。
 */

var TRIGGERS_CONFIG = {
  TZ: "Asia/Taipei",
  /** 每日客人更新：21:00 */
  DAILY_UPDATE_HOUR: 21,
  DAILY_UPDATE_MINUTE: 0,
  /** 明日預約客人重整客人消費狀態：22:00 */
  TOMORROW_REFRESH_HOUR: 22,
  TOMORROW_REFRESH_MINUTE: 0,
  /** 明日/昨日報告：8:00、8:30（錯開避免同時跑） */
  TOMORROW_HOUR: 8,
  TOMORROW_MINUTE: 0,
  YESTERDAY_HOUR: 8,
  YESTERDAY_MINUTE: 30,
  /** 每月 1 號月報：8:00 */
  MONTHLY_DAY: 1,
  MONTHLY_HOUR: 8,
  MONTHLY_MINUTE: 0,
  /** Pending 巡航：每 N 分鐘掃準客挽留清單 D=Pending，逾時則代發 Reply（ReplyToken 約 3 分鐘有效）。everyMinutes 僅支援 1, 5, 10, 15, 30 */
  PENDING_CRUISE_MINUTES: 1,
  /** 準客挽留清單清理：每日此時檢查，若距上次清理已滿 10 天則執行（刪除已結案與過期 Pending） */
  CLEANUP_HOUR: 3,
  CLEANUP_MINUTE: 0,
  /** 候補清單今日自動 Push：22:00（預約日=今天且仍 pending 則自動傳提醒，狀態改為 auto_pushed） */
  WAITLIST_AUTO_PUSH_HOUR: 22,
  WAITLIST_AUTO_PUSH_MINUTE: 0
};

/** 要由本腳本建立／管理的觸發對應函式（用於刪除重複） */
var MANAGED_TRIGGER_HANDLERS = [
  "runDailyCustomerUpdate",
  "refreshCustomersByTomorrowReservations",
  "runTomorrowReservationReportAndPush",
  "runYesterdaySalesReportAndPush",
  "runMonthlySalesReportAndPush",
  "checkTimeoutPending",
  "cleanupRetentionList",
  "runWaitlistAutoPush"
];

/**
 * 刪除指定函式名稱的現有觸發（避免重複建立）
 * @param {string[]} handlerNames - 函式名稱陣列
 */
function removeTriggersForHandlers(handlerNames) {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    var t = triggers[i];
    var name = t.getHandlerFunction();
    if (handlerNames.indexOf(name) !== -1) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  }
  Logger.log("已刪除 " + removed + " 個觸發");
  return removed;
}

/**
 * 列出目前專案所有觸發（方便檢查）
 */
function listMyTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var out = [];
  for (var i = 0; i < triggers.length; i++) {
    var t = triggers[i];
    out.push({
      handler: t.getHandlerFunction(),
      type: t.getEventType().toString(),
      uniqueId: t.getUniqueId()
    });
  }
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * 一鍵建立所有排程觸發（先刪除同函式的舊觸發再建立，可重複執行）。
 * 執行一次即可完成對接；之後若要改時間可改 TRIGGERS_CONFIG 再跑一次。
 */
function setupAllTriggers() {
  var c = TRIGGERS_CONFIG;
  removeTriggersForHandlers(MANAGED_TRIGGER_HANDLERS);

  // ----- 以下每日/每月排程已暫時註解，驗證後再取消註解並重新執行 setupAllTriggers -----
  // 每日 21:00：客人更新（掃訊息一覽、重整客人消費狀態、客人樣貌摘要）
  // ScriptApp.newTrigger("runDailyCustomerUpdate")
  //   .timeBased()
  //   .everyDays(1)
  //   .atHour(c.DAILY_UPDATE_HOUR)
  //   .nearMinute(c.DAILY_UPDATE_MINUTE)
  //   .inTimezone(c.TZ)
  //   .create();

  // 每日 22:00：明日預約客人重整客人消費狀態（供明日上班前主管看）
  // ScriptApp.newTrigger("refreshCustomersByTomorrowReservations")
  //   .timeBased()
  //   .everyDays(1)
  //   .atHour(c.TOMORROW_REFRESH_HOUR)
  //   .nearMinute(c.TOMORROW_REFRESH_MINUTE)
  //   .inTimezone(c.TZ)
  //   .create();

  // 每日 8:00：明日預約報告
  // ScriptApp.newTrigger("runTomorrowReservationReportAndPush")
  //   .timeBased()
  //   .everyDays(1)
  //   .atHour(c.TOMORROW_HOUR)
  //   .nearMinute(c.TOMORROW_MINUTE)
  //   .inTimezone(c.TZ)
  //   .create();

  // 每日 8:30：昨日消費報告
  // ScriptApp.newTrigger("runYesterdaySalesReportAndPush")
  //   .timeBased()
  //   .everyDays(1)
  //   .atHour(c.YESTERDAY_HOUR)
  //   .nearMinute(c.YESTERDAY_MINUTE)
  //   .inTimezone(c.TZ)
  //   .create();

  // 每月 1 號 8:00：本月消費報告（與員工每月樣態）
  // ScriptApp.newTrigger("runMonthlySalesReportAndPush")
  //   .timeBased()
  //   .onMonthDay(c.MONTHLY_DAY)
  //   .atHour(c.MONTHLY_HOUR)
  //   .nearMinute(c.MONTHLY_MINUTE)
  //   .inTimezone(c.TZ)
  //   .create();
  // ----- 以上暫時註解結束 -----

  // 每 N 分鐘：Pending 巡航（掃準客挽留清單 D=Pending，逾 3 分鐘則代發 Reply）。everyMinutes 僅接受 1, 5, 10, 15, 30
  var pendingMins = [1, 5, 10, 15, 30].indexOf(c.PENDING_CRUISE_MINUTES) >= 0 ? c.PENDING_CRUISE_MINUTES : 1;
  ScriptApp.newTrigger("checkTimeoutPending")
    .timeBased()
    .everyMinutes(pendingMins)
    .create();

  // 每日 03:00 檢查：若距上次清理已滿 10 天則執行 cleanupRetentionList（刪除已結案 Overwritten/Replied/AutoReplied/Skipped/SendFailed 與逾 7 天 Pending）
  ScriptApp.newTrigger("cleanupRetentionList")
    .timeBased()
    .everyDays(1)
    .atHour(c.CLEANUP_HOUR)
    .nearMinute(c.CLEANUP_MINUTE)
    .inTimezone(c.TZ)
    .create();

  // 每日 22:00：候補清單今日自動 Push（日期=今天且狀態=pending → 發 Push → 狀態改為 auto_pushed），結算候補追蹤率寫入 M 欄
  ScriptApp.newTrigger("runWaitlistAutoPush")
    .timeBased()
    .everyDays(1)
    .atHour(c.WAITLIST_AUTO_PUSH_HOUR)
    .nearMinute(c.WAITLIST_AUTO_PUSH_MINUTE)
    .inTimezone(c.TZ)
    .create();

  Logger.log("已建立 3 個排程觸發（每 " + pendingMins + " 分鐘 Pending 巡航、每日 " + c.CLEANUP_HOUR + ":00 準客挽留清理、每日 " + c.WAITLIST_AUTO_PUSH_HOUR + ":00 候補自動 Push）。每日 21:00/22:00/8:00/8:30 與每月 1 號 8:00 已暫時註解，驗證後取消註解並重新執行 setupAllTriggers 即可恢復。");
  Logger.log("請到 編輯 → 目前專案的觸發條件 確認。表單送出觸發（onFormSubmit_Survey）需在「表單回應的試算表」專案內手動加一次。");
  return listMyTriggers();
}
