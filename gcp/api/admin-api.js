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
      default:
        sendJson(res, 200, { status: 'error', message: `unknown admin action: ${action}` });
    }
  } catch (e) {
    sendJson(res, 200, { status: 'error', message: e?.message || String(e) });
  }
}

