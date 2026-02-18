import { appendSheet, readSheet, writeSheet } from './sheets.js';
import {
  getAllStorecashAddRecordByMembid,
  getAllStorecashUseRecordByMembid,
  getAllTransactionsByMembid,
  getMemApi,
  getReservationRecordByMembid,
} from './saydou-customer.js';
import { callAIForCustomerProfile } from './ai-crm.js';

const LINE_STORE_SS_ID = (process.env.LINE_STORE_SS_ID || process.env.INTEGRATED_SHEET_SS_ID || '').trim();
const CUSTOMER_SHEET_ID = String(process.env.CUSTOMER_SHEET_ID || '1wAfl4Dipag6Eh8msOYUc0ZUepaeQR_HnQNEcxIVUt3M').trim();
const CUSTOMER_HISTORY_SHEET_NAMES = String(process.env.CUSTOMER_HISTORY_SHEET_NAMES || 'sheet1,2025前')
  .split(/[,、，]/)
  .map((s) => s.trim())
  .filter(Boolean);

const EMPLOYEE_NOTES_SHEET_NAME = String(process.env.EMPLOYEE_NOTES_SHEET_NAME || '表單回覆 3').trim();

// Keep in sync with GAS CONFIG.INTEGRATED_HEADERS (gas/各店訊息一覽表/CustomerProfile.js).
export const INTEGRATED_HEADERS = [
  '時間',
  '手機',
  '員工填寫',
  '客人問卷',
  'line對話',
  '消費紀錄',
  '儲值紀錄',
  'saydouUserId',
  'ai prompt',
  'lineUserId',
  'AI分析結果',
  'ai調整建議',
  '預約記錄',
  '建議下次回訪日',
  '最後推播時間',
  '推播次數',
  '點擊積分',
  '連續未點擊',
  '客戶類型',
];

function normalizePhone9(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 9 && digits[0] === '9') return `0${digits}`;
  if (digits.length >= 10) return digits.slice(-10);
  return '';
}

function fmtTaipei(ts = Date.now(), withSeconds = true) {
  const d = new Date(ts);
  // Using sv-SE to get a stable YYYY-MM-DD HH:mm:ss format.
  const s = d.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 19);
  return withSeconds ? s.replace('-', '/').replace('-', '/') : s.slice(0, 16);
}

function buildStorecashMergedSummary(addItems, useItems) {
  const list = [];
  for (const o of Array.isArray(addItems) ? addItems : []) {
    list.push({
      rectim: o?.rectim || o?.cretim || '',
      typeLabel: '儲值',
      stonam: o?.stonam || o?.stor?.stonam || '',
      amount: o?.price_ ?? o?.stoval ?? 0,
      remark: o?.sremark || o?.remark || '',
    });
  }
  for (const o of Array.isArray(useItems) ? useItems : []) {
    list.push({
      rectim: o?.rectim || o?.cretim || '',
      typeLabel: '使用',
      stonam: o?.stor?.stonam || '',
      amount: o?.stoval ?? 0,
      remark: o?.remark || '',
    });
  }
  list.sort((a, b) => String(b.rectim || '').localeCompare(String(a.rectim || '')));
  if (!list.length) return '（尚無）';
  const lines = [];
  const maxShow = 30;
  for (let i = 0; i < Math.min(list.length, maxShow); i++) {
    const o = list[i];
    const remark = o.remark ? ` ${o.remark}` : '';
    lines.push(`${o.rectim || ''} ${o.typeLabel || '—'} ${o.stonam || ''} $${o.amount ?? 0}${remark}`.trim());
  }
  if (list.length > maxShow) lines.push(`…共 ${list.length} 筆`);
  return lines.join('\n');
}

function formatTransactionPaymentAmounts(t) {
  if (!t) return '';
  const parts = [];
  const cashVal = Number(t.cash ?? 0) + Number(t.cashpay ?? 0);
  if (cashVal > 0) parts.push(`現金 ${cashVal}`);
  const linepay = Number(t.linepay ?? 0);
  if (linepay > 0) parts.push(`LINE ${linepay}`);
  const transferVal = Number(t.transfer ?? 0) || Number(t.bank ?? 0);
  if (transferVal > 0) parts.push(`轉帳 ${transferVal}`);
  const rpcash = Number(t.rpcash ?? 0);
  if (rpcash > 0) parts.push(`儲值金 ${rpcash}`);
  const credit = Number(t.creditcard ?? 0) || Number(t.card ?? 0);
  if (credit > 0) parts.push(`信用卡 ${credit}`);
  const ticket = Number(t.ticket ?? 0);
  if (ticket > 0) parts.push(`券 ${ticket}`);
  const give = Number(t.give ?? 0);
  if (give > 0) parts.push(`贈送 ${give}`);
  const free = Number(t.free ?? 0);
  if (free > 0) parts.push(`免費 ${free}`);
  const voucher = Number(t.voucher ?? 0);
  if (voucher > 0) parts.push(`兌換券 ${voucher}`);
  return parts.join(' ');
}

function buildConsumeSummary(transactions = []) {
  if (!Array.isArray(transactions) || !transactions.length) return { consumeText: '—', lastDate: '' };
  const lines = [];
  const maxShow = 10;
  for (let i = 0; i < Math.min(transactions.length, maxShow); i++) {
    const t = transactions[i];
    const dateStr = t?.rectim || t?.cretim || '';
    const store = t?.stor?.stonam ? String(t.stor.stonam) : '';
    const price = t?.price_ ?? t?.rprice ?? 0;
    const detail = t?.ordds?.[0]?.godnam ? String(t.ordds[0].godnam) : '';
    const remark = t?.remark ? String(t.remark).trim() : '';
    const paymentPart = formatTransactionPaymentAmounts(t);
    const suffix = remark ? ` [備註:${remark}]` : '';
    const pay = paymentPart ? ` ${paymentPart}` : '';
    lines.push(`${dateStr} ${store} $${price} ${detail}${pay}${suffix}`.trim());
  }
  if (transactions.length > maxShow) lines.push(`…共 ${transactions.length} 筆`);
  const lastDate = transactions[0]?.rectim || transactions[0]?.cretim || '';
  const consumeText = lines.join('\n');
  return { consumeText, lastDate: lastDate ? String(lastDate).slice(0, 10) : '' };
}

function calculateSuggestedNextVisit(lastDateStr, avgDays = 30) {
  if (!lastDateStr) return '';
  const d = new Date(String(lastDateStr).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.max(7, Math.min(60, Number(avgDays) || 30));
  d.setDate(d.getDate() + days);
  // yyyy-MM-dd
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

function calculateConsumptionFrequency(transactions = []) {
  if (!Array.isArray(transactions) || transactions.length < 2) return 30;
  const dates = [];
  for (const t of transactions) {
    const dt = t?.rectim || t?.cretim;
    if (!dt) continue;
    const d = new Date(String(dt).slice(0, 10) + 'T00:00:00');
    if (Number.isNaN(d.getTime())) continue;
    dates.push(d.getTime());
    if (dates.length >= 10) break;
  }
  if (dates.length < 2) return 30;
  const gaps = [];
  for (let i = 0; i < dates.length - 1; i++) {
    const diffDays = Math.round((dates[i] - dates[i + 1]) / (24 * 60 * 60 * 1000));
    if (diffDays > 0 && diffDays < 365) gaps.push(diffDays);
  }
  if (!gaps.length) return 30;
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  return Math.max(7, Math.round(avg));
}

// Very small in-memory cache to avoid rereading entire questionnaire sheets repeatedly in one run.
let cachedQuestionnaire = { key: '', loadedAt: 0, rowsByPhone: new Map() };

async function loadQuestionnaireIndex(auth) {
  const key = `${CUSTOMER_SHEET_ID}:${CUSTOMER_HISTORY_SHEET_NAMES.join(',')}`;
  const now = Date.now();
  if (cachedQuestionnaire.key === key && now - cachedQuestionnaire.loadedAt < 3 * 60 * 1000) {
    return cachedQuestionnaire.rowsByPhone;
  }
  const rowsByPhone = new Map();
  for (const sheetName of CUSTOMER_HISTORY_SHEET_NAMES) {
    const rows = await readSheet(auth, CUSTOMER_SHEET_ID, `'${sheetName}'!A:Z`);
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const phone = normalizePhone9(row?.[1] || ''); // GAS config: B column is phone
      if (!phone) continue;
      const list = rowsByPhone.get(phone) || [];
      list.push(row);
      rowsByPhone.set(phone, list);
    }
  }
  cachedQuestionnaire = { key, loadedAt: now, rowsByPhone };
  return rowsByPhone;
}

function summarizeQuestionnaireRows(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return { summary: '—', hasQuestionnaire: false };
  // Keep a compact summary to fit in sheet cells; AI can use the full joined content.
  const maxLen = 8000;
  const last = rows[rows.length - 1];
  const text = String(last?.join(' | ') || '').trim();
  const summary = text ? (text.length > maxLen ? `${text.slice(0, maxLen)}\n…` : text) : '—';
  return { summary: summary || '—', hasQuestionnaire: summary !== '—' };
}

async function ensureIntegratedHeaderRow(auth) {
  if (!LINE_STORE_SS_ID) throw new Error('Missing LINE_STORE_SS_ID');
  const header = await readSheet(auth, LINE_STORE_SS_ID, "'客人消費狀態'!1:1");
  const row1 = header?.[0] || [];
  const hasPhone = row1.some((c) => String(c || '').trim() === '手機');
  if (!hasPhone) {
    // Best-effort: ensure header cells exist. This won't delete user-added columns beyond our range.
    await writeSheet(auth, LINE_STORE_SS_ID, `'客人消費狀態'!A1:S1`, [INTEGRATED_HEADERS]);
  }
}

async function findCustomerRowIndexByPhone(auth, phone) {
  const needle = normalizePhone9(phone);
  if (!needle) return null;
  const col = await readSheet(auth, LINE_STORE_SS_ID, "'客人消費狀態'!B2:B");
  for (let i = 0; i < col.length; i++) {
    const rowPhone = normalizePhone9(col[i]?.[0] || '');
    if (rowPhone && rowPhone === needle) return i + 2; // 1-based row index in sheet
  }
  return null;
}

function buildAIPrompt({ phone, questionnaireRows, consumeText, storecashText, reservationText }) {
  const lines = [];
  lines.push('【主表】');
  lines.push(`手機：${phone}`);
  lines.push('');
  lines.push('【問卷】');
  if (Array.isArray(questionnaireRows) && questionnaireRows.length) {
    const last = questionnaireRows[questionnaireRows.length - 1];
    lines.push(`最新一筆：${(last || []).join(' | ')}`);
  } else {
    lines.push('（尚無）');
  }
  lines.push('');
  lines.push('【消費紀錄】');
  lines.push(consumeText || '—');
  lines.push('');
  lines.push('【儲值紀錄】');
  lines.push(storecashText || '（尚無）');
  lines.push('');
  lines.push('【預約記錄】');
  lines.push(reservationText || '—');
  return lines.join('\n').slice(0, 20000);
}

export async function refreshCustomerByPhone(auth, phone, options = {}) {
  if (!LINE_STORE_SS_ID) throw new Error('Missing LINE_STORE_SS_ID');
  const normalized = normalizePhone9(phone);
  if (!normalized) throw new Error('invalid phone');

  const skipAI = options?.skipAI === true;
  const leaveEmployeeEmpty = options?.leaveEmployeeEmpty === true;

  await ensureIntegratedHeaderRow(auth);

  // Read existing row fields we should preserve.
  const existingRowIndex = await findCustomerRowIndexByPhone(auth, normalized);
  let existing = null;
  if (existingRowIndex) {
    const rows = await readSheet(auth, LINE_STORE_SS_ID, `'客人消費狀態'!A${existingRowIndex}:S${existingRowIndex}`);
    existing = rows?.[0] || null;
  }

  const questionnaireIndex = await loadQuestionnaireIndex(auth);
  const questionnaireRows = questionnaireIndex.get(normalized) || [];
  const { summary: questionnaireSummary, hasQuestionnaire } = summarizeQuestionnaireRows(questionnaireRows);

  let member = null;
  try {
    member = await getMemApi(auth, normalized);
  } catch (_) {
    member = null;
  }
  const membid = member?.membid;

  let transactions = [];
  try {
    transactions = membid ? await getAllTransactionsByMembid(auth, membid, 20, 10) : [];
  } catch (_) {
    transactions = [];
  }
  const consumeSummary = buildConsumeSummary(transactions);

  let storecashText = '（尚無）';
  try {
    if (membid) {
      const [addItems, useItems] = await Promise.all([
        getAllStorecashAddRecordByMembid(auth, membid, 20),
        getAllStorecashUseRecordByMembid(auth, membid, 20),
      ]);
      storecashText = buildStorecashMergedSummary(addItems, useItems);
    }
  } catch (_) {
    storecashText = '（尚無）';
  }

  let reservationText = '—';
  try {
    if (membid) {
      const items = await getReservationRecordByMembid(auth, membid);
      if (Array.isArray(items) && items.length) {
        reservationText = items
          .map((r) => `${String(r.rsvtim || '').slice(0, 16)} ${String(r.stonam || '').trim()}`.trim())
          .join('\n');
      }
    }
  } catch (_) {
    reservationText = '—';
  }

  const avgDays = calculateConsumptionFrequency(transactions);
  const suggestedNextVisit = consumeSummary.lastDate ? calculateSuggestedNextVisit(consumeSummary.lastDate, avgDays) : '';

  // Preserve reengagement + adjustment suggestions if present.
  const headerIndex = new Map(INTEGRATED_HEADERS.map((h, i) => [h, i]));
  const preserve = (name, fallback = '') => {
    const idx = headerIndex.get(name);
    if (idx == null) return fallback;
    const val = existing?.[idx];
    return val != null ? String(val).trim() : fallback;
  };

  const timestamp = fmtTaipei(Date.now(), true);
  const employeeSummary = leaveEmployeeEmpty ? '' : preserve('員工填寫', '—');
  const lineSummary = preserve('line對話', '—');
  const lineUserId = preserve('lineUserId', '');
  const aiAdjustment = preserve('ai調整建議', '');
  const lastPush = preserve('最後推播時間', '');
  const pushCount = preserve('推播次數', '');
  const clickScore = preserve('點擊積分', '');
  const consecutiveNoClick = preserve('連續未點擊', '');
  const customerType = preserve('客戶類型', '自動提醒');

  const aiPrompt = buildAIPrompt({
    phone: normalized,
    questionnaireRows,
    consumeText: consumeSummary.consumeText,
    storecashText,
    reservationText,
  });

  let aiResult = preserve('AI分析結果', '');
  if (!skipAI) {
    try {
      aiResult = await callAIForCustomerProfile(aiPrompt);
    } catch (e) {
      // Keep existing AI result if AI call fails.
      console.warn('[customer-profile] AI failed:', e?.message || e);
      aiResult = aiResult || '';
    }
  }

  const rowValues = [
    timestamp,
    normalized,
    employeeSummary,
    questionnaireSummary,
    lineSummary,
    consumeSummary.consumeText || '—',
    storecashText || '（尚無）',
    membid ? String(membid) : '—',
    aiPrompt,
    lineUserId,
    aiResult,
    aiAdjustment,
    reservationText,
    suggestedNextVisit,
    lastPush,
    pushCount,
    clickScore,
    consecutiveNoClick,
    customerType,
  ];

  if (existingRowIndex) {
    await writeSheet(auth, LINE_STORE_SS_ID, `'客人消費狀態'!A${existingRowIndex}:S${existingRowIndex}`, [rowValues]);
    return { ok: true, rowIndex: existingRowIndex, phone: normalized, created: false, hasQuestionnaire };
  }

  await appendSheet(auth, LINE_STORE_SS_ID, '客人消費狀態', rowValues);
  // We don't know the exact appended row index without extra API calls; return null.
  return { ok: true, rowIndex: null, phone: normalized, created: true, hasQuestionnaire };
}

export async function readCustomerStateRow(auth, phone) {
  if (!LINE_STORE_SS_ID) throw new Error('Missing LINE_STORE_SS_ID');
  await ensureIntegratedHeaderRow(auth);
  const normalized = normalizePhone9(phone);
  if (!normalized) return { rowIndex: null, phone: '', headers: INTEGRATED_HEADERS, row: null };
  const rowIndex = await findCustomerRowIndexByPhone(auth, normalized);
  if (!rowIndex) return { rowIndex: null, phone: normalized, headers: INTEGRATED_HEADERS, row: null };
  const rows = await readSheet(auth, LINE_STORE_SS_ID, `'客人消費狀態'!A${rowIndex}:S${rowIndex}`);
  const row = rows?.[0] || null;
  return { rowIndex, phone: normalized, headers: INTEGRATED_HEADERS, row };
}

