/**
 * safe-batch.js — 安全批次操作工具
 * 防止大量 API 呼叫造成 TCP port exhaustion
 * 
 * 2026-04-23 建立，防止重複發生 TIME_WAIT 爆量事件
 */

import { execSync } from 'child_process';

const PORT_WARN = 5000;
const PORT_CRITICAL = 10000;

/**
 * 取得目前 TIME_WAIT 連線數
 */
export function getTimeWaitCount() {
  try {
    const result = execSync("netstat -an 2>/dev/null | grep -c TIME_WAIT", { encoding: 'utf8', timeout: 5000 });
    return parseInt(result.trim()) || 0;
  } catch {
    return -1; // 無法取得
  }
}

/**
 * 檢查 port 健康度，回傳 { safe, count, level }
 */
export function checkPortHealth() {
  const count = getTimeWaitCount();
  if (count < 0) return { safe: true, count: 0, level: 'unknown' };
  if (count >= PORT_CRITICAL) return { safe: false, count, level: 'critical' };
  if (count >= PORT_WARN) return { safe: false, count, level: 'warning' };
  return { safe: true, count, level: 'ok' };
}

/**
 * 安全批次執行
 * @param {Array} items - 要處理的項目
 * @param {Function} processBatch - async (batch, batchIndex) => void
 * @param {Object} opts - { batchSize, delayMs, maxConcurrent, onProgress, abortOnPortExhaustion }
 */
export async function safeBatchProcess(items, processBatch, opts = {}) {
  const {
    batchSize = 100,
    delayMs = 500,
    maxRetries = 3,
    onProgress = null,
    abortOnPortExhaustion = true,
    portCheckInterval = 10, // 每 N 批檢查一次 port
  } = opts;

  const total = items.length;
  const batches = [];
  for (let i = 0; i < total; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }

  let processed = 0;

  for (let i = 0; i < batches.length; i++) {
    // 定期檢查 port 健康度
    if (abortOnPortExhaustion && i % portCheckInterval === 0) {
      const health = checkPortHealth();
      if (health.level === 'critical') {
        throw new Error(`🚨 TCP port exhaustion! TIME_WAIT: ${health.count}. 中止批次操作以保護系統。`);
      }
      if (health.level === 'warning') {
        console.warn(`⚠️ TIME_WAIT: ${health.count}，增加延遲...`);
        await sleep(3000); // 額外等待
      }
    }

    // 執行批次（含重試）
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await processBatch(batches[i], i);
        break;
      } catch (err) {
        if (attempt < maxRetries - 1) {
          const wait = delayMs * (attempt + 2);
          console.warn(`  ⏳ retry ${attempt + 1}: ${err.message?.slice(0, 60)}... wait ${wait}ms`);
          await sleep(wait);
        } else {
          throw err;
        }
      }
    }

    processed += batches[i].length;
    if (onProgress) onProgress(processed, total, i + 1, batches.length);

    // 批次間延遲
    if (i < batches.length - 1) {
      await sleep(delayMs);
    }
  }

  return { processed, batches: batches.length };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default { getTimeWaitCount, checkPortHealth, safeBatchProcess };
