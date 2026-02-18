import crypto from 'crypto';

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecodeToBuffer(s) {
  const b64 = String(s || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(String(s || '').length / 4) * 4, '=');
  return Buffer.from(b64, 'base64');
}

function safeEqual(a, b) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function normalizePhone9(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 9 && digits[0] === '9') return `0${digits}`;
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

export function createCustomerInfoToken({ phone, expMs, userId }) {
  const secret = String(process.env.CUSTOMER_TOKEN_SECRET || '').trim();
  if (!secret) throw new Error('CUSTOMER_TOKEN_SECRET is required');
  const p = normalizePhone9(phone);
  if (!p || p.length < 9) throw new Error('invalid phone');
  const exp = Number(expMs);
  if (!Number.isFinite(exp) || exp <= Date.now()) throw new Error('invalid expMs');

  const payload = { phone: p, exp };
  const uid = String(userId || '').trim();
  if (uid) payload.userId = uid;
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  const sigB64 = base64UrlEncode(sig);
  return `${payloadB64}.${sigB64}`;
}

export function verifyCustomerInfoToken(token) {
  const secret = String(process.env.CUSTOMER_TOKEN_SECRET || '').trim();
  if (!secret) return { ok: false, reason: 'missing_secret' };
  const t = String(token || '').trim();
  const parts = t.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'bad_format' };
  const payloadB64 = parts[0];
  const sigB64 = parts[1];

  const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  const expectedSigB64 = base64UrlEncode(expectedSig);
  if (!safeEqual(Buffer.from(expectedSigB64, 'utf8'), Buffer.from(sigB64, 'utf8'))) {
    return { ok: false, reason: 'bad_sig' };
  }

  let payload = null;
  try {
    payload = JSON.parse(base64UrlDecodeToBuffer(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  const phone = normalizePhone9(payload?.phone || '');
  const exp = Number(payload?.exp);
  if (!phone || phone.length < 9) return { ok: false, reason: 'bad_phone' };
  if (!Number.isFinite(exp)) return { ok: false, reason: 'bad_exp' };
  if (Date.now() > exp) return { ok: false, reason: 'expired' };
  return { ok: true, phone, userId: String(payload?.userId || '').trim() };
}

