/**
 * 實測 GCP /core 端點（含 issueInvoice 路徑）
 *
 * 環境變數：
 *   GCP_CORE_TEST_BASE_URL - Cloud Run 根網址（與 Giveme 同一服務；可與 GIVEME_TEST_BASE_URL 相同）
 *   PAO_CAT_SECRET_KEY     - Core API 金鑰（與 PaoMao_Core / 請款表單 指令碼屬性一致）
 *
 * 執行：cd gcp && source set-env.sh 2>/dev/null; node scripts/test-core-issue-invoice.js
 *   或：GCP_CORE_TEST_BASE_URL=https://xxx.run.app PAO_CAT_SECRET_KEY=xxx node scripts/test-core-issue-invoice.js
 */

const BASE = (process.env.GCP_CORE_TEST_BASE_URL || process.env.GIVEME_TEST_BASE_URL || 'https://pao-checkin-api-254258679209.asia-east1.run.app').replace(/\/$/, '');
const CORE_KEY = (process.env.PAO_CAT_SECRET_KEY || '').trim();

async function run() {
  console.log('Base URL:', BASE);
  console.log('Key set:', CORE_KEY ? 'yes' : 'no');
  if (!CORE_KEY) {
    console.error('請設定 PAO_CAT_SECRET_KEY（例：source set-env.sh 或 export PAO_CAT_SECRET_KEY=xxx）');
    process.exitCode = 1;
    return;
  }

  let failed = 0;

  // 1) GET getCoreConfig：驗證 /core 與金鑰
  const getUrl = `${BASE}/core?action=getCoreConfig&key=${encodeURIComponent(CORE_KEY)}`;
  console.log('\n[1] GET', getUrl.replace(CORE_KEY, '***'));
  try {
    const r = await fetch(getUrl, { method: 'GET', signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.log('回應非 JSON:', text.slice(0, 200));
      failed++;
      return;
    }
    if (r.status !== 200) {
      console.log('status', r.status, json?.message || json?.status || text.slice(0, 100));
      failed++;
      return;
    }
    if (json.status !== 'ok' || !json.data) {
      console.log('預期 status=ok 且 data:', json);
      failed++;
      return;
    }
    console.log('OK: getCoreConfig 通過, data keys:', Object.keys(json.data || {}));
  } catch (e) {
    console.error('getCoreConfig 請求失敗:', e.message);
    failed++;
    return;
  }

  // 2) POST issueInvoice（key 可放 query 或 body；此處用 query 相容未部署 body key 的環境）
  const postUrl = `${BASE}/core?key=${encodeURIComponent(CORE_KEY)}`;
  const body = {
    action: 'issueInvoice',
    storeInfo: { companyName: '測試店', pinCode: '', email: '' },
    odooNumber: '',
    buyType: '實測請款',
    items: [{ money: 1, number: 1 }],
  };
  console.log('\n[2] POST', postUrl.replace(CORE_KEY, '***'), 'body.action=issueInvoice');
  try {
    const r = await fetch(postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.log('回應非 JSON:', text.slice(0, 300));
      failed++;
      return;
    }
    if (r.status !== 200) {
      console.log('status', r.status, json?.message || text.slice(0, 150));
      failed++;
      return;
    }
    if (json.status === 'ok') {
      console.log('OK: issueInvoice 路徑回應 status=ok');
      if (json.data) {
        const d = json.data;
        if (d.success === true || String(d.success).toLowerCase() === 'true') {
          console.log('  Giveme 開單成功, code:', d.code, 'id:', d.id ? '(有)' : '(無)');
        } else {
          console.log('  Giveme 回覆:', d.msg || d.message || JSON.stringify(d).slice(0, 120));
        }
      }
    } else if (json.status === 'error' && /Giveme 設定未完成/.test(String(json.message || ''))) {
      console.log('OK: issueInvoice 路徑正常，Cloud Run 未設 GIVEME_* 時回傳「Giveme 設定未完成」屬預期');
    } else {
      console.log('未預期回應:', json);
      failed++;
    }
  } catch (e) {
    console.error('issueInvoice 請求失敗:', e.message);
    failed++;
  }

  if (failed > 0) {
    process.exitCode = 1;
    return;
  }
  console.log('\n全部實測通過。');
}

run();
