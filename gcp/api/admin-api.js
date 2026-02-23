import { sendAdminLinePush } from '../lib/line-push.js';
import { sendJson } from './http-utils.js';

const ADMIN_KEY = (process.env.ADMIN_KEY || process.env.PAO_CAT_SECRET_KEY || '').trim();

function requireAdminKey(url, bodyJson, res) {
  const key = (url.searchParams.get('key') || bodyJson?.key || '').trim();
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    sendJson(res, 401, { status: 'error', message: 'unauthorized' });
    return false;
  }
  return true;
}

export async function handleAdmin(req, res, { url, bodyJson }) {
  if (!requireAdminKey(url, bodyJson, res)) return;
  const method = req.method || 'GET';
  const params = method === 'POST' && bodyJson && typeof bodyJson === 'object' ? bodyJson : Object.fromEntries(url.searchParams.entries());
  const action = String(params.action || '').trim();

  try {
    switch (action) {
      case 'runDailyReport': {
        const { run } = await import('../scripts/daily-report.js');
        const args = [];
        if (params.date) args.push(String(params.date));
        if (params.startDate) args.push(String(params.startDate));
        if (params.endDate) args.push(String(params.endDate));
        await run(args);
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      case 'runEmployeeMonthlyReport': {
        const { run } = await import('../scripts/employee-monthly-report.js');
        const args = [];
        if (params.startYm) args.push(String(params.startYm));
        if (params.endYm) args.push(String(params.endYm));
        await run(args);
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      case 'runCheckTimeoutPending': {
        const { run } = await import('../scripts/check-timeout-pending.js');
        await run();
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      case 'runCleanupRetentionList': {
        const { run } = await import('../scripts/cleanup-retention-list.js');
        await run();
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      case 'runWaitlistAutoPush': {
        const { run } = await import('../scripts/waitlist-auto-push.js');
        await run();
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      case 'linePushAdmin': {
        const text = String(params.text || params.message || '').trim();
        if (!text) {
          sendJson(res, 200, { status: 'error', message: 'missing text' });
          return;
        }
        await sendAdminLinePush(text).catch((e) => console.warn('[admin] linePushAdmin failed', e?.message));
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      // 請款表單內容 GAS 選單「改由 GCP 執行」會呼叫；實際產出仍在 GAS 試算表本機流程，此處僅回傳說明
      case 'billing_bankTxt':
      case 'billing_issueInvoice':
      case 'billing_createLaborReceipts':
      case 'billing_cleanupTempSheets':
        sendJson(res, 200, {
          status: 'error',
          message: '此 action 尚未在 GCP 實作，請在試算表使用本機流程（帳務工具選單對應功能或直接執行 main / issueInvoice 等）。',
        });
        return;
      // 泡泡貓拉廣告資料 GAS 選單「產出動態預約 / 取得今日預約（改由 GCP 執行）」會呼叫；需設定 ADS_SS_ID（廣告試算表 ID）且試算表需分享給服務帳號
      case 'ads_appointmentLists': {
        const { run } = await import('../scripts/ads-appointment.js');
        const result = await run();
        sendJson(res, 200, { status: 'ok', message: `已寫入 ${result.rowCount} 筆`, rowCount: result.rowCount });
        return;
      }
      case 'ads_todayReservation': {
        const { run } = await import('../scripts/ads-today.js');
        const result = await run();
        sendJson(res, 200, { status: 'ok', message: `已寫入 ${result.rowCount} 筆`, rowCount: result.rowCount });
        return;
      }
      default:
        sendJson(res, 200, { status: 'error', message: `unknown admin action: ${action}` });
    }
  } catch (e) {
    sendJson(res, 200, { status: 'error', message: e?.message || String(e) });
  }
}

