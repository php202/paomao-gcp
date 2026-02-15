function gogoshopStocksReport() {
  // 1. 設定基礎網址 (不含 page 參數)
  var baseUrl = "https://my.gogoshop.io/Stocks/report";

  // 2. 設定你的 Cookie
  var myCookie = getP1();

  var options = {
    "method": "get",
    "headers": {
      "Cookie": myCookie,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      "Referer": "https://my.gogoshop.io/Dashboard"
    },
    "muteHttpExceptions": true
  };

  var allData = []; 
  var page = 1;     
  var hasNextPage = true;

  // === 開始迴圈抓取 ===
  while (hasNextPage) {
    
    var currentUrl = baseUrl;
    if (page > 1) {
      currentUrl = baseUrl + "?page=" + page;
    }

    Logger.log("正在抓取第 " + page + " 頁...");
    
    try {
      var response = UrlFetchApp.fetch(currentUrl, options);
      
      if (response.getResponseCode() !== 200) {
        Logger.log("請求失敗，停止抓取。狀態碼：" + response.getResponseCode());
        break;
      }

      var html = response.getContentText();
      html = html.replace(/(\r\n|\n|\r)/gm, "");

      var pageData = parseTableFromHtml(html);

      // 這裡原本會報錯，因為 pageData 沒收到東西
      if (pageData && pageData.length > 0) { 
        
        if (page === 1) {
           allData = allData.concat(pageData);
        } else {
           // 去掉標題列
           var dataOnly = pageData.slice(1); 
           allData = allData.concat(dataOnly);
        }
        
        Logger.log("第 " + page + " 頁抓取成功，取得 " + pageData.length + " 筆資料。");
        
        page++; 
        Utilities.sleep(1000); 

      } else {
        Logger.log("第 " + page + " 頁沒有抓到表格資料，判定為結束。");
        hasNextPage = false;
      }

    } catch (e) {
      Logger.log("發生錯誤：" + e);
      hasNextPage = false;
    }
    
    if (page > 50) { 
      Logger.log("達到安全頁數上限，停止。");
      break; 
    }
  }

  // === 寫入 Google Sheet ===
  if (allData.length > 0) {
    var ss = SpreadsheetApp.openById(PAOPAO_STORE_SS_ID);
    var sheet = ss.getSheetByName("gogoshop暫存");
    if (!sheet) {
      sheet = ss.insertSheet("gogoshop暫存");
    }

    sheet.clear(); 
    sheet.getRange(1, 1, allData.length, allData[0].length).setValues(allData);
    Logger.log("全部完成！總共寫入 " + allData.length + " 筆資料。");
  } else {
    Logger.log("沒有抓到任何資料。");
  }
  compareSalesData()
}

// 輔助函式：解析 HTML 中的表格
function parseTableFromHtml(html) {
  var tableData = [];
  var rowRegex = /<tr[^>]*>(.*?)<\/tr>/g;
  var rows = html.match(rowRegex);

  if (rows) {
    for (var i = 0; i < rows.length; i++) {
      var rowHtml = rows[i];
      var rowData = [];
      var cellRegex = /<(td|th)[^>]*>(.*?)<\/(td|th)>/g;
      var cells = rowHtml.match(cellRegex);
      
      if (cells) {
        for (var j = 0; j < cells.length; j++) {
          var cleanText = cells[j].replace(/<[^>]+>/g, "").trim();
          cleanText = cleanText.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
          rowData.push(cleanText);
        }
        tableData.push(rowData);
      }
    }
  }
  return tableData;
}

/**
 * 從「安全庫存」工作表上的 P1 儲存格取得數值。
 */
function getP1() {
  const spreadsheet = SpreadsheetApp.openById(PAOPAO_STORE_SS_ID);
  const sheet = spreadsheet.getSheetByName("安全庫存");
  if (sheet) {
    const range = sheet.getRange("P1"); 
    const value = range.getValue();
    Logger.log("P1 儲存格的數值為: " + value);
    // 如果您想將這個數值回傳給試算表中的另一個函式，可以 return value;
    return value;
  } else {
    Logger.log("找不到名為「安全庫存」的工作表。");
  }
}