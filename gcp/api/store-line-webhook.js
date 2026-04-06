import fetch from 'node-fetch';
import { findAvailableSlotsAction } from './core-api.js';
import { nowTaipeiStr } from '../lib/date-tz.js';
import { verifyLineSignature } from '../lib/line-webhook.js';
import { appendSheet, readSheet, batchUpdateValues } from '../lib/sheets.js';
import { appendWebhookError } from '../lib/webhook-error-log.js';
import { sendAdminLinePush } from '../lib/line-push.js';
import { sendJson } from './http-utils.js';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const memberLinker = require('/Users/paopaomao/.openclaw/workspace/泡泡貓/auto-reply/member-linker');
const memberCache = require('/Users/paopaomao/.openclaw/workspace/泡泡貓/auto-reply/member-cache');

// ── 38女神節 ticket mapping + state ──
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '8520607475:AAHKn1oBOmTGloSzvM_Y0ps41tigRG3torc';
const TG_OFFICE_CHAT = process.env.TG_OFFICE_CHAT_ID || '-5220564261';
const TG_AUTO_REPLY_CHAT = '-1003745850985'; // 泡泡貓自動訊息群組

let ticketMapping = {};
try {
  const raw = JSON.parse(fs.readFileSync('/Users/paopaomao/.openclaw/workspace/泡泡貓/38ticket-mapping.json', 'utf8'));
  for (const m of raw) { if (m.sayId && m.godsid) ticketMapping[m.sayId] = m.godsid; }
  console.log(`[ticket38] Loaded ${Object.keys(ticketMapping).length} store→godsid mappings`);
} catch (e) { console.warn('[ticket38] mapping load failed:', e.message); }

const ticketPhoneWaiting = new Map();
const TICKET_PHONE_TTL = 5 * 60 * 1000;
const ticketPendingPurchase = new Map();
const TICKET_PENDING_TTL = 10 * 60 * 1000;

function tgEscape(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function tgNotify(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_OFFICE_CHAT, text, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('[tg] notify failed:', e.message); }
}

async function lineReplyMessages(replyToken, messages, accessToken) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages }),
    signal: AbortSignal.timeout(10000),
  });
  return res.ok;
}

async function linePushMessages(userId, messages, accessToken) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: userId, messages }),
    signal: AbortSignal.timeout(10000),
  });
  return res.ok;
}

let _saydouTokenCache = { value: '', ts: 0 };
function getSaydouToken(forceRefresh = false) {
  // Cache 2 min, forceRefresh 強制重讀
  if (!forceRefresh && _saydouTokenCache.value && Date.now() - _saydouTokenCache.ts < 120000) return _saydouTokenCache.value;
  try {
    const t = fs.readFileSync('/Users/paopaomao/.openclaw/workspace/booking-site/.saydou-token', 'utf8').trim();
    _saydouTokenCache = { value: t, ts: Date.now() };
    return t;
  } catch { return ''; }
}

async function getValidSaydouToken() {
  let token = getSaydouToken();
  if (!token) return '';
  // 快速驗證
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await fetch(`https://saywebdatafeed.saydou.com/api/management/calendar/events/full?startDate=${today}&endDate=${today}&storid=1875&status%5B%5D=reservation&holiday=1`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    });
    if (r.status === 200) return token;
  } catch {}
  // Token 壞了 → 觸發 token-sync
  console.warn('[ticket38] Token expired, triggering sync...');
  try {
    const { execSync } = require('child_process');
    execSync('node /Users/paopaomao/.openclaw/workspace/booking-site/token-sync.cjs', { timeout: 60000 });
  } catch (e) { console.error('[ticket38] token-sync failed:', e.message); }
  return getSaydouToken(true);
}

function _unused_getSaydouToken() {
  try { return fs.readFileSync('/Users/paopaomao/.openclaw/workspace/booking-site/.saydou-token', 'utf8').trim(); }
  catch { return null; }
}

async function searchMemberSayDou(keyword, token) {
  const res = await fetch(`https://saywebdatafeed.saydou.com/api/management/crm/members?page=0&limit=10&keyword=${encodeURIComponent(keyword)}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
  });
  const d = await res.json();
  return { total: d?.data?.total || 0, items: d?.data?.items || [] };
}

// ── 38女神節 complete auto-purchase flow (synced with auto-reply server) ──

// 封測白名單（已解除，全部開放）
// const TICKET38_BETA_USERS = new Set([...]);

async function handleTicket38GCP(userId, displayName, store, accessToken, replyToken) {
  const saydouToken = getSaydouToken();
  if (!saydouToken) {
    await lineReplyMessages(replyToken, [{ type: 'text', text: '系統維護中，請稍後再試 🙏' }], accessToken);
    return;
  }

  // Date gate: 3/1 - 3/16
  const now = new Date();
  if (now < new Date('2026-03-01T00:00:00+08:00') || now > new Date('2026-03-16T23:59:59+08:00')) {
    await lineReplyMessages(replyToken, [{ type: 'text', text: '🎀 38女神節活動尚未開始或已結束，感謝您的關注！' }], accessToken);
    return;
  }

  // Step 0: 已綁定用戶 → 用 phone 重新驗證 SayDou → 確認 membid 一致才直接購買
  const linked = memberLinker.getMember(userId);
  if (linked && linked.membid && linked.phone) {
    // 用 phone 重查 SayDou，確認 membid 一致（防止錯誤綁定）
    try {
      const verifyResult = await searchMemberSayDou(linked.phone, saydouToken);
      const verifyMember = (verifyResult.items || []).find(m => String(m.membid) === String(linked.membid));
      if (verifyMember) {
        console.log(`[ticket38] ${store.storeName} | linked user verified: ${linked.memnam} (${linked.phone}) membid=${linked.membid}`);
        const linkedMember = { membid: linked.membid, memnam: verifyMember.memnam || linked.memnam, phone_: linked.phone, memtel: linked.phone, stcash: verifyMember.stcash || verifyMember.storecard?.stcash || 0 };
        await processTicket38PurchaseGCP(userId, linkedMember, store, accessToken, replyToken, saydouToken, displayName);
        return;
      } else {
        // membid 不一致 → 清除綁定，重新走驗證流程
        console.warn(`[ticket38] ${store.storeName} | linked membid ${linked.membid} NOT found by phone ${linked.phone} → clearing link`);
        memberLinker.unlink && memberLinker.unlink(userId);
      }
    } catch (e) {
      console.warn(`[ticket38] verify linked member error: ${e.message} → fallthrough to name search`);
    }
  } else if (linked && linked.membid) {
    // 有綁定但沒 phone → 不信任，清除重來
    console.warn(`[ticket38] ${store.storeName} | linked user ${linked.memnam} has no phone → clearing`);
    memberLinker.unlink && memberLinker.unlink(userId);
  }

  // 先查本地快取，找不到再打 SayDou API
  let items = [];
  const cached = memberCache.searchByName(displayName);
  if (cached.items.length > 0) {
    items = cached.items;
    console.log(`[ticket38] ${store.storeName} | cache "${displayName}" → ${items.length} results`);
  } else {
    const apiResult = await searchMemberSayDou(displayName, saydouToken);
    items = apiResult.items || [];
    console.log(`[ticket38] ${store.storeName} | API "${displayName}" → ${items.length} results`);
  }

  if (items.length === 0) {
    const noMemberFlex = { type: 'flex', altText: '🎀 38女神節 — 請先加入會員', contents: { type: 'bubble', size: 'mega',
      body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px', backgroundColor: '#FFF0F5', contents: [
        { type: 'text', text: '🎀 38女神節限定方案', weight: 'bold', size: 'lg', color: '#5a3e2b', align: 'center' },
        { type: 'separator', margin: 'lg' },
        { type: 'text', text: '目前查不到您的會員資料 😢', size: 'sm', color: '#555555', wrap: true, margin: 'lg' },
        { type: 'text', text: '請先到門市加入泡泡貓會員\n即可享有會員價 $380 購買！', size: 'sm', color: '#555555', wrap: true, margin: 'md' },
        { type: 'text', text: '💬 有問題歡迎呼叫喵小編', size: 'xs', color: '#888888', margin: 'lg' },
    ]}}};
    await lineReplyMessages(replyToken, [noMemberFlex], accessToken);
    //     await tgNotify(`🎀 <b>38女神節</b> | ${tgEscape(store.storeName)}\n👤 ${tgEscape(displayName)}\n❌ 非會員`);
    return;
  }

  // Any matches (1 or more) → always require phone verification for unlinked users
  // Prevents wrong-member linking when displayName partially matches (e.g. "鑫" → "廖宸鑫")
  if (items.length >= 1) {
    ticketPhoneWaiting.set(userId, { storeName: store.storeName, sayId: store.sayId, accessToken, ts: Date.now(), candidates: items });
    const matchText = items.length > 1
      ? `${displayName} 您好！\n\n我們找到多筆同名會員資料，請輸入您在泡泡貓登記的手機號碼以驗證身份 📱`
      : `${displayName} 您好！\n\n為了確保帳戶安全，請輸入您在泡泡貓登記的手機號碼以驗證身份 📱`;
    const askFlex = { type: 'flex', altText: '🎀 請輸入手機號碼驗證身份', contents: { type: 'bubble', size: 'mega',
      body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px', backgroundColor: '#FFF0F5', contents: [
        { type: 'text', text: '🎀 38女神節限定方案', weight: 'bold', size: 'lg', color: '#5a3e2b', align: 'center' },
        { type: 'separator', margin: 'lg' },
        { type: 'text', text: matchText, size: 'sm', color: '#555555', wrap: true, margin: 'lg' },
    ]}}};
    await lineReplyMessages(replyToken, [askFlex], accessToken);
    return;
  }
}

async function handleTicket38PhoneGCP(userId, phone, store, accessToken, replyToken) {
  const waiting = ticketPhoneWaiting.get(userId);
  if (!waiting || Date.now() - waiting.ts > TICKET_PHONE_TTL) { ticketPhoneWaiting.delete(userId); return false; }
  const cleanPhone = phone.replace(/[-\s]/g, '');
  ticketPhoneWaiting.delete(userId);

  const saydouToken = getSaydouToken();
  if (!saydouToken) { await lineReplyMessages(replyToken, [{ type: 'text', text: '系統維護中，請稍後再試 🙏' }], accessToken); return true; }

  // Cross-verify: phone must match one of the original displayName candidates
  const match = waiting.candidates?.find(m => (m.phone_ === cleanPhone || m.memtel === cleanPhone || m.phone === cleanPhone));
  if (!match) {
    await lineReplyMessages(replyToken, [{ type: 'text', text: '此手機號碼與您的會員資料不符 😢\n如需協助請呼叫喵小編' }], accessToken);
    //     await tgNotify(`🎀 <b>38女神節手機驗證失敗</b>\n📱 輸入: ${cleanPhone}\n❌ 不在 candidates 中`);
    return true;
  }
  // Re-fetch fresh member data — 先查本地快取
  let freshMember = memberCache.searchByPhone(cleanPhone);
  if (!freshMember) {
    const { items } = await searchMemberSayDou(cleanPhone, saydouToken);
    freshMember = items.find(m => (m.phone_ === cleanPhone || m.memtel === cleanPhone));
  }
  freshMember = freshMember || match;
  // 驗證成功提示
  const memName = freshMember.memnam || match.memnam || match.memtel || '';
  await lineReplyMessages(replyToken, [{ type: 'text', text: `✅ 驗證成功！${memName} 您好～` }], accessToken);
  // replyToken 已用，用 push 送確認卡片
  await processTicket38PurchaseGCP(userId, freshMember, { storeName: waiting.storeName, sayId: waiting.sayId }, accessToken, null, saydouToken, freshMember.memnam || '');
  return true;
}

async function processTicket38PurchaseGCP(userId, member, store, accessToken, replyToken, saydouToken, nameForLog) {
  const balance = member.stcash || member.storecard?.stcash || 0;
  const membid = member.membid;
  const memnam = member.memnam || '';
  const phone = member.phone_ || member.memtel || '';
  const price = 380;

  // Auto-link userId ↔ SayDou member
  try {
    const existing = memberLinker.getMember(userId);
    if (!existing) {
      memberLinker.manualLink(userId, membid, nameForLog || memnam, memnam, phone);
      console.log(`[ticket38] Auto-linked: ${userId.slice(-8)} → ${memnam} (${phone})`);
    }
  } catch (e) { console.warn('[ticket38] link error:', e.message); }

  // 餘額檢查移到 executeTicket38PurchaseGCP，由 SayDou 判斷

  const godsid = ticketMapping[store.sayId];
  if (!godsid) {
    await lineReplyMessages(replyToken, [{ type: 'text', text: '此門市尚未開放此方案，請呼叫喵小編協助 🙏' }], accessToken);
    return;
  }

  // ── 確認步驟：顯示確認卡片，等客人按「確定購買」 ──
  ticketPendingPurchase.set(userId, { member, store, saydouToken, nameForLog, ts: Date.now() });

  const confirmBodyContents = [
    { type: 'text', text: '🎀 38女神節限定方案', weight: 'bold', size: 'lg', color: '#5a3e2b', align: 'center' },
    { type: 'text', text: '✨ 您已符合會員購買資格！', size: 'md', color: '#27ae60', align: 'center', margin: 'md', weight: 'bold' },
    { type: 'separator', margin: 'lg' },
    { type: 'box', layout: 'horizontal', margin: 'lg', contents: [
      { type: 'text', text: '會員', size: 'sm', color: '#888888', flex: 1 },
      { type: 'text', text: memnam, size: 'sm', color: '#333333', align: 'end', weight: 'bold' },
    ]},
  ];
  if (balance > 0) {
    confirmBodyContents.push({ type: 'box', layout: 'horizontal', contents: [
      { type: 'text', text: '儲值金餘額', size: 'sm', color: '#888888', flex: 1 },
      { type: 'text', text: `$${balance}`, size: 'sm', color: '#333333', align: 'end' },
    ]});
  }
  confirmBodyContents.push(
    { type: 'box', layout: 'horizontal', contents: [
      { type: 'text', text: '方案價格', size: 'sm', color: '#888888', flex: 1 },
      { type: 'text', text: `$${price}`, size: 'sm', color: '#e74c3c', align: 'end', weight: 'bold' },
    ]},
    { type: 'text', text: `📅 有效期限 購買後六個月\n💆 票卷限本店使用唷～`, size: 'xs', color: '#888888', wrap: true, margin: 'lg' },
  );

  const confirmFlex = {
    type: 'flex', altText: '🎀 確認購買38女神節方案',
    contents: { type: 'bubble', size: 'mega',
      body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px', backgroundColor: '#FFF0F5', contents: confirmBodyContents },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: [
        { type: 'button', style: 'primary', color: '#5a3e2b', height: 'md',
          action: { type: 'postback', label: '✅ 確定購買', data: `action=confirm_ticket38&userId=${userId}`, displayText: '確定購買' } },
        { type: 'button', style: 'link', height: 'sm',
          action: { type: 'postback', label: '再想想', data: 'action=dismiss_ticket38', displayText: '再想想' } },
        { type: 'text', text: '有需要再呼叫唷～', size: 'xxs', color: '#aaaaaa', align: 'center' },
      ]}
    }
  };
  let cfReplied = replyToken ? await lineReplyMessages(replyToken, [confirmFlex], accessToken) : false;
  if (!cfReplied) await linePushMessages(userId, [confirmFlex], accessToken);
}

// ── 已綁定用戶直接購買（跳過確認卡） ──

// ── 實際執行購買（由 postback confirm_ticket38 觸發） ──
async function executeTicket38PurchaseGCP(userId, member, store, accessToken, replyToken, saydouToken) {
  let balance = member.stcash || member.storecard?.stcash || 0;
  const membid = member.membid;
  const memnam = member.memnam || '';
  const phone = member.phone_ || member.memtel || '';
  const price = 380;
  const godsid = ticketMapping[store.sayId];

  // 重新取得有效 token（pending 裡的可能已過期）
  const freshToken = await getValidSaydouToken() || saydouToken;

  // ── 防護：驗證 memberLinker 綁定的 phone 與 SayDou membid 一致 ──
  const linked = memberLinker.getMember(userId);
  if (linked && linked.phone && phone) {
    const linkedPhone = String(linked.phone).replace(/[-\s]/g, '');
    const memberPhone = String(phone).replace(/[-\s]/g, '');
    if (linkedPhone !== memberPhone) {
      console.error(`[ticket38] ❌ 綁定不一致！linked.phone=${linkedPhone} vs member.phone=${memberPhone}, membid=${membid}, userId=${userId.slice(-8)}`);
      const errorMsg = { type: 'text', text: '⚠️ 系統偵測到帳戶資料異常，為保護您的權益已暫停交易。\n請聯繫門市人員協助處理 🙏' };
      if (replyToken) await lineReplyMessages(replyToken, [errorMsg], accessToken);
      else await linePushMessages(userId, [errorMsg], accessToken);
      return;
    }
  }

  // 購買前查 SayDou 最新餘額
  console.log(`[ticket38] Pre-purchase check: phone=${phone} membid=${membid} initial_balance=${balance} tokenFresh=${freshToken !== saydouToken}`);
  if (phone) {
    try {
      const { items } = await searchMemberSayDou(phone, freshToken);
      console.log(`[ticket38] SayDou search ${phone} → ${items?.length || 0} results, membids: ${items?.map(m=>m.membid).join(',')}`);
      const fresh = items?.find(m => String(m.membid) === String(membid));
      if (fresh) {
        balance = fresh.stcash || fresh.storecard?.stcash || 0;
        console.log(`[ticket38] Fresh balance: $${balance}`);
      } else {
        console.warn(`[ticket38] membid ${membid} not found in search results`);
      }
    } catch (e) { console.warn(`[ticket38] balance refresh error: ${e.message}`); }
  } else {
    console.warn(`[ticket38] No phone for balance check`);
  }

  if (balance < price) {
    console.log(`[ticket38] ❌ 餘額不足: ${memnam} balance=$${balance} < $${price}`);
    const lowFlex = { type: 'flex', altText: '🎀 儲值金不足', contents: { type: 'bubble', size: 'mega',
      body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px', backgroundColor: '#FFF0F5', contents: [
        { type: 'text', text: '🎀 38女神節限定方案', weight: 'bold', size: 'lg', color: '#5a3e2b', align: 'center' },
        { type: 'separator', margin: 'lg' },
        { type: 'text', text: `${memnam} 您好！`, size: 'sm', color: '#5a3e2b', weight: 'bold', margin: 'lg' },
        { type: 'text', text: `目前儲值金餘額 $${balance}\n方案價格 $${price}`, size: 'sm', color: '#555555', wrap: true, margin: 'md' },
        { type: 'text', text: '儲值金不足，請先至門市儲值後再購買 💰', size: 'sm', color: '#e74c3c', wrap: true, margin: 'md', weight: 'bold' },
      ]},
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: [
        { type: 'button', style: 'primary', color: '#e74c3c', height: 'sm',
          action: { type: 'message', label: '🙋 呼叫喵小編', text: '呼叫喵小編' } },
      ]}
    }};
    let lowR = replyToken ? await lineReplyMessages(replyToken, [lowFlex], accessToken) : false;
    if (!lowR) await linePushMessages(userId, [lowFlex], accessToken);
    return;
  }

  const nowDate = new Date();
  const dateStr = `${nowDate.getFullYear()}-${String(nowDate.getMonth()+1).padStart(2,'0')}-${String(nowDate.getDate()).padStart(2,'0')}`;
  const timeStr = `${String(nowDate.getHours()).padStart(2,'0')}:${String(nowDate.getMinutes()).padStart(2,'0')}`;

  // 有效期限：購買後六個月
  const expDate = new Date(nowDate);
  expDate.setMonth(expDate.getMonth() + 6);
  const expDateStr = `${expDate.getFullYear()}-${String(expDate.getMonth()+1).padStart(2,'0')}-${String(expDate.getDate()).padStart(2,'0')}`;
  const expTimISO = new Date(Date.UTC(expDate.getFullYear(), expDate.getMonth(), expDate.getDate() - 1, 16, 0, 0)).toISOString();
  const expDisplay = `${expDate.getFullYear()}/${String(expDate.getMonth()+1).padStart(2,'0')}/${String(expDate.getDate()).padStart(2,'0')}`;

  const purchasePayload = {
    membid, storid: store.sayId, rectim: dateStr, time: timeStr, rsvtid: 0,
    tickets: [{
      tkitid: 0, usrsid: 0, pctpid: 3153, pclsid: 1795, dpmtid: 1561,
      godsid, godnam: '38女神節限定雙重升級', price_: price, sprice: price,
      usecnt: 1, rusect: 1, exptyp: 'util', pkgday: 0, strtim: null, exptim: expTimISO,
      dict_v: 0, dict_u: '', cost_v: 0, cost_u: '', fllcnt: 0, remark: '',
      cash: 0, card: price, give: 0, free: 0,
      cashPay: 0, creditCard: 0, linePay: 0, wechatPay: 0, aliPay: 0, applePay: 0,
      jkoPay: 0, googlePay: 0, taiwanPay: 0, cpay_1: 0, cpay_2: 0, cpay_3: 0, cpay_4: 0, cpay_5: 0, voucher: 0,
      stdata: {
        ach: { cash: { value: 0, unit: '%' }, card: { value: 0, unit: '%' }, give: { value: 0, unit: '%' }, free: { value: 0, unit: '%' } },
        bonus: { cash: { value: 0, unit: '' }, card: { value: 0, unit: '' }, give: { value: 0, unit: '' }, free: { value: 0, unit: '' } },
      },
      exptime: expDateStr
    }]
  };

  const resp = await fetch('https://saywebdatafeed.saydou.com/api/management/checkout/ticket', {
    method: 'POST',
    headers: { Authorization: `Bearer ${freshToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(purchasePayload),
  });
  const result = await resp.json();

  if (resp.ok && !result.error) {
    const newBal = balance > 0 ? balance - price : null;
    const successBody = [
      { type: 'text', text: '✅ 購買成功！', weight: 'bold', size: 'xl', color: '#27ae60', align: 'center' },
      { type: 'text', text: '🎀 38女神節限定雙重升級', size: 'md', color: '#5a3e2b', align: 'center', margin: 'md', weight: 'bold' },
      { type: 'separator', margin: 'lg' },
      { type: 'box', layout: 'horizontal', margin: 'lg', contents: [
        { type: 'text', text: '會員', size: 'sm', color: '#888888', flex: 1 },
        { type: 'text', text: memnam, size: 'sm', color: '#333333', align: 'end', weight: 'bold' },
      ]},
      { type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: '扣款金額', size: 'sm', color: '#888888', flex: 1 },
        { type: 'text', text: `$${price}`, size: 'sm', color: '#e74c3c', align: 'end', weight: 'bold' },
      ]},
    ];
    if (newBal !== null) {
      successBody.push({ type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: '剩餘儲值金', size: 'sm', color: '#888888', flex: 1 },
        { type: 'text', text: `$${newBal}`, size: 'sm', color: '#333333', align: 'end' },
      ]});
    }
    successBody.push(
      { type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: '有效期限', size: 'sm', color: '#888888', flex: 1 },
        { type: 'text', text: expDisplay, size: 'sm', color: '#333333', align: 'end' },
      ]},
      { type: 'separator', margin: 'lg' },
      { type: 'text', text: '💆 票卷限本店使用唷～', size: 'xs', color: '#888888', wrap: true, margin: 'md' },
    );
    const successFlex = { type: 'flex', altText: '🎀 購買成功！', contents: { type: 'bubble', size: 'mega',
      body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px', backgroundColor: '#FFF0F5', contents: successBody },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: [
        { type: 'button', style: 'link', height: 'sm',
          action: { type: 'message', label: '📞 呼叫喵小編', text: '呼叫喵小編' } },
      ]}
    }};
    let okReplied = replyToken ? await lineReplyMessages(replyToken, [successFlex], accessToken) : false;
    if (!okReplied) await linePushMessages(userId, [successFlex], accessToken);
    //     await tgNotify(`🎀 <b>38女神節購買成功</b> | ${tgEscape(store.storeName)}\n👤 ${tgEscape(memnam)} (${phone})\n💰 扣款 $${price}${newBal !== null ? `，餘額 $${newBal}` : ''}`);
    console.log(`[ticket38] ✅ ${memnam} bought at ${store.storeName}${newBal !== null ? `, $${balance}→$${newBal}` : ''}`);
  } else {
    console.error(`[ticket38] ❌ FAIL:`, JSON.stringify(result).slice(0, 300));
    const errMsg = JSON.stringify(result).toLowerCase();
    const isInsufficient = errMsg.includes('insufficient') || errMsg.includes('餘額') || errMsg.includes('balance') || errMsg.includes('card');
    const failFlex = { type: 'flex', altText: '🎀 購買失敗', contents: { type: 'bubble', size: 'mega',
      body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px', backgroundColor: '#FFF0F5', contents: [
        { type: 'text', text: '🎀 38女神節限定方案', weight: 'bold', size: 'lg', color: '#5a3e2b', align: 'center' },
        { type: 'separator', margin: 'lg' },
        { type: 'text', text: `${memnam} 您好！`, size: 'sm', color: '#5a3e2b', weight: 'bold', margin: 'lg' },
        { type: 'text', text: isInsufficient
          ? '儲值金餘額不足，請先至門市儲值後再購買 💰'
          : '購買失敗，請呼叫喵小編協助處理 🙏', size: 'sm', color: '#555555', wrap: true, margin: 'md' },
      ]},
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: [
        { type: 'button', style: 'primary', color: '#e74c3c', height: 'sm',
          action: { type: 'message', label: '🙋 呼叫喵小編', text: '呼叫喵小編' } },
      ]}
    }};
    let failR = replyToken ? await lineReplyMessages(replyToken, [failFlex], accessToken) : false;
    if (!failR) await linePushMessages(userId, [failFlex], accessToken);
    //     await tgNotify(`🎀 <b>38女神節購買失敗</b> | ${tgEscape(store.storeName)}\n👤 ${tgEscape(memnam)}\n❌ ${tgEscape(JSON.stringify(result).slice(0, 100))}`);
  }
}

const INTEGRATED_SHEET_SS_ID = (process.env.INTEGRATED_SHEET_SS_ID || process.env.LINE_STORE_SS_ID || '').trim();
const RETENTION_SHEET_NAME = '準客挽留清單';
/** 與客服小幫手同一來源：各店訊息一覽表 GAS searchAvailability。設為空則用 GCP findAvailableSlotsAction。 */
const LEGACY_GAS_STORES_API_URL = (process.env.LEGACY_GAS_STORES_API_URL || '').trim();

/** 空位結果快取：同店短期內不重複 call API。key = sayId, value = { slotsStr, debug, expiresAt } */
const slotsCache = new Map();
const SLOTS_CACHE_TTL_MS = Number(process.env.SLOTS_CACHE_TTL_MS) || 90 * 1000; // 90 秒

/** 同一使用者同店限送一次完整空位回覆，避免快速連打「線上預約」重複發送。key = userId:destinationId */
const replySentMap = new Map();
const REPLY_THROTTLE_MS = Number(process.env.REPLY_THROTTLE_MS) || 180 * 1000; // 3 分鐘（可用環境變數調整）

/** 從訊息文字擷取台灣手機號碼（09 開頭），正規化 10 碼；無則 null（與 GAS extractPhoneFromText 一致） */
function extractPhoneFromText(text) {
  if (text == null || String(text).trim() === '') return null;
  const match = String(text).match(/09[\d\s\-]{8,}/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, '');
  if (digits.length < 9) return null;
  if (digits.length === 9 && digits[0] === '9') return `0${digits}`;
  if (digits.length >= 10) return `0${digits.slice(-9)}`;
  return null;
}

/** 客人發送真實訊息時，將該 userId 在準客挽留清單中 Pending 改為 Replied（與 GAS markAsReplied 一致） */
async function markAsReplied(auth, userId) {
  if (!userId || !auth) return;
  const rows = await readSheet(auth, INTEGRATED_SHEET_SS_ID, `'${RETENTION_SHEET_NAME}'!A:D`);
  const updates = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() === userId && String(rows[i][3] || '').trim() === 'Pending') {
      updates.push({ range: `'${RETENTION_SHEET_NAME}'!D${i + 1}`, values: [['Replied']] });
      break;
    }
  }
  if (updates.length) await batchUpdateValues(auth, INTEGRATED_SHEET_SS_ID, updates);
}

/** 與 GAS messFilter 一致：依關鍵字分類選單/ postback，回傳 { type, desc, useAI, template, prompt } 或 null */
const MESS_FILTER_RULES = [
  { keyword: '我的會員', type: 'MEMBER', desc: '會員權益', useAI: false, template: '${name} 您好！想查詢點數嗎？請點擊選單下方的「會員中心」即可查看喔！' },
  { keyword: '課程介紹', type: 'INTRO', desc: '了解課程', useAI: false, template: '${name} 您好，我們的熱門課程都在選單裡囉！如果需要專人解說，請直接留言，我們稍後回覆您。' },
  { keyword: '送出預約', type: 'IGNORE', desc: '系統操作', useAI: false, template: null },
  { keyword: '【我想預約】', type: 'IGNORE', desc: 'Flex按鈕觸發', useAI: false, template: null },
  { keyword: '【確認預約】', type: 'IGNORE', desc: 'Flex確認按鈕', useAI: false, template: null },
  { keyword: '確認預約', type: 'IGNORE', desc: 'Flex確認按鈕', useAI: false, template: null },
  { keyword: '38女神節', type: 'TICKET_38', desc: '38女神節限定方案', useAI: false, template: null },
  { keyword: '女神節', type: 'TICKET_38', desc: '38女神節限定方案', useAI: false, template: null },
  { keyword: '呼叫喵小編', type: 'CALL_STAFF', desc: '呼叫真人客服', useAI: false, template: null },

  { keyword: '線上預約', type: 'BOOKING', desc: '查詢空位', useAI: false, template: 'Hi ${name}，想預約嗎？系統查到最近還有空位：\n${slots}\n\n有哪一個時段對妳來說比較方便嗎？\n如果想預約的話，再麻煩留下你的【姓名、電話】，稍後為妳登記保留喔。' },
  { keyword: '您已取消預約', type: 'BOOKING', desc: '取消挽回', useAI: true, prompt: '客人剛取消了預約。請產生一段貼心、不給壓力的文案，表示遺憾，並主動列出系統查到的最近空位(${slots})，詢問是否改約。' },
];

function messFilter(msg) {
  if (!msg || typeof msg !== 'string') return null;
  return MESS_FILTER_RULES.find((r) => msg.includes(r.keyword)) || null;
}

async function findStoreByDestinationId(auth, destinationId) {
  const rows = await readSheet(auth, INTEGRATED_SHEET_SS_ID, "'店家基本資料'!A:Q");
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const dest = String(row[4] || '').trim();
    if (dest && dest === destinationId) {
      const isReply = row[8] !== false && String(row[8]).toUpperCase() !== 'FALSE';
      return {
        storeName: String(row[1] || '').trim(),
        channelId: String(row[2] || '').trim(),
        channelSecret: String(row[3] || '').trim(),
        destinationId: dest,
        sayId: String(row[5] || '').trim(),
        botId: String(row[6] || '').trim(),
        isReply: isReply !== false,
        openTime: String(row[15] || '').trim() || '11:00',
        closeTime: String(row[16] || '').trim() || '21:00',
      };
    }
  }
  return null;
}

async function getLineAccessToken(channelId, channelSecret) {
  const res = await fetch('https://api.line.me/v2/oauth/accessToken', {
    method: 'post',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: channelId,
      client_secret: channelSecret,
    }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LINE accessToken failed: HTTP ${res.status} ${(text || '').slice(0, 200)}`);
  const json = JSON.parse(text);
  return String(json?.access_token || '').trim();
}

async function fetchDisplayName(userId, token) {
  if (!userId || !token) return '';
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      method: 'get',
      headers: { Authorization: `Bearer ${token}` },
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

/** 將 findAvailableSlotsAction 回傳的 data 轉成「近期空位:\nMM-DD (週x)：時段」字串；core-api 已用 getSmartSlots 每 day 最多 5 個精選時段，不再在此做截斷。 */
function formatSlotsLines(data) {
  if (!Array.isArray(data) || data.length === 0) return null;
  const lines = data.map((day) => {
    const datePart = (day.date && String(day.date).length >= 10) ? String(day.date).slice(5, 10) : (day.date || '');
    const weekPart = day.week || '';
    const times = Array.isArray(day.times) ? day.times : [];
    const slotsStr = times.join('、');
    return datePart + (weekPart ? ` (${weekPart})` : '') + '：' + slotsStr;
  });
  return lines.length > 0 ? '近期空位:\n' + lines.join(',\n') : null;
}

/** 呼叫與客服小幫手同一支 GAS searchAvailability（同 Action-getSlots cleanData），參數對齊：1 人、1.5hr、全天 11:00~21:00、全星期。回傳 { text, debug } 供除錯。 */
async function fetchSlotsFromGasSearchAvailability(botId, startDate, endDate) {
  if (!LEGACY_GAS_STORES_API_URL || !botId) {
    return { text: null, debug: !LEGACY_GAS_STORES_API_URL ? 'GAS_URL未設定' : 'botId空' };
  }
  const params = new URLSearchParams({
    action: 'searchAvailability',
    botId: String(botId),
    startDate,
    endDate,
    people: '1',
    duration: '1.5',
    weekDays: '0,1,2,3,4,5,6',
    timeStart: '11:00',
    timeEnd: '21:00',
  });
  const baseUrl = LEGACY_GAS_STORES_API_URL.replace(/\?.*$/, '');
  const url = `${baseUrl}?${params.toString()}`;
  try {
    const res = await fetch(url, { method: 'get', signal: AbortSignal.timeout(25000) });
    const text = await res.text();
    const json = (() => { try { return JSON.parse(text); } catch { return {}; } })();
    if (res.ok && json.status === 'success' && json.text != null && String(json.text).trim() !== '') {
      const gasText = String(json.text).trim();
      const out = gasText.indexOf('近期空位') === 0 ? gasText : '近期空位:\n' + gasText;
      console.log('[store-line-webhook] GAS searchAvailability OK botId=%s start=%s end=%s len=%s', (botId || '').slice(-8), startDate, endDate, out.length);
      return { text: out, debug: null };
    }
    const debug = !res.ok
      ? `GAS_HTTP${res.status}`
      : json.status !== 'success'
        ? `GAS_status=${json.status || 'n/a'}`
        : 'GAS_text空';
    console.warn('[store-line-webhook] GAS searchAvailability 無可用空位或失敗 botId=%s start=%s end=%s %s resOk=%s body=%s', (botId || '').slice(-8), startDate, endDate, debug, res.ok, (text || '').slice(0, 200));
    return { text: null, debug };
  } catch (err) {
    console.warn('[store-line-webhook] fetchSlotsFromGasSearchAvailability 失敗 botId=%s', (botId || '').slice(-8), err?.message || err);
    return { text: null, debug: `GAS_錯誤:${(err?.message || String(err)).slice(0, 50)}` };
  }
}

/** 四天內有空位就回傳；若四天內都沒有，往後查至多 MAX_DAYS_AHEAD 天，取「至少 MIN_DAYS_WITH_SLOTS 天」有空位的時段。一律使用 GCP findAvailableSlotsAction（11:00~21:00），不再呼叫 GAS。回傳 { slotsStr, debug }。 */
const FIRST_RANGE_DAYS = 4;
const MIN_DAYS_WITH_SLOTS = 3;
const MAX_DAYS_AHEAD = 30;

async function getUpcomingSlotsText(auth, sayId, store = null) {
  if (!sayId || !auth) return { slotsStr: null, debug: 'sayId或auth空' };
  const cacheKey = String(sayId);
  const cached = slotsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { slotsStr: cached.slotsStr, debug: cached.debug ?? '' };
  }

  const timeStart = store?.openTime || '11:00';
  const timeEnd = store?.closeTime || '21:00';

  const today = new Date();
  const toYmd = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const startDate = toYmd(today);
  const endFirst = new Date(today);
  endFirst.setDate(endFirst.getDate() + FIRST_RANGE_DAYS - 1);
  const endDateFirst = toYmd(endFirst);

  try {
    let result = await findAvailableSlotsAction(auth, {
      sayId,
      startDate,
      endDate: endDateFirst,
      needPeople: 1,
      durationMin: 90,
      timeStart,
      timeEnd,
    });
    if (!result?.status || !Array.isArray(result.data)) {
      console.warn('[store-line-webhook] getUpcomingSlotsText GCP API 無資料 sayId=%s', sayId);
      const out = { slotsStr: null, debug: 'GCP_無資料' };
      slotsCache.set(cacheKey, { ...out, expiresAt: Date.now() + SLOTS_CACHE_TTL_MS });
      return out;
    }
    const daysWithSlots = (result.data || []).filter((d) => d?.times && (Array.isArray(d.times) ? d.times.length : 1));
    if (daysWithSlots.length > 0) {
      const out = { slotsStr: formatSlotsLines(result.data), debug: null };
      slotsCache.set(cacheKey, { ...out, expiresAt: Date.now() + SLOTS_CACHE_TTL_MS });
      return out;
    }
    const endExtended = new Date(today);
    endExtended.setDate(endExtended.getDate() + MAX_DAYS_AHEAD);
    const endDateExtended = toYmd(endExtended);
    result = await findAvailableSlotsAction(auth, {
      sayId,
      startDate,
      endDate: endDateExtended,
      needPeople: 1,
      durationMin: 90,
      timeStart,
      timeEnd,
    });
    if (!result?.status || !Array.isArray(result.data)) {
      const out = { slotsStr: null, debug: 'GCP_延伸無資料' };
      slotsCache.set(cacheKey, { ...out, expiresAt: Date.now() + SLOTS_CACHE_TTL_MS });
      return out;
    }
    const extendedWithSlots = (result.data || []).filter((d) => d?.times && (Array.isArray(d.times) ? d.times.length : 1));
    const take = Math.min(MIN_DAYS_WITH_SLOTS, extendedWithSlots.length);
    if (take === 0) {
      console.warn('[store-line-webhook] getUpcomingSlotsText GCP 延伸查詢仍無空位 sayId=%s start=%s end=%s', sayId, startDate, endDateExtended);
      const out = { slotsStr: null, debug: 'GCP_延伸無空位' };
      slotsCache.set(cacheKey, { ...out, expiresAt: Date.now() + SLOTS_CACHE_TTL_MS });
      return out;
    }
    const out = { slotsStr: formatSlotsLines(extendedWithSlots.slice(0, take)), debug: null };
    slotsCache.set(cacheKey, { ...out, expiresAt: Date.now() + SLOTS_CACHE_TTL_MS });
    return out;
  } catch (err) {
    console.error('[store-line-webhook] getUpcomingSlotsText 查空位失敗 sayId=%s', sayId, err);
    return { slotsStr: null, debug: `GCP_錯誤:${(err?.message || String(err)).slice(0, 50)}` };
  }
}

/** 僅「線上預約」時：查空位、組文案、回傳訊息給客人。同一使用者同店短時間內只送一次完整回覆（throttle），空位結果短期快取減少 API。回傳 { finalContent, replied }。 */
async function replyOnlineBookingOnly(auth, { displayName, replyToken, store, accessToken, userId, destinationId }) {
  let name = (displayName && String(displayName).trim()) ? String(displayName).trim() : ' ';
  if (['未知用戶', '未知(未加好友)', '未知用户'].includes(name) || name.startsWith('未知/ID:')) name = ' ';
  const isTestUser = name.toLowerCase() === 'robby yu';

  const throttleKey = userId && destinationId ? `${userId}:${destinationId}` : '';
  if (throttleKey && !isTestUser) {
    const lastSent = replySentMap.get(throttleKey);
    if (lastSent != null && Date.now() - lastSent < REPLY_THROTTLE_MS) {
      return { finalContent: '（已於稍早回覆可預約時段，請參考上方訊息）', replied: false };
    }
  }

  let slotsStr = '';
  let slotsDebug = '';
  if (store?.sayId) {
    const out = await getUpcomingSlotsText(auth, store.sayId, store);
    slotsStr = (out?.slotsStr && String(out.slotsStr).trim()) || '';
    slotsDebug = out?.debug || '';
  }
  const template = 'Hi ${name}，想預約嗎？系統查到最近還有空位：\n${slots}\n\n有哪一個時段對妳來說比較方便嗎？\n如果想預約的話，再麻煩留下你的【姓名、電話】，稍後為妳登記保留喔。';
  let finalContent = slotsStr
    ? template.replace(/\$\{name\}/g, name).replace(/\$\{slots\}/g, slotsStr.trim())
    : `Hi ${name}，近幾天都滿了，可以呼叫貓小編協助看預約時間唷～`;
  if (!slotsStr && slotsDebug) {
    // 除錯訊息只通知管理員，絕不發給客人
    const isQuotaError = /Quota exceeded|Read requests/i.test(String(slotsDebug));
    const isRateLimit = /429|Too Many/i.test(String(slotsDebug));
    const hint = isQuotaError
      ? '此為 GCP Google Sheets API「讀取」配額超限，非 SayDou Token 問題。'
      : isRateLimit
        ? 'SayDou API 429 限流，請等幾分鐘後重試。'
        : '請檢查 SayDou Token 或相關設定。';
    const debugMsg = `[泡泡貓] 查空位除錯（請檢查）\n店：${store?.storeName || '-'}\n收件人：${name}\n除錯：${slotsDebug}\n\n${hint}`;
    sendAdminLinePush(debugMsg).catch((e) => console.warn('[store-line-webhook] 除錯 LINE 推播失敗', e?.message || e));
  }
  // Token 失效（401/Unauthenticated）或 API 錯誤時：不傳任何訊息給客人
  const isTokenError = /401|Unauthenticated/i.test(String(slotsDebug));
  const isApiError = /429|500|502|503|GCP_錯誤|SayDou HTTP/i.test(String(slotsDebug));
  if ((isTokenError || isApiError) && !isTestUser) {
    return { finalContent: '', replied: false };
  }
  // 客人永遠只看到友善訊息，絕不包含除錯資訊
  const messageToSend = slotsDebug && !isTestUser
    ? `Hi ${name}，近幾天都滿了，可以呼叫貓小編協助看預約時間唷～`
    : finalContent;
  const token = (accessToken && String(accessToken).trim()) ? String(accessToken).trim() : '';
  let replied = false;
  if (token && replyToken && store?.isReply !== false) {
    try {
      const res = await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'post',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: messageToSend }] }),
        signal: AbortSignal.timeout(10000),
      });
      replied = res.ok;
      if (replied && throttleKey) replySentMap.set(throttleKey, Date.now());
      if (!res.ok && res.status === 401) {
        console.warn('[store-line-webhook] LINE reply 401 token 可能失效，未傳訊息給客戶');
      }
    } catch {
      // 傳訊失敗不重試
    }
  } else if (!token && replyToken) {
    console.warn('[store-line-webhook] replyOnlineBookingOnly 無 token，不傳訊息給客戶');
  }
  return { finalContent, replied };
}

export async function handleStoreLineWebhook(req, res, { authClient, rawBody }) {
  if (!INTEGRATED_SHEET_SS_ID) {
    const msg = 'missing INTEGRATED_SHEET_SS_ID/LINE_STORE_SS_ID';
    await appendWebhookError(authClient, 'store-line-webhook', msg, 'env 未設定');
    sendJson(res, 200, { status: 'error', message: msg });
    return;
  }

  let payload = null;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  const destinationId = String(payload?.destination || '').trim();
  if (!destinationId) {
    console.warn('[store-line-webhook] missing destination in payload');
    sendJson(res, 200, { status: 'error', message: 'missing destination' });
    return;
  }

  const store = await findStoreByDestinationId(authClient, destinationId);
  if (!store?.channelSecret) {
    console.warn('[store-line-webhook] unknown destination, no match in 店家基本資料 E 欄:', destinationId);
    sendJson(res, 200, { status: 'error', message: `unknown destination ${destinationId}` });
    return;
  }
  const eventCount = Array.isArray(payload?.events) ? payload.events.length : 0;
  if (eventCount > 0) {
    console.log('[store-line-webhook] destination=%s store=%s events=%d', destinationId.slice(0, 12), store.storeName, eventCount);
  }

  const signature = String(req.headers['x-line-signature'] || '');
  if (!verifyLineSignature(rawBody, signature, store.channelSecret)) {
    sendJson(res, 401, { status: 'unauthorized' });
    return;
  }

  const events = Array.isArray(payload?.events) ? payload.events : [];
  if (!events.length) {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  // Best-effort: fetch profile name. If it fails, still log message.
  let accessToken = '';
  try {
    accessToken = await getLineAccessToken(store.channelId, store.channelSecret);
  } catch {
    accessToken = '';
  }

  for (const event of events) {
    // postback handling
    if (event?.type === 'postback' && event?.postback?.data) {
      const pbData = new URLSearchParams(event.postback.data);
      const pbAction = pbData.get('action');
      const pbUserId = String(event?.source?.userId || '').trim();
      const pbReplyToken = String(event?.replyToken || '').trim();

      if (pbAction === 'confirm_ticket38') {
        const pending = ticketPendingPurchase.get(pbUserId);
        if (!pending || Date.now() - pending.ts > TICKET_PENDING_TTL) {
          ticketPendingPurchase.delete(pbUserId);
          const expMsg = [{ type: 'text', text: '購買已逾時，請重新輸入「38女神節限定方案」再試一次 🙏' }];
          let expR = false;
          try { expR = await lineReplyMessages(pbReplyToken, expMsg, accessToken); } catch {}
          if (!expR) try { await linePushMessages(pbUserId, expMsg, accessToken); } catch {}
        } else {
          ticketPendingPurchase.delete(pbUserId);
          try {
            await executeTicket38PurchaseGCP(pbUserId, pending.member, pending.store, accessToken, pbReplyToken, pending.saydouToken);
          } catch (e) {
            console.error('[ticket38] confirm error:', e.message);
            const failMsg = [{ type: 'text', text: '購買失敗，請呼叫喵小編協助 🙏' }];
            let failR = false;
            try { failR = await lineReplyMessages(pbReplyToken, failMsg, accessToken); } catch {}
            if (!failR) try { await linePushMessages(pbUserId, failMsg, accessToken); } catch {}
          }
        }
      }
      continue;
    }
    // ── follow/unfollow 事件記錄 ──
    if (event?.type === 'follow' || event?.type === 'unfollow') {
      const fUserId = String(event?.source?.userId || '').trim();
      if (fUserId) {
        let fDisplayName = '';
        try { fDisplayName = accessToken ? await fetchDisplayName(fUserId, accessToken) : ''; } catch {}
        try {
          await fetch('http://localhost:3000/api/line-follow-event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              line_user_id: fUserId,
              store_name: store.storeName,
              line_channel_id: store.channelId,
              event_type: event.type,
              display_name: fDisplayName,
              secret: 'paopaomao_internal'
            })
          });
        } catch (e) { console.error(`[store-webhook] ${event.type} record failed:`, e.message); }
        console.log(`[store-webhook] 📊 ${event.type}: ${fDisplayName || fUserId} @ ${store.storeName}`);
      }
      continue;
    }

    if (event?.type !== 'message') continue;
    const userId = String(event?.source?.userId || '').trim();
    const replyToken = String(event?.replyToken || '').trim();
    const msgType = String(event?.message?.type || '');
    let msg = '';
    if (msgType === 'text') msg = String(event?.message?.text || '');
    else msg = `[${msgType || 'unknown'}]`;

    const displayName = accessToken ? await fetchDisplayName(userId, accessToken) : '';

    // ── 38女神節 phone verification intercept ──
    if (ticketPhoneWaiting.has(userId) && /^09\d{8}$/.test(msg.replace(/[-\s]/g, ''))) {
      try {
        const handled = await handleTicket38PhoneGCP(userId, msg, { storeName: store.storeName, sayId: store.sayId }, accessToken, replyToken);
        if (handled) continue;
      } catch (e) { console.error('[ticket38-phone] error:', e.message); }
    }

    // ── 應徵者手機號碼綁定 store_line_uid ──
    if (msgType === 'text' && /^09\d{8}$/.test(msg.replace(/[-\s]/g, ''))) {
      try {
        const cleanPhone = msg.replace(/[-\s]/g, '');
        const bindRes = await fetch('http://localhost:3000/api/candidate-line-bind', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone: cleanPhone,
            store_line_uid: userId,
            store_name: store.storeName,
            secret: 'paopaomao_internal'
          }),
          signal: AbortSignal.timeout(5000)
        });
        const bindJson = await bindRes.json();
        if (bindJson.status) {
          // 綁定成功！回覆確認訊息
          const bindMsg = [{ type: 'text', text: `✅ 綁定成功！\n${bindJson.candidate_name} 您好，面試通知會透過此帳號發送給您。\n\n如有任何問題，請直接回覆此訊息或聯繫門市。` }];
          let replied = false;
          try { replied = await lineReplyMessages(replyToken, bindMsg, accessToken); } catch {}
          if (!replied) try { await linePushMessages(userId, bindMsg, accessToken); } catch {}
          console.log(`[store-webhook] 📱 candidate bind: ${cleanPhone} → ${userId.slice(-8)} @ ${store.storeName}`);
          continue;
        }
        // 無匹配 → 不攔截，讓訊息繼續正常流程
      } catch (e) { console.warn('[store-webhook] candidate-bind check error:', e.message); }
    }

    const filterResult = messFilter(msg);

    if (filterResult) {
      // 與 GAS 一致：會員權益、了解課程不寫入挽留清單；其餘（查詢空位、系統操作、取消挽回）寫入準客挽留清單
      const skipRetentionList = filterResult.desc === '會員權益' || filterResult.desc === '了解課程';
      let finalContent = '';
      let rowStatus = 'Pending';

      // ── 38女神節限定方案（全自動購買，同 auto-reply server） ──
      if (filterResult.type === 'TICKET_38') {
        try {
          await handleTicket38GCP(userId, displayName, store, accessToken, replyToken);
        } catch (e) {
          console.error(`[ticket38] error:`, e.message);
          // 不回覆客人，只 log
        }
        continue;
      }

      // ── 呼叫喵小編（真人客服） ──
      if (filterResult.type === 'CALL_STAFF') {
        const nameForFlex = (displayName && String(displayName).trim()) ? String(displayName).trim() : '';
        // 不回覆客人，只通知 TG 真人客服處理
        // 發到自動訊息群組，不是辦公室群組
        try {
          await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_AUTO_REPLY_CHAT, text: `🙋 <b>呼叫喵小編</b> | ${tgEscape(store.storeName)}\n\n👤 ${tgEscape(nameForFlex)}\n💬 客人按下「呼叫喵小編」，請儘速回覆！`, parse_mode: 'HTML' })
          });
        } catch (e) { console.error('[tg] call-staff notify failed:', e.message); }
        try {
          let nameForSheet = nameForFlex || ' ';
          if (['未知用戶', '未知(未加好友)'].includes(nameForSheet)) nameForSheet = ' ';
          await appendSheet(authClient, INTEGRATED_SHEET_SS_ID, '訊息一覽', [
            nowTaipeiStr(), userId, store.storeName, nameForSheet, '呼叫喵小編', '', '', '', replyToken
          ]);
        } catch (e) { console.error('[call-staff] sheet failed:', e.message); }
        continue;
      }

      if (filterResult.desc === '查詢空位') {
        const result = await replyOnlineBookingOnly(authClient, {
          displayName,
          replyToken,
          store,
          accessToken,
          userId,
          destinationId,
        });
        finalContent = result?.finalContent ?? '';
        rowStatus = result?.replied ? 'Replied' : 'Pending';
      } else if (filterResult.type === 'IGNORE' || filterResult.desc === '系統操作') {
        finalContent = '(系統指令，無需挽留)';
      } else if (filterResult.desc === '取消挽回') {
        finalContent = '(系統紀錄，無須回覆)';
      } else {
        // 會員權益、了解課程：仍產出文案供紀錄，但 skipRetentionList 時不寫入
        const name = (displayName && String(displayName).trim()) ? String(displayName).trim() : ' ';
        const rule = MESS_FILTER_RULES.find((r) => r.desc === filterResult.desc);
        finalContent = rule?.template ? rule.template.replace(/\$\{name\}/g, name) : '';
      }

      if (!skipRetentionList && finalContent !== undefined) {
        let nameForSheet = (displayName && String(displayName).trim()) ? String(displayName).trim() : ' ';
        if (['未知用戶', '未知(未加好友)', '未知用户'].includes(nameForSheet) || nameForSheet.startsWith('未知/ID:')) nameForSheet = ' ';
        const retentionRow = [
          userId,
          nameForSheet,
          nowTaipeiStr(),
          rowStatus,
          filterResult.desc,
          finalContent,
          replyToken,
          store?.botId ?? '',
        ];
        await appendSheet(authClient, INTEGRATED_SHEET_SS_ID, RETENTION_SHEET_NAME, retentionRow);
      }
      continue;
    }

    // 真實訊息：標記挽留清單已互動（Pending→Replied）、寫入訊息一覽（含擷取手機 H 欄、名字未知寫 " "）
    await markAsReplied(authClient, userId);
    const extractedPhone = extractPhoneFromText(msg) || '';
    let nameForSheet = (displayName && String(displayName).trim()) ? String(displayName).trim() : ' ';
    if (['未知用戶', '未知(未加好友)', '未知用户'].includes(nameForSheet) || nameForSheet.startsWith('未知/ID:')) nameForSheet = ' ';
    const row = [
      nowTaipeiStr(),
      userId,
      store.storeName,
      nameForSheet,
      msg,
      '',
      '',
      extractedPhone,
      replyToken,
    ];
    try {
      await appendSheet(authClient, INTEGRATED_SHEET_SS_ID, '訊息一覽', row);
    } catch (err) {
      const errMsg = err?.message || String(err);
      console.error('[store-line-webhook] append 訊息一覽 failed:', errMsg, 'store=', store.storeName, 'userId=', userId?.slice(0, 8));
      await appendWebhookError(authClient, 'store-line-webhook', errMsg, `store=${store?.storeName || '-'} userId=${userId?.slice(0, 12) || '-'} append 訊息一覽`);
    }
  }

  sendJson(res, 200, { status: 'ok' });
}

