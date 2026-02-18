import fetch from 'node-fetch';
import { getBearerToken } from './saydou.js';

function normalizePhone9(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 9 && digits[0] === '9') return `0${digits}`;
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

async function saydouFetchJson(url, token) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) throw new Error(`SayDou HTTP ${res.status}: ${(text || '').slice(0, 200)}`);
  return json;
}

export async function getMemApi(auth, phone) {
  const keyword = normalizePhone9(phone);
  if (!keyword) return null;
  const token = await getBearerToken(auth);
  const url =
    'https://saywebdatafeed.saydou.com/api/management/unearn/memberStorecash' +
    '?page=0&limit=20&sort=stcash&order=desc' +
    `&keyword=${encodeURIComponent(keyword)}` +
    '&showGroup=0&tabIndex=0';
  const json = await saydouFetchJson(url, token);
  const items = json?.data?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  return items[0] || null;
}

export async function fetchTransactionsByMembidPage(auth, membid, page, limit) {
  const token = await getBearerToken(auth);
  const url =
    'https://saywebdatafeed.saydou.com/api/management/finance/transaction' +
    `?page=${encodeURIComponent(page)}` +
    `&limit=${encodeURIComponent(limit)}` +
    '&sort=ordrsn&order=desc&keyword=&searchMemberCtrl=null&searchProductCtrl=null&searchStaffCtrl=null' +
    `&membid=${encodeURIComponent(membid)}` +
    '&godsid=0&usrsid=0&memnam=&godnam=&usrnam=&assign=all&licnum=&goctString=';
  const json = await saydouFetchJson(url, token);
  const ok = json?.status === true || json?.status === 'success' || json?.status === 1;
  if (!ok || !json?.data) return { items: [], total: 0 };
  return { items: Array.isArray(json.data.items) ? json.data.items : [], total: Number(json.data.total || 0) || 0 };
}

export async function getAllTransactionsByMembid(auth, membid, pageSize = 20, maxPages = 10) {
  if (!membid) return [];
  const all = [];
  let page = 0;
  while (page < maxPages) {
    const res = await fetchTransactionsByMembidPage(auth, membid, page, pageSize);
    if (Array.isArray(res.items) && res.items.length) all.push(...res.items);
    if (!Array.isArray(res.items) || res.items.length < pageSize) break;
    page += 1;
  }
  return all;
}

async function fetchStorecashPage(auth, { type, membid, page, limit }) {
  const token = await getBearerToken(auth);
  if (type === 'use') {
    const url =
      'https://saywebdatafeed.saydou.com/api/management/unearn/storecashUseRecord' +
      `?page=${encodeURIComponent(page)}` +
      `&limit=${encodeURIComponent(limit)}` +
      '&sort=rectim&order=desc&keyword=&type=0&tabIndex=2' +
      `&membid=${encodeURIComponent(membid)}`;
    const json = await saydouFetchJson(url, token);
    const ok = json?.status === true || json?.status === 'success' || json?.status === 1;
    if (!ok || !json?.data) return { items: [], total: 0 };
    return { items: Array.isArray(json.data.items) ? json.data.items : [], total: Number(json.data.total || 0) || 0 };
  }

  const url =
    'https://saywebdatafeed.saydou.com/api/management/unearn/storecashAddRecord' +
    `?page=${encodeURIComponent(page)}` +
    `&limit=${encodeURIComponent(limit)}` +
    '&sort=rectim&order=desc&keyword=&type=0&tabIndex=1' +
    `&membid=${encodeURIComponent(membid)}`;
  const json = await saydouFetchJson(url, token);
  const ok = json?.status === true || json?.status === 'success' || json?.status === 1;
  if (!ok || !json?.data) return { items: [], total: 0 };
  return { items: Array.isArray(json.data.items) ? json.data.items : [], total: Number(json.data.total || 0) || 0 };
}

async function fetchAllPages(fetchPage, { pageSize = 20, maxPages = 5 }) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(page, pageSize);
    if (Array.isArray(res.items) && res.items.length) out.push(...res.items);
    if (!Array.isArray(res.items) || res.items.length < pageSize) break;
  }
  return out;
}

export async function getAllStorecashUseRecordByMembid(auth, membid, pageSize = 20) {
  if (!membid) return [];
  return await fetchAllPages((page, limit) => fetchStorecashPage(auth, { type: 'use', membid, page, limit }), { pageSize, maxPages: 5 });
}

export async function getAllStorecashAddRecordByMembid(auth, membid, pageSize = 20) {
  if (!membid) return [];
  return await fetchAllPages((page, limit) => fetchStorecashPage(auth, { type: 'add', membid, page, limit }), { pageSize, maxPages: 5 });
}

export async function getReservationRecordByMembid(auth, membid) {
  if (!membid) return [];
  const token = await getBearerToken(auth);
  const url =
    'https://saywebdatafeed.saydou.com/api/management/calendar/reservation/record/saydou/' +
    `${encodeURIComponent(membid)}/${encodeURIComponent(membid)}` +
    '?page=0&limit=20&sort=rsvtim&order=desc';
  const json = await saydouFetchJson(url, token);
  const items = json?.data?.items;
  if (!Array.isArray(items) || items.length === 0) return [];
  const now = Date.now();
  const out = [];
  for (const r of items) {
    if (r?.memcel === 'Y') continue;
    const rsvtim = r?.rsvtim ? String(r.rsvtim) : '';
    if (!rsvtim) continue;
    const ms = new Date(rsvtim).getTime();
    if (!Number.isFinite(ms) || ms < now) continue;
    const stonam = (r?.stor?.stonam != null) ? String(r.stor.stonam) : '';
    const txtser = (r?.txtser != null) ? String(r.txtser) : (r?.services != null ? String(r.services) : '');
    out.push({ rsvtim, stonam, txtser });
  }
  return out;
}

