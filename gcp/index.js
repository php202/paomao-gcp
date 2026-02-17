import dotenv from 'dotenv';
dotenv.config({ override: true });

/**
 * GCP 共用入口：員工業績月報、SayDou Token 檢查、打卡 API
 *
 * 執行：
 *   node index.js employee-monthly-report [startYm] [endYm]
 *   node index.js daily-report [date] 或 [startDate] [endDate]
 *   node index.js check-token
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

  // employee-monthly-report 或舊用法：node index.js [startYm] [endYm]
  const reportArgs = cmd === 'employee-monthly-report' ? rest : [cmd, rest[0]].filter(Boolean);
  const { run } = await import('./scripts/employee-monthly-report.js');
  await run(reportArgs);
}

main().catch(async (e) => {
  console.error('[GCP] 錯誤:', e?.message || e);
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
