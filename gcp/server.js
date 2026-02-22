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

    if ((method === 'GET' || method === 'POST') && url === '/stores') {
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
          order: 'Saydou order 或含 ordds[], price_/rprice, date, ordrsn, memnam, remark',
          options: { type: 'B2C|B2B', phone: '手機條碼(例/1234567)', orderCode: '編號載具', companyTaxId: 'B2B買方統編' },
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
