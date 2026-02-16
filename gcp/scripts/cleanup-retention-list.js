import { getAuth } from '../lib/auth.js';
import { deleteRows, getSheetIdByName, readSheet } from '../lib/sheets.js';

const INTEGRATED_SHEET_SS_ID = (process.env.INTEGRATED_SHEET_SS_ID || process.env.LINE_STORE_SS_ID || '').trim();
const RETENTION_SHEET_NAME = '準客挽留清單';
const CLOSED_STATUSES = new Set(['Overwritten', 'Replied', 'AutoReplied', 'Skipped', 'SendFailed']);
const PENDING_STALE_DAYS = Number.parseInt(process.env.PENDING_STALE_DAYS || '7', 10);

function parseDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function run() {
  if (!INTEGRATED_SHEET_SS_ID) throw new Error('missing INTEGRATED_SHEET_SS_ID/LINE_STORE_SS_ID');
  const auth = await getAuth();

  const sheetId = await getSheetIdByName(auth, INTEGRATED_SHEET_SS_ID, RETENTION_SHEET_NAME);
  if (sheetId == null) return;

  const rows = await readSheet(auth, INTEGRATED_SHEET_SS_ID, `'${RETENTION_SHEET_NAME}'!A:H`);
  if (rows.length <= 1) return;

  const now = new Date();
  const staleMs = PENDING_STALE_DAYS * 24 * 60 * 60 * 1000;
  const toDelete = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const status = String(row[3] || '').trim();
    const triggerTime = parseDate(row[2]);
    const isStalePending = status === 'Pending' && triggerTime && now.getTime() - triggerTime.getTime() > staleMs;
    if (CLOSED_STATUSES.has(status) || isStalePending) {
      toDelete.push(i + 1); // 1-based row index
    }
  }

  if (toDelete.length) await deleteRows(auth, INTEGRATED_SHEET_SS_ID, sheetId, toDelete);
}

