import { getAuth } from '../lib/auth.js';
import { appendWebhookError } from '../lib/webhook-error-log.js';
import { getLineSayDouInfoMap } from '../api/core-api.js';
import { getTomorrowReservationsOnly } from '../api/stores-api.js';
import { refreshCustomerByPhone } from '../lib/customer-profile.js';

function normalizePhone9(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 9 && digits[0] === '9') return `0${digits}`;
  if (digits.length >= 10) return digits.slice(-10);
  return '';
}

function pLimit(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max) return;
    const job = queue.shift();
    if (!job) return;
    active += 1;
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

export async function run() {
  const auth = await getAuth();
  const requestId = `refresh-tomorrow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  console.log(`[refreshCustomersByTomorrowReservations][${requestId}] start`);

  try {
    const storeMap = await getLineSayDouInfoMap(auth);
    const storeIds = Object.values(storeMap || [])
      .map((s) => String(s?.saydouId || '').trim())
      .filter((id) => id && id !== '0001');

    if (!storeIds.length) {
      console.log(`[refreshCustomersByTomorrowReservations][${requestId}] no stores`);
      return { ok: true, stores: 0, phones: 0, refreshed: 0, errors: 0 };
    }

    const list = await getTomorrowReservationsOnly(auth, storeIds);
    const byStore = Array.isArray(list?.byStore) ? list.byStore : [];

    const set = new Set();
    for (const b of byStore) {
      const items = Array.isArray(b?.items) ? b.items : [];
      for (const it of items) {
        const p = normalizePhone9(it?.phone || '');
        if (p) set.add(p);
      }
    }
    const phones = [...set.values()];
    console.log(`[refreshCustomersByTomorrowReservations][${requestId}] tomorrow=${list?.dateStr || '-'} stores=${byStore.length} phones=${phones.length}`);

    const limit = pLimit(Number(process.env.REFRESH_CUSTOMER_CONCURRENCY || 3));
    let refreshed = 0;
    let errors = 0;
    await Promise.all(
      phones.map((phone) =>
        limit(async () => {
          try {
            await refreshCustomerByPhone(auth, phone, { leaveEmployeeEmpty: true });
            refreshed += 1;
          } catch (e) {
            errors += 1;
            const msg = e?.stack ? String(e.stack) : String(e?.message || e);
            console.warn(`[refreshCustomersByTomorrowReservations][${requestId}] phone=${phone} error:`, e?.message || e);
            await appendWebhookError(auth, 'refreshCustomersByTomorrowReservations', msg.slice(0, 45000), `requestId=${requestId} phone=${phone}`);
          }
        }),
      ),
    );

    const elapsedMs = Date.now() - startedAt;
    console.log(`[refreshCustomersByTomorrowReservations][${requestId}] done refreshed=${refreshed} errors=${errors} elapsedMs=${elapsedMs}`);
    return { ok: true, requestId, dateStr: list?.dateStr || '', phones: phones.length, refreshed, errors, elapsedMs };
  } catch (e) {
    const msg = e?.stack ? String(e.stack) : String(e?.message || e);
    await appendWebhookError(auth, 'refreshCustomersByTomorrowReservations', msg.slice(0, 45000), `requestId=${requestId}`);
    throw e;
  }
}

