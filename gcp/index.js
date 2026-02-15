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

  // employee-monthly-report 或舊用法：node index.js [startYm] [endYm]
  const reportArgs = cmd === 'employee-monthly-report' ? rest : [cmd, rest[0]].filter(Boolean);
  const { run } = await import('./scripts/employee-monthly-report.js');
  await run(reportArgs);
}

main().catch((e) => {
  console.error('[GCP] 錯誤:', e.message);
  process.exit(1);
});
