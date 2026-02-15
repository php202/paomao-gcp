import dotenv from 'dotenv';
dotenv.config({ override: true });

/**
 * GCP 共用入口：員工業績月報、SayDou Token 檢查（可寄信至 paopaomao.of@gmail.com）
 *
 * 執行：
 *   node index.js employee-monthly-report [startYm] [endYm]
 *   node index.js check-token
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

  // employee-monthly-report 或舊用法：node index.js [startYm] [endYm]
  const reportArgs = cmd === 'employee-monthly-report' ? rest : [cmd, rest[0]].filter(Boolean);
  const { run } = await import('./scripts/employee-monthly-report.js');
  await run(reportArgs);
}

main().catch((e) => {
  console.error('[GCP] 錯誤:', e.message);
  process.exit(1);
});
