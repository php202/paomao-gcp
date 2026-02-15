import crypto from 'crypto';

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
