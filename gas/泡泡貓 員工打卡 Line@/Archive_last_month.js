function archiveLastMonthAttendance() {
  const lock = LockService.getScriptLock();
  // 嘗試取得鎖定，最多等待 10 秒，避免多人同時執行
  if (!lock.tryLock(10000)) {
    Logger.log("⚠️ 系統忙碌中，請稍後再試（其他程序正在執行封存）。");
    return;
  }

  try {
    const ss = SpreadsheetApp.openById(LINE_STAFF_SS_ID);
    const SRC_NAME = "員工打卡紀錄";
    const DST_NAME = "打卡紀錄封存";
    const TIME_ZONE = ss.getSpreadsheetTimeZone(); // 跟隨試算表的時區設定

    const src = ss.getSheetByName(SRC_NAME);
    if (!src) throw new Error(`找不到來源工作表：${SRC_NAME}`);

    // 取得或建立封存表
    let dst = ss.getSheetByName(DST_NAME);
    if (!dst) dst = ss.insertSheet(DST_NAME);

    // 檢查來源資料
    const lastRow = src.getLastRow();
    const lastCol = src.getLastColumn();
    
    // 如果只有標題或沒資料，直接結束
    if (lastRow < 2) {
      Logger.log("來源表沒有資料，略過封存程序。");
      return;
    }

    // ---- 1. 計算上個月的時間區間 ----
    const now = new Date();
    // 本月1號 (00:00:00)
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    // 上月1號 (00:00:00)
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    
    // 時間戳記比較 (毫秒)
    const startMs = lastMonthStart.getTime();
    const endMs = thisMonthStart.getTime(); // 不包含本月1號

    Logger.log(`封存區間：${Utilities.formatDate(lastMonthStart, TIME_ZONE, "yyyy-MM-dd")} ~ ${Utilities.formatDate(thisMonthStart, TIME_ZONE, "yyyy-MM-dd")}`);

    // ---- 2. 讀取與篩選資料 (記憶體操作) ----
    // 一次讀取所有資料 (含標題，方便處理格式)
    const range = src.getRange(1, 1, lastRow, lastCol);
    const values = range.getValues();
    const header = values[0]; // 標題列
    const data = values.slice(1); // 內容資料

    const toArchive = [];
    const toKeep = [];

    // 使用 filter 邏輯分離資料
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const cellDate = row[1]; // 假設 B 欄是日期
      
      // 確保是日期物件才進行比較
      let ts = NaN;
      if (cellDate instanceof Date) {
        ts = cellDate.getTime();
      } else if (typeof cellDate === 'string' && cellDate !== "") {
         // 嘗試解析字串日期
         const parsed = new Date(cellDate);
         if (!isNaN(parsed.getTime())) ts = parsed.getTime();
      }

      if (!isNaN(ts) && ts >= startMs && ts < endMs) {
        toArchive.push(row);
      } else {
        toKeep.push(row);
      }
    }

    Logger.log(`封存筆數：${toArchive.length}，保留筆數：${toKeep.length}`);

    if (toArchive.length === 0) {
      Logger.log("沒有符合上個月的資料，無需動作。");
      return;
    }

    // ---- 3. 寫入封存表 ----
    // 如果封存表是空的，先寫入標題
    if (dst.getLastRow() === 0) {
      dst.getRange(1, 1, 1, header.length).setValues([header]);
    }

    // 寫入資料
    dst.getRange(dst.getLastRow() + 1, 1, toArchive.length, lastCol).setValues(toArchive);
    SpreadsheetApp.flush(); // 強制生效，確保資料已安全存入

    // ---- 4. 更新來源表 (安全覆寫) ----
    // 清除舊資料區域 (保留標題)
    src.getRange(2, 1, lastRow - 1, lastCol).clearContent();

    // 寫回保留的資料
    if (toKeep.length > 0) {
      src.getRange(2, 1, toKeep.length, lastCol).setValues(toKeep);
    }

    // ★★★ 優化重點：刪除多餘的空白列 ★★★
    // 封存後，如果原本有 1000 列，剩 200 列，下方會有 800 列空白
    // 刪除它們可以讓試算表讀取變快
    const maxRows = src.getMaxRows();
    const newLastRow = toKeep.length + 1; // +1 是標題列
    
    // 如果空白列超過 10 列，就進行刪除 (保留一點緩衝)
    if (maxRows > newLastRow + 10) {
      src.deleteRows(newLastRow + 1, maxRows - newLastRow);
    }

    Logger.log("✅ 封存作業成功完成！");

  } catch (e) {
    Logger.log(`❌ 發生錯誤：${e.toString()}`);
    throw e; // 拋出錯誤讓外部知道
  } finally {
    lock.releaseLock(); // 務必釋放鎖定
  }
}