// 寄送 月份連結
function sendExcelFile(userId, managedStores, start, end) {
  // 1. 檢查是否已有生成的檔案 (快取機制)
  const signExcel = getSignExcel(userId, Utilities.formatDate(start, "Asia/Taipei", "yyyy-MM"));
  if (signExcel && signExcel[3] !== "") {
    return `📂 你的打卡紀錄 Excel 檔案已準備好！\n🔗 下載連結：${signExcel[3]}`;
  }
  const storeMap = Core.getLineSayDouInfoMap() || {};

  // 2. 準備 Google Drive 與 Sheet
  // 檔名加上日期區間比較清楚
  const dateStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyyMMdd_HHmm");
  const spreadsheet = SpreadsheetApp.create(`泡泡貓_出勤記錄_${dateStr}`);
  const spreadsheetId = spreadsheet.getId();
  const sheetUrl = spreadsheet.getUrl();
  
  const { employeesByLineId, employeesByStore } = formatManagedStores();
  let sheetCount = 0;

  // 3. 遍歷每個負責的店家
  for (const ms of managedStores) {
    console.log(ms)
    if(!ms) continue;
    const storeId = String(ms);
    const storeInfo = storeMap[storeId];
    if (!storeInfo) {
      console.log(`查無店家資料 ID: ${storeId}`);
      continue;
    }
    console.log(storeInfo)
    let employees = employeesByStore.get(storeInfo.id); 
    if (!employees || employees.length === 0) continue;

    // 過濾出有效的 Line ID
    let userIds = employees.map(em => em.lineId).filter(id => id && id !== "#N/A");
    if (userIds.length === 0) continue;

    // 取得資料
    let rawData = getUserAttendance(userIds, start, end);
    
    // 初始化日期地圖 (確保每一天都有列出來，即使那天沒人打卡)
    let attendanceMap = {}; 
    // 複製一個日期物件避免修改到原始 start
    let loopDate = new Date(start); 
    // 強制設為 00:00:00 避免時分秒導致無窮迴圈
    loopDate.setHours(0,0,0,0);
    const endDate = new Date(end);
    endDate.setHours(23,59,59,999);

    while (loopDate <= endDate) {
      let dStr = Utilities.formatDate(loopDate, "Asia/Taipei", "yyyy-MM-dd");
      attendanceMap[dStr] = {}; // 建立該日期的空物件
      loopDate.setDate(loopDate.getDate() + 1);
    }

    // 4. 處理打卡資料 (填入 Map)
    if (rawData && rawData.length > 0) {
      for (let [uId, timestamp, type] of rawData) {
        // ★ 修正重點 1: 安全存取員工姓名 (防止離職員工導致報錯)
        const empObj = employeesByLineId.get(uId);
        if (!empObj) continue; // 如果找不到該員工資料，略過該筆紀錄
        const userName = empObj.name;

        let timeStr = Utilities.formatDate(new Date(timestamp), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
        const datePart = timeStr.slice(0, 10);
        const timePart = timeStr.slice(11, 16); // 只取 HH:mm 比較整潔 (若需要秒數可改回 slice(11))

        // 防呆：如果 rawData 有超出範圍的日期，補上 key
        if (!attendanceMap[datePart]) attendanceMap[datePart] = {};
        
        // 初始化該員工當天的資料
        if (!attendanceMap[datePart][userName]) {
          attendanceMap[datePart][userName] = { checkIn: "-", checkOut: "-" };
        }

        // 堆疊打卡時間 (處理多次打卡)
        if (type === "上班打卡") {
          let current = attendanceMap[datePart][userName].checkIn;
          attendanceMap[datePart][userName].checkIn = (current === "-") ? timePart : current + "\n" + timePart;
        }
        if (type === "下班打卡") {
          let current = attendanceMap[datePart][userName].checkOut;
          attendanceMap[datePart][userName].checkOut = (current === "-") ? timePart : current + "\n" + timePart;
        }
      }
    }

    // 5. 寫入 Sheet
    let sheet;
    if (sheetCount === 0) {
      sheet = spreadsheet.getSheets()[0];
      sheet.setName(storeInfo.name);
    } else {
      sheet = spreadsheet.insertSheet(storeInfo.name);
    }

    // 建構表頭
    let headerRow1 = [storeInfo.name];     // 第一列：店名, 姓名, 空白, 姓名, 空白...
    let headerRow2 = ["日期"]; // 第二列：日期, 入班, 離班, 入班, 離班...
    
    // 紀錄合併範圍用
    let mergeRanges = []; 

    for (let i = 0; i < employees.length; i++) {
      let e = employees[i];
      headerRow1.push(e.name, ""); // 推入姓名和佔位符
      headerRow2.push("上班", "下班");
      
      // 計算合併範圍 (起始列1, 起始欄 2 + i*2, 佔 1列, 佔 2欄)
      // 欄位索引從 1 開始，A=1, B=2. 第一個人在 B(2), C(3)
      let startCol = 2 + (i * 2);
      mergeRanges.push(sheet.getRange(1, startCol, 1, 2));
    }

    sheet.appendRow(headerRow1);
    sheet.appendRow(headerRow2);

    // ★ 修正重點 2: 執行合併儲存格 (讓姓名置中跨兩欄)
    mergeRanges.forEach(range => range.merge().setHorizontalAlignment("center"));
    sheet.getRange(1, 1).merge(); // 合併 A1 (雖無實質作用但保持一致)

    // 建構內容列
    let sortedDates = Object.keys(attendanceMap).sort();
    let rows = [];
    
    for (let date of sortedDates) {
      let row = [date];
      for (let e of employees) {
        // ★ 修正重點 3: 這裡要用 e.lineId 判斷，不是 e.userId
        let record = { checkIn: "-", checkOut: "-" };
        
        // 只有當員工有 Line ID 且 Map 裡有資料時才取值
        if (e.lineId && attendanceMap[date][e.name]) {
          record = attendanceMap[date][e.name];
        }
        row.push(record.checkIn, record.checkOut);
      }
      rows.push(row);
    }

    if (rows.length > 0) {
      // 批次寫入資料
      let dataRange = sheet.getRange(3, 1, rows.length, headerRow2.length);
      dataRange.setValues(rows);
      
      // 美化格式
      dataRange.setHorizontalAlignment("center").setVerticalAlignment("middle"); // 置中
      dataRange.setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP); // 自動換行 (處理多次打卡)
      sheet.setColumnWidth(1, 100); // 日期欄寬
    }
    
    sheetCount++;
  }

  // 6. 如果完全沒有資料 (sheetCount 仍為 0)，避免回傳空檔案
  if (sheetCount === 0) {
    return "⚠️ 查無此區間的員工或打卡資料，無法產生檔案。";
  }

  // 7. 檔案權限與移動
  let file = DriveApp.getFileById(spreadsheetId);
  try {
    let folder = DriveApp.getFolderById(FOLDER_ID);
    file.moveTo(folder); // 直接用 moveTo 取代 add + remove
  } catch (e) {
    console.error("資料夾移動失敗，檔案將留在根目錄: " + e);
  }
  
  file.setSharing(DriveApp.Access.ANYONE, DriveApp.Permission.VIEW);
  
  // 更新紀錄 (回寫 DB)
  if (signExcel && signExcel[0]) {
    modifySignExcel(signExcel[0], sheetUrl);
  }

  return `📂 你的打卡紀錄 Excel 檔案已準備好！\n🔗 下載連結：${sheetUrl}`;
}

// 登記請求表單（員工表單 → 請求表單紀錄）
// 若同人同月已有紀錄則直接回傳該筆，不重複跑、不重複寫入
function getSignExcel(userId, start) {
  const ss = SpreadsheetApp.openById(LINE_STAFF_SS_ID);
  const sheet = ss.getSheetByName("請求表單紀錄");
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const data = sheet.getRange(2, 1, lastRow, 6).getValues(); // A~F：uuid, userId, start, url, createTime, updateTime
    // 從最後一筆倒序搜尋（同一人同月可能有多筆時取最新一筆）
    for (let i = data.length - 1; i >= 0; i--) {
      const row = data[i];
      if (row[1] === userId) {
        const rowDateStr = Utilities.formatDate(new Date(row[2]), "Asia/Taipei", "yyyy-MM");
        if (rowDateStr === start) {
          console.log("發現同人同月已有請求紀錄，不重複跑");
          return [row[0], row[1], row[2], row[3], row[4], row[5]];
        }
      }
    }
  }

  // 沒找到同人同月紀錄，建立新資料並寫入請求表單紀錄
  const uuid = Utilities.getUuid();
  const now = new Date();
  // 欄位: [uuid, userId, start, url(空), createTime, updateTime(空)]
  const newRow = [uuid, userId, start, '', now, '']; 
  
  sheet.appendRow(newRow);
  
  // 回傳的結構保持與讀取到的一致 (原本程式碼回傳的 data 結構可能與 appendRow 不太一樣，這裡統一)
  return newRow; 
}
// 修改請求表單
function modifySignExcel(id, url) {
  const ss = SpreadsheetApp.openById(LINE_STAFF_SS_ID);
  const sheet = ss.getSheetByName("請求表單紀錄");
  if (!sheet) return;

  // ★ 優化：使用 TextFinder 直接在 A 欄 (ID欄) 搜尋，不讀取整張表
  // 假設 ID 在第一欄 (Column A)
  const finder = sheet.getRange("A:A").createTextFinder(id).matchEntireCell(true);
  const result = finder.findNext();

  if (result) {
    const rowContent = result.getRow();
    
    // 欄位對應：
    // A=1 (ID), B=2, C=3, D=4 (Url), E=5 (CreateTime), F=6 (UpdateTime)
    // 我們要改 D(4) 和 F(6)。
    
    // 寫法 A: 分開寫 (可讀性高，TextFinder 已經夠快了，這兩次寫入影響不大)
    sheet.getRange(rowContent, 4).setValue(url);      // 修改 URL
    sheet.getRange(rowContent, 6).setValue(new Date()); // 修改 更新時間

    /* // 寫法 B: 極致效能 (一次寫入)
    // 如果中間的 E 欄位資料不動，分開寫比較安全。
    // 如果確定 E 欄位也要重寫，可以用 setValues([[url, existingDate, newDate]])
    */
    
    console.log(`已更新 ID: ${id} 的資料`);
  } else {
    console.log(`找不到 ID: ${id}`);
  }
}