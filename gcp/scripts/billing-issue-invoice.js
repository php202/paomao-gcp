/**
 * 請款表單每日開發票（GCP 排程版）
 * 與 GAS 請款表單內容 issueInvoice() 邏輯一致：讀「2026/ACH紀錄」、登陸ach=true、有 Odoo 單號、發票號碼為空 → 取 Odoo 明細 → 呼叫 Giveme 開票 → 寫回 N/R 欄。
 *
 * 環境變數：EXTERNAL_SS_ID（請款試算表，含 2026/ACH紀錄、店家基本資訊）、ODOO_*、GIVEME_*
 * 執行：node index.js billing-issue-invoice
 */

import { getAuth } from '../lib/auth.js';
import { readSheet, batchUpdateValues } from '../lib/sheets.js';
import { getOdooInvoice } from '../api/core-api.js';
import { getUnifiedInvoiceService } from '../lib/unified-invoice.cjs';

const ACH_SHEET_NAME = '2026/ACH紀錄';
const STORE_SHEET_NAME = '店家基本資訊';

function buildBankInfoMap(rows) {
  const map = new Map();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const code = row[1];
    if (!code) continue;
    const pinStr = String(row[7] ?? '').trim().padStart(8, '0');
    map.set(String(code).trim(), {
      no: row[0],
      bankAccount: String(row[2] ?? '').trim(),
      branch: String(row[3] ?? '').trim(),
      name: String(row[4] ?? '').trim(),
      pinCode: pinStr,
      companyName: String(row[6] ?? '').trim(),
      email: String(row[8] ?? '').trim(),
      groupId: String(row[9] ?? '').trim(),
      pin: String(row[10] ?? '').trim(),
      store: row[5],
    });
  }
  return map;
}

export async function run() {
  const ssId = (process.env.EXTERNAL_SS_ID || '').trim();
  if (!ssId) {
    throw new Error('[billing-issue-invoice] 請設定 EXTERNAL_SS_ID（請款試算表 ID）');
  }

  const auth = await getAuth();

  const storeRows = await readSheet(auth, ssId, `'${STORE_SHEET_NAME}'!A2:K`);
  const bankInfoMap = buildBankInfoMap(storeRows);

  const achRows = await readSheet(auth, ssId, `'${ACH_SHEET_NAME}'!A:R`);
  if (!achRows.length) {
    console.log('[billing-issue-invoice] 無資料列，結束');
    return;
  }

  const updates = [];
  let processed = 0;
  let successCount = 0;

  for (let i = 1; i < achRows.length; i++) {
    const row = achRows[i];
    const storeCode = row[3];
    const achBank = row[10];
    const invoiceNumber = row[13];
    const odooNumber = row[14];
    const buytype = String(row[4] ?? '').trim() || '請款';
    const feeType = buytype; // E 欄位就是 fee_type
    const description = String(row[2] ?? '').trim(); // 描述欄位

    // ⚠️ 儲值金不開發票，直接跳過（多重判斷確保不會遺漏）
    if (feeType === '儲值金' || 
        description.includes('儲值金') || 
        description.includes('月儲') ||
        buytype === '儲值金') {
      console.log(`[billing-issue-invoice] 列 ${i + 2} 儲值金記錄跳過開發票 (${odooNumber}) - feeType: ${feeType}, desc: ${description}`);
      continue;
    }

    if (achBank !== true || !odooNumber || (invoiceNumber && String(invoiceNumber).trim() !== '')) {
      continue;
    }

    const storeInfo = bankInfoMap.get(String(storeCode).trim());
    if (!storeInfo || !storeInfo.pinCode) {
      console.warn(`[billing-issue-invoice] 列 ${i + 2} 店家代碼 ${storeCode} 缺少統編，跳過`);
      updates.push(
        { range: `'${ACH_SHEET_NAME}'!N${i + 2}`, values: [['']] },
        { range: `'${ACH_SHEET_NAME}'!R${i + 2}`, values: [['店家代碼缺少統編']] }
      );
      processed++;
      continue;
    }

    const odooRes = await getOdooInvoice(null, odooNumber);
    const odooLines = odooRes.status === 'ok' && Array.isArray(odooRes.data) ? odooRes.data : null;
    if (odooLines == null) {
      const errMsg = odooRes.message || '未知錯誤';
      console.warn(`[billing-issue-invoice] 列 ${i + 2} Odoo 明細失敗 (${odooNumber}): ${errMsg}`);
      updates.push(
        { range: `'${ACH_SHEET_NAME}'!N${i + 2}`, values: [['']] },
        { range: `'${ACH_SHEET_NAME}'!R${i + 2}`, values: [['Odoo 明細失敗：' + errMsg]] }
      );
      processed++;
      continue;
    }

    const items = (odooLines || [])
      .filter((line) => (line.price_subtotal || 0) > 0)
      .map((line) => {
        const qty = line.quantity || 1;
        return {
          name: line.name || '',
          money: (line.price_subtotal || 0) / qty,
          number: qty,
        };
      });

    if (items.length === 0) {
      console.warn(`[billing-issue-invoice] 列 ${i + 2} 無有效品項，跳過 odooNumber=${odooNumber}`);
      updates.push(
        { range: `'${ACH_SHEET_NAME}'!N${i + 2}`, values: [['']] },
        { range: `'${ACH_SHEET_NAME}'!R${i + 2}`, values: [['無有效品項']] }
      );
      processed++;
      continue;
    }

    console.log(`[billing-issue-invoice] 列 ${i + 2} 開票 storeCode=${storeCode} odooNumber=${odooNumber}`);

    // 🎯 使用統一開票服務
    const unifiedInvoice = getUnifiedInvoiceService();
    let code = '';
    let msg = '';
    
    try {
      const result = await unifiedInvoice.issueInvoice({
        buyerTaxId: storeInfo.taxId,
        buyerName: storeInfo.name,
        amount: storeInfo.amount || 0,
        items: items || [{ name: buytype, money: storeInfo.amount || 0, number: 1 }],
        content: `${buytype} - ${odooNumber}`,
        buyType: buytype, // 用於儲值金檢查
        callerInfo: {
          user: 'system',
          script: 'billing-issue-invoice',
          function: 'processRow'
        }
      });
      
      code = result.invoiceNo || '';
      msg = '';
    } catch (error) {
      code = '';
      msg = error.message || '開立發票失敗';
      console.error(`[billing-issue-invoice] 列 ${i + 2} 開票失敗:`, error.message);
    }

    updates.push(
      { range: `'${ACH_SHEET_NAME}'!N${i + 2}`, values: [[code]] },
      { range: `'${ACH_SHEET_NAME}'!R${i + 2}`, values: [[msg]] }
    );

    processed++;
    if (ok) successCount++;
    else console.warn(`[billing-issue-invoice] 列 ${i + 2} 開票失敗: ${msg}`);
  }

  if (updates.length > 0) {
    await batchUpdateValues(auth, ssId, updates, 'USER_ENTERED');
  }
  console.log(`[billing-issue-invoice] 完成，處理 ${processed} 筆，成功 ${successCount} 筆`);
}
