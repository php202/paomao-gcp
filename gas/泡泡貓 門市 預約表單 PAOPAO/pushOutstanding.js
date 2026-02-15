// === 全域變數設定 ===
const coreConfig = Core.getCoreConfig();
const LINE_TOKEN_PAOPAO = coreConfig.LINE_TOKEN_PAOPAO;
const EXTERNAL_SS_ID = coreConfig.EXTERNAL_SS_ID;
const SHEET_NAME = '2026/ACH紀錄';
const ERROR_LOG_SOURCE = '泡泡貓 門市 預約表單 PAOPAO';

/**
 * 將錯誤寫入訊息一覽表試算表的「錯誤紀錄」工作表（統一錯誤表），方便集中查看。
 */
function appendErrorLog(message, context) {
  try {
    var config = typeof Core !== 'undefined' && Core.getCoreConfig ? Core.getCoreConfig() : {};
    var ssId = config.LINE_STORE_SS_ID || '1ZV_0vjtQylyEWrrB5n05fBvvQiDoexYvFuztje1Fgm0'; // 訊息一覽表
    var sheetName = '錯誤紀錄';
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.appendRow(['時間', '來源', '錯誤訊息', '上下文']);
      sheet.setColumnWidth(1, 150);
      sheet.setColumnWidth(2, 120);
      sheet.setColumnWidth(3, 300);
      sheet.setColumnWidth(4, 250);
    }
    var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
    sheet.appendRow([now, ERROR_LOG_SOURCE, String(message || '').slice(0, 2000), String(context || '').slice(0, 500)]);
  } catch (err) {
    console.error('appendErrorLog 寫入失敗: ' + err);
  }
}

// ==========================================
// 2. 定時檢查主程式 (dailyCheckAndPush)
// ==========================================
function dailyCheckAndPush() {
  console.log("🚀 開始執行 dailyCheckAndPush...");

  const externalSs = SpreadsheetApp.openById(EXTERNAL_SS_ID);
  const sheet = externalSs.getSheetByName(SHEET_NAME);
  
  if (!sheet) {
    console.error(`❌ 找不到工作表: ${SHEET_NAME}，請確認名稱是否完全正確 (包含空格)`);
    return;
  }

  const data = sheet.getDataRange().getValues();
  console.log(`📊 共讀取到 ${data.length} 列資料`);

  const bankInfoMap = Core.getBankInfoMap(); 
  console.log(`🏦 取得店家資訊 Map 大小: ${bankInfoMap.size}`);

  // 遍歷資料 (從第二行開始，索引為 1)
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rowNum = i + 1; // 實際行號
    
    // --- 欄位讀取與除錯 ---
    // 請仔細核對這裡印出來的值，跟您 Excel 看到的一不一樣
    const oValue = row[15];   // P 欄 (Index 15): Odoo ID
    const gValue = row[6];    // G 欄 (Index 6): 確認紀錄
    const storeCode = row[3]; // D 欄 (Index 3): 店家代碼
    const amount = parseFloat(row[2]); // C 欄 (Index 2): 金額 (注意：您上次代碼是 row[2]，原版是 row[9]，請確認)

    // 只有當 Odoo ID 有值時，才印出除錯訊息，避免 Log 太多
    if (oValue) {
      console.log(`Row ${rowNum} [P欄 OdooID]: ${oValue} | [G欄 狀態]: "${gValue}" | [D欄 代碼]: ${storeCode}`);
      
      // 檢查條件是否成立
      const isGEmpty = (!gValue || gValue.toString().trim() === "");
      
      if (isGEmpty) {
        console.log(`   ✅ Row ${rowNum} 符合條件！準備執行處理...`);
        
        try {
          const storeInfo = bankInfoMap.get(String(storeCode).trim());
          if (!storeInfo) {
            console.warn(`   ⚠️ 找不到店家代碼 ${storeCode} 的對應資訊，跳過 LINE 發送`);
            // 這裡不 return，繼續跑，看能不能抓 Odoo
          }

          // ... (中間省略 Odoo 抓取邏輯，與原版相同) ...
          
          let odooId = oValue;
          if (String(oValue).includes("http")) {
            const urlParams = Core.parseOdooUrl(oValue);
            if (urlParams) odooId = urlParams.res_id;
          }
          
          const isPayment = amount < 0;
          let lines = [];

          if (isPayment) {
             // 負數：一定是帳單/付款單 (Invoice/Bill)
             console.log(`   📉 [${odooId}] 判定為付款單 (負數)，抓取 Invoice/Bill...`);
             lines = Core.getOdooInvoiceJSON(odooId);
          } else {
             // 正數：優先抓取訂單 (Sale Order)
             console.log(`   📈 [${odooId}] 判定為訂單 (正數)，優先抓取 Sale Order...`);
             lines = Core.getOdooSaleOrderJSON(odooId);
             
             // ★★★ 新增：雙重保險 ★★★
             // 如果抓不到訂單明細，有可能它是「直接開立的客戶發票 (Customer Invoice)」
             if (!lines || lines.length === 0) {
               console.warn(`   ⚠️ [${odooId}] 抓不到 Sale Order，嘗試改抓 Customer Invoice...`);
               lines = Core.getOdooInvoiceJSON(odooId);
             }
          }

          console.log(`   📦 Odoo 回傳明細數: ${lines ? lines.length : 0}`);
          
          if (lines && lines.length > 0) {
             // 產生明細文字
             const itemsText = lines
                .filter(line => Math.abs(line.price_subtotal) > 0)
                .map(line => `▫️ ${line.name} x${line.quantity}：$${Math.abs(line.price_subtotal)}`)
                .join('\n');
             
             // 取得群組 ID
             const targetGroupId = (storeInfo && storeInfo.groupId) ? storeInfo.groupId : 'C1d30e400d913718ead2f6a086578ba60';
             
             // ★★★ 正式發送 (解除註解) ★★★
             // 這裡使用 Core 的發送功能
             Core.sendLineConfirmButton(row[1], itemsText, Math.abs(amount), rowNum, odooId, targetGroupId, isPayment);
             console.log(`   ✅ LINE 訊息已發送至群組`);
             
          } else {
             console.error(`   ❌ Odoo ID ${odooId} 完全抓不到資料 (既不是 Order 也不是 Invoice)，請檢查單號是否正確`);
          }
        } catch (e) {
          console.error(`   ❌ 處理錯誤: ${e.message}`);
        }

      } else {
        console.log(`   ⏭️ 跳過：G 欄已有資料 (${gValue})`);
      }
    }
  }
  console.log("🏁 執行結束");
}

// ==========================================
// 4. 按鈕確認回填邏輯 (handleConfirmPostback)
// 以 odooId（P 欄）＋ storeName（B 欄）在試算表內比對找列，不依賴 postback 的 row，避免增刪列後錯行
// ==========================================
function handleConfirmPostback(event) {
  try {
    handleConfirmPostback_(event);
  } catch (e) {
    var msg = (e && e.message) ? e.message : String(e);
    console.error("handleConfirmPostback 錯誤: " + msg);
    var ctx = (event && event.postback && event.postback.data) ? event.postback.data : '';
    appendErrorLog(msg, 'postback: ' + ctx);
    try {
      Core.sendLineReply(event.replyToken, "錯誤: " + (msg || "請查看試算表「錯誤紀錄」工作表"), LINE_TOKEN_PAOPAO);
    } catch (replyErr) {
      console.error("回覆錯誤訊息失敗: " + replyErr);
      appendErrorLog('回覆失敗: ' + replyErr, ctx);
    }
  }
}

function handleConfirmPostback_(event) {
  const params = {};
  if (event.postback.data) {
    event.postback.data.split('&').forEach(p => {
      const idx = p.indexOf('=');
      if (idx >= 0) {
        const k = p.substring(0, idx);
        let v = p.substring(idx + 1);
        try { v = decodeURIComponent(v); } catch (e) {}
        params[k] = v;
      }
    });
  }

  if (params.action !== 'confirm') return;

  const odooId = (params.odoo != null) ? String(params.odoo).trim() : '';
  const storeNameFromPostback = (params.storeName != null) ? String(params.storeName).trim() : '';

  if (!odooId) {
    Core.sendLineReply(event.replyToken, '⚠️ 無法取得單號，請重試。', LINE_TOKEN_PAOPAO);
    return;
  }

  const source = event.source;
  const targetId = source.groupId || source.roomId || source.userId;
  const userId = source.userId;
  let userName;
  try {
    userName = Core.getUserDisplayName(userId, source.groupId, source.roomId, LINE_TOKEN_PAOPAO);
  } catch (e) {
    console.warn("getUserDisplayName 失敗，使用備用: " + (e && e.message));
    userName = "操作者";
  }

  const externalSs = SpreadsheetApp.openById(EXTERNAL_SS_ID);
  const sheet = externalSs.getSheetByName(SHEET_NAME);
  if (!sheet) {
    console.error("找不到工作表: " + SHEET_NAME);
    Core.sendLineReply(event.replyToken, '⚠️ 找不到工作表，請聯絡管理員。', LINE_TOKEN_PAOPAO);
    return;
  }

  // 以 P 欄 (odooId) ＋ B 欄 (storeName) 比對找列（第 1 列為標題，從第 2 列開始）
  const data = sheet.getDataRange().getValues();
  const colP = 16;  // P 欄 = 第 16 欄 (1-based)
  const colB = 2;    // B 欄 = 第 2 欄
  const colG = 7;    // G 欄 = 確認紀錄
  let rowIndex = -1;
  let resolvedStoreName = storeNameFromPostback;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const pVal = (row[colP - 1] != null) ? String(row[colP - 1]).trim() : '';
    const bVal = (row[colB - 1] != null) ? String(row[colB - 1]).trim() : '';
    if (pVal === odooId && (bVal === storeNameFromPostback || !storeNameFromPostback)) {
      rowIndex = i + 1;
      resolvedStoreName = bVal || storeNameFromPostback;
      break;
    }
  }

  if (rowIndex < 0) {
    Core.sendLineReply(event.replyToken, `⚠️ 找不到符合的資料列（單號: ${odooId}${storeNameFromPostback ? '，店名: ' + storeNameFromPostback : ''}），請確認試算表內 P 欄與 B 欄。`, LINE_TOKEN_PAOPAO);
    return;
  }

  const existingStatusRange = sheet.getRange(rowIndex, colG);
  const existingStatus = existingStatusRange.getValue();

  if (existingStatus && existingStatus.toString().trim() !== '') {
    Core.sendLineReply(event.replyToken, `⚠️ ${userName} 您好，\n這筆資料已經確認過囉！\n\n紀錄：\n${existingStatus}`, LINE_TOKEN_PAOPAO);
    return;
  }

  const now = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd HH:mm');
  existingStatusRange.setValue(`${now} 由 ${userName} 確認`);

  try {
    console.log(`準備 Push 收據至: ${targetId} (單號: ${odooId})`);
    Core.pushFlexReceipt(targetId, resolvedStoreName, odooId, userName);
  } catch (e) {
    console.error('收據 Push 失敗，改用文字回覆: ' + (e && e.message));
    Core.sendLineReply(event.replyToken, '✅ 確認成功！\n(收據顯示異常但已紀錄)', LINE_TOKEN_PAOPAO);
  }
}