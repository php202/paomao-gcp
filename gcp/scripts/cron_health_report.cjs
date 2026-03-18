#!/usr/bin/env node
/**
 * cron_health_report.cjs — Cron 自動化健檢日報
 * 
 * 功能：
 * 1. 效能監控：各 cron 執行時長、趨勢、是否逼近 timeout
 * 2. 資料品質：saydou sync 對帳、空值處理統計
 * 3. 通訊警報：連續失敗偵測、API 負載衝突偵測
 * 4. 產出日報表：發送到 Telegram
 * 
 * 用法：
 *   node scripts/cron_health_report.cjs              # 產日報
 *   node scripts/cron_health_report.cjs --check      # 只檢查不發報告
 *   node scripts/cron_health_report.cjs --json       # JSON 輸出
 */

const { Pool } = require('pg');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ user: 'paopaomao', database: 'paomao' });

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const JSON_OUTPUT = args.includes('--json');

// ─── Config ───
const THRESHOLDS = {
  timeoutWarningPct: 0.75,   // 執行時間超過 timeout 75% → 警告
  consecutiveErrorAlert: 3,   // 連續失敗 >= 3 → 告警
  trendIncreasePct: 0.20,     // 執行時間比 7 天均值增加 20% → 警告
  concurrencyLimit: 5,        // SayDou 並行上限
  memoryLeakThresholdMB: 500, // RSS > 500MB → 警告
};

// ─── 1. Cron 狀態收集 ───
function getCronJobs() {
  try {
    const raw = execSync('openclaw cron list --json 2>/dev/null', { encoding: 'utf8', timeout: 15000 });
    return JSON.parse(raw).jobs || [];
  } catch (e) {
    console.error('❌ 無法取得 cron 列表:', e.message);
    return [];
  }
}

function getCronRuns(jobId, limit = 7) {
  try {
    const raw = execSync(`openclaw cron runs --id ${jobId} --limit ${limit} 2>/dev/null`, { encoding: 'utf8', timeout: 10000 });
    return JSON.parse(raw).entries || [];
  } catch {
    return [];
  }
}

// ─── 2. 效能分析 ───
function analyzePerformance(jobs) {
  const results = [];

  for (const job of jobs) {
    if (!job.enabled) continue;
    const state = job.state || {};
    const lastDuration = state.lastDurationMs || 0;
    const lastStatus = state.lastStatus || 'unknown';
    const consecutiveErrors = state.consecutiveErrors || 0;
    const lastError = state.lastError || '';

    // 計算 timeout
    const timeoutMs = (job.payload?.timeoutSeconds || job.timeoutSeconds || 120) * 1000;
    const timeoutPct = lastDuration / timeoutMs;

    // 取歷史 runs 算趨勢
    const runs = getCronRuns(job.id, 7);
    const successRuns = runs.filter(r => r.status === 'ok');
    const avgDuration = successRuns.length > 0
      ? successRuns.reduce((sum, r) => sum + (r.durationMs || 0), 0) / successRuns.length
      : 0;
    const trendPct = avgDuration > 0 ? (lastDuration - avgDuration) / avgDuration : 0;
    const successRate = runs.length > 0
      ? (runs.filter(r => r.status === 'ok').length / runs.length * 100).toFixed(0)
      : 'N/A';

    // 判定狀態
    let status = '✅ 正常';
    const warnings = [];

    if (consecutiveErrors >= THRESHOLDS.consecutiveErrorAlert) {
      status = '🔴 異常';
      warnings.push(`連續失敗 ${consecutiveErrors} 次`);
    } else if (lastStatus === 'error') {
      status = '⚠️ 失敗';
      warnings.push(lastError.slice(0, 60));
    }

    if (timeoutPct >= 1.0) {
      warnings.push('已超時');
    } else if (timeoutPct >= THRESHOLDS.timeoutWarningPct) {
      warnings.push(`耗時 ${(timeoutPct * 100).toFixed(0)}% timeout`);
    }

    if (trendPct >= THRESHOLDS.trendIncreasePct && avgDuration > 5000) {
      warnings.push(`較 7 日均值增加 ${(trendPct * 100).toFixed(0)}%`);
    }

    results.push({
      name: job.name,
      status,
      lastDurationSec: (lastDuration / 1000).toFixed(1),
      timeoutSec: (timeoutMs / 1000).toFixed(0),
      timeoutPct: (timeoutPct * 100).toFixed(0),
      successRate: successRate + '%',
      consecutiveErrors,
      avgDurationSec: (avgDuration / 1000).toFixed(1),
      trendPct: (trendPct * 100).toFixed(0),
      warnings,
      enabled: job.enabled,
    });
  }

  return results;
}

// ─── 3. SayDou 資料品質檢查 ───
async function checkSaydouIntegrity() {
  const checks = [];
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  try {
    // 當月交易筆數
    const { rows: [txCount] } = await pool.query(
      "SELECT COUNT(*) as cnt FROM saydou_transactions WHERE year_month = $1", [yearMonth]
    );

    // 當月儲值筆數
    const { rows: [scCount] } = await pool.query(
      "SELECT COUNT(*) as cnt FROM saydou_storecash WHERE year_month = $1", [yearMonth]
    );

    // 空值檢查
    const { rows: [nullMembers] } = await pool.query(
      "SELECT COUNT(*) as cnt FROM saydou_transactions WHERE year_month = $1 AND (memnam IS NULL OR memnam = '')", [yearMonth]
    );

    // 最後同步時間
    const { rows: [lastSync] } = await pool.query(
      "SELECT MAX(synced_at) as last_sync FROM saydou_transactions WHERE year_month = $1", [yearMonth]
    );

    // Sync log 成功率
    const { rows: syncStats } = await pool.query(
      "SELECT status, COUNT(*) as cnt FROM saydou_sync_log WHERE year_month = $1 GROUP BY status", [yearMonth]
    );
    const syncMap = Object.fromEntries(syncStats.map(r => [r.status, parseInt(r.cnt)]));
    const syncTotal = Object.values(syncMap).reduce((a, b) => a + b, 0);
    const syncSuccessRate = syncTotal > 0 ? ((syncMap.success || 0) / syncTotal * 100).toFixed(1) : 'N/A';

    checks.push({
      type: 'saydou',
      yearMonth,
      transactions: parseInt(txCount.cnt),
      storecash: parseInt(scCount.cnt),
      nullMembers: parseInt(nullMembers.cnt),
      lastSync: lastSync.last_sync,
      syncSuccessRate: syncSuccessRate + '%',
      syncErrors: syncMap.error || 0,
    });
  } catch (e) {
    checks.push({ type: 'saydou', error: e.message });
  }

  return checks;
}

// ─── 4. API 負載衝突偵測 ───
function detectScheduleConflicts(jobs) {
  const cronJobs = jobs.filter(j => j.enabled && j.schedule?.kind === 'cron');
  const conflicts = [];

  // 簡易解析：找同分鐘觸發的 cron
  const minuteMap = new Map();
  for (const job of cronJobs) {
    const expr = job.schedule.expr || '';
    const parts = expr.split(' ');
    if (parts.length >= 2) {
      const key = `${parts[0]} ${parts[1]}`; // minute hour
      if (!minuteMap.has(key)) minuteMap.set(key, []);
      minuteMap.get(key).push(job.name);
    }
  }

  for (const [time, names] of minuteMap) {
    if (names.length >= 3) {
      conflicts.push({ time, count: names.length, jobs: names });
    }
  }

  return conflicts;
}

// ─── 5. Node.js 進程記憶體檢查 ───
function checkMemory() {
  try {
    const raw = execSync("ps -eo pid,rss,command | grep '[n]ode' | awk '{printf \"%s %s %s\\n\", $1, $2, substr($0,index($0,$3),80)}'", { encoding: 'utf8' });
    const procs = raw.trim().split('\n').filter(Boolean).map(line => {
      const [pid, rss, ...cmd] = line.split(' ');
      return { pid, rssMB: (parseInt(rss) / 1024).toFixed(0), command: cmd.join(' ').slice(0, 60) };
    });
    const heavy = procs.filter(p => parseInt(p.rssMB) > THRESHOLDS.memoryLeakThresholdMB);
    return { total: procs.length, heavy };
  } catch {
    return { total: 0, heavy: [] };
  }
}

// ─── 6. 產出報告 ───
function formatReport(perfResults, saydouChecks, conflicts, memory) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  const abnormal = perfResults.filter(r => r.status !== '✅ 正常');
  const normal = perfResults.filter(r => r.status === '✅ 正常');

  let report = `🤖 <b>Agent 運行日報</b> (${dateStr})\n\n`;

  // 總覽
  report += `📊 <b>總覽</b>\n`;
  report += `• Cron 總數: ${perfResults.length} 個\n`;
  report += `• 正常: ${normal.length} | 異常: ${abnormal.length}\n\n`;

  // 異常清單
  if (abnormal.length > 0) {
    report += `🚩 <b>異常預警</b>\n`;
    for (const r of abnormal) {
      report += `• <code>${r.name}</code> ${r.status}\n`;
      report += `  耗時 ${r.lastDurationSec}s / ${r.timeoutSec}s | 成功率 ${r.successRate}\n`;
      if (r.warnings.length > 0) {
        report += `  ⤷ ${r.warnings.join('; ')}\n`;
      }
    }
    report += '\n';
  }

  // 效能表（只列有資料的）
  report += `⏱ <b>效能概覽</b> (Top 10 耗時)\n`;
  const sorted = [...perfResults].sort((a, b) => parseFloat(b.lastDurationSec) - parseFloat(a.lastDurationSec));
  for (const r of sorted.slice(0, 10)) {
    const bar = parseFloat(r.timeoutPct) >= 75 ? '🟡' : parseFloat(r.timeoutPct) >= 100 ? '🔴' : '🟢';
    report += `${bar} <code>${r.name.padEnd(28)}</code> ${r.lastDurationSec.padStart(6)}s (${r.timeoutPct}%)\n`;
  }
  report += '\n';

  // SayDou 資料品質
  if (saydouChecks.length > 0) {
    report += `📋 <b>SayDou 資料品質</b>\n`;
    for (const c of saydouChecks) {
      if (c.error) {
        report += `• ❌ 檢查失敗: ${c.error}\n`;
      } else {
        report += `• ${c.yearMonth}: 交易 ${c.transactions.toLocaleString()} 筆 / 儲值 ${c.storecash.toLocaleString()} 筆\n`;
        report += `• 同步成功率: ${c.syncSuccessRate} (錯誤 ${c.syncErrors} 次)\n`;
        if (c.nullMembers > 0) {
          report += `• ⚠️ 空會員名 ${c.nullMembers} 筆\n`;
        }
        if (c.lastSync) {
          const ago = ((Date.now() - new Date(c.lastSync).getTime()) / 60000).toFixed(0);
          report += `• 最後同步: ${ago} 分鐘前\n`;
        }
      }
    }
    report += '\n';
  }

  // 排程衝突
  if (conflicts.length > 0) {
    report += `⚡ <b>排程衝突偵測</b>\n`;
    for (const c of conflicts) {
      report += `• ${c.time} → ${c.count} 個任務同時觸發: ${c.jobs.join(', ')}\n`;
    }
    report += '\n';
  }

  // 記憶體
  if (memory.heavy.length > 0) {
    report += `🧠 <b>記憶體警告</b> (>${THRESHOLDS.memoryLeakThresholdMB}MB)\n`;
    for (const p of memory.heavy) {
      report += `• PID ${p.pid}: ${p.rssMB}MB — ${p.command}\n`;
    }
    report += '\n';
  }

  return report;
}

// ─── Main ───
async function main() {
  console.log('🔍 Cron 健檢開始...\n');

  const jobs = getCronJobs();
  if (jobs.length === 0) {
    console.log('❌ 無法取得 cron 列表');
    process.exit(1);
  }

  const enabledJobs = jobs.filter(j => j.enabled);
  console.log(`📋 共 ${enabledJobs.length} 個啟用中的 cron\n`);

  // 效能分析
  console.log('⏱ 分析效能...');
  const perfResults = analyzePerformance(enabledJobs);

  // SayDou 資料品質
  console.log('📋 檢查 SayDou 資料品質...');
  const saydouChecks = await checkSaydouIntegrity();

  // 排程衝突
  console.log('⚡ 偵測排程衝突...');
  const conflicts = detectScheduleConflicts(jobs);

  // 記憶體
  console.log('🧠 檢查記憶體...');
  const memory = checkMemory();

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ perfResults, saydouChecks, conflicts, memory }, null, 2));
  } else {
    const report = formatReport(perfResults, saydouChecks, conflicts, memory);
    console.log('\n' + report);

    if (!CHECK_ONLY) {
      // 儲存到檔案
      const logDir = path.join(process.env.HOME, '.openclaw/workspace/logs/cron-health');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const dateStr = new Date().toISOString().split('T')[0];
      fs.writeFileSync(path.join(logDir, `${dateStr}.txt`), report.replace(/<[^>]+>/g, ''));
      console.log(`📁 報告已存: logs/cron-health/${dateStr}.txt`);
    }
  }

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
