#!/usr/bin/env node
/**
 * grooming_daily_check.cjs — 儀容禮儀每日自動檢查
 * 
 * 功能：
 * 1. 檢查日（10/20/30）18:00 → 未上傳照片標記為「缺考」
 * 2. 連續 3 天未讀禮儀規範 → 通知店長
 * 3. 連續 2 次指甲不合格 → 通知 HR (TG 辦公室群)
 * 4. 檢查日 09:00 → LINE 推播提醒上傳
 * 
 * Usage: node grooming_daily_check.cjs [--notify-only] [--mark-absent]
 */

const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({ connectionString: 'postgresql://localhost/paomao' });
const TG_TOKEN = process.env.TG_TOKEN || require('fs').readFileSync(
  require('path').join(require('os').homedir(), '.openclaw/secrets/telegram-token.txt'), 'utf8'
).trim();
const TG_OFFICE_CHAT = '-5220564261';

const now = new Date();
const day = now.getDate();
const hour = now.getHours();
const isCheckDay = [10, 20, 30].includes(day);

async function sendTG(chatId, text) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.write(data);
    req.end();
  });
}

async function markAbsent() {
  if (!isCheckDay) { console.log('今天不是檢查日，跳過缺考標記'); return; }
  
  // 找出活躍員工中沒上傳照片的
  const { rows } = await pool.query(`
    SELECT e.id, e.name, e.store_name
    FROM employees e
    WHERE e.is_active = true AND e.store_name NOT LIKE '%總公司%'
      AND NOT EXISTS (
        SELECT 1 FROM grooming_checks gc 
        WHERE gc.employee_id = e.id AND gc.check_date = CURRENT_DATE
      )
  `);

  if (!rows.length) { console.log('所有人都已上傳，無需標記缺考'); return; }

  for (const emp of rows) {
    await pool.query(
      `INSERT INTO grooming_checks (employee_id, check_date, result)
       VALUES ($1, CURRENT_DATE, 'absent')
       ON CONFLICT (employee_id, check_date) DO NOTHING`,
      [emp.id]
    );
  }
  console.log(`標記 ${rows.length} 人為缺考`);

  // 通知 TG
  const names = rows.slice(0, 10).map(r => `${r.name}(${r.store_name})`).join('、');
  const more = rows.length > 10 ? `...等共 ${rows.length} 人` : '';
  await sendTG(TG_OFFICE_CHAT, `⚠️ <b>儀容檢查缺考通知</b>\n${day}號指甲檢查未上傳：${names}${more}`);
}

async function checkUnread() {
  // 連續 3 天未讀禮儀規範的員工
  const { rows } = await pool.query(`
    SELECT e.id, e.name, e.store_name,
      (SELECT max(read_date) FROM etiquette_readings WHERE employee_id = e.id) as last_read
    FROM employees e
    WHERE e.is_active = true AND e.store_name NOT LIKE '%總公司%'
      AND NOT EXISTS (
        SELECT 1 FROM etiquette_readings er 
        WHERE er.employee_id = e.id AND er.read_date >= CURRENT_DATE - 3
      )
  `);

  if (!rows.length) { console.log('所有人近 3 天都有閱讀規範'); return; }

  console.log(`${rows.length} 人連續 3+ 天未讀規範`);
  // TODO: 通知各店店長（LINE 推播）
  // 目前先通知 TG 辦公室
  if (rows.length <= 20) {
    const list = rows.map(r => `• ${r.name}(${r.store_name}) 最後閱讀:${r.last_read||'從未'}`).join('\n');
    await sendTG(TG_OFFICE_CHAT, `📖 <b>禮儀規範未讀提醒</b>\n以下員工連續 3 天以上未閱讀：\n${list}`);
  }
}

async function checkConsecutiveFails() {
  // 連續 2 次不合格
  const { rows } = await pool.query(`
    WITH recent AS (
      SELECT employee_id, result, check_date,
        ROW_NUMBER() OVER (PARTITION BY employee_id ORDER BY check_date DESC) as rn
      FROM grooming_checks WHERE result IN ('pass','fail')
    )
    SELECT r1.employee_id, e.name, e.store_name
    FROM recent r1 JOIN recent r2 ON r1.employee_id = r2.employee_id
    JOIN employees e ON e.id = r1.employee_id
    WHERE r1.rn = 1 AND r2.rn = 2 AND r1.result = 'fail' AND r2.result = 'fail'
  `);

  if (!rows.length) { console.log('沒有連續 2 次不合格員工'); return; }

  const list = rows.map(r => `• ${r.name}(${r.store_name})`).join('\n');
  await sendTG(TG_OFFICE_CHAT, `🔴 <b>儀容檢查連續不合格警報</b>\n以下員工連續 2 次指甲不合格，建議安排面談：\n${list}`);
  console.log(`${rows.length} 人連續不合格，已通知`);
}

async function main() {
  try {
    const args = process.argv.slice(2);

    if (args.includes('--mark-absent') || (!args.length && isCheckDay && hour >= 18)) {
      await markAbsent();
    }

    if (args.includes('--notify-only') || !args.length) {
      await checkUnread();
      await checkConsecutiveFails();
    }

    console.log('✅ grooming daily check 完成');
  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
