/**
 * lib/error-tracker.js — 統一錯誤追蹤模組（ESM）
 *
 * 功能：
 * 1. 錯誤寫入 DB 表 module_errors
 * 2. 追蹤每個模組/函數的錯誤次數
 * 3. 超過閾值（同一函數 3 次/小時）發 Telegram 通知到辦公室群組
 * 4. 提供 withTracking(fn, moduleName, funcName) 自動 try/catch 包裝
 *
 * 建表 SQL（首次使用前執行）：
 *   CREATE TABLE IF NOT EXISTS module_errors (
 *     id SERIAL PRIMARY KEY,
 *     module_name TEXT,
 *     function_name TEXT,
 *     error_message TEXT,
 *     stack TEXT,
 *     created_at TIMESTAMPTZ DEFAULT NOW()
 *   );
 */

import pool from './db.js';
import { readFileSync } from 'fs';

const TG_CHAT_OFFICE = '-5220564261';
const ERROR_THRESHOLD = 3;       // 觸發通知的閾值
const ERROR_WINDOW_MS = 60 * 60 * 1000; // 1 小時

// 記憶體中的錯誤計數（key: "module:func", value: { count, firstAt }）
const _errorCounts = new Map();

function getTgToken() {
  if (process.env.TG_BOT_TOKEN) return process.env.TG_BOT_TOKEN;
  try {
    return readFileSync('/Users/paopaomao/.openclaw/secrets/telegram-bot-token.txt', 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 發送 Telegram 通知
 * @param {string} text
 */
async function sendTelegramAlert(text) {
  const token = getTgToken();
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_OFFICE, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.error('[error-tracker] Telegram alert failed:', e.message);
  }
}

/**
 * 記錄錯誤到 DB，並視情況發 Telegram 通知
 * @param {string} moduleName - 模組名稱
 * @param {string} functionName - 函數名稱
 * @param {Error|string} error - 錯誤物件
 */
export async function trackError(moduleName, functionName, error) {
  const errMsg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack || '') : '';

  // 1. 寫入 DB
  try {
    await pool.query(
      `INSERT INTO module_errors (module_name, function_name, error_message, stack)
       VALUES ($1, $2, $3, $4)`,
      [moduleName, functionName, errMsg.slice(0, 2000), stack.slice(0, 5000)]
    );
  } catch (dbErr) {
    console.error('[error-tracker] DB insert failed:', dbErr.message);
  }

  // 2. 更新記憶體計數
  const key = `${moduleName}:${functionName}`;
  const now = Date.now();
  const entry = _errorCounts.get(key);

  if (!entry || now - entry.firstAt > ERROR_WINDOW_MS) {
    // 重置計數
    _errorCounts.set(key, { count: 1, firstAt: now });
  } else {
    entry.count += 1;
    // 3. 超過閾值發通知
    if (entry.count === ERROR_THRESHOLD) {
      const msg = `⚠️ <b>[錯誤警報]</b>\n模組: <code>${moduleName}</code>\n函數: <code>${functionName}</code>\n1 小時內已錯誤 ${entry.count} 次\n最後錯誤: ${errMsg.slice(0, 300)}`;
      await sendTelegramAlert(msg);
    }
  }

  console.error(`[${moduleName}] ${functionName} error:`, errMsg);
}

/**
 * 包裝 async function，自動追蹤錯誤
 * @param {Function} fn - 要包裝的 async function
 * @param {string} moduleName - 模組名稱
 * @param {string} functionName - 函數名稱（預設用 fn.name）
 * @returns {Function} 包裝後的 function
 */
export function withTracking(fn, moduleName, functionName) {
  const fname = functionName || fn.name || 'anonymous';
  return async function (...args) {
    try {
      return await fn.apply(this, args);
    } catch (error) {
      await trackError(moduleName, fname, error);
      throw error;
    }
  };
}

/**
 * 建立 module_errors 資料表（首次使用時執行一次）
 */
export async function ensureErrorTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS module_errors (
        id SERIAL PRIMARY KEY,
        module_name TEXT,
        function_name TEXT,
        error_message TEXT,
        stack TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('[error-tracker] module_errors table ready');
  } catch (e) {
    console.error('[error-tracker] ensureErrorTable failed:', e.message);
  }
}
