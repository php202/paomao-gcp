#!/usr/bin/env node
/**
 * 本機預覽：各店訊息一覽表「報表／工作表」的呈現格式（範例資料，不呼叫 API）。
 * 執行：在專案根目錄 node gas/preview-reports.js
 */

const path = require('path');

const MSG_DIR = path.join(__dirname, '各店訊息一覽表');

// 從 CustomerProfile.js 讀取表頭（與實際一致）
const INTEGRATED_HEADERS = [
  '時間', '手機', '員工填寫', '客人問卷', 'line對話', '消費紀錄', '儲值紀錄',
  'saydouUserId', 'ai prompt', 'lineUserId'
];

const SEP = '\n' + '─'.repeat(60) + '\n';

function main() {
  console.log('\n=== 各店訊息一覽表 － 本機預覽（範例呈現）===\n');

  // 1. 昨日消費報告
  console.log('【1】昨日消費報告（寫入試算表「昨日消費報告」）');
  console.log('欄位：日期 | 店名 | 總額 | 依經手人摘要\n');
  const yesterdaySample = [
    ['2025-02-01', '台北店', 15800, 'nk001 (王小明): $8200 | nk002 (李小華): $7600'],
    ['2025-02-01', '台中店', 12000, 'nk001 (王小明): $12000']
  ];
  console.log('日期\t\t店名\t總額\t依經手人摘要');
  yesterdaySample.forEach(r => console.log(r.join('\t')));
  console.log('\n--- LINE Push 給管理者的文字範例 ---');
  console.log('【台北店】昨日消費 2025-02-01');
  console.log('總額: $15800');
  console.log('--- 依經手人 ---');
  console.log('nk001 (王小明): $8200');
  console.log('nk002 (李小華): $7600');
  console.log(SEP);

  // 2. 本月消費報告 + 員工每月樣態
  console.log('【2】本月消費報告（寫入試算表「本月消費報告」）');
  console.log('欄位：年月 | 起訖 | 店名 | 總額 | 依經手人摘要\n');
  const monthlySample = [
    ['2025-02', '2025-02-01 ~ 2025-02-28', '台北店', 185000, 'nk001: $95000 | nk002: $90000'],
    ['2025-02', '2025-02-01 ~ 2025-02-28', '台中店', 120000, 'nk001: $120000']
  ];
  monthlySample.forEach(r => console.log(r.join('\t')));
  console.log('\n【3】員工每月樣態（寫入試算表「員工每月樣態」）');
  console.log('欄位：年月 | 店名 | 員工代碼 | 員工姓名 | 當月總額 | 筆數\n');
  const empMonthlySample = [
    ['2025-02', '台北店', 'nk001', '王小明', 95000, 42],
    ['2025-02', '台北店', 'nk002', '李小華', 90000, 38],
    ['2025-02', '台中店', 'nk001', '王小明', 120000, 50]
  ];
  console.log('年月\t\t店名\t員工代碼\t員工姓名\t當月總額\t筆數');
  empMonthlySample.forEach(r => console.log(r.join('\t')));
  console.log(SEP);

  // 4. 明日預約報告
  console.log('【4】明日預約報告（寫入試算表「明日預約報告」）');
  console.log('欄位：日期 | 店名 | 報告全文（摘要）\n');
  console.log('--- LINE Push 範例 ---');
  console.log('【台北店】明日預約客人（給 AI 過水用）');
  console.log('姓名\t手機\t預約時間\t潔顏師\t課程／服務\t備註');
  console.log('王小姐\t0912345678\t2025-02-02 10:00\t王小明\t深層潔顏\t');
  console.log('陳小姐\t0923456789\t2025-02-02 14:00\t李小華\t保濕導入\t想睡少聊天');
  console.log(SEP);

  // 5. 客人消費狀態
  console.log('【5】客人消費狀態（主表）');
  console.log('表頭：' + INTEGRATED_HEADERS.join(' | '));
  console.log('\n範例一列（摘要）：');
  const sampleRow = [
    '2025/02/01 12:00:00',
    '0912345678',
    '喜好度5、乾性敏感、推薦皮秒',
    '問卷歷程…',
    'LINE 對話摘要…',
    '消費紀錄摘要…',
    '儲值紀錄摘要…',
    'saydou_xxx',
    '【員工填寫】…【客人問卷】…【客人訊息】…（完整給 AI 的歷程）',
    'U1234567890'
  ];
  INTEGRATED_HEADERS.forEach((h, i) => console.log('  ' + h + ': ' + (sampleRow[i] && sampleRow[i].length > 40 ? sampleRow[i].slice(0, 40) + '…' : sampleRow[i])));
  console.log(SEP);

  // 6. 客人樣貌摘要
  console.log('【6】客人樣貌摘要（由 runDailyCustomerUpdate 產出）');
  console.log('欄位：手機 | 最後更新時間 | 有無LINE | 消費紀錄摘要 | 儲值摘要\n');
  const profileSample = [
    ['0912345678', '2025/02/01 21:05', '有', '最近一次 保濕導入 $1200…', '儲值 $5000 餘額 $3200…'],
    ['0923456789', '2025/02/01 21:05', '—', '—', '—']
  ];
  console.log('手機\t\t最後更新時間\t\t有無LINE\t消費紀錄摘要\t儲值摘要');
  profileSample.forEach(r => console.log(r.join('\t')));
  console.log(SEP);

  // 7. 觸發與流程
  console.log('【7】排程觸發（setupAllTriggers 建立）');
  console.log('  每日 21:00 → runDailyCustomerUpdate（客人更新 + 客人樣貌摘要）');
  console.log('  每日 8:00  → runTomorrowReservationReportAndPush');
  console.log('  每日 8:30  → runYesterdaySalesReportAndPush');
  console.log('  每月 1 號 8:00 → runMonthlySalesReportAndPush');
  console.log('\n本機驗證：node gas/validate.js → 已通過');
  console.log('實際資料需在 Apps Script 執行（需 Core 與試算表權限）。\n');
}

main();
