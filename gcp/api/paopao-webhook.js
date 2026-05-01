import fetch from 'node-fetch';
import { Pool } from 'pg';
import { verifyLineSignature } from '../lib/line-webhook.js';
import { appendSheet, readSheet, writeSheet, batchUpdateValues } from '../lib/sheets.js';
import { getDirectStoreReplyStatusText } from '../lib/store-reply-status.js';
import { sendAdminLinePush } from '../lib/line-push.js';
import { sendJson } from './http-utils.js';
import { odooCall } from '../lib/odoo.js';

import fs from 'fs';

// PostgreSQL connection for delete orders
const pgPool = new Pool({ database: 'paomao', host: 'localhost', port: 5432, max: 5 });
pgPool.on('error', (err) => console.error('[paopao-webhook] Pool idle client error:', err.message));

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

async function replyText(replyToken, text, userId) {
  if (!PAOPAO_TOKEN) return;
  const msg = [{ type: 'text', text: String(text || '') }];
  // 先嘗試 reply，失敗則 fallback 到 push
  if (replyToken) {
    try {
      const res = await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'post',
        headers: { Authorization: `Bearer ${PAOPAO_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ replyToken, messages: msg }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return;
      const errBody = await res.text().catch(() => '');
      // Invalid reply token → fallback push
      if (errBody.includes('Invalid reply token') && userId) {
        console.warn(`[line] reply token 過期，fallback push to ${userId}`);
      } else {
        console.error(`[line] reply failed ${res.status}: ${errBody.substring(0, 100)}`);
        return;
      }
    } catch (e) {
      if (userId) {
        console.warn(`[line] reply error (${e.message}), fallback push to ${userId}`);
      } else {
        console.error(`[line] reply error: ${e.message}`);
        return;
      }
    }
  }
  // Fallback: push message
  if (userId) {
    try {
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'post',
        headers: { Authorization: `Bearer ${PAOPAO_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: userId, messages: msg }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (pushErr) {
      console.error(`[line] push fallback failed: ${pushErr.message}`);
    }
  }
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
      data.customerName = line.replace(/.*客人姓名\s*[：:]\s*/, '').trim();
    } else if (line.includes('訂單編號')) {
      data.orderId = line.replace(/.*訂單編號\s*[：:]\s*/, '').trim();
    } else if (line.includes('需刪除的原因') || line.includes('刪除原因')) {
      // ⚠️ 「需刪除的原因」必須在「電話」之前判斷，因為原因內容可能包含「電話」二字
      data.reason = line.replace(/.*(?:需刪除的原因|刪除原因)\s*[：:]\s*/, '').trim();
    } else if (/電話|手機/.test(line)) {
      const phoneStr = line.replace(/.*(?:電話|手機)\s*[：:]\s*/, '').trim();
      // 只取數字部分（防止後面夾雜文字）
      const phoneMatch = phoneStr.match(/^(0\d{8,9})/);
      data.phone = phoneMatch ? phoneMatch[1] : phoneStr;
    } else if (line.includes('金額')) {
      const amountStr = line.replace(/.*金額\s*[：:]\s*/, '').replace(/[^\d.-]/g, '');
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
    const memberId = member.membid || member.id || member._id || '';
    
    // 查交易記錄（用 membid，比姓名精準）
    const transRes = await fetch(`${SAYDOU_API}/api/management/finance/transaction?keyword=&membid=${memberId}&page=0&limit=50&sort=ordrsn&order=desc`, {
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
    
    // 最後手段：直接用訂單編號搜交易（不依賴 membid，處理手機號碼錯誤的情況）
    if (orderId) {
      console.log('[delete-order] membid 查不到，改用 ordrsn 直接搜:', orderId);
      try {
        const directRes = await fetch(`${SAYDOU_API}/api/management/finance/transaction?keyword=${encodeURIComponent(orderId)}&page=0&limit=10&sort=ordrsn&order=desc`, {
          headers, signal: AbortSignal.timeout(20000)
        });
        const directData = await directRes.json();
        const directItems = directData?.data?.items || directData?.data || [];
        // ordrsn 可能有重複（不同門市/會員），需要用姓名+金額輔助比對
        const exactMatches = directItems.filter(t =>
          t.ordrsn && String(t.ordrsn) === String(orderId)
        );
        let directMatch = null;
        if (exactMatches.length === 1) {
          directMatch = exactMatches[0];
        } else if (exactMatches.length > 1) {
          // 多筆同 ordrsn，優先比對：客人姓名 > 金額
          directMatch = exactMatches.find(t => t.memnam === customerName) 
            || exactMatches.find(t => {
              const amt = parseFloat(t.rprice || t.price_ || 0);
              // 找到金額和申請者提供的一致的（如果有提供金額的話）
              return amt > 0 && exactMatches.filter(x => parseFloat(x.rprice || x.price_ || 0) === amt).length === 1;
            })
            || exactMatches[0]; // fallback 取第一筆
          console.log('[delete-order] ordrsn 有', exactMatches.length, '筆重複, 選 ordcid:', directMatch.ordcid, 'memnam:', directMatch.memnam);
        }
        if (directMatch) {
          const nameMatch = directMatch.memnam === customerName;
          console.log('[delete-order] 用 ordrsn 直接找到! ordcid:', directMatch.ordcid, 'membid:', directMatch.membid, 'nameMatch:', nameMatch);
          return {
            found: true,
            type: 'transaction',
            memberId: String(directMatch.membid),
            ordcid: String(directMatch.ordcid),
            ordrsn: String(directMatch.ordrsn || ''),
            transactionData: directMatch,
            actualAmount: parseFloat(directMatch.rprice || directMatch.price_ || directMatch.total || directMatch.amount || 0),
            storeName: directMatch.stor?.stonam || '',
            note: nameMatch ? '' : `⚠️ 手機號碼與訂單會員不同（訂單會員：${directMatch.memnam}），請確認`
          };
        }
      } catch (e) {
        console.error('[delete-order] direct ordrsn search error:', e.message);
      }
    }

    return { found: false, reason: 'order_not_matched' };
    
  } catch (error) {
    console.error('[delete-order] searchSayDouOrder error:', error.message);
    return { found: false, reason: 'api_error', error: error.message };
  }
}

/** IG Story 空位：每日每店限用一次的 rate limit */
const slotStoryDailyUsage = new Map(); // key: "YYYY-MM-DD:storeName" → true

/** 處理「幫我發送空位」請求 */
async function handleSlotStoryRequest(event) {
  const text = String(event?.message?.text || '').trim();
  // 格式：【幫我發送空位：竹北光明店】或 幫我發送空位：竹北光明
  const match = text.match(/幫我發送空位[：:](.+)/);
  if (!match) return false;

  const rawStoreName = match[1].replace(/[【】\s]/g, '').replace(/店$/, '').trim();
  if (!rawStoreName) {
    await replyText(event.replyToken, '⚠️ 請指定店名\n\n格式：幫我發送空位：竹北光明店', event.source?.userId);
    return true;
  }

  // 權限檢查：只有該店關聯的群組才能發送
  const sourceGroupId = event?.source?.groupId;
  if (!sourceGroupId) {
    // 個人聊天一律擋掉，已讀不回
    return true;
  }
  // 群組：檢查是否為該店的群組
  try {
    const { rows } = await pgPool.query(
      `SELECT s.store_name FROM stores s
       JOIN payee_stores ps ON ps.store_id = s.id
       JOIN payees p ON p.id = ps.payee_id
       WHERE p.line_group_id = $1
       AND s.store_name ILIKE $2`,
      [sourceGroupId, `%${rawStoreName}%`]
    );
    if (rows.length === 0) {
      // 沒關聯的群組：已讀不回
      return true;
    }
  } catch (e) {
    console.error('[slot-story] group check error:', e.message);
    return true;
  }

  // Rate limit: 一天一店一次
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const rateKey = `${today}:${rawStoreName}`;
  if (slotStoryDailyUsage.has(rateKey)) {
    await replyText(event.replyToken, `⚠️ ${rawStoreName}店 今天已經發送過空位 Story 了\n\n每間店每天限發一次`, event.source?.userId);
    return true;
  }

  // 回覆「處理中」
  await replyText(event.replyToken, `⏳ 正在查詢 ${rawStoreName}店 空位並產生 IG Story...`, event.source?.userId);

  try {
    const { execSync } = await import('child_process');
    const result = execSync(
      `cd ${process.env.HOME}/paomao-gcp/gcp && GOOGLE_APPLICATION_CREDENTIALS=${process.env.HOME}/.openclaw/secrets/gcp-service-account.json /opt/homebrew/bin/node scripts/ig_story_slots.mjs --store "${rawStoreName}"`,
      { encoding: 'utf8', timeout: 90000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: '/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/bin:/bin' } }
    );
    
    console.log('[slot-story]', result);
    
    const source = event.source || {};
    const targetId = source.groupId || source.roomId || source.userId;

    // 檢查是否滿位
    const fullMatch = result.match(/FULL:(.+)/);
    if (fullMatch) {
      if (targetId && PAOPAO_TOKEN) {
        await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PAOPAO_TOKEN}` },
          body: JSON.stringify({
            to: targetId,
            messages: [{ type: 'text', text: `🎉 ${rawStoreName}店 今明兩天都滿了，很棒！` }]
          })
        });
      }
      return true;
    }

    // 有空位 → 產圖預覽（不直接發 IG）
    const previewMatch = result.match(/PREVIEW:(.+)/);
    const previewUrl = previewMatch ? previewMatch[1].trim() : null;

    slotStoryDailyUsage.set(rateKey, true);
    
    if (targetId && PAOPAO_TOKEN && previewUrl) {
      const flexMsg = {
        type: 'flex',
        altText: `📋 ${rawStoreName}店 空位預覽`,
        contents: {
          type: 'bubble',
          hero: {
            type: 'image',
            url: previewUrl,
            size: 'full',
            aspectRatio: '9:16',
            aspectMode: 'cover'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'text', text: `📋 ${rawStoreName}店 空位預覽`, weight: 'bold', size: 'md' },
              { type: 'text', text: '確認沒問題後，按下方按鈕發布到 IG Story', size: 'xs', color: '#888888', margin: 'sm', wrap: true }
            ]
          },
          footer: {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#008BD5',
                action: { type: 'postback', label: '✅ 發布到 IG', data: `action=publish_story&store=${encodeURIComponent(rawStoreName)}&url=${encodeURIComponent(previewUrl)}`, displayText: `發布 ${rawStoreName}店 空位到 IG` }
              },
              {
                type: 'button',
                style: 'secondary',
                action: { type: 'postback', label: '❌ 取消', data: `action=cancel_story&store=${encodeURIComponent(rawStoreName)}`, displayText: '取消發布' }
              }
            ]
          }
        }
      };
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PAOPAO_TOKEN}` },
        body: JSON.stringify({ to: targetId, messages: [flexMsg] })
      });
    }
  } catch (e) {
    console.error('[slot-story] error:', JSON.stringify({ message: e.message?.slice(0,200), status: e.status, stderr: e.stderr?.slice(0,300), stdout: e.stdout?.slice(0,300) }));
    const source = event.source || {};
    const targetId = source.groupId || source.roomId || source.userId;
    const rawErr = (e.stderr || e.message || '').replace(/\[auth\][^\n]*/g, '').trim();
    const errMsg = `❌ 空位查詢失敗：${rawErr.slice(0, 80) || '系統錯誤'}`;
    if (targetId && PAOPAO_TOKEN) {
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PAOPAO_TOKEN}` },
        body: JSON.stringify({ to: targetId, messages: [{ type: 'text', text: errMsg }] })
      });
    }
  }
  return true;
}

/** 處理「發布空位 Story」postback */
async function handlePublishStoryPostback(event, params) {
  const storeName = decodeURIComponent(params.store || '');
  const imageUrl = decodeURIComponent(params.url || '');
  
  if (!imageUrl) {
    await replyText(event.replyToken, '❌ 找不到預覽圖片 URL', event.source?.userId);
    return;
  }

  await replyText(event.replyToken, `⏳ 正在發布 ${storeName}店 空位到 IG Story...`, event.source?.userId);

  try {
    const META_TOKEN = fs.readFileSync(`${process.env.HOME}/.openclaw/secrets/meta-token.txt`, 'utf8').trim();
    const IG_USER_ID = '17841463367279845';

    // Create container
    const createRes = await fetch(`https://graph.facebook.com/v21.0/${IG_USER_ID}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_type: 'STORIES', image_url: imageUrl, access_token: META_TOKEN })
    });
    const createData = await createRes.json();
    if (!createData.id) throw new Error(`Container 失敗: ${JSON.stringify(createData).slice(0, 100)}`);

    // Wait for processing
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const s = await (await fetch(`https://graph.facebook.com/v21.0/${createData.id}?fields=status_code&access_token=${META_TOKEN}`)).json();
      if (s.status_code === 'FINISHED') break;
      if (s.status_code === 'ERROR') throw new Error('圖片處理失敗');
    }

    // Publish
    const pubData = await (await fetch(`https://graph.facebook.com/v21.0/${IG_USER_ID}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: createData.id, access_token: META_TOKEN })
    })).json();

    if (!pubData.id) throw new Error(`發布失敗: ${JSON.stringify(pubData).slice(0, 100)}`);

    // Push success
    const source = event.source || {};
    const targetId = source.groupId || source.roomId || source.userId;
    if (targetId && PAOPAO_TOKEN) {
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PAOPAO_TOKEN}` },
        body: JSON.stringify({ to: targetId, messages: [{ type: 'text', text: `✅ ${storeName}店 空位 Story 已發布到 @paopaomao_ IG！\nStory ID: ${pubData.id}` }] })
      });
    }
  } catch (e) {
    console.error('[publish-story]', e.message);
    const source = event.source || {};
    const targetId = source.groupId || source.roomId || source.userId;
    if (targetId && PAOPAO_TOKEN) {
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PAOPAO_TOKEN}` },
        body: JSON.stringify({ to: targetId, messages: [{ type: 'text', text: `❌ 發布失敗：${e.message}` }] })
      });
    }
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
    await replyText(event.replyToken, '⚠️ 刪單資訊不完整，請確認格式：\n客人姓名、訂單編號、電話 必填', event.source?.userId);
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
    await replyText(event.replyToken, '❌ 查無此筆訂單，麻煩再提供正確資料。', event.source?.userId);
    return true;
  }
  
  // 金額僅記錄，不擋審核
  if (deleteData.amount && searchResult.actualAmount && deleteData.amount !== searchResult.actualAmount) {
    console.log('[delete-order] 金額不符但不擋: 提供=', deleteData.amount, '系統=', searchResult.actualAmount);
  }
  
  // 檢查是否已有相同訂單的刪單請求（防重複）
  try {
    const { rows: existing } = await pgPool.query(
      "SELECT id, status FROM delete_orders WHERE order_id = $1 AND phone = $2 AND status IN ('pending', 'deleted')",
      [deleteData.orderId, deleteData.phone]
    );
    if (existing.length > 0) {
      const e = existing[0];
      if (e.status === 'deleted') {
        await replyText(event.replyToken, `ℹ️ 訂單 ${deleteData.orderId} 已刪除完成，無需重複處理。`, event.source?.userId);
      } else {
        await replyText(event.replyToken, `ℹ️ 訂單 ${deleteData.orderId} 已在審核中，請勿重複提交。`, event.source?.userId);
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
    
    await replyText(event.replyToken, '泡泡貓會計正在審核中，請稍後。', event.source?.userId);

    // 通知 TG 辦公室群有新的刪單待處理
    const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || (() => { try { return fs.readFileSync(`${process.env.HOME}/.openclaw/secrets/tg-bot-token.txt`, 'utf8').trim(); } catch { return ''; } })();
    const noteLine = searchResult.note ? `\n⚠️ ${searchResult.note}` : '';
    const tgMsg = `📋 新刪單申請\n客人：${deleteData.customerName}\n訂單：${deleteData.orderId}\n金額：$${deleteData.amount || searchResult.actualAmount}\n門市：${searchResult.storeName || sourceGroupName}\n申請人：${requestedBy}\n原因：${deleteData.reason || '未提供'}${noteLine}\n\n👉 請至 dashboard.paopaomao.tw/hq 確認刪除`;
    try {
      await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: '-5220564261', text: tgMsg })
      });
    } catch (tgErr) { console.error('[delete-order] TG notify error:', tgErr.message); }
    
  } catch (dbError) {
    await replyText(event.replyToken, '❌ 系統錯誤，請稍後再試。', event.source?.userId);
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
    await replyText(event.replyToken, '⚠️ 無法取得單號，請重試。', event.source?.userId);
    return;
  }
  if (!EXTERNAL_SS_ID) {
    await replyText(event.replyToken, CUSTOMER_FALLBACK_MSG, event.source?.userId);
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
      // Using shared pgPool
      const { rows: dbRows } = await pgPool.query(
        'SELECT store_name, customer_confirmed FROM ach_records WHERE id = $1 AND year = 2026', [dbId]
      );
      if (dbRows.length === 0) {
        await replyText(event.replyToken, `⚠️ 找不到單號 ${dbId} 的資料。`, event.source?.userId);
        return;
      }
      if (dbRows[0].customer_confirmed && String(dbRows[0].customer_confirmed).trim()) {
        await replyText(event.replyToken, `⚠️ ${userName} 您好，\n這筆資料已經確認過囉！\n\n紀錄：\n${dbRows[0].customer_confirmed}`, event.source?.userId);
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
      await replyText(event.replyToken, CUSTOMER_FALLBACK_MSG, event.source?.userId);
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
      await replyText(event.replyToken, `⚠️ 找不到符合的資料列（單號: ${odooId}${storeNameFromPostback ? '，店名: ' + storeNameFromPostback : ''}）`, event.source?.userId);
      return;
    }
    // Check existing G column from Sheet
    let sheetRows;
    try { sheetRows = await readSheet(authClient, EXTERNAL_SS_ID, `'${ACH_SHEET_NAME}'!G${rowIndex}`); } catch {}
    const existingG = sheetRows?.[0]?.[0];
    if (existingG && String(existingG).trim()) {
      await replyText(event.replyToken, `⚠️ ${userName} 您好，\n這筆資料已經確認過囉！\n\n紀錄：\n${existingG}`, event.source?.userId);
      return;
    }
  }

  // ─── 寫入確認 (DB only — DB is source of truth, Sheet G 欄不再同步) ───
  const now = formatTaiwanDateTime(new Date());
  const confirmText = `${now} 由 ${userName} 確認`;

  try {
    // Using shared pgPool
    if (resolvedDbId) {
      await pgPool.query(
        'UPDATE ach_records SET customer_confirmed = $1 WHERE id = $2 AND year = 2026',
        [confirmText, resolvedDbId]
      );
    } else {
      await pgPool.query(
        'UPDATE ach_records SET customer_confirmed = $1 WHERE sheet_row = $2 AND year = 2026',
        [confirmText, rowIndex]
      );
    }
    console.log(`[paopao-webhook] ✅ ACH confirmed: dbId=${resolvedDbId || '?'} sheetRow=${rowIndex} by ${userName}`);
  } catch (dbErr) {
    console.error('[paopao-webhook] DB write failed:', dbErr?.message);
    await replyText(event.replyToken, CUSTOMER_FALLBACK_MSG, event.source?.userId);
    return;
  }

  // 3. Odoo actions: SO confirm / PO vendor bill
  try {
    // Using shared pgPool
    const { rows: achRows } = await pgPool.query(
      'SELECT odoo_quote_id, fee_type FROM ach_records WHERE id = $1 AND year = 2026', [resolvedDbId]
    );

    const quoteId = achRows[0]?.odoo_quote_id;
    if (quoteId && String(quoteId).trim()) {
      // odooCall imported from ../lib/odoo.js

      if (quoteId.startsWith('S')) {
        // Sale Order → confirm → create invoice → post → get INV number
        const soIds = await odooCall('sale.order', 'search', [[['name', '=', quoteId]]]);
        if (soIds && soIds.length > 0) {
          const so = await odooCall('sale.order', 'read', [soIds[0]], { fields: ['state', 'invoice_ids'] });
          // Step 1: Confirm SO if draft/sent
          if (so[0].state === 'draft' || so[0].state === 'sent') {
            await odooCall('sale.order', 'action_confirm', [soIds]);
            console.log(`[paopao-webhook] ✅ Odoo SO ${quoteId} confirmed (was ${so[0].state})`);
          } else {
            console.log(`[paopao-webhook] SO ${quoteId} already in state: ${so[0].state}`);
          }
          // Step 2: Create invoice if none exists
          let invName = quoteId;
          const soAfter = await odooCall('sale.order', 'read', [soIds[0]], { fields: ['invoice_ids'] });
          let invoiceIds = soAfter[0].invoice_ids || [];
          if (invoiceIds.length === 0) {
            try {
              const wizardId = await odooCall('sale.advance.payment.inv', 'create', [{
                advance_payment_method: 'delivered'
              }], { context: { active_ids: soIds, active_model: 'sale.order' } });
              await odooCall('sale.advance.payment.inv', 'create_invoices', [wizardId], { context: { active_ids: soIds, active_model: 'sale.order' } });
              const soInv = await odooCall('sale.order', 'read', [soIds[0]], { fields: ['invoice_ids'] });
              invoiceIds = soInv[0].invoice_ids || [];
              console.log(`[paopao-webhook] ✅ Invoice created for ${quoteId}`);
            } catch (invErr) {
              console.error(`[paopao-webhook] ⚠️ Invoice creation failed for ${quoteId}: ${invErr.message?.slice(0, 200)}`);
            }
          }
          // Step 3: Post invoice to get INV number
          if (invoiceIds.length > 0) {
            const lastInvId = invoiceIds[invoiceIds.length - 1];
            const inv = await odooCall('account.move', 'read', [lastInvId], { fields: ['name', 'state'] });
            if (inv[0].state === 'draft') {
              try {
                await odooCall('account.move', 'action_post', [[lastInvId]]);
                const invPosted = await odooCall('account.move', 'read', [lastInvId], { fields: ['name'] });
                invName = invPosted[0].name || quoteId;
                console.log(`[paopao-webhook] ✅ Invoice posted: ${invName}`);
              } catch (postErr) {
                console.error(`[paopao-webhook] ⚠️ Invoice post failed for ${quoteId}: ${postErr.message?.slice(0, 200)}`);
                invName = inv[0].name || quoteId;
              }
            } else {
              invName = inv[0].name || quoteId;
            }
          }
          // Write INV number to DB
          // Using shared pgPool
          await pgPool.query(
            'UPDATE ach_records SET odoo_invoice_id = $1 WHERE id = $2 AND year = 2026',
            [invName, resolvedDbId]
          );
        }
      } else if (quoteId.startsWith('P')) {
        // Purchase Order → create vendor bill → post → get BILL number
        const poIds = await odooCall('purchase.order', 'search', [[['name', '=', quoteId]]]);
        if (poIds && poIds.length > 0) {
          const po0 = await odooCall('purchase.order', 'read', [poIds[0]], { fields: ['invoice_ids'] });
          let billIds = po0[0]?.invoice_ids || [];
          // Create vendor bill if none exists
          if (billIds.length === 0) {
            await odooCall('purchase.order', 'action_create_invoice', [poIds]);
            const po1 = await odooCall('purchase.order', 'read', [poIds[0]], { fields: ['invoice_ids'] });
            billIds = po1[0]?.invoice_ids || [];
          }
          let billName = quoteId;
          if (billIds.length > 0) {
            const lastBillId = billIds[billIds.length - 1];
            const bill = await odooCall('account.move', 'read', [lastBillId], { fields: ['name', 'state'] });
            // Post if draft
            if (bill[0].state === 'draft') {
              try {
                const today = new Date().toISOString().slice(0, 10);
                await odooCall('account.move', 'write', [[lastBillId], { invoice_date: today }]);
                await odooCall('account.move', 'action_post', [[lastBillId]]);
                const billPosted = await odooCall('account.move', 'read', [lastBillId], { fields: ['name'] });
                billName = billPosted[0]?.name || quoteId;
              } catch (postErr) {
                console.error(`[paopao-webhook] ⚠️ Bill post failed for ${quoteId}: ${postErr.message?.slice(0, 200)}`);
                billName = bill[0]?.name || quoteId;
              }
            } else {
              billName = bill[0]?.name || quoteId;
            }
          }
          console.log(`[paopao-webhook] ✅ Odoo PO ${quoteId} vendor bill: ${billName}`);
          // Write bill name to O column
          // Using shared pgPool
          await pgPool.query(
            'UPDATE ach_records SET odoo_invoice_id = $1 WHERE id = $2 AND year = 2026',
            [billName, resolvedDbId]
          );
        }
      }
    }
  } catch (odooErr) {
    // Odoo errors should NOT block the confirm flow — log and continue
    console.error('[paopao-webhook] Odoo action failed (non-blocking):', odooErr?.message);
  }

  // 4. Reply + receipt
  await replyText(event.replyToken, '✅ 已確認，謝謝！', event.source?.userId);
  try {
    await pushFlexReceipt(targetId, resolvedStoreName, resolvedDbId || odooId, userName);
  } catch (e) {
    console.error('[paopao-webhook] pushFlexReceipt failed:', e?.message);
  }
}

/** 直營店「正確」按鈕 postback：直接在 Odoo 登記付款 (sale → paid)
 *  postback data: action=direct_confirm&odooOrder=S01234
 */
async function handleDirectConfirmPostback(event) {
  const params = parsePostbackParams(event?.postback?.data);
  if (params.action !== 'direct_confirm') return false;

  const odooOrder = params.odooOrder ? String(params.odooOrder).trim() : '';
  if (!odooOrder) {
    await replyText(event.replyToken, '⚠️ 無法取得訂單號碼。', event.source?.userId);
    return true;
  }

  const source = event.source || {};
  const userId = source.userId;
  let userName = await fetchDisplayNameInSource(userId, source);
  if (!userName) userName = '操作者';

  try {
    // odooCall imported from ../lib/odoo.js

    // 1. Find SO
    const soIds = await odooCall('sale.order', 'search', [[['name', '=', odooOrder]]]);
    if (!soIds || soIds.length === 0) {
      await replyText(event.replyToken, `⚠️ 找不到 Odoo 訂單 ${odooOrder}`, event.source?.userId);
      return true;
    }

    const so = await odooCall('sale.order', 'read', [soIds[0]], { fields: ['state'] });

    // 2. Confirm SO (draft/sent → sale)
    if (so[0].state === 'draft' || so[0].state === 'sent') {
      await odooCall('sale.order', 'action_confirm', [soIds]);
      console.log(`[direct-confirm] ✅ SO ${odooOrder} confirmed (was ${so[0].state})`);
    } else {
      console.log(`[direct-confirm] SO ${odooOrder} already in state: ${so[0].state}`);
    }

    await replyText(event.replyToken, `✅ ${odooOrder} 已確認，謝謝 ${userName}！`, event.source?.userId);
    console.log(`[direct-confirm] ✅ ${odooOrder} confirmed by ${userName}`);
  } catch (e) {
    console.error(`[direct-confirm] ❌ ${odooOrder} failed:`, e.message?.slice(0, 300));
    await replyText(event.replyToken, `⚠️ 處理失敗：${e.message?.slice(0, 100)}\n請通知總公司。`, event.source?.userId);
  }
  return true;
}

// Dedup: 防止 LINE webhook retry 重複觸發 so_confirm
const _soConfirmInProgress = new Set();
setInterval(() => _soConfirmInProgress.clear(), 60000); // 每 60 秒清一次

/** Dashboard「發送」按鈕 postback：action=so_confirm&orderId=xxx&orderName=S01xxx
 *  1. 在 ach_records 裡找對應紀錄（by odoo_quote_id = orderName）
 *  2. 寫 customer_confirmed
 *  3. Odoo 確認 SO + 開發票
 */
async function handleSOConfirmPostback(authClient, event) {
  const params = parsePostbackParams(event?.postback?.data);
  const orderId = params.orderId ? String(params.orderId).trim() : '';
  const orderName = params.orderName ? String(params.orderName).trim() : '';

  const source = event.source || {};
  const targetId = source.groupId || source.roomId || source.userId;
  const userId = source.userId;
  let userName = await fetchDisplayNameInSource(userId, source);
  if (!userName) userName = '操作者';

  if (!orderName) {
    await replyText(event.replyToken, '⚠️ 無法取得訂單號碼，請重試。', event.source?.userId);
    return;
  }

  // Dedup: 同一筆訂單 60 秒內不重複處理
  if (_soConfirmInProgress.has(orderName)) {
    console.log(`[paopao-webhook] so_confirm: ${orderName} dedup 跳過（重複 postback）`);
    return;
  }
  _soConfirmInProgress.add(orderName);

  let achRows = [];
  try {
    // Using shared pgPool

    // 找 ach_records by odoo_quote_id — 優先找「未確認」的那筆
    const dbResult = await pgPool.query(
      `SELECT id, store_name, customer_confirmed, odoo_invoice_id FROM ach_records 
       WHERE odoo_quote_id = $1 AND year = 2026 AND is_active = true
       ORDER BY CASE WHEN (customer_confirmed IS NULL OR TRIM(customer_confirmed) = '') THEN 0 ELSE 1 END, id DESC`,
      [orderName]
    );
    achRows = dbResult.rows;

    if (achRows.length > 0) {
      // 找到未確認的那筆
      const unconfirmed = achRows.find(r => !r.customer_confirmed || !String(r.customer_confirmed).trim());
      if (unconfirmed) {
        // 寫入確認
        const now = formatTaiwanDateTime(new Date());
        const confirmText = `${now} 由 ${userName} 確認`;
        await pgPool.query(
          'UPDATE ach_records SET customer_confirmed = $1 WHERE id = $2',
          [confirmText, unconfirmed.id]
        );
        console.log(`[paopao-webhook] ✅ so_confirm: ${orderName} (ach id=${unconfirmed.id}) by ${userName}`);
      } else {
        // 全部已確認 — 回覆已處理，不重複執行
        console.log(`[paopao-webhook] so_confirm: ${orderName} 所有 ach_records 已確認，跳過重複`);
        await replyText(event.replyToken, `ℹ️ ${orderName} 已經確認過囉，${userName}！`, event.source?.userId);
        return;
      }
    } else {
      console.log(`[paopao-webhook] so_confirm: ${orderName} 不在 ach_records 中，僅做 Odoo 確認`);
    }
  } catch (dbErr) {
    console.error('[paopao-webhook] so_confirm DB error:', dbErr?.message);
  }

  // 判斷 fee_type：服務費只留 sent，不做 Odoo confirm/invoice/ACH
  let feeType = '';
  try {
    const { rows: ftRows } = await pgPool.query(
      `SELECT fee_type FROM ach_records WHERE odoo_quote_id = $1 AND is_active = true ORDER BY id DESC LIMIT 1`,
      [orderName]
    );
    feeType = (ftRows[0]?.fee_type || '').trim();
  } catch (e) { /* ignore */ }

  if (feeType === '服務費') {
    // 服務費：做 Odoo confirm + create invoice + post，但不開 GiveMe 發票、不上傳 ACH
    try {
      const soIds = await odooCall('sale.order', 'search', [[['name', '=', orderName]]]);
      if (soIds && soIds.length > 0) {
        const so = await odooCall('sale.order', 'read', [soIds[0]], { fields: ['state', 'invoice_ids'] });

        // Step 1: Confirm SO (會自動處理貸記單連結)
        if (so[0].state === 'draft' || so[0].state === 'sent') {
          await odooCall('sale.order', 'action_confirm', [soIds]);
          console.log(`[so_confirm] ✅ 服務費 ${orderName} confirmed (was ${so[0].state})`);
        }

        // Step 2: Create Invoice
        let invoiceIds = so[0].invoice_ids || [];
        const soAfter = await odooCall('sale.order', 'read', [soIds[0]], { fields: ['invoice_ids'] });
        invoiceIds = soAfter[0].invoice_ids || [];
        if (invoiceIds.length === 0) {
          try {
            const wizardId = await odooCall('sale.advance.payment.inv', 'create', [{
              advance_payment_method: 'delivered'
            }], { context: { active_ids: soIds, active_model: 'sale.order' } });
            await odooCall('sale.advance.payment.inv', 'create_invoices', [wizardId], { context: { active_ids: soIds, active_model: 'sale.order' } });
            const soInv = await odooCall('sale.order', 'read', [soIds[0]], { fields: ['invoice_ids'] });
            invoiceIds = soInv[0].invoice_ids || [];
            console.log(`[so_confirm] ✅ 服務費 ${orderName} invoice created`);
          } catch (invErr) {
            console.error(`[so_confirm] ⚠️ 服務費 ${orderName} invoice creation failed: ${invErr.message?.slice(0, 200)}`);
          }
        }

        // Step 3: Post Invoice
        let invName = orderName;
        if (invoiceIds.length > 0) {
          const lastInvId = invoiceIds[invoiceIds.length - 1];
          const inv = await odooCall('account.move', 'read', [lastInvId], { fields: ['name', 'state'] });
          if (inv[0].state === 'draft') {
            try {
              await odooCall('account.move', 'action_post', [[lastInvId]]);
              const invPosted = await odooCall('account.move', 'read', [lastInvId], { fields: ['name'] });
              invName = invPosted[0].name || orderName;
              console.log(`[so_confirm] ✅ 服務費 ${orderName} invoice posted: ${invName}`);
            } catch (postErr) {
              console.error(`[so_confirm] ⚠️ 服務費 ${orderName} invoice post failed: ${postErr.message?.slice(0, 200)}`);
            }
          } else {
            invName = inv[0].name || orderName;
          }
        }

        // Step 3.5: 自動沖抵貸記單（服務費也適用）
        let creditNoteInfoSvc = '';
        if (invoiceIds.length > 0) {
          try {
            const lastInvIdSvc = invoiceIds[invoiceIds.length - 1];
            const invDataSvc = await odooCall('account.move', 'read', [lastInvIdSvc], { fields: ['partner_id', 'amount_residual', 'state'] });
            const partnerIdSvc = invDataSvc[0]?.partner_id?.[0];
            const invResidualSvc = invDataSvc[0]?.amount_residual || 0;

            if (partnerIdSvc && invResidualSvc > 0 && invDataSvc[0].state === 'posted') {
              const creditNotesSvc = await odooCall('account.move', 'search_read',
                [[['partner_id', '=', partnerIdSvc], ['move_type', '=', 'out_refund'], ['state', '=', 'posted'], ['amount_residual', '>', 0]]],
                { fields: ['id', 'name', 'amount_residual', 'ref'], order: 'date asc' }
              );
              if (creditNotesSvc.length > 0) {
                const invRecSvc = await odooCall('account.move.line', 'search_read',
                  [[['move_id', '=', lastInvIdSvc], ['account_type', '=', 'asset_receivable'], ['reconciled', '=', false]]],
                  { fields: ['id'] }
                );
                if (invRecSvc.length > 0) {
                  const appliedSvc = [];
                  for (const cn of creditNotesSvc) {
                    const cnRecSvc = await odooCall('account.move.line', 'search_read',
                      [[['move_id', '=', cn.id], ['account_type', '=', 'asset_receivable'], ['reconciled', '=', false]]],
                      { fields: ['id'] }
                    );
                    if (cnRecSvc.length > 0) {
                      try {
                        await odooCall('account.move.line', 'reconcile', [[invRecSvc[0].id, cnRecSvc[0].id]]);
                        appliedSvc.push(`${cn.name} ($${Math.abs(cn.amount_residual)})`);
                        console.log(`[so_confirm] ✅ 服務費貸記單沖抵: ${cn.name} → ${invName}`);
                      } catch (recErr) {
                        console.error(`[so_confirm] ⚠️ 服務費 reconcile ${cn.name} failed: ${recErr.message?.slice(0, 200)}`);
                      }
                    }
                  }
                  if (appliedSvc.length > 0) {
                    const invAfterSvc = await odooCall('account.move', 'read', [lastInvIdSvc], { fields: ['amount_residual'] });
                    const newAmtSvc = invAfterSvc[0]?.amount_residual || 0;
                    creditNoteInfoSvc = `\n已沖抵貸記單：${appliedSvc.join('、')}\n沖抵後應收餘額：$${newAmtSvc}`;
                    // 同步更新 ach_records 金額
                    if (newAmtSvc > 0) {
                      try {
                        await pgPool.query(
                          'UPDATE ach_records SET amount = $1 WHERE odoo_quote_id = $2 AND year = 2026 AND is_active = true',
                          [newAmtSvc, orderName]
                        );
                        console.log(`[so_confirm] ✅ 服務費 ach_records 金額更新: ${orderName} $${newAmtSvc}`);
                      } catch (e) { console.error(`[so_confirm] ach_records 金額更新失敗:`, e.message?.slice(0,100)); }
                    }
                  }
                }
              }
            }
          } catch (cnErrSvc) {
            console.error(`[so_confirm] ⚠️ 服務費貸記單沖抵失敗: ${cnErrSvc.message?.slice(0, 200)}`);
          }
        }

        // Step 4: Write INV to ach_records
        if (invName !== orderName && achRows?.length > 0) {
          try {
            await pgPool.query('UPDATE ach_records SET odoo_invoice_id = $1 WHERE odoo_quote_id = $2 AND year = 2026', [invName, orderName]);
            console.log(`[so_confirm] ✅ 服務費 ach_records: ${orderName} → ${invName}`);
          } catch (dbErr) { console.error(`[so_confirm] DB write INV failed: ${dbErr?.message}`); }
        }

        // Step 5: Chatter
        const now2 = formatTaiwanDateTime(new Date());
        await odooCall('sale.order', 'message_post', [soIds[0]], {
          body: `<p>✅ LINE 確認（服務費）：由 <b>${userName}</b> 於 ${now2} 點擊「正確」確認此訂單</p>${invName !== orderName ? `<p>📄 應收帳款：${invName}</p>` : ''}${creditNoteInfoSvc ? `<p>💰 ${creditNoteInfoSvc.replace(/\\n/g, '<br/>')}</p>` : ''}`,
          message_type: 'comment', subtype_xmlid: 'mail.mt_note'
        });
      }
      // ❌ 不開 GiveMe 電子發票、不上傳永豐 ACH
    } catch (odooErr) {
      console.error(`[so_confirm] 服務費 ${orderName} Odoo error:`, odooErr?.message?.slice(0, 200));
    }
    await replyText(event.replyToken, `✅ ${orderName} 已確認，謝謝 ${userName}！`, event.source?.userId);
    return;
  }

  // Odoo: 確認 SO (odooCall imported from ../lib/odoo.js)
  try {
    const soIds = await odooCall('sale.order', 'search', [[['name', '=', orderName]]]);
    let invName = orderName;
    if (soIds && soIds.length > 0) {
      const so = await odooCall('sale.order', 'read', [soIds[0]], { fields: ['state', 'invoice_ids', 'origin'] });

      // Step 1: Confirm SO (draft/sent → sale)
      if (so[0].state === 'draft' || so[0].state === 'sent') {
        await odooCall('sale.order', 'action_confirm', [soIds]);
        console.log(`[so_confirm] ✅ SO ${orderName} confirmed (was ${so[0].state})`);
      } else {
        console.log(`[so_confirm] SO ${orderName} already in state: ${so[0].state}`);
      }

      // Step 1.5: 維修單 — 如果 origin 是 ppm/RO/，把 repair.order 改為 confirmed
      const roOrigin = so[0].origin;
      if (roOrigin && roOrigin.startsWith('ppm/RO/')) {
        try {
          const roIds = await odooCall('repair.order', 'search', [[['name', '=', roOrigin]]]);
          if (roIds && roIds.length > 0) {
            const ro = await odooCall('repair.order', 'read', [roIds[0]], { fields: ['state'] });
            if (ro[0].state === 'draft') {
              await odooCall('repair.order', 'write', [roIds, { state: 'confirmed' }]);
              console.log(`[so_confirm] ✅ Repair order ${roOrigin} confirmed`);
            } else {
              console.log(`[so_confirm] Repair order ${roOrigin} already in state: ${ro[0].state}`);
            }
          }
        } catch (roErr) {
          console.error(`[so_confirm] ⚠️ Repair order confirm failed for ${roOrigin}: ${roErr.message?.slice(0, 200)}`);
        }

        // Step 1.6: Dashboard repair_orders — 更新狀態為 payment_received（可進行維修），通知維修群
        try {
          const { rows: roRows } = await pgPool.query(
            `UPDATE repair_orders SET status = 'payment_received', payment_status = 'paid', updated_at = NOW()
             WHERE odoo_so_name = $1 AND status IN ('quoted', 'confirmed')
             RETURNING id, order_number, store_name, equipment_type, fault_description`,
            [orderName]
          );
          if (roRows.length > 0) {
            const ro = roRows[0];
            console.log(`[so_confirm] ✅ Dashboard repair_orders ${ro.order_number} → payment_received (可進行維修)`);

            // 寫入進度記錄
            await pgPool.query(
              `INSERT INTO repair_progress (repair_order_id, status, description, technician_name)
               VALUES ($1, 'payment_received', $2, 'System')`,
              [ro.id, `客人已確認報價 (${orderName})，可進行維修`]
            ).catch(e => console.error('[so_confirm] repair_progress insert error:', e.message));

            // TG 通知維修群（泡泡貓維修 -1003466360577）
            const tgRepairMsg = `🔧 維修單可進行維修！\n\n📋 ${ro.order_number}\n🏪 ${ro.store_name}\n🔩 ${ro.equipment_type}\n📝 ${(ro.fault_description || '').slice(0, 60)}\n\n✅ 客人已確認報價 (${orderName})`;
            const TG_TOKEN = process.env.TG_BOT_TOKEN || (() => { try { return require('fs').readFileSync(`${process.env.HOME}/.openclaw/secrets/tg-bot-token.txt`, 'utf8').trim(); } catch { return ''; } })();
            if (TG_TOKEN) {
              await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: '-1003466360577', text: tgRepairMsg })
              }).catch(e => console.error('[so_confirm] TG repair notify error:', e.message));
            }
          }
        } catch (dbRoErr) {
          console.error(`[so_confirm] ⚠️ Dashboard repair_orders update failed: ${dbRoErr.message?.slice(0, 200)}`);
        }
      }

      // Step 2: Create invoice if none exists
      const soAfter = await odooCall('sale.order', 'read', [soIds[0]], { fields: ['invoice_ids'] });
      let invoiceIds = soAfter[0].invoice_ids || [];
      if (invoiceIds.length === 0) {
        try {
          const wizardId = await odooCall('sale.advance.payment.inv', 'create', [{
            advance_payment_method: 'delivered'
          }], { context: { active_ids: soIds, active_model: 'sale.order' } });
          await odooCall('sale.advance.payment.inv', 'create_invoices', [wizardId], { context: { active_ids: soIds, active_model: 'sale.order' } });
          const soInv = await odooCall('sale.order', 'read', [soIds[0]], { fields: ['invoice_ids'] });
          invoiceIds = soInv[0].invoice_ids || [];
          console.log(`[so_confirm] ✅ Invoice created for ${orderName}`);
        } catch (invErr) {
          console.error(`[so_confirm] ⚠️ Invoice creation failed for ${orderName}: ${invErr.message?.slice(0, 200)}`);
        }
      }

      // Step 3: Post invoice (draft → posted, 產生 INV 編號)
      if (invoiceIds.length > 0) {
        const lastInvId = invoiceIds[invoiceIds.length - 1];
        const inv = await odooCall('account.move', 'read', [lastInvId], { fields: ['name', 'state'] });
        if (inv[0].state === 'draft') {
          try {
            await odooCall('account.move', 'action_post', [[lastInvId]]);
            const invPosted = await odooCall('account.move', 'read', [lastInvId], { fields: ['name'] });
            invName = invPosted[0].name || orderName;
            console.log(`[so_confirm] ✅ Invoice posted: ${invName}`);
          } catch (postErr) {
            console.error(`[so_confirm] ⚠️ Invoice post failed for ${orderName}: ${postErr.message?.slice(0, 200)}`);
            invName = inv[0].name || orderName;
          }
        } else {
          invName = inv[0].name || orderName;
        }
      }

      // Step 3.5: 自動沖抵貸記單（credit notes）
      // ⚠️ 儲值金品項不能用貸記單，跳過沖抵
      let creditNoteInfo = '';
      const isStoredValue = feeType === '儲值金' || (achRows.length > 0 && achRows[0].fee_type === '儲值金');
      if (invoiceIds.length > 0 && !isStoredValue) {
        try {
          const lastInvId = invoiceIds[invoiceIds.length - 1];
          const invData = await odooCall('account.move', 'read', [lastInvId], { fields: ['partner_id', 'amount_residual', 'state'] });
          const partnerId = invData[0]?.partner_id?.[0];
          const invResidual = invData[0]?.amount_residual || 0;

          if (partnerId && invResidual > 0 && invData[0].state === 'posted') {
            // 查該 partner 的未使用貸記單
            const creditNotes = await odooCall('account.move', 'search_read',
              [[['partner_id', '=', partnerId], ['move_type', '=', 'out_refund'], ['state', '=', 'posted'], ['amount_residual', '>', 0]]],
              { fields: ['id', 'name', 'amount_residual', 'ref'], order: 'date asc' }
            );

            if (creditNotes.length > 0) {
              // 找發票的 receivable line
              const invReceivable = await odooCall('account.move.line', 'search_read',
                [[['move_id', '=', lastInvId], ['account_type', '=', 'asset_receivable'], ['reconciled', '=', false]]],
                { fields: ['id', 'amount_residual'] }
              );

              if (invReceivable.length > 0) {
                const invLineId = invReceivable[0].id;
                const appliedCNs = [];

                for (const cn of creditNotes) {
                  // 查貸記單的 receivable line
                  const cnReceivable = await odooCall('account.move.line', 'search_read',
                    [[['move_id', '=', cn.id], ['account_type', '=', 'asset_receivable'], ['reconciled', '=', false]]],
                    { fields: ['id', 'amount_residual'] }
                  );
                  if (cnReceivable.length > 0) {
                    try {
                      // Odoo reconcile: 把發票和貸記單的 receivable lines 配對
                      await odooCall('account.move.line', 'reconcile', [[invLineId, cnReceivable[0].id]]);
                      appliedCNs.push(`${cn.name} ($${Math.abs(cn.amount_residual)})`);
                      console.log(`[so_confirm] ✅ 貸記單沖抵: ${cn.name} ($${cn.amount_residual}) → ${invName}`);
                    } catch (recErr) {
                      console.error(`[so_confirm] ⚠️ reconcile ${cn.name} failed: ${recErr.message?.slice(0, 200)}`);
                    }
                  }
                }

                if (appliedCNs.length > 0) {
                  creditNoteInfo = `\n已沖抵貸記單：${appliedCNs.join('、')}`;
                  // 重新讀取發票餘額
                  const invAfter = await odooCall('account.move', 'read', [lastInvId], { fields: ['amount_residual'] });
                  const newAmount = invAfter[0]?.amount_residual || 0;
                  creditNoteInfo += `\n沖抵後應收餘額：$${newAmount}`;
                  console.log(`[so_confirm] ✅ 貸記單沖抵完成，剩餘: $${newAmount}`);

                  // 同步更新 ach_records 的金額（確保 ACH 扣款用沖抵後的金額）
                  if (newAmount > 0) {
                    try {
                      await pgPool.query(
                        'UPDATE ach_records SET amount = $1 WHERE odoo_quote_id = $2 AND year = 2026 AND is_active = true',
                        [newAmount, orderName]
                      );
                      console.log(`[so_confirm] ✅ ach_records 金額更新: ${orderName} $${newAmount}`);
                    } catch (achAmtErr) {
                      console.error(`[so_confirm] ⚠️ ach_records 金額更新失敗: ${achAmtErr.message?.slice(0, 100)}`);
                    }
                  }
                }
              }
            }
          }
        } catch (cnErr) {
          console.error(`[so_confirm] ⚠️ 貸記單沖抵失敗: ${cnErr.message?.slice(0, 200)}`);
        }
      }

      // Step 4: Write INV number to ach_records
      if (invName !== orderName && achRows && achRows.length > 0) {
        try {
          // Using shared pgPool
          await pgPool.query('UPDATE ach_records SET odoo_invoice_id = $1 WHERE odoo_quote_id = $2 AND year = 2026', [invName, orderName]);
          console.log(`[so_confirm] ✅ ach_records updated: ${orderName} → ${invName}`);
        } catch (dbErr2) {
          console.error(`[so_confirm] ⚠️ DB write INV failed: ${dbErr2?.message}`);
        }
      }

      // Step 5: Chatter 紀錄誰確認的
      const now2 = formatTaiwanDateTime(new Date());
      await odooCall('sale.order', 'message_post', [soIds[0]], {
        body: `<p>✅ LINE 確認：由 <b>${userName}</b> 於 ${now2} 點擊「正確」確認此訂單</p>${invName !== orderName ? `<p>📄 應收帳款：${invName}</p>` : ''}${creditNoteInfo ? `<p>💰 ${creditNoteInfo.replace(/\n/g, '<br/>')}</p>` : ''}`,
        message_type: 'comment',
        subtype_xmlid: 'mail.mt_note'
      });
      console.log(`[so_confirm] ✅ Chatter note added for ${orderName} by ${userName}`);
    }
  } catch (odooErr) {
    // Odoo errors non-blocking
    console.error(`[so_confirm] ❌ Odoo error for ${orderName}:`, odooErr?.message?.slice(0, 200));
  }

  await replyText(event.replyToken, `✅ ${orderName} 已確認，謝謝 ${userName}！`, event.source?.userId);
}

/** PO「正確」按鈕 postback：action=po_confirm&orderName=P00xxx */
async function handlePOConfirmPostback(event) {
  const params = parsePostbackParams(event?.postback?.data);
  const orderName = params.orderName ? String(params.orderName).trim() : '';
  const source = event.source || {};
  const userId = source.userId;
  let userName = await fetchDisplayNameInSource(userId, source);
  if (!userName) userName = '操作者';

  if (!orderName) {
    await replyText(event.replyToken, '⚠️ 無法取得訂單號碼，請重試。', event.source?.userId);
    return;
  }

  try {
    // Odoo: confirm PO
    const poIds = await odooCall('purchase.order', 'search', [[['name', '=', orderName]]]);
    if (poIds && poIds.length > 0) {
      const po = await odooCall('purchase.order', 'read', [poIds[0]], { fields: ['state'] });
      if (po[0].state === 'draft' || po[0].state === 'sent') {
        await odooCall('purchase.order', 'button_confirm', [poIds]);
        console.log(`[po_confirm] ✅ ${orderName} confirmed (was ${po[0].state}) by ${userName}`);
      } else {
        console.log(`[po_confirm] ${orderName} already ${po[0].state}`);
      }
    }
  } catch (odooErr) {
    console.error(`[po_confirm] ❌ Odoo error for ${orderName}:`, odooErr?.message?.slice(0, 200));
  }

  // 通知 TG
  try {
    const tgToken = require('fs').readFileSync('/Users/paopaomao/.openclaw/secrets/telegram-bot-token.txt', 'utf8').trim();
    await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: '-5220564261', text: `✅ PO ${orderName} 已確認 by ${userName}`, parse_mode: 'HTML' })
    });
  } catch(e) { /* ignore */ }

  await replyText(event.replyToken, `✅ ${orderName} 已確認，謝謝 ${userName}！`, event.source?.userId);
}

/** PO「有問題」按鈕 postback：action=po_dispute&orderName=P00xxx */
async function handlePODisputePostback(event) {
  const params = parsePostbackParams(event?.postback?.data);
  const orderName = params.orderName ? String(params.orderName).trim() : '';
  const source = event.source || {};
  const userId = source.userId;
  let userName = await fetchDisplayNameInSource(userId, source);
  if (!userName) userName = '操作者';

  // 通知 TG 辦公室群組
  try {
    const tgToken = require('fs').readFileSync('/Users/paopaomao/.openclaw/secrets/telegram-bot-token.txt', 'utf8').trim();
    await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: '-5220564261', text: `⚠️ PO ${orderName} 有問題！由 ${userName} 回報，請確認`, parse_mode: 'HTML' })
    });
  } catch(e) { /* ignore */ }

  await replyText(event.replyToken, `📝 ${orderName} 已標記為有問題，總公司會盡快確認，謝謝 ${userName}！`, event.source?.userId);
}

/** Dashboard「取消」按鈕 postback：action=so_cancel&orderId=xxx&orderName=S01xxx */
async function handleSOCancelPostback(event) {
  const params = parsePostbackParams(event?.postback?.data);
  const orderName = params.orderName ? String(params.orderName).trim() : '';
  const orderId = params.orderId ? parseInt(params.orderId) : 0;

  const source = event.source || {};
  const userId = source.userId;
  let userName = await fetchDisplayNameInSource(userId, source);
  if (!userName) userName = '操作者';

  // ═══ Odoo 取消訂單 ═══
  let odooResult = '';
  try {
    if (orderId) {
      // 先查訂單狀態
      const soState = await odooCall('sale.order', 'read', [orderId], { fields: ['state', 'name'] });
      if (soState && soState.length) {
        const state = soState[0].state;
        if (state === 'cancel') {
          odooResult = '\nℹ️ Odoo 訂單已是取消狀態';
        } else if (['draft', 'sent'].includes(state)) {
          await odooCall('sale.order', 'action_cancel', [[orderId]]);
          odooResult = '\n✅ Odoo 訂單已取消';
          console.log(`[so_cancel] ✅ ${orderName} (id=${orderId}) cancelled in Odoo (was ${state})`);
        } else if (state === 'sale') {
          // 已確認的訂單也可以取消
          await odooCall('sale.order', 'action_cancel', [[orderId]]);
          odooResult = '\n✅ Odoo 訂單已取消（原狀態：已確認）';
          console.log(`[so_cancel] ✅ ${orderName} (id=${orderId}) cancelled in Odoo (was sale)`);
        } else {
          odooResult = `\n⚠️ Odoo 訂單狀態 ${state}，無法自動取消，請聯繫總公司`;
          console.log(`[so_cancel] ⚠️ ${orderName} state=${state}, cannot cancel`);
        }
      } else {
        odooResult = '\n⚠️ 找不到 Odoo 訂單';
      }
    } else if (orderName) {
      // 用 orderName 搜尋
      const soIds = await odooCall('sale.order', 'search', [[['name', '=', orderName]]]);
      if (soIds && soIds.length) {
        const so = await odooCall('sale.order', 'read', [soIds[0]], { fields: ['state'] });
        const state = so[0]?.state;
        if (state === 'cancel') {
          odooResult = '\nℹ️ Odoo 訂單已是取消狀態';
        } else {
          await odooCall('sale.order', 'action_cancel', [soIds]);
          odooResult = '\n✅ Odoo 訂單已取消';
          console.log(`[so_cancel] ✅ ${orderName} cancelled in Odoo`);
        }
      } else {
        odooResult = '\n⚠️ 找不到 Odoo 訂單';
      }
    }
  } catch (odooErr) {
    odooResult = `\n⚠️ Odoo 取消失敗：${odooErr.message?.slice(0, 80)}`;
    console.error(`[so_cancel] Odoo error for ${orderName}:`, odooErr.message?.slice(0, 200));
  }

  // ═══ ACH 記錄也標記取消 ═══
  try {
    if (orderName) {
      await pgPool.query(
        `UPDATE ach_records SET is_active = false, updated_at = NOW() WHERE odoo_quote_id = $1 AND is_active = true`,
        [orderName]
      );
    }
  } catch (dbErr) {
    console.error(`[so_cancel] DB error for ${orderName}:`, dbErr.message);
  }

  await replyText(event.replyToken, `❌ ${orderName} 已取消確認。${odooResult}\n\n操作者：${userName}\n如有疑問請聯繫總公司。`, event.source?.userId);
  console.log(`[paopao-webhook] so_cancel: ${orderName} by ${userName}${odooResult}`);
}

/** 票券折抵確認 postback：ticket_confirm:batchId:storeCode */
async function handleTicketConfirmPostback(event) {
  const data = event?.postback?.data || '';
  const parts = data.split(':');
  if (parts.length < 3) {
    console.warn(`[ticket-confirm] invalid postback data: ${data}`);
    return;
  }
  const [, batchId, storeCode] = parts;

  const source = event.source || {};
  const userId = source.userId;
  let userName = await fetchDisplayNameInSource(userId, source);
  if (!userName) userName = 'LINE用戶';

  try {
    // 直接更新 DB（共用同一台 PostgreSQL）
    const { rowCount } = await pgPool.query(
      `UPDATE ticket_items
       SET status = 'confirmed', confirmed_at = NOW(), confirmed_by = $1
       WHERE batch_id = $2 AND store_code = $3 AND status != 'confirmed'`,
      [userName, batchId, storeCode]
    );

    if (rowCount === 0) {
      await replyText(event.replyToken, `ℹ️ ${userName} 您好，這筆票券折抵已經確認過囉！`, event.source?.userId);
      return;
    }

    // 確認是否全部完成
    const { rows: pendingRows } = await pgPool.query(
      `SELECT COUNT(*) as cnt FROM ticket_items WHERE batch_id = $1 AND status != 'confirmed'`,
      [batchId]
    );
    const pendingCount = parseInt(pendingRows[0].cnt);
    if (pendingCount === 0) {
      await pgPool.query(`UPDATE ticket_batches SET status = 'done' WHERE id = $1`, [batchId]);
    }

    await replyText(event.replyToken, `✅ 票券折抵已確認，謝謝 ${userName}！`, event.source?.userId);
    console.log(`[ticket-confirm] ✅ batch=${batchId} store=${storeCode} by=${userName} remaining=${pendingCount}`);
  } catch (e) {
    console.error('[ticket-confirm] DB error:', e.message);
    await replyText(event.replyToken, '⚠️ 系統錯誤，請稍後再試或聯繫總公司。', event.source?.userId);
  }
}

export async function handlePaopaoWebhook(req, res, { authClient, rawBody }) {
  if (!PAOPAO_STORE_SS_ID) {
    sendJson(res, 200, { status: 'error', message: 'PAOPAO_STORE_SS_ID missing' });
    return;
  }

  let body = null;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  // Cookie/token update: 需要內部 API key（不走 LINE signature）
  if (body?.cookie || body?.token) {
    const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();
    const providedKey = String(req.headers['x-api-key'] || body?.apiKey || '').trim();
    if (!INTERNAL_API_KEY || providedKey !== INTERNAL_API_KEY) {
      console.warn('[paopao-webhook] ❌ cookie/token update rejected: invalid API key');
      sendJson(res, 401, { status: 'unauthorized', message: 'Invalid API key' });
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
    console.log(`[paopao-webhook] event type=${event?.type}${event?.type === 'postback' ? ' data=' + event?.postback?.data : ''}`);
    if (event?.type === 'postback' && event?.postback?.data) {
      const params = parsePostbackParams(event.postback.data);
      console.log(`[paopao-webhook] postback action=${params.action} dbId=${params.dbId || ''} odoo=${params.odoo || ''}`);
      // 票券折抵確認 postback：格式 ticket_confirm:batchId:storeCode
      if (event.postback.data.startsWith('ticket_confirm:')) {
        await handleTicketConfirmPostback(event);
        continue;
      }
      if (params.action === 'confirm') {
        await handleConfirmPostback(authClient, event);
      } else if (params.action === 'direct_confirm') {
        await handleDirectConfirmPostback(event);
      } else if (params.action === 'so_confirm') {
        await handleSOConfirmPostback(authClient, event);
      } else if (params.action === 'so_cancel') {
        await handleSOCancelPostback(event);
      } else if (params.action === 'po_confirm') {
        await handlePOConfirmPostback(event);
      } else if (params.action === 'po_dispute') {
        await handlePODisputePostback(event);
      } else if (params.action === 'publish_story') {
        await handlePublishStoryPostback(event, params);
      } else if (params.action === 'cancel_story') {
        await replyText(event.replyToken, '👌 已取消發布', event.source?.userId);
      }
      continue;
    }
    if (event?.type === 'message' && event?.message?.type === 'text') {
      const text = String(event.message.text || '').trim();

      // ── 應徵者手機號碼綁定（1:1 私訊才觸發） ──
      if (event.source?.type === 'user' && /^09\d{8}$/.test(text.replace(/[-\s]/g, ''))) {
        try {
          const cleanPhone = text.replace(/[-\s]/g, '');
          const userId = String(event.source.userId || '');
          const bindRes = await fetch('http://localhost:3000/api/candidate-line-bind', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              phone: cleanPhone,
              store_line_uid: userId,
              store_name: '', // 不限門市，查所有待配對的候選人
              secret: 'paopaomao_internal'
            }),
            signal: AbortSignal.timeout(5000)
          });
          const bindJson = await bindRes.json();
          if (bindJson.status) {
            await replyText(event.replyToken, `✅ 綁定成功！\n${bindJson.candidate_name} 您好，面試通知會透過此帳號發送給您。\n\n如有任何問題，請直接回覆此訊息。`, event.source?.userId);
            console.log(`[paopao-webhook] 📱 candidate bind: ${cleanPhone} → ${userId.slice(-8)}`);
            continue;
          }
          // 無匹配 → 不攔截，讓訊息繼續正常流程
        } catch (e) { console.warn('[paopao-webhook] candidate-bind error:', e.message); }
      }

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
              await replyText(event.replyToken, `✅ 已綁定群組\n\n群組名稱：${groupName}\n群組 ID：${groupId}\n對應代付戶：${rows[0].payee_name}\n門市：${rows[0].store_name || '-'}`, event.source?.userId);
            } else if (rows.length > 1) {
              const list = rows.map(r => `• ${r.payee_name} (${r.store_name || '-'})`).join('\n');
              await replyText(event.replyToken, `⚠️ 找到多個匹配的代付戶，請手動在 Dashboard 設定：\n\n${list}\n\n群組 ID：${groupId}`, event.source?.userId);
            } else {
              await replyText(event.replyToken, `⚠️ 找不到匹配的代付戶\n\n群組名稱：${groupName}\n群組 ID：${groupId}\n\n請在 Dashboard 門市管理 → 代收代付 手動設定此 ID`, event.source?.userId);
            }
          } catch (e) {
            console.error('[bind-group] DB error:', e.message);
            await replyText(event.replyToken, `群組 ID：${groupId}\n（DB 寫入失敗，請手動設定）`, event.source?.userId);
          }
        }
        continue;
      }

      // 處理「幫我發送空位」請求 — 已停用，改由 Dashboard 發布
      // if (await handleSlotStoryRequest(event)) {
      //   continue;
      // }

      // 處理刪單請求
      if (await handleDeleteOrder(event)) {
        continue; // 已處理刪單，跳過其他處理
      }
      
      if (text.includes('店家回覆狀態')) {
        try {
          if (!LINE_STORE_SS_ID) {
            await replyText(event.replyToken, '店家回覆狀態需設定 LINE_STORE_SS_ID（各店訊息一覽表），請聯繫管理員。', event.source?.userId);
          } else {
            const result = await getDirectStoreReplyStatusText(authClient, LINE_STORE_SS_ID);
            const replyMsg = result.ok ? result.text : (result.message || '無法取得店家回覆狀態，請稍後再試。');
            await replyText(event.replyToken, replyMsg, event.source?.userId);
          }
        } catch (err) {
          const fallback = '查詢店家回覆狀態時發生錯誤，請稍後再試或聯繫管理員。';
          await replyText(event.replyToken, fallback).catch(() => {}, event.source?.userId);
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

