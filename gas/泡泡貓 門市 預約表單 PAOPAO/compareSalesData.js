function compareSalesData() {
  // ================= 設定區 =================
  var myCookie = getP1();
  // =========================================
  Logger.log("=== 步驟 1: 正在抓取 3 個月內的資料 ===");
  var data3M = fetchReportByMonths(3, myCookie);
  if (data3M.length === 0) { Logger.log("3個月資料抓取失敗或無資料"); return; }
  Logger.log("=== 步驟 2: 正在抓取 6 個月內的資料 (主表) ===");
  var data6M = fetchReportByMonths(6, myCookie);
  if (data6M.length === 0) { Logger.log("6個月資料抓取失敗或無資料"); return; }
  Logger.log("=== 步驟 3: 開始合併資料 ===");
  
  // 建立對照表
  var map3M = {};
  var header3M = [...new Set(data3M[0])];
  
  // 安全檢查：確保 header3M 存在
  if (!header3M) { Logger.log("錯誤：3個月資料沒有標題列"); return; }

  for (var i = 1; i < data3M.length; i++) {
    var row = data3M[i];
    if (row.length > 0) {
      var key = row[0]; 
      map3M[key] = row;
    }
  }

  var finalData = [];
  var header6M = [...new Set(data6M[0])];
  
  // --- 合併標題 ---
  // 這裡計算出我們期望的「標準總寬度」
  var newHeader = header6M.concat(header3M.map(function(h){ return "(3M) " + h; }));
  finalData.push(newHeader);
  var expectedColumns = newHeader.length; // 這是關鍵數字 (例如 14)

  // --- 合併內容 ---
  for (var i = 1; i < data6M.length; i++) {
    var row6M = data6M[i];
    var key = row6M[0];
    var mergedRow = [];
    
    var row3M = map3M[key];
    
    if (row3M) {
      mergedRow = row6M.concat(row3M);
    } else {
      var emptyRow = new Array(header3M.length).fill(""); 
      mergedRow = row6M.concat(emptyRow);
    }
    
    finalData.push(mergedRow);
  }

  // === 步驟 3.5: 【修復錯誤的關鍵】資料正規化 ===
  // 確保每一列的長度都跟標題列一樣長
  Logger.log("正在修正欄位長度不一致的問題 (正規化)...");
  
  for (var i = 0; i < finalData.length; i++) {
    var row = finalData[i];
    
    // 如果這一列太短 (例如 Total 列)，補空白
    while (row.length < expectedColumns) {
      row.push(""); 
    }
    
    // 如果這一列太長 (極少見)，切掉多餘的
    if (row.length > expectedColumns) {
      finalData[i] = row.slice(0, expectedColumns);
    }
  }

  // === 步驟 4: 寫入 Google Sheet ===
  var sheetName = "3M vs 6M 銷售比較";
  var ss = SpreadsheetApp.openById(PAOPAO_STORE_SS_ID);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) { sheet = ss.insertSheet(sheetName); }
  
  sheet.clear();
  
  // 現在 finalData 已經非常整齊，不會報錯了
  if (finalData.length > 0) {
    sheet.getRange(1, 1, finalData.length, expectedColumns).setValues(finalData);
  }
  
  Logger.log("完成！請查看工作表：「" + sheetName + "」");
}


// ========== 共用的抓取函式 (自動翻頁) ==========
function fetchReportByMonths(months, cookie) {
  var dateRange = calculateDateRange(months);
  var baseUrl = "https://my.gogoshop.io/Report/product?tag_id=&type=name&created_from=" + dateRange.from + "&created_to=" + dateRange.to;
  
  var options = {
    "method": "get",
    "headers": {
      "Cookie": cookie,
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://my.gogoshop.io/Dashboard"
    },
    "muteHttpExceptions": true
  };

  var allData = [];
  var page = 1;
  var hasNextPage = true;

  while (hasNextPage) {
    var currentUrl = baseUrl + (page > 1 ? "&page=" + page : "");
    try {
      var response = UrlFetchApp.fetch(currentUrl, options);
      if (response.getResponseCode() !== 200) break;

      var html = response.getContentText().replace(/(\r\n|\n|\r)/gm, "");
      var pageData = parseTableFromHtml(html);

      if (pageData && pageData.length > 0) {
        if (page === 1) {
           allData = allData.concat(pageData); // 第一頁包含標題
        } else {
           allData = allData.concat(pageData.slice(1)); // 之後的頁數去掉標題
        }
        page++;
        Utilities.sleep(800); // 稍微休息一下
      } else {
        hasNextPage = false;
      }
    } catch (e) {
      Logger.log("Error: " + e);
      hasNextPage = false;
    }
    if (page > 50) break; // 安全機制
  }
  return allData;
}

// 日期計算輔助
function calculateDateRange(monthsBack) {
  var today = new Date();
  var pastDate = new Date();
  pastDate.setMonth(today.getMonth() - monthsBack);
  return { to: formatDate(today), from: formatDate(pastDate) };
}

function formatDate(date) {
  var d = new Date(date), month = '' + (d.getMonth() + 1), day = '' + d.getDate(), year = d.getFullYear();
  if (month.length < 2) month = '0' + month;
  if (day.length < 2) day = '0' + day;
  return [year, month, day].join('-');
}

// HTML 解析輔助
function parseTableFromHtml(html) {
  var tableData = [];
  var rows = html.match(/<tr[^>]*>(.*?)<\/tr>/g);
  if (rows) {
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].match(/<(td|th)[^>]*>(.*?)<\/(td|th)>/g);
      if (cells) {
        var rowData = [];
        for (var j = 0; j < cells.length; j++) {
          var txt = cells[j].replace(/<[^>]+>/g, "").trim().replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
          rowData.push(txt);
        }
        tableData.push(rowData);
      }
    }
  }
  return tableData;
}