import crypto from 'crypto';

const EVENT_DEDUP_TTL_MS = 60 * 1000; // 60 秒，與 GAS 重複攔截一致，避免 LINE 重試時重複處理
const eventIdCache = new Map(); // eventId -> expiryTime (Date.now() + TTL)

function pruneExpiredEventIds(now = Date.now()) {
  for (const [id, exp] of eventIdCache.entries()) {
    if (exp <= now) eventIdCache.delete(id);
  }
}

/**
 * 檢查是否為重複事件（同一 webhookEventId 在 TTL 內已處理過）。
 * 若未見過則記錄並回傳 false；若已見過則回傳 true（應跳過處理）。
 * @param {string} [eventId] - event.webhookEventId
 * @returns {boolean} true = 重複，應跳過；false = 首次，可處理
 */
export function isDuplicateLineEvent(eventId) {
  if (!eventId || typeof eventId !== 'string') return false;
  const now = Date.now();
  pruneExpiredEventIds(now);
  if (eventIdCache.has(eventId)) return true;
  eventIdCache.set(eventId, now + EVENT_DEDUP_TTL_MS);
  return false;
}

/**
 * 驗證 LINE Webhook 的 X-Line-Signature
 * @param {string|Buffer} rawBody - 原始 request body（未經 JSON 解析）
 * @param {string} signature - X-Line-Signature header 值
 * @param {string} channelSecret - LINE Channel Secret
 * @returns {boolean}
 */
export function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!rawBody || !signature || !channelSecret) return false;
  try {
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    const expected = crypto.createHmac('sha256', channelSecret).update(body).digest('base64');
    const sigBuf = Buffer.from(signature, 'base64');
    const expBuf = Buffer.from(expected, 'base64');
    return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}
