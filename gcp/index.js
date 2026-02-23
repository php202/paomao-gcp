import dotenv from 'dotenv';
dotenv.config({ override: true });

/**
 * GCP 共用入口：員工業績月報、SayDou Token 檢查、打卡 API
 *
 * 執行：
 *   node index.js employee-monthly-report [startYm] [endYm]
 *   node index.js daily-report [date] 或 [startDate] [endDate]
 *   node index.js check-token
 *   node index.js check-auth <LINE_userId>  → 查詢該 userId 在員工清單/管理者清單的權限
 *   node index.js serve   → 啟動打卡 API HTTP 服務（Cloud Run Service 用）
 *
 * 未指定指令時預設執行 employee-monthly-report
 */

const cmd = process.argv[2];
const rest = process.argv.slice(3);

async function main() {
  if (cmd === 'check-token') {
    const { run } = await import('./scripts/check-token.js');
    await run();
    return;
  }

  if (cmd === 'test-line-push') {
    const { sendAdminLinePush } = await import('./lib/line-push.js');
    const ok = await sendAdminLinePush('[泡泡貓] 測試推播\n\n這是一則測試訊息，若你收到代表 LINE Push 設定正確。');
    console.log(ok ? '已送出測試推播，請檢查 LINE。' : '未送出（請確認 ADMIN_LINE_USER_ID、LINE_TOKEN_PAOSTAFF 已設定）');
    return;
  }

  if (cmd === 'check-auth') {
    const userId = rest[0]?.trim() || '';
    if (!userId) {
      console.error('用法: node index.js check-auth <LINE_userId>');
      process.exit(1);
    }
    const { getAuth } = await import('./lib/auth.js');
    const { isUserAuthorized } = await import('./scripts/line-checkin-handler.js');
    const ssId = process.env.LINE_STAFF_SS_ID || '';
    if (!ssId) {
      console.error('[GCP] 請設定 LINE_STAFF_SS_ID');
      process.exit(1);
    }
    const auth = await getAuth();
    const result = await isUserAuthorized(auth, ssId, userId);
    console.log(JSON.stringify({ userId, spreadsheetId: ssId.slice(0, 12) + '...', ...result }, null, 2));
    return;
  }

  if (cmd === 'serve') {
    const { startServer } = await import('./server.js');
    startServer();
    return;
  }

  if (cmd === 'daily-report') {
    const { run } = await import('./scripts/daily-report.js');
    await run(rest);
    return;
  }

  if (cmd === 'check-timeout-pending') {
    const { run } = await import('./scripts/check-timeout-pending.js');
    await run();
    return;
  }

  if (cmd === 'cleanup-retention-list') {
    const { run } = await import('./scripts/cleanup-retention-list.js');
    await run();
    return;
  }

  if (cmd === 'waitlist-auto-push') {
    const { run } = await import('./scripts/waitlist-auto-push.js');
    await run();
    return;
  }

  if (cmd === 'billing-issue-invoice') {
    const { run } = await import('./scripts/billing-issue-invoice.js');
    await run();
    return;
  }

  if (cmd === 'refresh-customers-by-tomorrow-reservations') {
    const { run } = await import('./scripts/refresh-customers-by-tomorrow-reservations.js');
    await run();
    return;
  }

  // employee-monthly-report 或舊用法：node index.js [startYm] [endYm]
  const reportArgs = cmd === 'employee-monthly-report' ? rest : [cmd, rest[0]].filter(Boolean);
  const { run } = await import('./scripts/employee-monthly-report.js');
  await run(reportArgs);
}

function formatGoogleApisError(e) {
  const err = e?.response?.data?.error;
  if (!err) return null;
  return {
    code: err.code,
    status: err.status,
    message: err.message,
    errors: err.errors,
  };
}

main().catch(async (e) => {
  // Keep console logs actionable (but avoid printing request headers like Authorization).
  console.error('[GCP] 錯誤:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  const apiErr = formatGoogleApisError(e);
  if (apiErr) console.error('[GCP] Google API error:', JSON.stringify(apiErr));

  // Best-effort: also write to the unified error log sheet for monitoring.
  try {
    const { getAuth } = await import('./lib/auth.js');
    const { appendWebhookError } = await import('./lib/webhook-error-log.js');
    const auth = await getAuth();
    const msg = e?.stack ? String(e.stack) : String(e?.message || e);
    await appendWebhookError(auth, 'gcp-cli', msg, `cmd=${cmd || 'employee-monthly-report'} args=${rest.join(' ')}`);
  } catch (_) {
    // Ignore logging failures; still exit non-zero.
  }
  process.exit(1);
});
