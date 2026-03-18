#!/usr/bin/env node
/**
 * 報修系統 Polling + 通知
 * 同步新報修單並發送 Telegram 通知
 * 
 * 建議用 cron 每小時執行一次:
 * 0 * * * * cd ~/paomao-gcp/gcp && node scripts/repair_poll_and_notify.cjs
 */

const { google } = require('googleapis');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const SPREADSHEET_ID = '1KMcIvJNC8XYXMXRoYmJRQg8d91G-ClcQdzoCSVv9q5E';
const SERVICE_ACCOUNT_PATH = path.join(process.env.HOME, '.openclaw', 'secrets', 'gcp-service-account.json');
const STATE_FILE = path.join(__dirname, '.repair_sync_state.json');

// Read bot token from dashboard .env
function getBotToken() {
  const envPaths = [
    path.join(process.env.HOME, '泡泡貓', 'dashboard', '.env'),
    path.join(process.env.HOME, '.openclaw', '.env'),
  ];
  for (const p of envPaths) {
    try {
      const content = fs.readFileSync(p, 'utf8');
      const match = content.match(/TELEGRAM_BOT_TOKEN=(.+)/);
      if (match) return match[1].trim();
    } catch {}
  }
  return process.env.TELEGRAM_BOT_TOKEN || '';
}

const TELEGRAM_BOT_TOKEN = getBotToken();
const TELEGRAM_CHAT_ID = '-5220564261';

const COL = {
  TIMESTAMP: 0, PROGRESS: 1, COST: 2, TECH_NOTE: 3, REPLACEMENT: 4,
  STORE: 5, EST_TIME: 6, SERIAL: 7, REASON: 8, VIDEO: 9, NOTE: 10,
  NEED_DISPATCH: 11, ITEM_QTY: 12, NEED_BACKUP: 16,
};

const pool = new Pool({ database: 'paomao', host: 'localhost', port: 5432, max: 5 });

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastSyncedRow: 1 }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function parseTimestamp(ts) {
  if (!ts) return null;
  const m = ts.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(上午|下午)\s*(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  let [, year, month, day, ampm, hour, min, sec] = m;
  hour = parseInt(hour);
  if (ampm === '下午' && hour < 12) hour += 12;
  if (ampm === '上午' && hour === 12) hour = 0;
  return new Date(year, month - 1, day, hour, min, sec);
}

async function generateOrderNumber(timestamp) {
  const d = timestamp || new Date();
  const dateStr = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const r = await pool.query("SELECT COUNT(*) FROM repair_orders WHERE order_number LIKE $1", [`RO${dateStr}%`]);
  return `RO${dateStr}${String(parseInt(r.rows[0].count)+1).padStart(4,'0')}`;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN) { console.log('⚠️ No bot token, skip notify'); return; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) console.error('Telegram error:', await res.text());
  } catch (e) { console.error('Telegram send failed:', e.message); }
}

async function main() {
  try {
    const creds = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'A1:T1000' });
    const allRows = res.data.values || [];
    if (allRows.length <= 1) { console.log('No data'); return; }

    const state = loadState();
    const startRow = Math.max(2, state.lastSyncedRow);

    if (startRow > allRows.length) {
      console.log('ℹ️ 沒有新資料');
      return;
    }

    const dataRows = allRows.slice(startRow - 1);
    console.log(`📋 檢查第 ${startRow} ~ ${allRows.length} 行`);

    let newCount = 0;
    const newOrders = [];

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rowNum = startRow + i;
      const timestamp = parseTimestamp(row[COL.TIMESTAMP]);
      const storeName = (row[COL.STORE] || '').trim();
      const reason = (row[COL.REASON] || '').trim();
      if (!storeName && !reason) continue;

      // Check duplicate
      const exists = await pool.query("SELECT id FROM repair_orders WHERE internal_notes LIKE $1", [`%sheet_row:${rowNum}%`]);
      if (exists.rows.length > 0) continue;

      const itemQty = (row[COL.ITEM_QTY] || '').trim();
      const serial = (row[COL.SERIAL] || '').trim();
      const needDispatch = (row[COL.NEED_DISPATCH] || '').trim();
      const needBackup = (row[COL.NEED_BACKUP] || '').trim();
      const note = (row[COL.NOTE] || '').trim();
      const video = (row[COL.VIDEO] || '').trim();

      const internalNotes = [
        `sheet_row:${rowNum}`,
        needDispatch ? `派車:${needDispatch}` : '',
        needBackup ? `備用機:${needBackup}` : '',
        video ? `影片:${video}` : '',
        note ? `備註:${note}` : '',
      ].filter(Boolean).join(' | ');

      const orderNumber = await generateOrderNumber(timestamp);
      await pool.query(`
        INSERT INTO repair_orders (order_number, store_name, equipment_type, equipment_serial,
          fault_description, priority, status, submitted_at, internal_notes, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'submitted',$7,$8,$9,$9)
      `, [orderNumber, storeName, itemQty || '未指定', serial, reason || '(未填寫)',
          needDispatch === '是' ? 1 : 3, timestamp, internalNotes, timestamp || new Date()]);

      newCount++;
      newOrders.push({ orderNumber, storeName, itemQty, serial, reason, needDispatch, needBackup });
    }

    saveState({ lastSyncedRow: allRows.length + 1, lastSync: new Date().toISOString() });

    if (newOrders.length > 0) {
      console.log(`🔔 ${newOrders.length} 筆新報修單`);

      for (const o of newOrders) {
        const msg = `🆕 新報修單 ${o.orderNumber}

🏪 店名：${o.storeName}
🔧 品項：${o.itemQty || '未指定'}
📋 編號：${o.serial || '無'}
❓ 原因：${o.reason || '未填寫'}
🚗 派車：${o.needDispatch || '未填'}
💡 備用機：${o.needBackup || '未填'}`;

        await sendTelegram(msg);
      }
    } else {
      console.log('ℹ️ 沒有新報修單');
    }

  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
