/**
 * IG Messaging Webhook — 處理 Story 回覆，自動 DM 預約連結
 * 
 * 流程：粉絲回覆 Story (+1/預約) → 查 story_stats 找對應店家 → DM 預約連結 + LINE
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || '/Users/paopaomao';

const VERIFY_TOKEN = (() => {
  try { return fs.readFileSync(path.join(HOME, '.openclaw/secrets/ig-webhook-verify-token.txt'), 'utf8').trim(); }
  catch { return ''; }
})();

const APP_SECRET = (() => {
  try { return fs.readFileSync(path.join(HOME, '.openclaw/secrets/meta-app-secret.txt'), 'utf8').trim(); }
  catch { return ''; }
})();

/** 讀 Meta token（每次讀檔，支援 token refresh 不用重啟） */
function getMetaToken() {
  try { return fs.readFileSync(path.join(HOME, '.openclaw/secrets/meta-token.txt'), 'utf8').trim(); }
  catch { return ''; }
}

/** 驗證 Meta X-Hub-Signature-256 */
function verifyMetaSignature(rawBody, signature) {
  if (!APP_SECRET || !signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

const IG_USER_ID = '17841463367279845';
const BOOKING_BASE = 'https://book.paopaomao.tw';

// DB pool (lazy, with error handler)
let pool;
function getPool() {
  if (!pool) {
    pool = new pg.Pool({ database: 'paomao', user: 'paopaomao', max: 3 });
    pool.on('error', (err) => console.error('[ig-webhook] Pool idle client error:', err.message));
  }
  return pool;
}

// 觸發關鍵字
const TRIGGER_KEYWORDS = ['+1', '預約', '我要預約', '想預約', 'book', '報名'];

/**
 * GET /ig-webhook — Meta webhook verification
 */
export function handleIgWebhookVerify(url, res) {
  const params = new URL(url, 'http://localhost').searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[ig-webhook] ✅ Verification OK');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(challenge);
  } else {
    console.warn('[ig-webhook] ❌ Verification failed');
    res.writeHead(403);
    res.end('Forbidden');
  }
}

// Replay protection: 記住最近處理過的 sender+story 組合（最多 500 筆，10 分鐘過期）
const _recentDMs = new Map();
function isDuplicate(senderId, storyId) {
  const key = `${senderId}:${storyId}`;
  const now = Date.now();
  if (_recentDMs.has(key) && now - _recentDMs.get(key) < 600_000) return true;
  _recentDMs.set(key, now);
  // 清理過期的
  if (_recentDMs.size > 500) {
    for (const [k, t] of _recentDMs) {
      if (now - t > 600_000) _recentDMs.delete(k);
    }
  }
  return false;
}

/**
 * POST /ig-webhook — 接收 IG messaging events
 * @param {string|Buffer} rawBody - 原始 request body
 * @param {string} signature - X-Hub-Signature-256 header
 * @param {object} res - HTTP response
 */
export async function handleIgWebhookEvent(rawBody, signature, res) {
  // 驗證 Meta webhook 簽名
  if (!verifyMetaSignature(rawBody, signature)) {
    console.warn('[ig-webhook] ❌ Signature verification failed');
    res.writeHead(403);
    res.end('Invalid signature');
    return;
  }

  // 立即回 200（Meta 要求 5 秒內回應）
  res.writeHead(200);
  res.end('EVENT_RECEIVED');

  try {
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const data = JSON.parse(body);
    const entries = data.entry || [];

    for (const entry of entries) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        await processMessage(event);
      }
    }
  } catch (e) {
    console.error('[ig-webhook] Error processing event:', e.message);
  }
}

async function processMessage(event) {
  const senderId = event.sender?.id;
  const message = event.message;

  if (!senderId || !message) return;

  // 只處理 Story 回覆
  const storyReply = message.reply_to?.story;
  if (!storyReply) {
    console.log(`[ig-webhook] Non-story message from ${senderId}, skipping`);
    return;
  }

  const storyId = storyReply.id;
  const text = (message.text || '').trim();

  console.log(`[ig-webhook] Story reply: sender=${senderId} storyId=${storyId} text="${text}"`);

  // Replay protection: 同一個 sender+story 10 分鐘內不重複發 DM
  if (isDuplicate(senderId, storyId)) {
    console.log(`[ig-webhook] Duplicate DM skipped: ${senderId}:${storyId}`);
    return;
  }

  // 檢查關鍵字
  const isTriggered = TRIGGER_KEYWORDS.some(kw => text.toLowerCase().includes(kw.toLowerCase()));
  if (!isTriggered) {
    console.log(`[ig-webhook] No trigger keyword in "${text}", skipping`);
    return;
  }

  // 查 story_stats 找對應店家
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT ss.store_name, s.line_oa_url, s.address, s.phone, s.google_map_url
       FROM story_stats ss
       LEFT JOIN stores s ON s.store_name = ss.store_name
       WHERE ss.ig_media_id = $1
       LIMIT 1`,
      [storyId]
    );

    if (!rows.length) {
      console.log(`[ig-webhook] Story ${storyId} not found in story_stats, trying fuzzy...`);
      // 可能 media_id 格式不同，跳過
      await sendFallbackDM(senderId);
      return;
    }

    const store = rows[0];
    const shortName = store.store_name.replace('泡泡貓｜', '').replace('SOGO(4F)', '');
    
    await sendStoreDM(senderId, shortName, store);
    console.log(`[ig-webhook] ✅ DM sent to ${senderId} for ${store.store_name}`);

  } catch (e) {
    console.error(`[ig-webhook] DB/DM error:`, e.message);
    await sendFallbackDM(senderId);
  }
}

/**
 * 發送店家專屬 DM
 */
async function sendStoreDM(recipientId, shortName, store) {
  const bookingUrl = `${BOOKING_BASE}/s/${encodeURIComponent(shortName)}?code=IG_STORY`;
  const lineUrl = store.line_oa_url || '';

  let text = `哈囉！收到你的 +1 囉 ✨\n`;
  text += `幫你準備好專屬的預約連結了，趕快點進來卡位，讓我們幫你把肌膚顧得水噹噹 👇\n`;
  text += `👉 ${bookingUrl}\n\n`;
  text += `有任何問題都可以直接在這裡留言問我喔！期待見到你 🥰\n\n`;
  if (lineUrl) {
    text += `如有問題，可以到我們的 LINE@ 官方詢問\n👉 ${lineUrl}`;
  }

  await sendIGMessage(recipientId, text);
}

/**
 * 找不到店家時的 fallback DM
 */
async function sendFallbackDM(recipientId) {
  const text = `哈囉！收到你的 +1 囉 ✨\n` +
    `幫你準備好專屬的預約連結了，趕快點進來卡位，讓我們幫你把肌膚顧得水噹噹 👇\n` +
    `👉 ${BOOKING_BASE}/near?code=IG_STORY\n\n` +
    `有任何問題都可以直接在這裡留言問我喔！期待見到你 🥰\n\n` +
    `如有問題，可以到我們的 LINE@ 官方詢問\n👉 https://linktr.ee/paopaomao`;
  
  await sendIGMessage(recipientId, text);
}

/**
 * 透過 IG Send API 發 DM
 */
async function sendIGMessage(recipientId, text) {
  const url = `https://graph.facebook.com/v21.0/${IG_USER_ID}/messages`;
  const token = getMetaToken();
  if (!token) { console.error('[ig-webhook] META_TOKEN is empty'); return { error: { message: 'No token' } }; }
  
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text }
    })
  });

  const result = await resp.json();
  if (result.error) {
    console.error(`[ig-webhook] Send DM error:`, result.error.message);
  }
  return result;
}
