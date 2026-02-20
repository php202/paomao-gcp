/**
 * 在試算表開啟時建立自訂選單
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🛠 帳務工具')
      .addItem('🚀 產出銀行傳輸 TXT 檔（改由 GCP 執行）', 'gcp_main')
      .addItem('🚀 開發票（改由 GCP 執行）', 'gcp_issueInvoice')
      .addItem('🚀 產出勞報單（改由 GCP 執行）', 'gcp_createLaborReceipts')
      .addSeparator()
      .addItem('🔍 檢查 Odoo 單號與開票連線', 'checkOdooNumberAndCoreApi')
      .addItem('🗑️ 刪除暫存工作表（改由 GCP 執行）', 'gcp_cleanupTempSheets')
      .addToUi();
}

function getGcpAdminParams_() {
  const p = PropertiesService.getScriptProperties();
  const url = (p.getProperty('GCP_ADMIN_URL') || '').trim();
  const key = (p.getProperty('GCP_ADMIN_KEY') || p.getProperty('PAO_CAT_SECRET_KEY') || '').trim();
  return { url, key, useAdmin: url.length > 0 && key.length > 0 };
}

function callGcpAdmin_(action, extraParams) {
  const { url, key, useAdmin } = getGcpAdminParams_();
  if (!useAdmin) return null;
  const payload = Object.assign({ key: key, action: action }, extraParams || {});
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    followRedirects: true,
  });
  try {
    return JSON.parse(res.getContentText() || '{}');
  } catch (e) {
    return { status: 'error', message: res.getContentText() };
  }
}

function gcp_main() {
  const ui = SpreadsheetApp.getUi();
  const res = callGcpAdmin_('billing_bankTxt', {});
  if (!res) return ui.alert('尚未設定 GCP_ADMIN_URL / GCP_ADMIN_KEY，或 GCP 尚未提供此 action。');
  ui.alert(res.status === 'ok' ? '已送出 GCP 工作（請至 Cloud Run Logs/Jobs 查看進度）' : ('GCP 執行失敗：' + (res.message || 'unknown')));
}

function gcp_issueInvoice() {
  const ui = SpreadsheetApp.getUi();
  const res = callGcpAdmin_('billing_issueInvoice', {});
  if (!res) return ui.alert('尚未設定 GCP_ADMIN_URL / GCP_ADMIN_KEY，或 GCP 尚未提供此 action。');
  ui.alert(res.status === 'ok' ? '已送出 GCP 工作（請至 Cloud Run Logs/Jobs 查看進度）' : ('GCP 執行失敗：' + (res.message || 'unknown')));
}

function gcp_createLaborReceipts() {
  const ui = SpreadsheetApp.getUi();
  const res = callGcpAdmin_('billing_createLaborReceipts', {});
  if (!res) return ui.alert('尚未設定 GCP_ADMIN_URL / GCP_ADMIN_KEY，或 GCP 尚未提供此 action。');
  ui.alert(res.status === 'ok' ? '已送出 GCP 工作（請至 Cloud Run Logs/Jobs 查看進度）' : ('GCP 執行失敗：' + (res.message || 'unknown')));
}

function gcp_cleanupTempSheets() {
  const ui = SpreadsheetApp.getUi();
  const res = callGcpAdmin_('billing_cleanupTempSheets', {});
  if (!res) return ui.alert('尚未設定 GCP_ADMIN_URL / GCP_ADMIN_KEY，或 GCP 尚未提供此 action。');
  ui.alert(res.status === 'ok' ? '已送出 GCP 工作（請至 Cloud Run Logs/Jobs 查看進度）' : ('GCP 執行失敗：' + (res.message || 'unknown')));
}

/** 費用種類	說明
 * case1 貨款	ach p01文件、666_>686 的excel
 * case2 儲值金	若 C > 0, ach p01文件, 若 C < 0, 666 轉給加盟主
 * case3 票卷	686 轉給加盟主
 * case4 免費/自行匯款	不用做事
*/
function main() {
  const ss = SpreadsheetApp.openById(PAYMENT_SS_ID);
  const sheet = ss.getSheetByName('2026/ACH紀錄'); // 2026/ACH紀錄
  const rows = sheet.getDataRange().getValues(); // 取得所有資料 (二維陣列)
  // 1. 取得店家銀行帳號對應表
  let bankInfoMap;
  try {
    bankInfoMap = Core.getBankInfoMap();
  } catch (e) {
    SpreadsheetApp.getUi().alert('設定錯誤：' + e.toString());
    return;
  }

  // 準備儲存不同分類的資料
  let achP01List = [];      // 存放需要產出 ACH P01 文字檔的資料
  let excel666To686 = [];   // 存放 666 -> 686 Excel 轉換的資料
  let pay666ToFranchisee = []; // 存放公司須轉帳給加盟主的資料 (666轉出 或 686轉出)
  let pay686ToFranchisee = []; // 存放公司須轉帳給加盟主的資料 (666轉出 或 686轉出)
  

  // 整理付款種類 E=4
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const amount = row[2];          // Column C: 金額
    const type = String(row[4]);    // Column E: 費用種類
    const customerConfirm = String(row[6]).toLowerCase().trim(); // Column G
    const achRegister = String(row[7]).trim();                   // Column H

    // 篩選條件：客人確認 = 'true' 且 登陸ach 為空
    if (!customerConfirm || achRegister !== '') {
      continue;
    }
    // --- 分 Case 處理邏輯 ---
    switch (type) {
      case '貨款':
      case '服務費':
      case '廣告費':
      case '儀器運費':
      case '維修費':
      case '顧問':
        // case1: ach p01文件、666_>686 的excel
        achP01List.push(row);
        excel666To686.push(row);
        break;

      case 'ACH餘額不足':
        // ach p01文件，不做 666_>686
        achP01List.push(row);
        break;

      case '儲值金':
        // case2: 若 C > 0, ach p01文件; 若 C < 0, 666 轉給加盟主
        if (amount > 0) {
          achP01List.push(row);
        } else if (amount < 0) {
          pay666ToFranchisee.push(row);
        }
        break;

      case '票卷':
        // case3: 686 轉給加盟主
        pay686ToFranchisee.push(row);
        break;

      case '免費/自行匯款':
        // case4: 不用做事
        console.log(`跳過自行匯款項目: ${row[1]}`);
        break;

      case '666轉686':
        pay666ToFranchisee.push(['', row[1], row[2], '94256530686', '內帳',])
        break;
        
      case '686轉666':
        pay686ToFranchisee.push(['', row[1], row[2], '94256530666', '內帳',])
        break;

      default:
        // console.warn(`未知的費用種類: ${type} (行號: ${i + 1})`);
    }
  }
  const { achFileName, achDownloadUrl } = achP01(achP01List)
  const { etewfTempSheetName, etewfDownloadUrl } = exportToExcelWithFilter(excel666To686, pay666ToFranchisee, pay686ToFranchisee)

  const htmlTemplate = `
    <div style="font-family: sans-serif; text-align: center; padding: 10px;">
      <p style="font-size: 14px;">✅ 檔案 <b>${achFileName}</b> 已產生</p>
      <br>
      <a href="${achDownloadUrl}" target="_blank" 
          style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
          🚀 點我立即下載 TXT
      </a>
      <p style="font-size: 14px;">✅ 檔案 <b>${etewfTempSheetName}</b> 已產生</p>
      <br>
      <a href="${etewfDownloadUrl}" target="_blank" 
          style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
          🚀 點我立即下載 TXT
      </a>
      <p style="font-size: 11px; color: #666; margin-top: 15px;">下載完成後可手動關閉此視窗</p>
    </div>
  `;

  const htmlOutput = HtmlService
      .createHtmlOutput(htmlTemplate)
      .setWidth(350)
      .setHeight(180);
      
  SpreadsheetApp.getUi().showModalDialog(htmlOutput, '檔案產出成功');

}

function cleanupTempSheets() {
  Core.cleanupTempSheets('17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE', '銀行匯款格式_')
}

/** GCP /core 預設網址（僅在未設 GCP_CORE_API_URL 且 PAO_CAT_CORE_API_URL 為 GAS 時使用，與 gcp/set-env.sh GCP_CORE_PUBLIC_URL 一致） */
var GCP_CORE_API_URL_FALLBACK = 'https://pao-checkin-api-vkffbzouva-de.a.run.app/core';

/**
 * 開發票與 getOdooInvoice：優先 GCP_CORE_API_URL + GCP_CORE_SECRET_KEY；
 * 未設則用 PAO_CAT_CORE_API_URL + PAO_CAT_SECRET_KEY。若 PAO_CAT 指到 GAS（script.google.com），
 * 自動改打 GCP_CORE_API_URL_FALLBACK（直連 GCP），金鑰仍用 PAO_CAT_SECRET_KEY，無需再設 GCP 網址。
 */
function getCoreApiParams() {
  const p = PropertiesService.getScriptProperties();
  const gcpUrl = (p.getProperty('GCP_CORE_API_URL') || '').trim();
  const gcpKey = (p.getProperty('GCP_CORE_SECRET_KEY') || '').trim();
  const paoUrl = (p.getProperty('PAO_CAT_CORE_API_URL') || '').trim();
  const paoKey = (p.getProperty('PAO_CAT_SECRET_KEY') || '').trim();
  console.log('[getCoreApiParams] GCP_CORE_API_URL=%s GCP_CORE_SECRET_KEY=%s PAO_CAT_CORE_API_URL=%s PAO_CAT_SECRET_KEY=%s',
    gcpUrl ? 'set(' + gcpUrl.length + ')' : 'empty',
    gcpKey ? 'set' : 'empty',
    paoUrl ? 'set(' + paoUrl.length + ')' : 'empty',
    paoKey ? 'set' : 'empty');
  if (gcpUrl.length > 0 && gcpKey.length > 0) {
    console.log('[getCoreApiParams] 使用 source=gcp_core_api_url url=%s', gcpUrl.replace(/key=.*/i, '').substring(0, 60) + (gcpUrl.length > 60 ? '...' : ''));
    return { url: gcpUrl, key: gcpKey, useApi: true };
  }
  if (paoUrl.length > 0 && paoKey.length > 0) {
    var isGas = paoUrl.indexOf('script.google.com') !== -1;
    var fallbackDefined = typeof GCP_CORE_API_URL_FALLBACK !== 'undefined' && GCP_CORE_API_URL_FALLBACK;
    var finalUrl = isGas && fallbackDefined ? GCP_CORE_API_URL_FALLBACK : paoUrl;
    console.log('[getCoreApiParams] PAO_CAT_isGAS=%s FALLBACK_defined=%s 使用 source=%s finalUrlHost=%s',
      isGas, !!fallbackDefined,
      isGas ? (fallbackDefined ? 'fallback_to_gcp' : 'pao_cat_gas_no_fallback') : 'pao_cat_direct',
      finalUrl ? finalUrl.replace(/^https?:\/\//, '').split('/')[0] : 'empty');
    return { url: finalUrl, key: paoKey, useApi: true };
  }
  console.log('[getCoreApiParams] 使用 source=none useApi=false');
  return { url: '', key: '', useApi: false };
}

/**
 * 透過 Core API 取得 Odoo 發票明細。
 * 回傳 { data: 陣列 } 成功，{ data: null, error: "訊息" } 失敗（會帶出 Core 回傳的錯誤原因）。
 */
function fetchOdooInvoiceFromCoreApi(odooId) {
  const { url, key, useApi } = getCoreApiParams();
  if (!useApi) return { data: null, error: '未設定 PAO_CAT_CORE_API_URL 或 PAO_CAT_SECRET_KEY' };
  const sep = url.indexOf('?') >= 0 ? '&' : '?';
  const q = sep + 'key=' + encodeURIComponent(key) + '&action=getOdooInvoice&id=' + encodeURIComponent(String(odooId));
  let res, json;
  try {
    res = UrlFetchApp.fetch(url + q, { muteHttpExceptions: true, followRedirects: true });
    const text = res.getContentText();
    json = JSON.parse(text);
  } catch (e) {
    return { data: null, error: 'Core API 連線或回應格式異常：' + (e.message || String(e)) };
  }
  if (json && json.status === 'ok' && Array.isArray(json.data)) {
    return { data: json.data };
  }
  const msg = (json && json.message) ? json.message : ('HTTP ' + res.getResponseCode());
  return { data: null, error: msg };
}

/**
 * 檢查 Odoo 單號與 Core API 連線（選單「🔍 檢查 Odoo 單號與開票連線」）。
 * 可輸入一筆 Odoo 單號（須為 Odoo account.move 的數字 ID），會呼叫 getOdooInvoice 並顯示結果，用來確認欄位與 API 是否正確。
 */
function checkOdooNumberAndCoreApi() {
  const { useApi } = getCoreApiParams();
  if (!useApi) {
    SpreadsheetApp.getUi().alert('請先設定 GCP_CORE_API_URL＋GCP_CORE_SECRET_KEY 或 PAO_CAT_CORE_API_URL＋PAO_CAT_SECRET_KEY。');
    return;
  }
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('檢查 Odoo 單號', '請輸入 Odoo 單號（account.move 的數字 ID，例如 22718）：', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const odooId = String(response.getResponseText() || '').trim();
  if (!odooId) {
    ui.alert('未輸入單號。');
    return;
  }
  const result = fetchOdooInvoiceFromCoreApi(odooId);
  if (result.data != null) {
    const lines = result.data;
    const summary = lines.length + ' 筆明細';
    const detail = lines.slice(0, 5).map(function (l) {
      return (l.name || '') + ' x' + (l.quantity || 0) + ' = ' + (l.price_subtotal || 0);
    }).join('\n');
    const more = lines.length > 5 ? '\n… 共 ' + lines.length + ' 筆' : '';
    console.log('[checkOdooNumberAndCoreApi] odooId=%s %s', odooId, summary);
    ui.alert('Odoo 單號 ' + odooId + ' 取得成功\n' + summary + '\n\n' + detail + more);
  } else {
    const err = result.error || '未知錯誤';
    console.warn('[checkOdooNumberAndCoreApi] odooId=%s 失敗: %s', odooId, err);
    ui.alert('Odoo 單號 ' + odooId + ' 取得失敗：\n' + err);
  }
}

/** 透過 Core API 開立發票（需已設 GCP_CORE_* 或 PAO_CAT_*） */
function issueInvoiceViaCoreApi(storeInfo, odooNumber, buyType, items) {
  const { url, key, useApi } = getCoreApiParams();
  var urlHost = url ? url.replace(/^https?:\/\//, '').split('/')[0] : '';
  console.log('[issueInvoiceViaCoreApi] useApi=%s requestHost=%s urlLength=%s', useApi, urlHost || 'none', url ? url.length : 0);
  if (!useApi) return null;
  const odoo = String(odooNumber || '');
  const company = (storeInfo && storeInfo.companyName) ? String(storeInfo.companyName) : '';
  const itemCount = Array.isArray(items) ? items.length : 0;
  console.log('[issueInvoiceViaCoreApi] 請求 odooNumber=%s buyType=%s company=%s items=%s requestHost=%s', odoo, String(buyType || '請款'), company, itemCount, urlHost);
  const payload = JSON.stringify({
    key: key,
    action: 'issueInvoice',
    storeInfo: storeInfo,
    odooNumber: odoo,
    buyType: String(buyType || '請款'),
    items: items
  });
  console.log('[issueInvoiceViaCoreApi] POST url=%s (host=%s)', url ? url.split('?')[0] : 'null', urlHost);
  const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: payload, muteHttpExceptions: true });
  const responseCode = res.getResponseCode();
  const responseText = res.getContentText();
  console.log('[issueInvoiceViaCoreApi] 回應 HTTP=%s bodyLen=%s bodyPreview=%s', responseCode, responseText ? responseText.length : 0, responseText ? responseText.slice(0, 200) : '');
  if (responseCode !== 200) {
    console.error('[issueInvoiceViaCoreApi] HTTP %s odooNumber=%s body=%s', responseCode, odoo, responseText ? responseText.slice(0, 600) : '');
  }
  try {
    const parsed = JSON.parse(responseText);
    if (parsed && parsed.status === 'ok' && parsed.data) {
      const d = parsed.data;
      if (d.success === 'true') {
        console.log('[issueInvoiceViaCoreApi] 成功 odooNumber=%s code=%s', odoo, d.code || '');
      } else {
        console.warn('[issueInvoiceViaCoreApi] 回傳非成功 odooNumber=%s success=%s msg=%s', odoo, d.success || '', d.msg || '');
      }
      return d;
    }
    console.warn('[issueInvoiceViaCoreApi] 回傳格式非常規 odooNumber=%s status=%s raw=%s', odoo, parsed.status || '', responseText.slice(0, 300));
    return parsed.data || parsed;
  } catch (parseErr) {
    console.error('[issueInvoiceViaCoreApi] JSON 解析失敗 odooNumber=%s error=%s body=%s', odoo, parseErr.message || '', responseText ? responseText.slice(0, 500) : '');
    throw parseErr;
  }
}

/**
 * 開發票：由選單「🚀 開發票」呼叫。
 * 掃描「2026/ACH紀錄」：登陸ach＝true、有 Odoo 單號、發票號碼為空 的列。
 * 一律透過 Core API 拿取明細與開票（需設定 GCP_CORE_* 或 PAO_CAT_*）。
 *
 * 試算表「2026/ACH紀錄」欄位對應（開發票用）：
 *   D(4)=店家代碼  E(5)=費用種類  K(11)=登陸ach  N(14)=發票號碼  O(15)=Odoo 單號  R(18)=錯誤訊息
 * Odoo 單號（O 欄）須為 Odoo 的 account.move 的 ID（數字，如 22718），不是單據編號 ref。
 */
function issueInvoice() {
  const ss = SpreadsheetApp.openById(PAYMENT_SS_ID);
  const sheet = ss.getSheetByName('2026/ACH紀錄');
  if (!sheet) {
    SpreadsheetApp.getUi().alert('找不到工作表「2026/ACH紀錄」。');
    return;
  }
  const { useApi } = getCoreApiParams();
  if (!useApi) {
    SpreadsheetApp.getUi().alert('請在指令碼屬性設定 GCP_CORE_API_URL 與 GCP_CORE_SECRET_KEY（直連 GCP 開發票），或 PAO_CAT_CORE_API_URL 與 PAO_CAT_SECRET_KEY（經 GAS Core）。');
    return;
  }

  let bankInfoMap;
  try {
    bankInfoMap = Core.getBankInfoMap();
  } catch (e) {
    SpreadsheetApp.getUi().alert('設定錯誤：' + e.toString());
    return;
  }

  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const storeCode = row[3];       // D 欄: 店家代碼
    const achBank = row[10];        // K 欄: 登陸ach
    const invoiceNumber = row[13];  // N 欄: 發票號碼
    const odooNumber = row[14];    // O 欄: Odoo 單號
    const buytype = String(row[4] || '').trim() || '請款'; // E 欄: 費用種類

    if (achBank !== true || !odooNumber || (invoiceNumber && String(invoiceNumber).trim() !== '')) {
      continue;
    }

    const storeInfo = bankInfoMap.get(String(storeCode).trim());
    if (!storeInfo || !storeInfo.pinCode) {
      console.error(`店家代碼 ${storeCode} 缺少統編，跳過。`);
      continue;
    }

    const apiResult = fetchOdooInvoiceFromCoreApi(odooNumber);
    const odooLines = apiResult.data;
    if (odooLines == null) {
      const errMsg = apiResult.error || '未知錯誤';
      console.error(`Core API 取得 Odoo 明細失敗 (${odooNumber}): ${errMsg}`);
      sheet.getRange(i + 1, 18).setValue('Odoo 明細失敗：' + errMsg);
      continue;
    }

    const items = (odooLines || [])
      .filter(line => line.price_subtotal > 0)
      .map(line => {
        const qty = line.quantity || 1;
        return {
          name: line.name || '',
          money: line.price_subtotal / qty,
          number: qty
        };
      });

    if (items.length === 0) {
      console.error('[issueInvoice] 列 %s 無有效品項，跳過開票 storeCode=%s odooNumber=%s', i + 1, storeCode, odooNumber);
      continue;
    }

    console.log('[issueInvoice] 列 %s 開始開票 storeCode=%s odooNumber=%s buytype=%s items=%s', i + 1, storeCode, odooNumber, buytype, items.length);
    sheet.getRange(i + 1, 14).setValue('B2B開票中...');
    SpreadsheetApp.flush();

    try {
      const result = issueInvoiceViaCoreApi(storeInfo, odooNumber, buytype, items);
      if (result && result.success === 'true') {
        sheet.getRange(i + 1, 14).setValue(result.code || '');
        sheet.getRange(i + 1, 18).setValue(''); // 成功時清空 R 欄錯誤訊息
        console.log('[issueInvoice] 列 %s 成功開立發票 code=%s odooNumber=%s', i + 1, result.code || '', odooNumber);
      } else {
        sheet.getRange(i + 1, 14).setValue('');
        const failMsg = (result && result.msg != null && String(result.msg).trim() !== '') ? String(result.msg) : '開立發票失敗';
        sheet.getRange(i + 1, 18).setValue('失敗：' + failMsg);
        console.error('[issueInvoice] 列 %s 開票失敗 storeCode=%s odooNumber=%s success=%s msg=%s result=%s',
          i + 1, storeCode, odooNumber, (result && result.success) || '', (result && result.msg) || '', JSON.stringify(result || {}).slice(0, 400));
      }
    } catch (e) {
      sheet.getRange(i + 1, 14).setValue('');
      sheet.getRange(i + 1, 18).setValue('中繼站連線異常');
      console.error('[issueInvoice] 列 %s 異常 storeCode=%s odooNumber=%s error=%s stack=%s',
        i + 1, storeCode, odooNumber, e.message || String(e), (e.stack || '').slice(0, 500));
    }
  }
}