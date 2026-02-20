/**
 * Giveme 電子發票開單 API（GCP 直連，IP 白名單已開在 GCP）
 * 供 Tampermonkey（Saydou 結帳同步）或測試端 POST 呼叫。
 * 依 order.storid 從試算表「店家基本資料」M 欄（帳號密碼）、N 欄（統一編號）讀取憑證；找不到則用環境變數。
 */

import crypto from 'crypto';
import fetch from 'node-fetch';
import { getAuth } from '../lib/auth.js';
import { readSheet } from '../lib/sheets.js';

const LINE_STORE_SS_ID = (process.env.LINE_STORE_SS_ID || process.env.INTEGRATED_SHEET_SS_ID || '').trim();
const GIVEME_UNCODE = (process.env.GIVEME_UNCODE || '').trim();
const GIVEME_IDNO = (process.env.GIVEME_IDNO || '').trim();
const GIVEME_PASSWORD = (process.env.GIVEME_PASSWORD || '').trim();

const CRED_CACHE_TTL_MS = 5 * 60 * 1000;
let credCache = { storid: null, cred: null, expiresAt: 0 };

const GIVEME_B2C_URL = 'https://www.giveme.com.tw/invoice.do?action=addB2C';
const GIVEME_B2B_URL = 'https://www.giveme.com.tw/invoice.do?action=addB2B';

function md5Upper(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex').toUpperCase();
}

function send(res, statusCode, body) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(data);
}

/** 商品名稱勿含特殊符號（PDF 要求） */
function sanitizeName(s) {
  return String(s ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[^\d\w\u4e00-\u9fff\s\-\.]/g, '')
    .trim() || '商品';
}

/**
 * 從 Saydou order 組出 Giveme 用的 items
 * order.ordds[]: godnam, rprice, amount
 */
function buildItemsFromOrder(order) {
  const ordds = Array.isArray(order?.ordds) ? order.ordds : [];
  return ordds.map((row) => ({
    name: sanitizeName(row.godnam),
    money: Number(row.rprice ?? row.price_ ?? 0),
    number: Math.max(1, parseInt(row.amount ?? 1, 10)),
  })).filter((it) => it.name && (it.money > 0 || it.number > 0));
}

/**
 * 從 Saydou order 取總金額（整數）
 */
function getTotalFromOrder(order) {
  const total = Number(order?.rprice ?? order?.price_ ?? 0);
  return Math.max(0, Math.round(total));
}

/**
 * 發票日期 yyyy-MM-dd（依 order 或 今天）
 */
function getInvoiceDate(order) {
  const d = order?.date || order?.rectim;
  if (d && /^\d{4}-\d{2}-\d{2}/.test(String(d))) return String(d).slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/**
 * 從試算表「店家基本資料」依 storid 取 Giveme 憑證：F 欄=神美(storid)，M 欄=帳號密碼，N 欄=統一編號
 * M 欄可為 JSON {"idno","password"} 或 "idno,password" / "idno|password"
 */
async function getCredentialByStorid(auth, storid) {
  if (!LINE_STORE_SS_ID || !storid) return null;
  const now = Date.now();
  if (credCache.storid === String(storid).trim() && credCache.expiresAt > now) return credCache.cred;

  const rows = await readSheet(auth, LINE_STORE_SS_ID, "'店家基本資料'!A:N");
  const needle = String(storid).trim();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (String(row[5] ?? '').trim() !== needle) continue;
    const uncode = String(row[13] ?? '').trim();
    const mCell = String(row[12] ?? '').trim();
    if (!uncode || !mCell) continue;

    let idno = '';
    let password = '';
    try {
      const parsed = JSON.parse(mCell);
      if (parsed && typeof parsed.idno === 'string' && typeof parsed.password === 'string') {
        idno = parsed.idno.trim();
        password = parsed.password.trim();
      }
    } catch {
      const parts = mCell.split(/[,|]/).map((s) => s.trim());
      if (parts.length >= 2) {
        idno = parts[0];
        password = parts[1];
      }
    }
    if (!idno || !password) continue;

    const cred = { uncode, idno, password };
    credCache = { storid: needle, cred, expiresAt: now + CRED_CACHE_TTL_MS };
    return cred;
  }
  return null;
}

/**
 * 組 B2C 請求 body（不列印時需 phone 或 orderCode 其一）；cred = { uncode, idno, password }
 */
function buildB2CBody(order, options, cred) {
  const timeStamp = Date.now().toString();
  const sign = md5Upper(timeStamp + cred.idno + cred.password);
  const items = buildItemsFromOrder(order);
  const totalFee = getTotalFromOrder(order);
  const datetime = getInvoiceDate(order);
  const content = (order?.remark && String(order.remark).trim()) || `Saydou ${order?.ordrsn || order?.ordcid || ''}`.trim();

  const payload = {
    timeStamp,
    uncode: cred.uncode,
    idno: cred.idno,
    sign,
    customerName: String(order?.memnam ?? '').trim() || undefined,
    datetime,
    state: '0',
    totalFee: String(totalFee),
    content: content.slice(0, 200),
    items: JSON.stringify(items),
  };

  const phone = String(options?.phone ?? '').trim();
  const orderCode = String(options?.orderCode ?? '').trim();
  if (phone) payload.phone = phone;
  if (orderCode) payload.orderCode = orderCode;

  return payload;
}

/**
 * 組 B2B 請求 body（買方統編必填，列印紙本）；cred = { uncode, idno, password }
 */
function buildB2BBody(order, options, cred) {
  const timeStamp = Date.now().toString();
  const sign = md5Upper(timeStamp + cred.idno + cred.password);
  const items = buildItemsFromOrder(order);
  const totalAmount = getTotalFromOrder(order);
  const sales = Math.round(totalAmount / 1.05);
  const taxAmount = totalAmount - sales;
  const datetime = getInvoiceDate(order);
  const content = (order?.remark && String(order.remark).trim()) || `Saydou ${order?.ordrsn || order?.ordcid || ''}`.trim();
  const phone = String(options?.companyTaxId ?? options?.phone ?? '').trim();

  return {
    timeStamp,
    uncode: cred.uncode,
    idno: cred.idno,
    sign,
    customerName: String(order?.memnam ?? '').trim() || undefined,
    phone,
    datetime,
    taxState: '0',
    totalFee: String(totalAmount),
    amount: String(taxAmount),
    sales: String(sales),
    content: content.slice(0, 200),
    items: JSON.stringify(items),
  };
}

export async function handleGivemeInvoice(req, res, { rawBody }) {
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    send(res, 400, { success: false, msg: 'Invalid JSON body' });
    return;
  }

  const order = body?.order ?? body;
  const options = body?.options ?? {};
  const type = String(options.type ?? 'B2C').toUpperCase();

  const totalFee = getTotalFromOrder(order);
  if (totalFee < 1) {
    send(res, 400, { success: false, msg: '總金額需大於 0' });
    return;
  }

  const items = buildItemsFromOrder(order);
  if (!items.length) {
    send(res, 400, { success: false, msg: '訂單無有效明細' });
    return;
  }

  if (type === 'B2B') {
    const companyTaxId = String(options.companyTaxId ?? options.phone ?? '').trim();
    if (!companyTaxId) {
      send(res, 400, { success: false, msg: 'B2B 請提供 companyTaxId（買方統編）' });
      return;
    }
  }

  let cred = null;
  const storid = order?.storid != null ? String(order.storid).trim() : '';
  if (LINE_STORE_SS_ID && storid) {
    try {
      const auth = await getAuth();
      cred = await getCredentialByStorid(auth, storid);
    } catch (e) {
      console.warn('[giveme-invoice] getCredentialByStorid failed:', e?.message || e);
    }
  }
  if (!cred && GIVEME_UNCODE && GIVEME_IDNO && GIVEME_PASSWORD) {
    cred = { uncode: GIVEME_UNCODE, idno: GIVEME_IDNO, password: GIVEME_PASSWORD };
  }
  if (!cred) {
    send(res, 503, { success: false, msg: 'Giveme 設定未完成（試算表 M/N 欄或環境變數 GIVEME_UNCODE/IDNO/PASSWORD）' });
    return;
  }

  try {
    if (type === 'B2B') {
      const payload = buildB2BBody(order, options, cred);
      const resG = await fetch(GIVEME_B2B_URL, {
        method: 'post',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      const text = await resG.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { success: false, msg: text.slice(0, 300) };
      }
      send(res, 200, json);
      return;
    }

    const payload = buildB2CBody(order, options, cred);
    const resG = await fetch(GIVEME_B2C_URL, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    const text = await resG.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { success: false, msg: text.slice(0, 300) };
    }
    send(res, 200, json);
  } catch (e) {
    console.error('[giveme-invoice]', e?.message || e);
    send(res, 500, { success: false, msg: e?.message || 'Giveme 請求失敗' });
  }
}
