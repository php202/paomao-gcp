/**
 * GCP 備援 HTTP 服務：打卡 API、LINE Webhook（當 GAS urlfetch 額度用盡時可改用此服務）
 * 環境變數：LINE_CHANNEL_SECRET, LINE_STAFF_SS_ID, LINE_TOKEN_PAOSTAFF, CHECK_IN_LINK（可選）
 * 執行：node index.js serve
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { verifyLineSignature, isDuplicateLineEvent } from './lib/line-webhook.js';
import { getAuth } from './lib/auth.js';
import pool from './lib/db.js';
import { handleCheckInRequest, handleRegisterRequest } from './scripts/line-checkin-handler.js';
import { handleStaffCommand } from './scripts/line-staff-handler.js';
import { handleCore } from './api/core-api.js';
import { handleStores } from './api/stores-api.js';
import { handleStoreLineWebhook } from './api/store-line-webhook.js';
import { handlePaopaoWebhook } from './api/paopao-webhook.js';
import { handleAdmin } from './api/admin-api.js';
import { handleReportApi } from './api/report-api.js';
import { handleCustomerApi } from './api/customer-api.js';
import { handleSaydouTokenSync } from './api/saydou-token-sync.js';
import { handleGivemeInvoice, handleGivemeInvoiceCheck, handleGivemeInvoicePrint } from './api/giveme-invoice.js';
import { handleCheckinApi } from './scripts/checkin-api.js';
import { appendWebhookError } from './lib/webhook-error-log.js';
import { handleIgWebhookVerify, handleIgWebhookEvent } from './api/ig-webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_TOKEN_PAOSTAFF = process.env.LINE_TOKEN_PAOSTAFF;
const GAS_WEBHOOK_URL = process.env.GAS_WEBHOOK_URL;
const FORWARD_UNKNOWN_TO_GAS = String(process.env.FORWARD_UNKNOWN_TO_GAS || '0') === '1';
const PORT = Number(process.env.PORT) || 8080;
const WEBHOOK_LOG_VERBOSE = String(process.env.WEBHOOK_LOG_VERBOSE || '1') !== '0';

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, statusCode, body, contentType = 'application/json') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(data),
    'X-Checkin-Server': 'gcp-backup',
  });
  res.end(data);
}

async function handleLineWebhook(req, rawBody, res) {
  const requestId = `lwk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const signature = req.headers['x-line-signature'] || '';
  if (!LINE_CHANNEL_SECRET || !verifyLineSignature(rawBody, signature, LINE_CHANNEL_SECRET)) {
    console.warn(`[line-webhook][${requestId}] unauthorized signature`);
    send(res, 401, { status: 'unauthorized' });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    send(res, 200, { status: 'ok' });
    return;
  }
  const events = Array.isArray(payload?.events) ? payload.events : [];
  if (events.length === 0) {
    console.log(`[line-webhook][${requestId}] no events`);
    send(res, 200, { status: 'ok' });
    return;
  }
  const startedAt = Date.now();
  let localHandledCount = 0;
  let forwardedCount = 0;
  let forwardFailCount = 0;
  const auth = await getAuth();
  const forwardEvents = [];

  const eventMeta = (event) => ({
    type: event?.type || '',
    msgType: event?.message?.type || '',
    text: event?.message?.type === 'text' ? String(event?.message?.text || '').trim().slice(0, 80) : '',
    userId: event?.source?.userId || '',
    groupId: event?.source?.groupId || '',
    roomId: event?.source?.roomId || '',
  });

  async function replyFallback(replyToken, text) {
    if (!replyToken || !LINE_TOKEN_PAOSTAFF) return;
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'post',
      headers: {
        Authorization: `Bearer ${LINE_TOKEN_PAOSTAFF}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: 'text', text }],
      }),
    });
  }

  for (const event of events) {
    const eventId = event.webhookEventId;
    if (eventId && isDuplicateLineEvent(eventId)) {
      if (WEBHOOK_LOG_VERBOSE) {
        console.log(`[line-webhook][${requestId}] ♻️ 重複請求已攔截 eventId=${eventId}`);
      }
      continue;
    }
    const replyToken = event.replyToken;
    const meta = eventMeta(event);
    try {
      if (WEBHOOK_LOG_VERBOSE) {
        console.log(`[line-webhook][${requestId}] recv`, JSON.stringify(meta));
      }
      if (event.type === 'message' && event.message?.type === 'text') {
        const text = String(event.message.text || '').trim();
        const userId = event.source?.userId || '';
        if (text === '我要打卡') {
          console.log(`[line-webhook][${requestId}] local-handle:checkin user=${userId || '-'} `);
          await handleCheckInRequest(auth, replyToken, userId);
          localHandledCount += 1;
          continue;
        }
        if (text.includes('我要註冊')) {
          await handleRegisterRequest(auth, replyToken, userId, text);
          localHandledCount += 1;
          continue;
        }
        const handled = await handleStaffCommand({
          authClient: auth,
          text,
          event,
          replyText: async (msg) => replyFallback(replyToken, msg),
          replyMessages: async (messages) => {
            if (!replyToken || !LINE_TOKEN_PAOSTAFF) return;
            await fetch('https://api.line.me/v2/bot/message/reply', {
              method: 'post',
              headers: {
                Authorization: `Bearer ${LINE_TOKEN_PAOSTAFF}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ replyToken, messages }),
            });
          },
        });
        if (handled) {
          localHandledCount += 1;
          continue;
        }
      }
      if (FORWARD_UNKNOWN_TO_GAS) {
        if (WEBHOOK_LOG_VERBOSE) {
          console.log(`[line-webhook][${requestId}] queue-forward`, JSON.stringify(meta));
        }
        forwardEvents.push(event);
      } else {
        localHandledCount += 1;
      }
    } catch (err) {
      console.error('[line-webhook] event error:', err.message);
      await appendWebhookError(auth, 'line-webhook', err.message, `eventId=${event?.webhookEventId || '-'} userId=${meta?.userId?.slice(0, 12) || '-'} text=${(meta?.text || '').slice(0, 50)}`);
      try {
        await replyFallback(replyToken, '🚧 系統發生未預期的錯誤，請稍後再試或聯繫管理員。');
      } catch (e) {
        console.error('[line-webhook] reply error:', e.message);
        await appendWebhookError(auth, 'line-webhook', e.message, 'reply fallback');
      }
    }
  }

  if (forwardEvents.length > 0) {
    if (!GAS_WEBHOOK_URL) {
      console.warn(`[line-webhook][${requestId}] GAS_WEBHOOK_URL 未設定，無法轉發非打卡事件，共 ${forwardEvents.length} 筆。`);
      for (const event of forwardEvents) {
        try {
          if (event.type === 'message' && event.message?.type === 'text') {
            await replyFallback(event.replyToken, '⚠️ 備援模式目前僅支援「我要打卡」，其他功能暫時無法使用。');
          }
          forwardFailCount += 1;
        } catch (e) {
          console.error('[line-webhook] fallback reply error:', e.message);
          await appendWebhookError(auth, 'line-webhook', e.message, 'GAS_WEBHOOK_URL 未設定時 fallback reply');
        }
      }
    } else {
      try {
        const forwardedPayload = { ...payload, events: forwardEvents };
        console.log(`[line-webhook][${requestId}] forwarding ${forwardEvents.length} event(s) to GAS`);
        const forwardRes = await fetch(GAS_WEBHOOK_URL, {
          method: 'post',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-By': 'gcp-backup-line-webhook',
            ...(signature ? { 'X-Line-Signature': String(signature) } : {}),
          },
          body: JSON.stringify(forwardedPayload),
        });
        if (!forwardRes.ok) {
          const errText = await forwardRes.text();
          throw new Error(`status=${forwardRes.status} body=${(errText || '').slice(0, 300)}`);
        }
        forwardedCount = forwardEvents.length;
        console.log(`[line-webhook][${requestId}] forward-success status=${forwardRes.status} count=${forwardedCount}`);
      } catch (e) {
        console.error(`[line-webhook][${requestId}] forward to GAS error:`, e.message);
        await appendWebhookError(auth, 'line-webhook', e.message, `forward to GAS requestId=${requestId}`);
        for (const event of forwardEvents) {
          try {
            if (event.type === 'message' && event.message?.type === 'text') {
              await replyFallback(event.replyToken, '🚧 主系統暫時無法使用，請稍後再試。');
            }
            forwardFailCount += 1;
          } catch (replyErr) {
            console.error('[line-webhook] forward fail reply error:', replyErr.message);
            await appendWebhookError(auth, 'line-webhook', replyErr.message, 'forward fail 後 reply');
          }
        }
      }
    }
  }
  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[line-webhook][${requestId}] done total=${events.length} local=${localHandledCount} forwarded=${forwardedCount} forwardFail=${forwardFailCount} elapsedMs=${elapsedMs}`,
  );
  send(res, 200, { status: 'ok' });
}

export function startServer() {
  // Catch truly unexpected crashes and still record them to the unified error log sheet.
  // This helps monitoring when Cloud Run restarts the container.
  let authPromise = null;
  const getAuthCached = async () => {
    if (!authPromise) authPromise = getAuth();
    return await authPromise;
  };
  const logFatal = async (source, err, context) => {
    try {
      const auth = await getAuthCached();
      const msg = err?.stack ? String(err.stack) : String(err?.message || err);
      await appendWebhookError(auth, source, msg, context);
    } catch (_) {
      // Ignore logging failures.
    }
  };

  process.on('unhandledRejection', (reason) => {
    console.error('[GCP] unhandledRejection:', reason?.message || reason);
    logFatal('gcp-unhandledRejection', reason, 'server');
  });
  process.on('uncaughtException', (err) => {
    console.error('[GCP] uncaughtException:', err?.message || err);
    logFatal('gcp-uncaughtException', err, 'server').finally(() => process.exit(1));
  });

  const server = http.createServer(async (req, res) => {
    const method = req.method;
    const url = req.url?.split('?')[0] || '/';
    const fullUrl = new URL(req.url || '/', 'http://localhost');

    if (method === 'GET' && (url === '/' || url === '/health')) {
      send(res, 200, { status: 'ok', server: 'gcp-backup' });
      return;
    }

    if (method === 'GET' && url === '/line-webhook') {
      send(res, 200, { status: 'ok', message: 'LINE Webhook 端點存在，請用 POST 傳送事件' });
      return;
    }

    if (method === 'POST' && url === '/line-webhook') {
      const rawBody = await parseBody(req);
      await handleLineWebhook(req, rawBody, res);
      return;
    }

    if (method === 'GET' && url === '/store-line-webhook') {
      send(res, 200, { status: 'ok', message: 'Store LINE Webhook endpoint exists. Use POST.' });
      return;
    }
    if (method === 'POST' && url === '/store-line-webhook') {
      const authClient = await getAuth();
      const rawBody = await parseBody(req);
      await handleStoreLineWebhook(req, res, { authClient, rawBody });
      return;
    }

    // Privacy Policy
    if (method === 'GET' && url === '/privacy') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>隱私權政策 - 泡泡貓</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Noto Sans TC',sans-serif;max-width:700px;margin:40px auto;padding:0 20px;color:#333;line-height:1.8}h1{color:#008BD5;font-size:24px}h2{color:#5a3e2b;font-size:18px;margin-top:28px}p{margin:8px 0}a{color:#008BD5}</style></head><body>
<h1>🐱 泡泡貓 隱私權政策</h1><p>最後更新：2026 年 3 月 15 日</p>
<p>泡泡貓股份有限公司（統一編號：94256530，以下稱「本公司」）重視您的隱私權，特訂定本政策說明我們如何收集、使用及保護您的個人資料。</p>
<h2>1. 資料收集</h2><p>當您透過 Instagram 回覆我們的限時動態或與我們互動時，我們可能會收到以下資訊：</p>
<ul><li>您的 Instagram 用戶 ID</li><li>您發送的訊息內容</li><li>您回覆的限時動態資訊</li></ul>
<p>當您使用我們的預約網站（book.paopaomao.tw）時，我們可能會收集：</p>
<ul><li>您的姓名、電話號碼</li><li>您選擇的預約門市及時段</li><li>裝置定位資訊（僅在您授權時）</li></ul>
<h2>2. 資料使用</h2><ul><li>回覆您的預約需求，提供門市資訊及預約連結</li><li>改善我們的服務品質</li><li>我們<strong>不會</strong>將您的資料出售或分享給無關第三方</li></ul>
<h2>3. 資料保留</h2><p>我們僅在提供服務所需期間內保留您的資料。Instagram 互動紀錄保留不超過 90 天。</p>
<h2>4. 資料刪除</h2><p>您可以隨時要求刪除您的個人資料：</p>
<ul><li>透過 Instagram 封鎖或取消追蹤 @paopaomao_ 帳號</li><li>發送 Email 至 <a href="mailto:mktpaopao88@gmail.com">mktpaopao88@gmail.com</a> 請求刪除</li><li>透過資料刪除連結：<a href="https://gcp.paopaomao.tw/data-deletion">資料刪除請求</a></li></ul>
<h2>5. Cookie 及追蹤</h2><p>我們的預約網站使用 Meta Pixel 追蹤廣告成效，您可透過瀏覽器設定管理 Cookie。</p>
<h2>6. 第三方服務</h2><p>我們使用以下第三方服務：Meta (Facebook/Instagram)、LINE、Google。各服務的隱私政策請參閱其官方網站。</p>
<h2>7. 聯絡方式</h2><p>泡泡貓股份有限公司<br>地址：407 台中市西屯區四川二街 38 號<br>Email：<a href="mailto:mktpaopao88@gmail.com">mktpaopao88@gmail.com</a><br>網站：<a href="https://paopaomao.tw">paopaomao.tw</a></p>
</body></html>`);
      return;
    }

    // Data Deletion Callback (Meta 要求)
    if (method === 'GET' && url === '/data-deletion') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>資料刪除 - 泡泡貓</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Noto Sans TC',sans-serif;max-width:600px;margin:40px auto;padding:0 20px;color:#333;line-height:1.8}h1{color:#008BD5}input,textarea{width:100%;padding:10px;border:1.5px solid #ddd;border-radius:8px;font-size:14px;margin:6px 0 16px}button{background:#008BD5;color:#fff;border:none;padding:12px 32px;border-radius:8px;font-size:15px;cursor:pointer}button:hover{background:#006fa3}</style></head><body>
<h1>🗑️ 資料刪除請求</h1><p>如果您希望刪除我們所持有的您的個人資料，請填寫以下表單，我們將在 30 天內處理。</p>
<form method="POST" action="/data-deletion"><label>您的 Email<input type="email" name="email" required></label><label>Instagram 帳號（選填）<input type="text" name="ig_username"></label><label>說明<textarea name="note" rows="3" placeholder="請說明您希望刪除的資料"></textarea></label><button type="submit">提交刪除請求</button></form>
</body></html>`);
      return;
    }
    if (method === 'POST' && url === '/data-deletion') {
      const rawBody = await parseBody(req);
      try {
        const params = new URLSearchParams(rawBody);
        const email = params.get('email') || '';
        const ig = params.get('ig_username') || '';
        const note = params.get('note') || '';
        console.log('[data-deletion] Request:', { email, ig, note });
        // 通知 Robby
        const TG_TOKEN = process.env.TG_BOT_TOKEN || '8520607475:AAHKn1oBOmTGloSzvM_Y0ps41tigRG3torc';
        fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: '7956245081', text: `🗑️ 資料刪除請求\nEmail: ${email}\nIG: ${ig}\n說明: ${note}` })
        }).catch(() => {});
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px;text-align:center"><h2>✅ 已收到您的刪除請求</h2><p>我們將在 30 天內處理，並以 Email 通知您結果。</p><a href="https://paopaomao.tw">返回泡泡貓官網</a></body></html>');
      } catch(e) {
        res.writeHead(500);
        res.end('Error');
      }
      return;
    }

    // IG Messaging Webhook (Story 回覆自動 DM)
    if (method === 'GET' && url === '/ig-webhook') {
      handleIgWebhookVerify(req.url, res);
      return;
    }
    if (method === 'POST' && url === '/ig-webhook') {
      const rawBody = await parseBody(req);
      const signature = req.headers['x-hub-signature-256'] || '';
      await handleIgWebhookEvent(rawBody, signature, res);
      return;
    }

    if (method === 'GET' && url === '/paopao-line-webhook') {
      send(res, 200, { status: 'ok', message: 'PAOPAO LINE Webhook endpoint exists. Use POST.' });
      return;
    }
    if (method === 'POST' && url === '/paopao-line-webhook') {
      const authClient = await getAuth();
      const rawBody = await parseBody(req);
      await handlePaopaoWebhook(req, res, { authClient, rawBody });
      return;
    }
    if (method === 'POST' && url === '/paopao-line-push') {
      try {
        const rawBody = await parseBody(req);
        const body = JSON.parse(rawBody.toString('utf8'));
        const PAOPAO_TOKEN = (process.env.LINE_TOKEN_PAOPAO || '').trim();
        
        if (!PAOPAO_TOKEN) {
          send(res, 500, { status: 'error', message: 'LINE_TOKEN_PAOPAO not configured' });
          return;
        }
        
        const lineResponse = await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${PAOPAO_TOKEN}`,
            'Content-Type': 'application/json' 
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
        
        if (lineResponse.ok) {
          send(res, 200, { status: 'success' });
        } else {
          const errorText = await lineResponse.text();
          send(res, lineResponse.status, { status: 'error', message: errorText });
        }
      } catch (error) {
        send(res, 500, { status: 'error', message: error.message });
      }
      return;
    }

    if (method === 'OPTIONS' && url === '/core') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }
    if ((method === 'GET' || method === 'POST') && url === '/core') {
      const authClient = await getAuth();
      let bodyJson = null;
      if (method === 'POST') {
        const rawBody = await parseBody(req);
        bodyJson = (() => {
          try {
            return JSON.parse(rawBody.toString('utf8'));
          } catch {
            return null;
          }
        })();
      }
      await handleCore(req, res, { authClient, url: fullUrl, bodyJson });
      return;
    }

    if (method === 'OPTIONS' && url === '/stores') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    if ((method === 'GET' || method === 'POST') && url === '/stores') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const authClient = await getAuth();
      let bodyJson = null;
      if (method === 'POST') {
        const rawBody = await parseBody(req);
        bodyJson = (() => {
          try {
            return JSON.parse(rawBody.toString('utf8'));
          } catch {
            return null;
          }
        })();
      }
      await handleStores(req, res, { authClient, url: fullUrl, bodyJson });
      return;
    }

    if (url === '/checkin') {
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }
      if (method === 'GET') {
        send(res, 200, {
          usage: 'POST JSON { action: "bind"|"check_in", uuid, frontUuid, userId?, latitude?, longitude? }',
          endpoint: '/checkin',
        });
        return;
      }
      if (method === 'POST') {
        const authClient = await getAuth();
        let bodyJson = null;
        try {
          const rawBody = await parseBody(req);
          bodyJson = JSON.parse(rawBody.toString('utf8'));
        } catch {
          bodyJson = null;
        }
        await handleCheckinApi(req, res, { auth: authClient, bodyJson });
        return;
      }
      send(res, 405, { status: 'error', message: 'Method not allowed' });
      return;
    }

    if (method === 'GET' && url === '/saydou-token') {
      send(res, 200, { status: 'ok', message: 'SayDou Token Sync endpoint. Use POST with JSON body { token }.' });
      return;
    }
    if (method === 'POST' && url === '/saydou-token') {
      const rawBody = await parseBody(req);
      await handleSaydouTokenSync(req, res, { rawBody });
      return;
    }

    // ─── SayDou Resync API：店長改單後觸發重跑 ───
    if (method === 'POST' && url === '/saydou-resync') {
      const rawBody = await parseBody(req);
      const body = JSON.parse(rawBody.toString());
      const { store_id, store_name, date, requested_by } = body || {};
      if (!store_id || !date) {
        send(res, 400, { error: 'store_id and date required' });
        return;
      }
      const { rows } = await pool.query(
        `INSERT INTO saydou_resync_requests (store_id, store_name, resync_date, requested_by)
         VALUES ($1, $2, $3, $4) RETURNING id, status`,
        [store_id, store_name || `store_${store_id}`, date, requested_by || 'api']
      );
      // 立即觸發 resync（背景）
      const { spawn } = await import('child_process');
      const scriptDir = path.dirname(fileURLToPath(import.meta.url));
      const cp = spawn('node', [
        'scripts/sync_saydou_data.cjs', '--resync'
      ], { cwd: scriptDir, stdio: 'ignore', detached: true });
      cp.unref();
      send(res, 200, { ok: true, resync_id: rows[0].id, message: `Resync queued for store ${store_id} @ ${date}` });
      return;
    }
    if (method === 'GET' && url === '/saydou-resync') {
      const { rows } = await pool.query(
        "SELECT * FROM saydou_resync_requests ORDER BY requested_at DESC LIMIT 20"
      );
      send(res, 200, { requests: rows });
      return;
    }

    // ─── Daily Accounting API：從 VIEW 查帳表（僅限有 daily_report 權限的門市）───
    if (method === 'GET' && fullUrl.pathname === '/daily-accounting') {
      const qs = fullUrl.searchParams;
      const storeId = qs.get('store_id');
      const date = qs.get('date');
      const from = qs.get('from');
      const to = qs.get('to');
      const isAdmin = qs.get('admin') === 'true'; // admin 看全部（Dashboard 後台用）

      // 取得有 daily_report 權限的門市
      const { rows: enabledStores } = await pool.query(
        "SELECT store_name FROM store_features WHERE feature_key = 'daily_report' AND enabled = true"
      );
      const allowedStoreNames = enabledStores.map(r => r.store_name);

      if (allowedStoreNames.length === 0 && !isAdmin) {
        send(res, 200, { date: date || '', rows: [], note: 'No stores have daily_report enabled' });
        return;
      }

      let query, params;
      if (storeId && date) {
        query = 'SELECT * FROM daily_accounting WHERE store_id = $1 AND date = $2';
        params = [storeId, date];
      } else if (storeId && from && to) {
        query = 'SELECT * FROM daily_accounting WHERE store_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date';
        params = [storeId, from, to];
      } else if (date && !isAdmin) {
        // 非 admin：只回傳有權限的門市
        query = 'SELECT * FROM daily_accounting WHERE date = $1 AND store_name = ANY($2) ORDER BY total_amount DESC';
        params = [date, allowedStoreNames];
      } else if (date) {
        query = 'SELECT * FROM daily_accounting WHERE date = $1 ORDER BY total_amount DESC';
        params = [date];
      } else {
        const yesterday = new Date(Date.now() + 8*3600000 - 86400000).toISOString().substring(0, 10);
        if (!isAdmin) {
          query = 'SELECT * FROM daily_accounting WHERE date = $1 AND store_name = ANY($2) ORDER BY total_amount DESC';
          params = [yesterday, allowedStoreNames];
        } else {
          query = 'SELECT * FROM daily_accounting WHERE date = $1 ORDER BY total_amount DESC';
          params = [yesterday];
        }
      }
      const { rows } = await pool.query(query, params);
      send(res, 200, { date: date || params[0], rows, enabledStores: allowedStoreNames });
      return;
    }

    if (url === '/giveme-invoice') {
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }
      if (method === 'GET') {
        send(res, 200, {
          usage: 'POST JSON: { order, options }',
          order: 'Saydou order 或含 ordds[], price_/rprice, date, ordrsn, memnam, remark；若有實際收款(優惠券折抵)可傳 actualAmount/invoiceAmount/realTotal/payamt',
          options: { type: 'B2C|B2B', phone: '手機條碼', companyTaxId: 'B2B買方統編', invoiceAmount: '發票金額(實際收款，選填)' },
          example: { order: { ordds: [{ godnam: '測試', rprice: 10, amount: 1 }], rprice: 10, date: '2026-02-20', ordrsn: 'TEST001' }, options: { type: 'B2C' } },
        });
        return;
      }
      if (method === 'POST') {
        const rawBody = await parseBody(req);
        await handleGivemeInvoice(req, res, { rawBody });
        return;
      }
      send(res, 405, { success: false, msg: 'Method not allowed' });
      return;
    }

    if (method === 'GET' && url === '/giveme-invoice/check') {
      await handleGivemeInvoiceCheck(req, res);
      return;
    }

    if (method === 'GET' && url === '/giveme-invoice-print') {
      await handleGivemeInvoicePrint(req, res);
      return;
    }

    if ((method === 'GET' || method === 'POST') && url === '/admin') {
      let bodyJson = null;
      if (method === 'POST') {
        const rawBody = await parseBody(req);
        bodyJson = (() => {
          try {
            return JSON.parse(rawBody.toString('utf8'));
          } catch {
            return null;
          }
        })();
      }
      await handleAdmin(req, res, { url: fullUrl, bodyJson });
      return;
    }

    if (method === 'GET' && url === '/report') {
      const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const host = req.headers['x-forwarded-host'] || req.headers['host'] || '';
      const reportApiBase = `${proto}://${host}/report-api`;
      const reportPath = path.join(__dirname, 'public', 'report.html');
      try {
        let html = fs.readFileSync(reportPath, 'utf8');
        html = html.replace(/__REPORT_API_BASE__/g, reportApiBase);
        send(res, 200, html, 'text/html; charset=utf-8');
      } catch (e) {
        console.error('[report] read report.html:', e?.message);
        send(res, 500, '<!DOCTYPE html><html><body>報告頁面暫時無法載入。</body></html>', 'text/html; charset=utf-8');
      }
      return;
    }

    if (method === 'GET' && url === '/customer-info') {
      const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const host = req.headers['x-forwarded-host'] || req.headers['host'] || '';
      const apiBase = `${proto}://${host}`;
      const p = path.join(__dirname, 'public', 'customer-info.html');
      try {
        let html = fs.readFileSync(p, 'utf8');
        html = html.replace(/__CUSTOMER_API_BASE__/g, apiBase);
        send(res, 200, html, 'text/html; charset=utf-8');
      } catch (e) {
        console.error('[customer-info] read customer-info.html:', e?.message);
        send(res, 500, '<!DOCTYPE html><html><body>客人狀態頁暫時無法載入。</body></html>', 'text/html; charset=utf-8');
      }
      return;
    }

    if (url === '/customer-api') {
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }
      if (method === 'GET') {
        const authClient = await getAuthCached();
        await handleCustomerApi(req, res, { authClient, url: fullUrl });
        return;
      }
    }

    if (url === '/report-api') {
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }
      if (method === 'GET') {
        await handleReportApi(req, res, { url: fullUrl });
        return;
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'not_found' }));
  });

  const missing = [];
  if (!LINE_CHANNEL_SECRET) missing.push('LINE_CHANNEL_SECRET');
  if (!LINE_TOKEN_PAOSTAFF) missing.push('LINE_TOKEN_PAOSTAFF');
  if (!process.env.LINE_STAFF_SS_ID) missing.push('LINE_STAFF_SS_ID');
  if (missing.length) {
    console.warn('[GCP] LINE Webhook 備援需要以下環境變數（請在 .env 或環境中設定）：', missing.join(', '));
  }
  if (!GAS_WEBHOOK_URL) {
    console.warn('[GCP] GAS_WEBHOOK_URL 未設定：若啟用 FORWARD_UNKNOWN_TO_GAS，非本地指令將無法轉發。');
  }
  if (!FORWARD_UNKNOWN_TO_GAS) {
    console.log('[GCP] FORWARD_UNKNOWN_TO_GAS=0：優先走 GCP 本地指令，不再預設轉發 GAS。');
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[GCP] Server listening on port ${PORT}`);
    console.log('[GCP] GET / 健康檢查、POST /line-webhook LINE Webhook');
  });
}
