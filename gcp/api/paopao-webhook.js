import fetch from 'node-fetch';
import { Pool } from 'pg';
import { verifyLineSignature } from '../lib/line-webhook.js';
import { appendSheet, readSheet, writeSheet, batchUpdateValues } from '../lib/sheets.js';
import { getDirectStoreReplyStatusText } from '../lib/store-reply-status.js';
import { sendAdminLinePush } from '../lib/line-push.js';
import { sendJson } from './http-utils.js';

import fs from 'fs';

// PostgreSQL connection for delete orders
const pgPool = new Pool({ database: 'paomao', host: 'localhost', port: 5432, max: 3 });

// SayDou API
const SAYDOU_API = 'https://saywebdatafeed.saydou.com';
function getSaydouToken() {
  try { return fs.readFileSync('/Users/paopaomao/.openclaw/workspace/booking-site/.saydou-token', 'utf8').trim(); }
  catch { return ''; }
}

/** 管理員級錯誤只推給 Robby，客戶只收到通用訊息 */
const CUSTOMER_FALLBACK_MSG = '暫時無法處理，請稍後再試。';

const PAOPAO_STORE_SS_ID = (process.env.PAOPAO_STORE_SS_ID || '').trim();
/** 店家回覆狀態報表用（各店訊息一覽表，含店家名、狀態欄）；與員工打卡同一份 */
const LINE_STORE_SS_ID = (process.env.LINE_STORE_SS_ID || '').trim();
const PAOPAO_CHANNEL_SECRET = (process.env.LINE_CHANNEL_SECRET_PAOPAO || '').trim();
const PAOPAO_TOKEN = (process.env.LINE_TOKEN_PAOPAO || '').trim();
/** 請款 ACH 紀錄試算表（與 GAS Config EXTERNAL_SS_ID 一致）；未設則不處理「正確」postback */
const EXTERNAL_SS_ID = (process.env.EXTERNAL_SS_ID || '').trim();
/** 工作表分頁名稱（須與試算表底部標籤完全一致，含斜線／繁簡體）；可設 ACH_SHEET_NAME 覆寫 */
const ACH_SHEET_NAME = (process.env.ACH_SHEET_NAME || '2026/ACH紀錄').trim() || '2026/ACH紀錄';

async function replyText(replyToken, text) {
  if (!replyToken || !PAOPAO_TOKEN) return;
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    headers: { Authorization: `Bearer ${PAOPAO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: String(text || '') }] }),
    signal: AbortSignal.timeout(15000),
  });
}

async function fetchDisplayName(userId) {
  if (!userId || !PAOPAO_TOKEN) return '';
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      method: 'get',
      headers: { Authorization: `Bearer ${PAOPAO_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    if (!res.ok) return '';
    const json = JSON.parse(text);
    return String(json?.displayName || '').trim();
  } catch {
    return '';
  }
}

/** 取得 LINE 群組顯示名稱（用於訊息一覽 C 欄顯示真實群組名而非 UUID） */
async function fetchGroupName(groupId) {
  if (!groupId || !PAOPAO_TOKEN) return '';
  try {
    const res = await fetch(`https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/summary`, {
      method: 'get',
      headers: { Authorization: `Bearer ${PAOPAO_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return '';
    const json = await res.json();
    return String(json?.groupName || '').trim();
  } catch {
    return '';
  }
}

/** 群組/聊天室內取得顯示名稱（與 GAS Core.getUserDisplayName 行為一致） */
async function fetchDisplayNameInSource(userId, source) {
  if (!userId || !PAOPAO_TOKEN) return '';
  let url;
  if (source?.groupId) {
    url = `https://api.line.me/v2/bot/group/${encodeURIComponent(source.groupId)}/member/${encodeURIComponent(userId)}`;
  } else if (source?.roomId) {
    url = `https://api.line.me/v2/bot/room/${encodeURIComponent(source.roomId)}/member/${encodeURIComponent(userId)}`;
  } else {
    return fetchDisplayName(userId);
  }
  try {
    const res = await fetch(url, {
      method: 'get',
      headers: { Authorization: `Bearer ${PAOPAO_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return await fetchDisplayName(userId);
    const json = JSON.parse(await res.text());
    const name = String(json?.displayName || '').trim();
    return name || (await fetchDisplayName(userId));
  } catch {
    return await fetchDisplayName(userId);
  }
}

function parsePostbackParams(data) {
  const params = {};
  if (!data || typeof data !== 'string') return params;
  data.split('&').forEach((p) => {
    const idx = p.indexOf('=');
    if (idx >= 0) {
      const k = p.substring(0, idx);
      let v = p.substring(idx + 1);
      try {
        v = decodeURIComponent(v);
      } catch {}
      params[k] = v;
    }
  });
  return params;
}

/** 台灣時間 yyyy/MM/dd HH:mm（與 GAS 一致） */
function formatTaiwanDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const s = d.toLocaleString('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const [datePart, timePart] = s.split(', ');
  const [y, m, day] = datePart.split('-');
  return `${y}/${m}/${day} ${timePart.slice(0, 5)}`;
}

/** 與 GAS LineBot.pushFlexReceipt 相同結構的收據 Push */
async function pushFlexReceipt(targetId, storeName, odooId, operatorName) {
  if (!targetId || !PAOPAO_TOKEN) return;
  const timestamp = formatTaiwanDateTime(new Date());
  const safeStoreName = storeName || '未知店家';
  const payload = {
    to: targetId,
    messages: [
      {
        type: 'flex',
        altText: '✅ 核銷完成憑證',
        contents: {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#d1d1d1',
            contents: [{ type: 'text', text: '已確認 / CONFIRMED', weight: 'bold', color: '#555555', size: 'sm', align: 'center' }],
          },
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'text', text: safeStoreName, weight: 'bold', size: 'lg', align: 'center', color: '#333333' },
              { type: 'separator', margin: 'md' },
              {
                type: 'box',
                layout: 'vertical',
                margin: 'md',
                spacing: 'sm',
                contents: [
                  { type: 'box', layout: 'baseline', contents: [{ type: 'text', text: 'Odoo 單號', color: '#aaaaaa', size: 'xs', flex: 2 }, { type: 'text', text: String(odooId), wrap: true, color: '#666666', size: 'xs', flex: 4 }] },
                  { type: 'box', layout: 'baseline', contents: [{ type: 'text', text: '操作人員', color: '#aaaaaa', size: 'xs', flex: 2 }, { type: 'text', text: operatorName || '操作者', wrap: true, color: '#666666', size: 'xs', flex: 4 }] },
                  { type: 'box', layout: 'baseline', contents: [{ type: 'text', text: '確認時間', color: '#aaaaaa', size: 'xs', flex: 2 }, { type: 'text', text: timestamp, wrap: true, color: '#666666', size: 'xs', flex: 4 }] },
                ],
              },
            ],
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [{ type: 'text', text: '此單據已結案，請勿重複操作', size: 'xxs', color: '#bbbbbb', align: 'center' }],
          },
        },
      },
    ],
  };
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    headers: { Authorization: `Bearer ${PAOPAO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
}

/** 解析刪單請求文字 */
function parseDeleteOrderText(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line);
  const data = {};
  
  for (const line of lines) {
    if (line.includes('客人姓名')) {
      data.customerName = line.replace(/.*客人姓名[：:]\s*/, '').trim();
    } else if (line.includes('訂單編號')) {
      data.orderId = line.replace(/.*訂單編號[：:]\s*/, '').trim();
    } else if (line.includes('電話')) {
      data.phone = line.replace(/.*電話[：:]\s*/, '').trim();
    } else if (line.includes('需刪除的原因')) {
      data.reason = line.replace(/.*需刪除的原因[：:]\s*/, '').trim();
    } else if (line.includes('金額')) {
      const amountStr = line.replace(/.*金額[：:]\s*/, '').replace(/[^\d.-]/g, '');
      data.amount = parseFloat(amountStr) || 0;
    }
  }
  
  return data;
}

/** 查詢 SayDou 會員和訂單 */
async function searchSayDouOrder(phone, customerName, orderId) {
  try {
    const token = getSaydouToken();
    if (!token) {
      return { found: false, reason: 'api_error', error: 'SayDou token not available' };
    }
    const headers = { Authorization: `Bearer ${token}` };
    console.log('[delete-order] 查詢 SayDou, phone:', phone, 'name:', customerName, 'orderId:', orderId);
    
    // 先用電話查會員
    const memberRes = await fetch(`${SAYDOU_API}/api/management/crm/members?page=0&limit=10&keyword=${encodeURIComponent(phone)}`, {
      headers, signal: AbortSignal.timeout(20000)
    });
    const memberData = await memberRes.json();
    const members = memberData?.data?.items || memberData?.data || [];
    
    if (!members.length) {
      return { found: false, reason: 'member_not_found' };
    }
    
    const member = members[0];
    const memberId = member.id || member._id || '';
    
    // 查交易記錄（用姓名）
    const transRes = await fetch(`${SAYDOU_API}/api/management/finance/transaction?keyword=${encodeURIComponent(customerName)}`, {
      headers, signal: AbortSignal.timeout(20000)
    });
    const transData = await transRes.json();
    const transactions = transData?.data?.items || transData?.data || [];
    
    // 找符合的消費訂單（門市傳的是 ordrsn，刪除用 ordcid）
    if (transactions.length) {
      const matchingTrans = transactions.find(trans => 
        (trans.ordrsn && String(trans.ordrsn) === String(orderId)) ||
        (trans.ordcid && String(trans.ordcid) === String(orderId))
      );
      
      if (matchingTrans) {
        console.log('[delete-order] 找到消費訂單 ordrsn:', matchingTrans.ordrsn, 'ordcid:', matchingTrans.ordcid);
        return {
          found: true,
          type: 'transaction',
          memberId,
          ordcid: String(matchingTrans.ordcid),
          ordrsn: String(matchingTrans.ordrsn || ''),
          transactionData: matchingTrans,
          actualAmount: parseFloat(matchingTrans.rprice || matchingTrans.price_ || matchingTrans.total || matchingTrans.amount || 0)
        };
      }
      console.log('[delete-order] 消費訂單不符, 搜尋到', transactions.length, '筆, ordrsn:', transactions.map(t => t.ordrsn).join(','));
    }
    
    // 消費找不到，查儲值紀錄
    const membid = member.membid || member.id || member._id || '';
    if (membid) {
      console.log('[delete-order] 消費找不到，查儲值紀錄 membid:', membid);
      const scRes = await fetch(`${SAYDOU_API}/api/management/unearn/storecashAddRecord?page=0&limit=50&sort=rectim&order=desc&keyword=&membid=${membid}&type=0&tabIndex=1`, {
        headers, signal: AbortSignal.timeout(20000)
      });
      const scData = await scRes.json();
      const scItems = scData?.data?.items || scData?.data || [];
      
      if (scItems.length) {
        // 用訂單編號比對（ordrsn 或 scitid）
        const matchingSc = scItems.find(sc =>
          (sc.ordrsn && String(sc.ordrsn) === String(orderId)) ||
          (sc.scitid && String(sc.scitid) === String(orderId))
        );
        
        if (matchingSc) {
          console.log('[delete-order] 找到儲值紀錄 scitid:', matchingSc.scitid);
          return {
            found: true,
            type: 'storecash',
            memberId: String(membid),
            scitid: String(matchingSc.scitid),
            ordrsn: String(matchingSc.ordrsn || orderId),
            transactionData: matchingSc,
            actualAmount: parseFloat(matchingSc.amount || matchingSc.cash || 0)
          };
        }
        
        // 沒有精確比對到，但有紀錄 — 找最近一筆金額符合的
        console.log('[delete-order] 儲值紀錄 ordrsn 不符, 共', scItems.length, '筆');
      }
    }
    
    return { found: false, reason: 'order_not_matched' };
    
  } catch (error) {
    console.error('[delete-order] searchSayDouOrder error:', error.message);
    return { found: false, reason: 'api_error', error: error.message };
  }
}

/** 處理刪單請求 */
async function handleDeleteOrder(event) {
  const text = String(event?.message?.text || '').trim();
  
  if (!text.includes('【泡泡貓協助刪單paodelete】')) {
    return false; // 不是刪單請求
  }
  console.log('[delete-order] 收到刪單請求:', text.substring(0, 100));
  
  const deleteData = parseDeleteOrderText(text);
  
  if (!deleteData.customerName || !deleteData.phone || !deleteData.orderId) {
    await replyText(event.replyToken, '⚠️ 刪單資訊不完整，請確認格式：\n客人姓名、訂單編號、電話 必填');
    return true;
  }
  
  const source = event.source || {};
  const userId = source.userId || '';
  const requestedBy = await fetchDisplayNameInSource(userId, source);
  const sourceGroupId = source.groupId || source.roomId || '';
  let sourceGroupName = '';
  if (sourceGroupId) {
    sourceGroupName = await fetchGroupName(sourceGroupId) || sourceGroupId;
  } else {
    sourceGroupName = `私訊（${requestedBy || 'unknown'}）`;
  }
  
  // 查詢 SayDou
  const searchResult = await searchSayDouOrder(deleteData.phone, deleteData.customerName, deleteData.orderId);
  
  if (!searchResult.found) {
    // 查不到，回覆請重新提供資料
    await replyText(event.replyToken, '❌ 查無此筆訂單，麻煩再提供正確資料。');
    return true;
  }
  
  // 金額僅記錄，不擋審核
  if (deleteData.amount && searchResult.actualAmount && deleteData.amount !== searchResult.actualAmount) {
    console.log('[delete-order] 金額不符但不擋: 提供=', deleteData.amount, '系統=', searchResult.actualAmount);
  }
  
  // 檢查是否已有相同訂單的刪單請求（防重複）
  try {
    const { rows: existing } = await pgPool.query(
      "SELECT id, status FROM delete_orders WHERE order_id = $1 AND status IN ('pending', 'deleted')",
      [deleteData.orderId]
    );
    if (existing.length > 0) {
      const e = existing[0];
      if (e.status === 'deleted') {
        await replyText(event.replyToken, `ℹ️ 訂單 ${deleteData.orderId} 已刪除完成，無需重複處理。`);
      } else {
        await replyText(event.replyToken, `ℹ️ 訂單 ${deleteData.orderId} 已在審核中，請勿重複提交。`);
      }
      return true;
    }
  } catch (e) {
    console.error('[delete-order] duplicate check error:', e.message);
  }

  // 查到，寫入 DB 等待會計確認
  const orderType = searchResult.type || 'transaction'; // 'transaction' or 'storecash'
  const deleteId = orderType === 'storecash' ? searchResult.scitid : searchResult.ordcid;
  try {
    await pgPool.query(`
      INSERT INTO delete_orders (
        customer_name, phone, order_id, amount, reason, 
        saydou_member_id, saydou_ordcid, order_type,
        source_group_id, source_group_name, 
        requested_by, requested_by_user_id, 
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
    `, [
      deleteData.customerName,
      deleteData.phone, 
      deleteData.orderId,
      deleteData.amount || searchResult.actualAmount,
      deleteData.reason,
      searchResult.memberId,
      deleteId,
      orderType,
      sourceGroupId,
      sourceGroupName,
      requestedBy,
      userId
    ]);
    
    await replyText(event.replyToken, '泡泡貓會計正在審核中，請稍後。');
    
  } catch (dbError) {
    await replyText(event.replyToken, '❌ 系統錯誤，請稍後再試。');
    console.error('[delete-order] DB insert failed:', dbError.message);
  }
  
  return true;
}

/** 請款「正確」按鈕 postback：寫入 ACH 試算表 G 欄 + DB 並回覆＋推播收據
 *  支援兩種模式：
 *  - 新版 (Dashboard): action=confirm&dbId=xxx&sheetRow=xxx → 直接用 DB id + sheet_row
 *  - 舊版 (GAS):       action=confirm&odoo=xxx&storeName=xxx → 搜尋 P+B 欄比對
 */
async function handleConfirmPostback(authClient, event) {
  const params = parsePostbackParams(event?.postback?.data);
  if (params.action !== 'confirm') return;

  const source = event.source || {};
  const targetId = source.groupId || source.roomId || source.userId;
  const userId = source.userId;
  let userName = await fetchDisplayNameInSource(userId, source);
  if (!userName) userName = '操作者';

  const dbId = params.dbId ? String(params.dbId).trim() : '';
  const sheetRow = params.sheetRow ? parseInt(params.sheetRow) : 0;
  const odooId = params.odoo != null ? String(params.odoo).trim() : '';
  const storeNameFromPostback = params.storeName != null ? String(params.storeName).trim() : '';

  // Must have either dbId or odooId
  if (!dbId && !odooId) {
    await replyText(event.replyToken, '⚠️ 無法取得單號，請重試。');
    return;
  }
  if (!EXTERNAL_SS_ID) {
    await replyText(event.replyToken, CUSTOMER_FALLBACK_MSG);
    return;
  }

  let rowIndex = -1;
  let resolvedStoreName = storeNameFromPostback;
  let resolvedDbId = dbId;

  if (dbId && sheetRow) {
    // ─── 新版：直接用 DB id + sheet_row ───
    rowIndex = sheetRow;
    // 從 DB 取 store_name 做收據用
    try {
      const { Pool } = await import('pg');
      const dbPool = new Pool({ host: '/tmp', database: 'paomao', user: 'paopaomao' });
      const { rows: dbRows } = await dbPool.query(
        'SELECT store_name, customer_confirmed FROM ach_records WHERE id = $1 AND year = 2026', [dbId]
      );
      await dbPool.end();
      if (dbRows.length === 0) {
        await replyText(event.replyToken, `⚠️ 找不到單號 ${dbId} 的資料。`);
        return;
      }
      if (dbRows[0].customer_confirmed && String(dbRows[0].customer_confirmed).trim()) {
        await replyText(event.replyToken, `⚠️ ${userName} 您好，\n這筆資料已經確認過囉！\n\n紀錄：\n${dbRows[0].customer_confirmed}`);
        return;
      }
      resolvedStoreName = dbRows[0].store_name || storeNameFromPostback;
    } catch (dbErr) {
      console.error('[paopao-webhook] DB lookup failed:', dbErr?.message);
    }
  } else {
    // ─── 舊版：搜尋 Sheet P+B 欄 ───
    let rows;
    try {
      rows = await readSheet(authClient, EXTERNAL_SS_ID, `'${ACH_SHEET_NAME}'!A:P`);
    } catch (err) {
      console.error('[paopao-webhook] readSheet ACH 失敗:', err?.message);
      await replyText(event.replyToken, CUSTOMER_FALLBACK_MSG);
      return;
    }
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const pVal = row[15] != null ? String(row[15]).trim() : '';
      const bVal = row[1] != null ? String(row[1]).trim() : '';
      if (pVal === odooId && (!storeNameFromPostback || bVal === storeNameFromPostback || bVal.includes(storeNameFromPostback) || storeNameFromPostback.includes(bVal))) {
        rowIndex = i + 1;
        resolvedStoreName = bVal || storeNameFromPostback;
        break;
      }
    }
    if (rowIndex < 0) {
      await replyText(event.replyToken, `⚠️ 找不到符合的資料列（單號: ${odooId}${storeNameFromPostback ? '，店名: ' + storeNameFromPostback : ''}）`);
      return;
    }
    // Check existing G column from Sheet
    let sheetRows;
    try { sheetRows = await readSheet(authClient, EXTERNAL_SS_ID, `'${ACH_SHEET_NAME}'!G${rowIndex}`); } catch {}
    const existingG = sheetRows?.[0]?.[0];
    if (existingG && String(existingG).trim()) {
      await replyText(event.replyToken, `⚠️ ${userName} 您好，\n這筆資料已經確認過囉！\n\n紀錄：\n${existingG}`);
      return;
    }
  }

  // ─── 寫入確認 (DB only — DB is source of truth, Sheet G 欄不再同步) ───
  const now = formatTaiwanDateTime(new Date());
  const confirmText = `${now} 由 ${userName} 確認`;

  try {
    const { Pool } = await import('pg');
    const dbPool = new Pool({ host: '/tmp', database: 'paomao', user: 'paopaomao' });
    if (resolvedDbId) {
      await dbPool.query(
        'UPDATE ach_records SET customer_confirmed = $1 WHERE id = $2 AND year = 2026',
        [confirmText, resolvedDbId]
      );
    } else {
      await dbPool.query(
        'UPDATE ach_records SET customer_confirmed = $1 WHERE sheet_row = $2 AND year = 2026',
        [confirmText, rowIndex]
      );
    }
    await dbPool.end();
    console.log(`[paopao-webhook] ✅ ACH confirmed: dbId=${resolvedDbId || '?'} sheetRow=${rowIndex} by ${userName}`);
  } catch (dbErr) {
    console.error('[paopao-webhook] DB write failed:', dbErr?.message);
    await replyText(event.replyToken, CUSTOMER_FALLBACK_MSG);
    return;
  }

  // 3. Reply + receipt
  await replyText(event.replyToken, '✅ 已確認，謝謝！');
  try {
    await pushFlexReceipt(targetId, resolvedStoreName, resolvedDbId || odooId, userName);
  } catch (e) {
    console.error('[paopao-webhook] pushFlexReceipt failed:', e?.message);
  }
}

export async function handlePaopaoWebhook(req, res, { authClient, rawBody }) {
  if (!PAOPAO_STORE_SS_ID) {
    sendJson(res, 200, { status: 'error', message: 'PAOPAO_STORE_SS_ID missing' });
    return;
  }

  // If this is a non-LINE payload (cookie/token update), allow without signature.
  let body = null;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (body?.cookie) {
    await writeSheet(authClient, PAOPAO_STORE_SS_ID, "'安全庫存'!P1:Q1", [[String(body.cookie), new Date().toISOString()]]);
    sendJson(res, 200, { status: 'success', message: 'Cookie Updated' });
    return;
  }
  if (body?.token) {
    await writeSheet(authClient, PAOPAO_STORE_SS_ID, "'預約表單'!C2:D2", [[String(body.token), new Date().toISOString()]]);
    sendJson(res, 200, { status: 'success', message: 'Token Updated' });
    return;
  }

  const signature = String(req.headers['x-line-signature'] || '');
  if (!PAOPAO_CHANNEL_SECRET || !verifyLineSignature(rawBody, signature, PAOPAO_CHANNEL_SECRET)) {
    console.log('[paopao-webhook] signature verification failed, secret set:', !!PAOPAO_CHANNEL_SECRET);
    sendJson(res, 401, { status: 'unauthorized' });
    return;
  }
  console.log('[paopao-webhook] received events:', body?.events?.length || 0);

  const events = Array.isArray(body?.events) ? body.events : [];
  for (const event of events) {
    if (event?.type === 'postback' && event?.postback?.data) {
      const params = parsePostbackParams(event.postback.data);
      if (params.action === 'confirm') {
        await handleConfirmPostback(authClient, event);
      }
      continue;
    }
    if (event?.type === 'message' && event?.message?.type === 'text') {
      const text = String(event.message.text || '').trim();
      
      // 處理群組綁定請求：在 LINE 群組輸入「綁定群組」，自動抓 groupId 寫入 payees
      if (text.includes('綁定群組') && event.source?.type === 'group') {
        const groupId = event.source.groupId || '';
        const groupName = await fetchGroupName(groupId);
        if (groupId) {
          try {
            // 用群組名稱模糊匹配 payees（去掉「泡泡貓｜」前綴比對）
            const shortName = (groupName || '').replace(/^泡泡貓[｜|]/, '').replace(/店$/, '').trim();
            const { rows } = await pgPool.query(
              `SELECT p.id, p.payee_name, p.line_group_id, s.store_name
               FROM payees p LEFT JOIN stores s ON p.store_id = s.id
               WHERE s.store_name ILIKE $1 OR p.payee_name ILIKE $1
               LIMIT 5`,
              [`%${shortName}%`]
            );
            if (rows.length === 1) {
              await pgPool.query('UPDATE payees SET line_group_id = $1 WHERE id = $2', [groupId, rows[0].id]);
              await replyText(event.replyToken, `✅ 已綁定群組\n\n群組名稱：${groupName}\n群組 ID：${groupId}\n對應代付戶：${rows[0].payee_name}\n門市：${rows[0].store_name || '-'}`);
            } else if (rows.length > 1) {
              const list = rows.map(r => `• ${r.payee_name} (${r.store_name || '-'})`).join('\n');
              await replyText(event.replyToken, `⚠️ 找到多個匹配的代付戶，請手動在 Dashboard 設定：\n\n${list}\n\n群組 ID：${groupId}`);
            } else {
              await replyText(event.replyToken, `⚠️ 找不到匹配的代付戶\n\n群組名稱：${groupName}\n群組 ID：${groupId}\n\n請在 Dashboard 門市管理 → 代收代付 手動設定此 ID`);
            }
          } catch (e) {
            console.error('[bind-group] DB error:', e.message);
            await replyText(event.replyToken, `群組 ID：${groupId}\n（DB 寫入失敗，請手動設定）`);
          }
        }
        continue;
      }

      // 處理刪單請求
      if (await handleDeleteOrder(event)) {
        continue; // 已處理刪單，跳過其他處理
      }
      
      if (text.includes('店家回覆狀態')) {
        try {
          if (!LINE_STORE_SS_ID) {
            await replyText(event.replyToken, '店家回覆狀態需設定 LINE_STORE_SS_ID（各店訊息一覽表），請聯繫管理員。');
          } else {
            const result = await getDirectStoreReplyStatusText(authClient, LINE_STORE_SS_ID);
            const replyMsg = result.ok ? result.text : (result.message || '無法取得店家回覆狀態，請稍後再試。');
            await replyText(event.replyToken, replyMsg);
          }
        } catch (err) {
          const fallback = '查詢店家回覆狀態時發生錯誤，請稍後再試或聯繫管理員。';
          await replyText(event.replyToken, fallback).catch(() => {});
        }
      }
    }
  }

  // Log text messages into PAOPAO 試算表（PAOPAO_STORE_SS_ID）的工作表「訊息一覽」
  // 試算表範例：https://docs.google.com/spreadsheets/d/1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE/edit
  // 該試算表內必須有名為「訊息一覽」的工作表，且 Cloud Run 的 Service Account 需有編輯權限
  // C 欄「群組」寫入 LINE 群組真實名稱，不寫 UUID
  const PAOPAO_MESSAGE_SHEET_NAME = '訊息一覽';
  const logRows = [];
  for (const event of events) {
    if (event?.type !== 'message' || event?.message?.type !== 'text') continue;
    const userId = String(event?.source?.userId || '').trim();
    const msg = String(event?.message?.text || '');
    const replyToken = String(event?.replyToken || '').trim();
    const sourceType = String(event?.source?.type || 'user');
    let sourceName;
    if (sourceType === 'group') {
      const groupId = String(event?.source?.groupId || '');
      const groupName = await fetchGroupName(groupId);
      sourceName = groupName ? `[群] ${groupName}` : '[群] 未知群組';
    } else if (sourceType === 'room') {
      sourceName = `[聊天室] ${String(event?.source?.roomId || '')}`;
    } else {
      sourceName = '個人私訊';
    }
    const userName = await fetchDisplayName(userId);
    logRows.push([new Date().toISOString(), replyToken, sourceName, userName, msg, event?.source?.groupId || '', event?.source?.roomId || '']);
  }
  for (const row of logRows) {
    await appendSheet(authClient, PAOPAO_STORE_SS_ID, PAOPAO_MESSAGE_SHEET_NAME, row);
  }

  sendJson(res, 200, { status: 'ok' });
}

