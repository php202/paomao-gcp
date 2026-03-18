#!/usr/bin/env node
/**
 * 報修表單 Google Sheet → PostgreSQL 同步
 * 讀取「泡泡貓報修表單」回應試算表，寫入 repair_orders
 * 
 * 用法:
 *   node repair_sheet_sync.js           # 同步新資料
 *   node repair_sheet_sync.js --full    # 全量同步
 *   node repair_sheet_sync.js --notify  # 同步並發 Telegram 通知
 */

const { google } = require('googleapis');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const SPREADSHEET_ID = '1KMcIvJNC8XYXMXRoYmJRQg8d91G-ClcQdzoCSVv9q5E';
const FORM_ID = '1FDILESecI29YOrJl3RPDH_gvatsFMz2dKLaMkphwIHA';
const SERVICE_ACCOUNT_PATH = path.join(process.env.HOME, '.openclaw', 'secrets', 'gcp-service-account.json');
const STATE_FILE = path.join(__dirname, '.repair_sync_state.json');

// Sheet column mapping (0-indexed)
const COL = {
  TIMESTAMP: 0,       // A: 時間戳記
  PROGRESS: 1,        // B: 處理進度 (manual)
  COST: 2,            // C: 維修費用 (manual)
  TECH_NOTE: 3,       // D: 維修部備註 (manual)
  REPLACEMENT: 4,     // E: 替換主機.手柄 (manual)
  STORE: 5,           // F: 店名
  EST_TIME: 6,        // G: 預估時間 (manual)
  SERIAL: 7,          // H: 儀器編號
  REASON: 8,          // I: 報修原因
  VIDEO: 9,           // J: 故障影片
  NOTE: 10,           // K: 備註
  NEED_DISPATCH: 11,  // L: 是否需要總公司派車
  ITEM_QTY: 12,       // M: 報修品項與數量
  // N: empty
  RECV_DATE: 14,      // O: 總公司收到日期 (manual)
  SEND_DATE: 15,      // P: 總公司寄送日期 (manual)
  NEED_BACKUP: 16,    // Q: 是否需要備用機台
  // R: empty
  RECV_DATE2: 18,     // S: 收到日期 (manual)
  SEND_DATE2: 19,     // T: 寄送日期 (manual)
};

const pool = new Pool({ database: 'paomao', host: 'localhost', port: 5432, max: 5 });

async function getAuthClient() {
  const creds = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return auth.getClient();
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastSyncedRow: 1 }; // 1 = header
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function parseTimestamp(ts) {
  if (!ts) return null;
  // Format: "2025/1/2 下午 4:38:29" or "2025/1/2 上午 10:38:29"
  const m = ts.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(上午|下午)\s*(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  let [, year, month, day, ampm, hour, min, sec] = m;
  hour = parseInt(hour);
  if (ampm === '下午' && hour < 12) hour += 12;
  if (ampm === '上午' && hour === 12) hour = 0;
  return new Date(year, month - 1, day, hour, min, sec);
}

function mapStatus(progressText) {
  if (!progressText) return 'submitted';
  if (progressText.includes('已完成')) return 'completed';
  if (progressText.includes('維修中')) return 'in_repair';
  if (progressText.includes('已寄出') || progressText.includes('已送出')) return 'in_repair';
  if (progressText.includes('已收到')) return 'received';
  if (progressText.includes('待處理')) return 'submitted';
  return 'submitted';
}

function mapPriority(needDispatch) {
  if (!needDispatch) return 3;
  if (needDispatch === '是') return 1; // needs dispatch = high priority
  return 3;
}

async function generateOrderNumber(timestamp) {
  const d = timestamp || new Date();
  const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const result = await pool.query(
    "SELECT COUNT(*) FROM repair_orders WHERE order_number LIKE $1",
    [`RO${dateStr}%`]
  );
  const seq = String(parseInt(result.rows[0].count) + 1).padStart(4, '0');
  return `RO${dateStr}${seq}`;
}

async function syncRows(rows, startRow, notify = false) {
  let newCount = 0;
  let updatedCount = 0;
  const newOrders = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = startRow + i;
    const timestamp = parseTimestamp(row[COL.TIMESTAMP]);
    const storeName = (row[COL.STORE] || '').trim();
    const reason = (row[COL.REASON] || '').trim();

    if (!storeName && !reason) continue; // skip empty rows

    // Use timestamp + store + reason as unique key
    const fingerprint = `${row[COL.TIMESTAMP]}|${storeName}|${reason}`;

    // Check if already exists
    const existing = await pool.query(
      "SELECT id, status FROM repair_orders WHERE internal_notes LIKE $1",
      [`%sheet_row:${rowNum}%`]
    );

    const status = mapStatus(row[COL.PROGRESS]);
    const itemQty = (row[COL.ITEM_QTY] || '').trim();
    const serial = (row[COL.SERIAL] || '').trim();
    const video = (row[COL.VIDEO] || '').trim();
    const note = (row[COL.NOTE] || '').trim();
    const needDispatch = (row[COL.NEED_DISPATCH] || '').trim();
    const needBackup = (row[COL.NEED_BACKUP] || '').trim();
    const techNote = (row[COL.TECH_NOTE] || '').trim();
    const replacement = (row[COL.REPLACEMENT] || '').trim();
    const costText = (row[COL.COST] || '').trim();
    const cost = costText ? parseFloat(costText.replace(/[^0-9.]/g, '')) || null : null;

    const internalNotes = [
      `sheet_row:${rowNum}`,
      needDispatch ? `派車:${needDispatch}` : '',
      needBackup ? `備用機:${needBackup}` : '',
      replacement ? `替換:${replacement}` : '',
      techNote ? `維修備註:${techNote}` : '',
      video ? `影片:${video}` : '',
      note ? `備註:${note}` : '',
    ].filter(Boolean).join(' | ');

    // Determine equipment type from item description
    const equipmentType = itemQty || '未指定';

    if (existing.rows.length === 0) {
      // Insert new
      const orderNumber = await generateOrderNumber(timestamp);
      await pool.query(`
        INSERT INTO repair_orders (
          order_number, store_name, equipment_type, equipment_serial,
          fault_description, priority, status, submitted_at,
          actual_cost, payment_status, internal_notes, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
      `, [
        orderNumber, storeName, equipmentType, serial,
        reason || '(未填寫)', mapPriority(needDispatch), status,
        timestamp, cost, cost ? 'paid' : 'pending', internalNotes, timestamp || new Date()
      ]);

      newCount++;
      if (status === 'submitted' || !row[COL.PROGRESS]) {
        newOrders.push({ orderNumber, storeName, equipmentType, serial, reason, needDispatch, needBackup });
      }
    } else {
      // Update existing - sync status from sheet
      const current = existing.rows[0];
      if (current.status !== status || cost) {
        await pool.query(`
          UPDATE repair_orders SET status=$1, actual_cost=COALESCE($2, actual_cost),
          internal_notes=$3, updated_at=NOW()
          ${status === 'completed' ? ", completed_at=COALESCE(completed_at, NOW())" : ''}
          WHERE id=$4
        `, [status, cost, internalNotes, current.id]);
        updatedCount++;
      }
    }
  }

  console.log(`✅ 同步完成: ${newCount} 筆新增, ${updatedCount} 筆更新`);

  if (notify && newOrders.length > 0) {
    return newOrders;
  }
  return [];
}

async function main() {
  const args = process.argv.slice(2);
  const fullSync = args.includes('--full');
  const notify = args.includes('--notify');

  try {
    const client = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    // Get all data
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'A1:T1000',
    });

    const allRows = res.data.values || [];
    if (allRows.length <= 1) {
      console.log('ℹ️ 沒有資料');
      return;
    }

    const state = loadState();
    const startRow = fullSync ? 2 : Math.max(2, state.lastSyncedRow);
    const dataRows = allRows.slice(startRow - 1); // -1 because array is 0-indexed

    console.log(`📋 處理第 ${startRow} ~ ${allRows.length} 行 (共 ${dataRows.length} 筆)`);

    const newOrders = await syncRows(dataRows, startRow, notify);

    // Save state
    saveState({ lastSyncedRow: allRows.length + 1, lastSync: new Date().toISOString() });

    // Print new orders for notification
    if (newOrders.length > 0) {
      console.log('\n🔔 新報修單:');
      newOrders.forEach(o => {
        console.log(`  ${o.orderNumber} | ${o.storeName} | ${o.equipmentType} | ${o.reason}`);
      });
      // Output JSON for programmatic use
      console.log('\n__NEW_ORDERS_JSON__');
      console.log(JSON.stringify(newOrders));
    }

  } catch (error) {
    console.error('❌ 同步失敗:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
