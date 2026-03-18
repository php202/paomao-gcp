#!/usr/bin/env node
/**
 * 每月15號 自動發放「泡泡貓｜員工潔顏券」給所有在職員工
 * 對象：直營店 + 特許加盟 的在職員工（排除管理者）
 * 流程：
 *   1. 從 DB 撈在職員工 + 手機號碼
 *   2. 用手機號碼在 SayDou 查會員 ID
 *   3. POST checkout/ticket 發券
 * 
 * Usage: node monthly_employee_ticket.cjs [--dry-run] [--phone 0912345678]
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ database: 'paomao' });
const TOKEN_PATH = path.join(process.env.HOME, '.openclaw/workspace/booking-site/.saydou-token');
const SAYDOU_BASE = 'https://saywebdatafeed.saydou.com/api/management';
const TICKET_GODSID = 189132; // 泡泡貓｜員工潔顏券
const TICKET_NAME = '泡泡貓｜員工潔顏券';

const TG_BOT_TOKEN = '8520607475:AAHKn1oBOmTGloSzvM_Y0ps41tigRG3torc';
const TG_ROBBY_CHAT = '7956245081';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SINGLE_PHONE = args.find((a, i) => args[i - 1] === '--phone');

function getToken() {
  return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
}

async function saydouFetch(url, opts = {}) {
  const token = getToken();
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`SayDou non-JSON response (${res.status}): ${text.slice(0, 100)}`);
  }
}

// Search member by phone
async function findMemberByPhone(phone) {
  const cleanPhone = phone.replace(/[-\s]/g, '');
  const data = await saydouFetch(`${SAYDOU_BASE}/crm/members?keyword=${encodeURIComponent(cleanPhone)}`);
  if (!data.status || !data.data?.items?.length) return null;
  // Find exact phone match
  const member = data.data.items.find(m => 
    (m.mphone || '').replace(/[-\s]/g, '') === cleanPhone ||
    (m.phones || []).some(p => p.replace(/[-\s]/g, '') === cleanPhone)
  );
  return member || data.data.items[0]; // fallback to first result
}

// Issue ticket to member
async function issueTicket(memberId, storeId) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5);

  const payload = {
    membid: memberId,
    storid: storeId,
    rectim: dateStr,
    time: timeStr,
    rsvtid: 0,
    tickets: [{
      tkitid: 0,
      usrsid: 0,
      pctpid: 3153,   // payment type: ticket
      pclsid: 1795,
      dpmtid: 1561,
      godsid: TICKET_GODSID,
      godnam: TICKET_NAME,
      price_: 0,
      sprice: 0,
      usecnt: 1,
      rusect: 1,
      exptyp: 'unlimit',
      pkgday: 0,
      strtim: null,
      exptim: null,
      dict_v: 0,
      dict_u: '',
      cost_v: 0,
      cost_u: '',
      fllcnt: 0,
      remark: `${new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'long' })}份員工潔顏券`,
      cash: 0,
      card: 0,
      give: 0,
      free: 1, // 贈送
      cashPay: 0, creditCard: 0, linePay: 0, wechatPay: 0, aliPay: 0,
      applePay: 0, jkoPay: 0, googlePay: 0, taiwanPay: 0,
      cpay_1: 0, cpay_2: 0, cpay_3: 0, cpay_4: 0, cpay_5: 0, voucher: 0,
      stdata: {
        ach: { cash: { value: 0, unit: '' }, card: { value: 0, unit: '' }, give: { value: 0, unit: '' }, free: { value: 0, unit: '' } },
        bonus: { cash: { value: 0, unit: '' }, card: { value: 0, unit: '' }, give: { value: 0, unit: '' }, free: { value: 0, unit: '' } },
      },
    }]
  };

  const data = await saydouFetch(`${SAYDOU_BASE}/checkout/ticket`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return data;
}

async function sendTG(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_ROBBY_CHAT, text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('[TG] send failed:', e.message); }
}

async function main() {
  console.log(`[employee-ticket] ${DRY_RUN ? '🔍 DRY RUN' : '🎫 LIVE'} — ${new Date().toISOString()}`);

  // 1. Get active employees from direct + franchise stores
  let query = `
    SELECT e.id, e.name, e.phone, e.store_name, e.employee_code, s.saydou_id
    FROM employees e
    JOIN stores s ON s.store_name = e.store_name
    WHERE e.is_active = true
      AND s.store_type IN ('direct', 'special_franchise')
      AND s.is_active = true
      AND e.title NOT IN ('管理者')
      AND e.phone IS NOT NULL AND e.phone != ''
  `;
  const params = [];
  if (SINGLE_PHONE) {
    query += ' AND e.phone = $1';
    params.push(SINGLE_PHONE);
  }
  query += ' ORDER BY e.store_name, e.name';

  const { rows: employees } = await pool.query(query, params);
  console.log(`[employee-ticket] Found ${employees.length} employees with phone numbers`);

  if (employees.length === 0) {
    console.log('[employee-ticket] No employees to process');
    await pool.end();
    return;
  }

  let success = 0, failed = 0, noMember = 0;
  const results = [];

  // 當月份 (YYYY-MM)
  const currentMonth = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).slice(0, 7);
  console.log(`[employee-ticket] 月份: ${currentMonth}`);

  for (const emp of employees) {
    const label = `${emp.name} (${emp.phone}) @ ${emp.store_name}`;
    try {
      // 防重複：檢查本月是否已發過
      const { rows: dup } = await pool.query(
        "SELECT id FROM employee_ticket_log WHERE phone=$1 AND month=$2 AND status='ok'",
        [emp.phone, currentMonth]
      );
      if (dup.length > 0) {
        console.log(`  ⏭️ ${label} — 本月已發過，跳過`);
        results.push({ ...emp, status: 'skipped' });
        continue;
      }

      // 2. Find SayDou member
      const member = await findMemberByPhone(emp.phone);
      if (!member) {
        console.log(`  ❌ ${label} — SayDou 查無會員`);
        noMember++;
        results.push({ ...emp, status: 'no_member' });
        continue;
      }

      const memberId = member.membid;
      const storeId = emp.saydou_id || 0;

      if (DRY_RUN) {
        console.log(`  ✅ ${label} — member ${memberId}, store ${storeId} [DRY RUN]`);
        success++;
        results.push({ ...emp, status: 'dry_run', memberId });
        continue;
      }

      // 3. Issue ticket
      const result = await issueTicket(memberId, storeId);
      if (result.status) {
        console.log(`  ✅ ${label} — 發券成功`);
        success++;
        results.push({ ...emp, status: 'ok', memberId });
        // 寫入 log 防重複
        await pool.query(
          `INSERT INTO employee_ticket_log (employee_id, employee_name, phone, store_name, month, saydou_membid, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'ok')`,
          [emp.id, emp.name, emp.phone, emp.store_name, currentMonth, memberId]
        );
      } else {
        console.log(`  ❌ ${label} — ${result.message || JSON.stringify(result)}`);
        failed++;
        results.push({ ...emp, status: 'error', error: result.message });
        await pool.query(
          `INSERT INTO employee_ticket_log (employee_id, employee_name, phone, store_name, month, saydou_membid, status, error_msg)
           VALUES ($1, $2, $3, $4, $5, $6, 'error', $7)`,
          [emp.id, emp.name, emp.phone, emp.store_name, currentMonth, memberId, result.message || '']
        );
      }

      // Rate limit: 200ms between requests
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.log(`  ❌ ${label} — ${e.message}`);
      failed++;
      results.push({ ...emp, status: 'error', error: e.message });
    }
  }

  // Summary
  const skipped = results.filter(r => r.status === 'skipped').length;
  const summary = `🎫 員工潔顏券發放${DRY_RUN ? '（測試）' : ''}完成\n\n` +
    `📅 月份：${currentMonth}\n` +
    `📊 總人數：${employees.length}\n` +
    `✅ 成功：${success}\n` +
    `❌ 失敗：${failed}\n` +
    `🔍 查無會員：${noMember}` +
    (skipped > 0 ? `\n⏭️ 已發過跳過：${skipped}` : '');
  
  console.log('\n' + summary);
  if (!DRY_RUN) await sendTG(summary);

  await pool.end();
}

main().catch(e => {
  console.error('[employee-ticket] Fatal:', e);
  pool.end();
  process.exit(1);
});
