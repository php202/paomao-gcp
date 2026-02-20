/**
 * 測試 Giveme 開立發票 API：開單後應在同一回應拿到 printUrl、searchInvoiceUrl（Giveme 發票查詢）、發票圖
 *
 * 環境變數：
 *   GIVEME_TEST_BASE_URL - API 根網址（預設 Cloud Run）
 *   GIVEME_TEST_STORID   - 門市 storid（試算表「店家基本資料」F 欄需有對應 M/N）
 *
 * 執行：node scripts/test-giveme-invoice.js  或  node index.js test-giveme-invoice
 */

const BASE = process.env.GIVEME_TEST_BASE_URL || 'https://pao-checkin-api-254258679209.asia-east1.run.app';
const STORID = process.env.GIVEME_TEST_STORID || '';

// 內部驗證：Giveme 回傳 id 時我們組出的 searchInvoiceUrl 格式
const GIVEME_SEARCH_BASE = 'https://www.giveme.com.tw/168.do';
function buildSearchInvoiceUrl(id) {
  return id ? `${GIVEME_SEARCH_BASE}?action=searchInvoice&id=${encodeURIComponent(String(id).trim())}` : '';
}
const sampleId = '8ae4e5819c42f861019c7a968f882ece';
const expected = 'https://www.giveme.com.tw/168.do?action=searchInvoice&id=8ae4e5819c42f861019c7a968f882ece';
if (buildSearchInvoiceUrl(sampleId) !== expected) {
  console.error('FAIL: buildSearchInvoiceUrl 格式錯誤');
  process.exitCode = 1;
  process.exit(1);
}
console.log('OK: searchInvoiceUrl 格式驗證通過（Giveme 回傳 id 時可正確組出）');

// 模擬後端邏輯：收到 Giveme 回傳 { success, code, id } 時會加上 searchInvoiceUrl
const mockJson = { success: true, code: 'AB12345678', id: sampleId };
if (mockJson.id) mockJson.searchInvoiceUrl = buildSearchInvoiceUrl(mockJson.id);
if (mockJson.searchInvoiceUrl !== expected) {
  console.error('FAIL: 模擬後端邏輯未正確產出 searchInvoiceUrl');
  process.exitCode = 1;
  process.exit(1);
}
console.log('OK: 模擬後端邏輯驗證通過（有 id 即會產出 searchInvoiceUrl）\n');

const testOrder = {
  storid: STORID || 'TEST',
  ordrsn: 'TEST-' + Date.now(),
  rprice: 1,
  date: new Date().toISOString().slice(0, 10),
  ordds: [{ godnam: '測試品項', rprice: 1, amount: 1 }],
};

async function run() {
  console.log('POST', BASE + '/giveme-invoice');
  console.log('order.storid:', testOrder.storid);
  const res = await fetch(BASE + '/giveme-invoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: testOrder, options: { type: 'B2C' } }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log('回應非 JSON:', text.slice(0, 300));
    process.exitCode = 1;
    return;
  }
  console.log('status', res.status);
  console.log('success:', json.success);
  console.log('code:', json.code);
  console.log('msg:', json.msg);
  console.log('uncode:', json.uncode);
  console.log('id:', json.id ?? '(無)');
  console.log('searchInvoiceUrl:', json.searchInvoiceUrl ? json.searchInvoiceUrl : '(無)');
  console.log('printUrl:', json.printUrl ? '(有)' : '(無)');
  console.log('printImageBase64:', json.printImageBase64 ? `有 (${json.printImageBase64.length} 字元)` : '(無)');

  if (json.success !== true && String(json.success).toLowerCase() !== 'true') {
    console.log('開單未成功，不檢查列印欄位');
    if (res.status === 503 && /Giveme 設定未完成/.test(json.msg || '')) {
      console.log('提示：請設 GIVEME_TEST_STORID=試算表有的門市代號，或設 GIVEME_UNCODE/GIVEME_IDNO/GIVEME_PASSWORD 後再測');
    }
    process.exitCode = 1;
    return;
  }
  if (!json.printUrl) {
    console.log('FAIL: 開單成功但未回傳 printUrl');
    process.exitCode = 1;
    return;
  }
  console.log('OK: 開立時已直接拿到 printUrl');

  if (json.id && json.searchInvoiceUrl) {
    const want = buildSearchInvoiceUrl(json.id);
    if (json.searchInvoiceUrl === want) {
      console.log('OK: 開立時已直接拿到 searchInvoiceUrl（Giveme 發票查詢頁）');
    } else {
      console.log('WARN: searchInvoiceUrl 與 id 組出結果不一致');
    }
  } else if (json.id) {
    console.log('WARN: 有 id 但無 searchInvoiceUrl');
  } else {
    console.log('INFO: Giveme 未回傳 id，無法提供發票查詢連結（請向 Giveme 確認 addB2C/addB2B 是否回傳 id）');
  }

  if (json.printImageBase64) {
    console.log('OK: 開立時已直接拿到發票圖 (printImageBase64)');
  } else {
    console.log('WARN: 未回傳 printImageBase64（可能 Giveme 發票圖片 API 失敗或未設白名單）');
  }

  console.log('\n--- 驗證列印連結 ---');
  const printRes = await fetch(json.printUrl, { signal: AbortSignal.timeout(15000) });
  const contentType = printRes.headers.get('content-type') || '';
  console.log('GET printUrl status:', printRes.status, 'content-type:', contentType);
  if (printRes.ok && (contentType.includes('image') || contentType.includes('pdf'))) {
    console.log('OK: 列印連結可取得圖片/檔案');
  } else if (printRes.ok) {
    const body = await printRes.text();
    console.log('回應預覽:', body.slice(0, 200));
  } else {
    console.log('WARN: 列印連結回應非 2xx 或非圖片');
  }
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
