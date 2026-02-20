/**
 * Giveme 電子發票開單 API（篡改猴／門市開立發票用）
 * 供 Tampermonkey（Saydou 結帳同步）或測試端 POST 呼叫。
 * 依 order.storid 從試算表「店家基本資料」M/N 欄取憑證；找不到則 fallback 環境變數。
 * 架構：直連 Giveme 時強制 IPv4（與 VM 中繼一致），避免 Cloud Run 走 IPv6 導致連線慢／逾時。
 * 若仍逾時可改設 GIVEME_PROXY_URL 指向 VM 中繼（見 invoice-proxy/）。
 */

import crypto from 'crypto';
import https from 'node:https';
import fetch from 'node-fetch';
import { getAuth } from '../lib/auth.js';
import { readSheet } from '../lib/sheets.js';

// 與 VM 中繼一致：強制 IPv4 連線，避免 Cloud Run 走 IPv6 導致 Giveme 連線慢或逾時
const GIVEME_HTTPS_AGENT = new https.Agent({ family: 4 });

const LINE_STORE_SS_ID = (process.env.LINE_STORE_SS_ID || process.env.INTEGRATED_SHEET_SS_ID || '').trim();
const GIVEME_PROXY_URL = (process.env.GIVEME_PROXY_URL || '').trim();
const GIVEME_PICTURE_PROXY_URL = (process.env.GIVEME_PICTURE_PROXY_URL || '').trim();
const GIVEME_UNCODE = (process.env.GIVEME_UNCODE || '').trim();
const GIVEME_IDNO = (process.env.GIVEME_IDNO || '').trim();
const GIVEME_PASSWORD = (process.env.GIVEME_PASSWORD || '').trim();

const CRED_CACHE_TTL_MS = 5 * 60 * 1000;
let credCache = { storid: null, cred: null, expiresAt: 0 };

const GIVEME_B2C_URL = 'https://www.giveme.com.tw/invoice.do?action=addB2C';
const GIVEME_B2B_URL = 'https://www.giveme.com.tw/invoice.do?action=addB2B';
const GIVEME_PICTURE_URL = 'https://www.giveme.com.tw/invoice.do?action=picture';

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
 * 依 uncode（統一編號）從試算表找該店 Giveme 憑證（用於列印時查詢）
 */
async function getCredentialByUncode(auth, uncode) {
  if (!LINE_STORE_SS_ID || !uncode) return null;
  const needle = String(uncode).trim();
  const rows = await readSheet(auth, LINE_STORE_SS_ID, "'店家基本資料'!A:N");
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (String(row[13] ?? '').trim() !== needle) continue;
    const mCell = String(row[12] ?? '').trim();
    if (!mCell) continue;
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
    if (idno && password) return { uncode: needle, idno, password };
  }
  if (GIVEME_UNCODE === needle && GIVEME_IDNO && GIVEME_PASSWORD) {
    return { uncode: GIVEME_UNCODE, idno: GIVEME_IDNO, password: GIVEME_PASSWORD };
  }
  return null;
}

/**
 * 發票備註（總備註）：避開「測試」等無意義字樣，優先用品項名稱或訂單編號
 */
function getInvoiceContent(order) {
  const remark = (order?.remark && String(order.remark).trim()) || '';
  const skipRemark = /^(測試|test)$/i.test(remark);
  if (remark && !skipRemark) return remark.slice(0, 200);
  const ordds = Array.isArray(order?.ordds) ? order.ordds : [];
  const firstName = ordds[0] && (ordds[0].godnam || ordds[0].name);
  if (firstName && String(firstName).trim()) return sanitizeName(firstName).slice(0, 200);
  const ordNo = String(order?.ordrsn || order?.ordcid || '').trim();
  if (ordNo) return `Saydou ${ordNo}`.slice(0, 200);
  return 'Saydou 結帳';
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
  const content = getInvoiceContent(order);

  const payload = {
    timeStamp,
    uncode: cred.uncode,
    idno: cred.idno,
    sign,
    customerName: String(order?.memnam ?? '').trim() || undefined,
    datetime,
    state: '0',
    totalFee: String(totalFee),
    content,
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
  const content = getInvoiceContent(order);
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
    content,
    items: JSON.stringify(items),
  };
}

/**
 * GET /giveme-invoice/check?storid=門市代號
 * 回傳 { configured: true|false }，供前端決定是否顯示開立發票視窗。
 */
export async function handleGivemeInvoiceCheck(req, res) {
  const u = new URL(req.url || '', 'http://localhost');
  const storid = (u.searchParams.get('storid') || '').trim();
  let configured = false;
  if (LINE_STORE_SS_ID && storid) {
    try {
      const auth = await getAuth();
      const cred = await getCredentialByStorid(auth, storid);
      if (cred) configured = true;
    } catch {
      // configured 維持 false
    }
  }
  if (!configured && GIVEME_UNCODE && GIVEME_IDNO && GIVEME_PASSWORD) {
    configured = true;
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ configured }));
}

/** 將 AbortSignal/網路錯誤轉成給前端的友善說明 */
function toUserFriendlyMsg(err) {
  const m = String(err?.message || err || '');
  if (/aborted|timeout|ETIMEDOUT|ECONNRESET/i.test(m)) {
    return 'Giveme 回應逾時，請稍後再試或至 Giveme 查詢發票。';
  }
  return m || 'Giveme 請求失敗';
}

export async function handleGivemeInvoice(req, res, { rawBody }) {
  const reqId = `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    console.warn('[giveme-invoice]', reqId, 'Invalid JSON body');
    send(res, 400, { success: false, msg: 'Invalid JSON body' });
    return;
  }

  const order = body?.order ?? body;
  const options = body?.options ?? {};
  const type = String(options.type ?? 'B2C').toUpperCase();
  const storid = order?.storid != null ? String(order.storid).trim() : '';
  const totalFee = getTotalFromOrder(order);
  const ordrsn = order?.ordrsn || order?.ordcid || '';

  console.log('[giveme-invoice]', reqId, 'start', { storid, type, totalFee, ordrsn: String(ordrsn).slice(0, 30) });

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
  if (LINE_STORE_SS_ID && storid) {
    try {
      const auth = await getAuth();
      cred = await getCredentialByStorid(auth, storid);
    } catch (e) {
      console.warn('[giveme-invoice]', reqId, 'getCredentialByStorid failed:', e?.message || e);
    }
  }
  if (!cred && GIVEME_UNCODE && GIVEME_IDNO && GIVEME_PASSWORD) {
    cred = { uncode: GIVEME_UNCODE, idno: GIVEME_IDNO, password: GIVEME_PASSWORD };
  }
  if (!cred) {
    console.warn('[giveme-invoice]', reqId, 'no cred');
    send(res, 503, { success: false, msg: 'Giveme 設定未完成（試算表 M/N 欄或環境變數 GIVEME_UNCODE/IDNO/PASSWORD）' });
    return;
  }

  const OPEN_TIMEOUT_MS = 40000;
  const PICTURE_TIMEOUT_MS = 10000;

  const postToGiveme = async (url, payload) => {
    const t0 = Date.now();
    const useIPv4 = url && String(url).includes('giveme.com.tw');
    if (useIPv4) console.log('[giveme-invoice]', reqId, 'postToGiveme 使用 IPv4 連線');
    try {
      const resG = await fetch(url, {
        method: 'post',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
        ...(useIPv4 && { agent: GIVEME_HTTPS_AGENT }),
      });
      const text = await resG.text();
      console.log('[giveme-invoice]', reqId, 'postToGiveme', resG.status, `${Date.now() - t0}ms`);
      try {
        return JSON.parse(text);
      } catch {
        return { success: false, msg: text.slice(0, 300) };
      }
    } catch (e) {
      console.warn('[giveme-invoice]', reqId, 'postToGiveme error', e?.message || e, `${Date.now() - t0}ms`);
      throw e;
    }
  };

  const buildPrintUrl = (code, uncode) => {
    const proto = (req.headers['x-forwarded-proto'] || req.headers['x-forwarded-protocol'] || 'https').split(',')[0].trim();
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (!host) return '';
    const path = '/giveme-invoice-print?code=' + encodeURIComponent(code) + '&uncode=' + encodeURIComponent(uncode);
    return proto + '://' + host + path;
  };

  const GIVEME_SEARCH_BASE = 'https://www.giveme.com.tw/168.do';
  const buildSearchInvoiceUrl = (id) => (id ? `${GIVEME_SEARCH_BASE}?action=searchInvoice&id=${encodeURIComponent(String(id).trim())}` : '');

  try {
    if (type === 'B2B') {
      const payload = buildB2BBody(order, options, cred);
      const targetUrl = GIVEME_PROXY_URL || GIVEME_B2B_URL;
      const json = await postToGiveme(targetUrl, payload);
      const ok = json && (json.success === true || String(json.success).toLowerCase() === 'true');
      if (ok) {
        json.uncode = cred.uncode;
        if (json.id) json.searchInvoiceUrl = buildSearchInvoiceUrl(json.id);
        if (json.code) {
          json.printUrl = buildPrintUrl(json.code, cred.uncode);
          try {
            const pic = await fetchInvoicePicture(cred, json.code, '1');
            if (pic.ok) {
              json.printImageBase64 = pic.base64;
              json.printImageContentType = pic.contentType;
            } else {
              console.warn('[giveme-invoice]', reqId, 'fetchInvoicePicture 失敗:', pic.reason);
            }
          } catch (e) {
            console.warn('[giveme-invoice]', reqId, 'fetchInvoicePicture:', e?.message || e);
          }
        }
      }
      console.log('[giveme-invoice]', reqId, 'done B2B', { ok: !!ok, code: json?.code });
      send(res, 200, json);
      return;
    }

    const payload = buildB2CBody(order, options, cred);
    const targetUrl = GIVEME_PROXY_URL || GIVEME_B2C_URL;
    const json = await postToGiveme(targetUrl, payload);
    const ok = json && (json.success === true || String(json.success).toLowerCase() === 'true');
    if (ok) {
      json.uncode = cred.uncode;
      if (json.id) json.searchInvoiceUrl = buildSearchInvoiceUrl(json.id);
      if (json.code) {
        json.printUrl = buildPrintUrl(json.code, cred.uncode);
        try {
          const pic = await fetchInvoicePicture(cred, json.code, '1');
          if (pic.ok) {
            json.printImageBase64 = pic.base64;
            json.printImageContentType = pic.contentType;
          } else {
            console.warn('[giveme-invoice]', reqId, 'fetchInvoicePicture 失敗:', pic.reason);
          }
        } catch (e) {
          console.warn('[giveme-invoice]', reqId, 'fetchInvoicePicture:', e?.message || e);
        }
      }
    }
    console.log('[giveme-invoice]', reqId, 'done B2C', { ok: !!ok, code: json?.code });
    send(res, 200, json);
  } catch (e) {
    const rawMsg = e?.message || String(e);
    const userMsg = toUserFriendlyMsg(e);
    console.error('[giveme-invoice]', reqId, 'error', rawMsg);
    send(res, 500, { success: false, msg: userMsg });
  }
}

/**
 * 向 Giveme 取得發票圖片，回傳 { ok, base64, contentType } 或 { ok: false, reason? }
 * 僅在回應為實際圖片（或 PDF）時回傳 ok: true，否則回傳 reason 供除錯。
 */
async function fetchInvoicePicture(cred, code, typeNum = '1') {
  const timeStamp = String(Date.now());
  // 發票圖 API 簽名需含資源：timeStamp + idno + password + code + type（依 Giveme 驗證規則）
  const signStr = timeStamp + cred.idno + cred.password + String(code) + String(typeNum);
  const sign = md5Upper(signStr);
  const body = {
    timeStamp,
    uncode: cred.uncode,
    idno: cred.idno,
    sign,
    code,
    type: typeNum,
  };
  const pictureUrl = GIVEME_PICTURE_PROXY_URL || GIVEME_PICTURE_URL;
  const useIPv4 = pictureUrl && String(pictureUrl).includes('giveme.com.tw');
  let response;
  try {
    response = await fetch(pictureUrl, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      ...(useIPv4 && { agent: GIVEME_HTTPS_AGENT }),
    });
  } catch (e) {
    const reason = e?.message || '連線 Giveme 失敗';
    if (/aborted|timeout/i.test(reason)) {
      console.warn('[giveme-invoice] fetchInvoicePicture timeout/aborted', code, reason);
    }
    return { ok: false, reason };
  }
  const rawContentType = (response.headers.get('content-type') || '').toLowerCase();
  const buf = await response.arrayBuffer();
  const bodyPreview = (() => {
    const s = Buffer.from(buf).toString('utf8').slice(0, 200);
    return s.replace(/\s+/g, ' ').trim();
  })();
  if (response.status !== 200) {
    return { ok: false, reason: `Giveme 回傳 ${response.status}${bodyPreview ? ': ' + bodyPreview : ''}` };
  }
  if (buf.byteLength === 0) {
    return { ok: false, reason: 'Giveme 回傳空內容' };
  }
  // 只接受實際的圖片或 PDF，避免把錯誤頁（JSON/HTML）當成圖
  if (!rawContentType.includes('image/') && !rawContentType.includes('application/pdf')) {
    return { ok: false, reason: bodyPreview ? `Giveme 非圖片回應: ${bodyPreview}` : `Content-Type: ${rawContentType || '(無)'}` };
  }
  const contentType = rawContentType.split(';')[0].trim() || 'image/png';
  const base64 = Buffer.from(buf).toString('base64');
  return { ok: true, base64, contentType };
}

/**
 * GET /giveme-invoice-print?code=發票號碼&uncode=統一編號&type=1|2|3
 * 取得 Giveme 發票圖片（1=證明聯+明細 2=證明聯 3=明細），回傳 image 供瀏覽器列印。
 */
export async function handleGivemeInvoicePrint(req, res) {
  const u = new URL(req.url || '', 'http://localhost');
  const code = (u.searchParams.get('code') || '').trim();
  const uncode = (u.searchParams.get('uncode') || '').trim();
  const type = (u.searchParams.get('type') || '1').trim();
  if (!code || !uncode) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, msg: '需要 code 與 uncode 參數' }));
    return;
  }
  const typeNum = ['1', '2', '3'].includes(type) ? type : '1';
  let auth;
  try {
    auth = await getAuth();
  } catch (e) {
    console.error('[giveme-invoice-print] getAuth:', e?.message || e);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, msg: '無法取得憑證' }));
    return;
  }
  const cred = await getCredentialByUncode(auth, uncode);
  if (!cred) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, msg: '找不到該統一編號的 Giveme 憑證' }));
    return;
  }
  try {
    const pic = await fetchInvoicePicture(cred, code, typeNum);
    if (!pic.ok) {
      const msg = pic.reason ? `取得發票圖片失敗: ${pic.reason}` : '取得發票圖片失敗';
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: false, msg }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': pic.contentType,
      'Content-Length': Buffer.byteLength(Buffer.from(pic.base64, 'base64')),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(Buffer.from(pic.base64, 'base64'));
  } catch (e) {
    console.error('[giveme-invoice-print]', e?.message || e);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, msg: e?.message || '取得發票圖片失敗' }));
  }
}
