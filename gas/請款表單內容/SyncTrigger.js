/**
 * Sheet 變動即時同步到 Dashboard DB
 * 
 * 安裝方式：
 *   1. 在 GAS 編輯器開啟此專案
 *   2. 左側「觸發條件」→「新增觸發條件」
 *   3. 函式: onSheetEdit
 *   4. 事件來源: 試算表 → 編輯時
 *   5. 儲存
 * 
 * 或直接執行 installSyncTrigger() 自動安裝
 */

/** Dashboard API 設定 */
var SYNC_CONFIG = {
  API_URL: 'https://dashboard.paopaomao.tw/api/billing/sync',
  API_KEY: 'paomao-billing-sync-2026',
  
  /** Sheet 名稱 → sync type 對應 */
  SHEET_MAP: {
    '2026/ACH紀錄': 'ach',
    '2026請款表': 'claims',
    '勞報單': 'labor'
  }
};

/**
 * 安裝觸發器（執行一次即可）
 */
function installSyncTrigger() {
  // 先刪除舊的
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'onSheetEdit') {
      ScriptApp.deleteTrigger(t);
    }
  });
  
  // 安裝新的 installable onChange trigger（比 onEdit 更可靠，含程式碼修改也能偵測）
  ScriptApp.newTrigger('onSheetEdit')
    .forSpreadsheet(PAYMENT_SS_ID)
    .onChange()
    .create();
  
  console.log('✅ 同步觸發器已安裝');
}

/**
 * Sheet 編輯時觸發
 * 使用 onChange 而非 onEdit，因為 onChange 能捕捉更多事件類型
 */
function onSheetEdit(e) {
  try {
    const ss = SpreadsheetApp.openById(PAYMENT_SS_ID);
    const sheet = ss.getActiveSheet();
    const sheetName = sheet.getName();
    
    // 只同步指定的 sheet
    const syncType = SYNC_CONFIG.SHEET_MAP[sheetName];
    if (!syncType) return;
    
    // onChange 事件沒有精確的 row range，需要用 getActiveRange
    const range = sheet.getActiveRange();
    if (!range) return;
    
    const startRow = range.getRow();
    const endRow = startRow + range.getNumRows() - 1;
    
    // 跳過標題列
    if (startRow <= 1 && endRow <= 1) return;
    
    // 取得所有標題
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    
    // 同步受影響的每一列
    const actualStart = Math.max(startRow, 2);
    for (let row = actualStart; row <= endRow; row++) {
      syncRow_(sheet, headers, row, syncType);
    }
  } catch (err) {
    console.error('[SyncTrigger] 錯誤:', err.message || err);
  }
}

/**
 * 同步單一列到 Dashboard DB
 */
function syncRow_(sheet, headers, rowNum, syncType) {
  const rowData = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
  
  // 建立 key-value 資料物件
  const data = buildRowData_(headers, rowData, syncType);
  
  // 如果整列都是空的就跳過
  if (!data) return;
  
  const payload = {
    api_key: SYNC_CONFIG.API_KEY,
    sheet: syncType,
    row_index: rowNum,
    data: data
  };
  
  try {
    const res = UrlFetchApp.fetch(SYNC_CONFIG.API_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects: true
    });
    
    const code = res.getResponseCode();
    if (code !== 200) {
      console.warn(`[SyncTrigger] 同步失敗 ${syncType} row ${rowNum}: HTTP ${code} ${res.getContentText().slice(0, 200)}`);
    }
  } catch (e) {
    console.error(`[SyncTrigger] 網路錯誤 ${syncType} row ${rowNum}:`, e.message);
  }
}

/**
 * 根據 sheet 類型，將列資料轉成 API 需要的 key-value
 */
function buildRowData_(headers, rowData, syncType) {
  // 通用：將空字串轉 null
  const val = (idx) => {
    if (idx < 0 || idx >= rowData.length) return null;
    const v = rowData[idx];
    if (v === '' || v === null || v === undefined) return null;
    if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
    return String(v).trim();
  };
  
  const idx = (name) => headers.indexOf(name);
  
  if (syncType === 'ach') {
    const storeName = val(1);  // B 欄：店家
    const amount = val(2);     // C 欄：金額
    // 如果店家和金額都空，跳過
    if (!storeName && !amount) return null;
    
    return {
      record_date:        val(0),
      store_name:         storeName,
      amount:             amount,
      payee_code:         val(3),
      fee_type:           val(4),
      description:        val(5),
      customer_confirmed: val(6),
      ach_registered:     val(7),
      ach_case_no:        val(8),
      ach_released:       val(9),
      ach_confirmed:      val(10),
      transfer_666_686:   val(11),
      transfer_case_no:   val(12),
      invoice_confirmed:  val(13),
      odoo_invoice_id:    val(14),
      odoo_quote_id:      val(15),
      odoo_posted:        val(16),
      ref_case_no:        val(17),
      ref_amount:         val(18),
      ref_store:          val(19),
      ref_account:        val(20),
      ref_extra:          val(21)
    };
  }
  
  if (syncType === 'claims') {
    const claimNo = val(idx('編號'));
    if (!claimNo) return null;
    
    return {
      claim_no:              claimNo,
      registered_at:         val(idx('登記時間')),
      claimant:              val(idx('請款人')),
      claim_confirmed:       val(idx('請款單確認')),
      unit:                  val(idx('單位')),
      claim_reason:          val(idx('請款事由')),
      quantity:              val(idx('數量')),
      untaxed_amount:        val(idx('未稅金額')),
      tax_amount:            val(idx('進項稅額')),
      total_amount:          val(idx('總價')),
      currency:              val(idx('幣別')),
      exchange_rate:         val(idx('匯率')),
      claim_amount:          val(idx('請款金額')),
      approved_li:           val(idx('簽核完成(李)')),
      estimated_remit_date:  val(idx('預計匯款日(羅)')),
      disbursement_logged:   val(idx('登錄撥款(Ro)')),
      remit_case_no:         val(idx('匯款編號')),
      release_confirmed:     val(idx('確認放行(余)')),
      actual_remit_date:     val(idx('正確匯款日期(家)\n收款')),
      acc_invoice:           val(idx('  ACC get invoice')),
      odoo_posted:           val(idx('應付付款入odoo')),
      odoo_posted_no:        val(idx('odoo入帳編號')),
      shipping_no:           val(idx('海運單號')),
      occurrence_count:      val(idx('出現幾次'))
    };
  }
  
  if (syncType === 'labor') {
    const name = val(idx('基本資料'));
    if (!name) return null;
    
    return {
      submitted_at:          val(idx('時間戳記')),
      email:                 val(idx('電子郵件地址')),
      full_name:             name,
      address:               val(idx('戶籍地址')),
      id_number:             val(idx('身分證字號 / 居留證號')),
      service_start:         val(idx('勞務提供期間（起始日）')),
      service_end:           val(idx('勞務提供期間（結束日）')),
      service_desc:          val(idx('勞務內容說明')),
      gross_amount:          val(idx('勞務報酬金額（未扣稅）')),
      identity_type:         val(idx('身分類型')),
      bank_code:             val(idx('銀行代碼（數字表示）')),
      branch_code:           val(idx('分行代碼（數字表示）')),
      bank_account:          val(idx('銀行帳號')),
      account_holder:        val(idx('戶名')),
      id_front_url:          val(idx('身分證正面')),
      id_back_url:           val(idx('身分證反面')),
      signature_url:         val(idx('簽名（可在下方押上日期）')),
      passbook_url:          val(idx('存摺封面')),
      declaration:           val(idx('聲明與同意')),
      confirmed_luo:         val(idx('確認（羅）')),
      expense_type:          val(idx('費用性質（羅）')),
      estimated_remit_date:  val(idx('預計匯款日（羅）')),
      remit_form_done:       val(idx('製作匯款單完成（余）')),
      release_yu:            val(idx('放行（余）')),
      receipt_no:            val(idx('編號')),
      remit_success:         val(idx('是否匯款成功（羅）')),
      pdf_url:               val(idx('勞報單製作完成'))
    };
  }
  
  return null;
}

/**
 * 手動全量同步（用於初次設定或資料修復）
 * 會同步所有三張表的所有資料到 DB
 */
function fullSync() {
  const ss = SpreadsheetApp.openById(PAYMENT_SS_ID);
  const ui = SpreadsheetApp.getUi();
  
  let totalSynced = 0;
  
  for (const [sheetName, syncType] of Object.entries(SYNC_CONFIG.SHEET_MAP)) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) { console.log(`跳過: 找不到 ${sheetName}`); continue; }
    
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    let count = 0;
    
    for (let i = 1; i < data.length; i++) {
      const rowData = data[i];
      const rowObj = buildRowData_(headers, rowData, syncType);
      if (!rowObj) continue;
      
      const payload = {
        api_key: SYNC_CONFIG.API_KEY,
        sheet: syncType,
        row_index: i + 1,
        data: rowObj
      };
      
      try {
        UrlFetchApp.fetch(SYNC_CONFIG.API_URL, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(payload),
          muteHttpExceptions: true,
          followRedirects: true
        });
        count++;
      } catch (e) {
        console.error(`[fullSync] ${syncType} row ${i+1} 失敗:`, e.message);
      }
      
      // 避免 UrlFetchApp 配額爆掉，每 50 筆暫停一下
      if (count % 50 === 0) Utilities.sleep(1000);
    }
    
    console.log(`${sheetName}: 同步 ${count} 筆`);
    totalSynced += count;
  }
  
  ui.alert(`全量同步完成！共同步 ${totalSynced} 筆資料。`);
}
