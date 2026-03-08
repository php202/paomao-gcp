#!/usr/bin/env node
/**
 * 新竹公道店 AI 廣告每日監控
 * - 檢查廣告是否被 Meta 自動開啟 → 自動暫停
 * - 拉取成效數據 → 發送到 TG 行銷群組
 */

const fs = require('fs');
const path = require('path');

const META_TOKEN = fs.readFileSync(path.join(process.env.HOME, '.openclaw/secrets/meta-token.txt'), 'utf8').trim();
const TG_TOKEN = '8520607475:AAHKn1oBOmTGloSzvM_Y0ps41tigRG3torc';
const TG_MARKETING_GROUP = '-5212644364';

const CAMPAIGN_ID = '120243012336550365';
const ADSET_ID = '120243012765010365';  // 新竹公道_女性18-45_預約導流
const AB_TEST_ADSET_ID = '120243115192060365';  // 公道_AB_Test_3素材

// 🔒 公道_A_桃花肌：不動！只監控 CPC/CTR 變化
const AD_A_ID = '120243120318300365';  // 公道_A_桃花肌（學習完畢，觀察中）
// B/D/E 時程過短無參考，C 已關（BA圖）文案可保留
const DO_NOT_TOUCH = [AD_A_ID]; // 這些廣告不要自動暫停

async function metaGet(endpoint) {
  const url = `https://graph.facebook.com/v21.0/${endpoint}&access_token=${META_TOKEN}`;
  const res = await fetch(url);
  return res.json();
}

async function metaPost(id, params) {
  const body = new URLSearchParams({ ...params, access_token: META_TOKEN });
  const res = await fetch(`https://graph.facebook.com/v21.0/${id}`, { method: 'POST', body });
  return res.json();
}

async function sendTG(text) {
  const body = JSON.stringify({
    chat_id: TG_MARKETING_GROUP,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const json = await res.json();
  if (!json.ok) console.error('TG send failed:', json);
  return json;
}

const LEARNING_PERIOD_DAYS = 7; // 廣告發布 7 天內不自動修改

async function checkAdAge(adId) {
  // 取得廣告建立時間或最後啟用時間
  const data = await metaGet(`${adId}?fields=name,created_time,updated_time,effective_status`);
  const createdAt = new Date(data.created_time || data.updated_time);
  const daysSinceCreation = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
  return { ...data, daysSinceCreation: Math.floor(daysSinceCreation) };
}

async function checkAndPause() {
  const warnings = [];

  // Check 預約導流 ad set — should stay paused
  const adset = await metaGet(`${ADSET_ID}?fields=name,effective_status,configured_status,created_time`);
  if (adset.configured_status === 'ACTIVE' && adset.effective_status === 'ACTIVE') {
    const age = await checkAdAge(ADSET_ID);
    if (age.daysSinceCreation < LEARNING_PERIOD_DAYS) {
      warnings.push(`⚠️ 預約導流 Ad Set 被自動開啟，但發布僅 ${age.daysSinceCreation} 天 — 大規模修改恐影響成效，未自動暫停，請人工確認`);
    } else {
      await metaPost(ADSET_ID, { status: 'PAUSED' });
      warnings.push('⚠️ 預約導流 Ad Set 被自動開啟，已重新暫停');
    }
  }

  // Check all ads under AB Test ad set for unexpected status changes
  const ads = await metaGet(`${AB_TEST_ADSET_ID}/ads?fields=id,name,effective_status,configured_status,created_time`);
  for (const ad of (ads.data || [])) {
    // Skip A_桃花肌 (do not touch)
    if (DO_NOT_TOUCH.includes(ad.id)) continue;

    // If a paused ad got re-enabled
    if (ad.effective_status === 'ACTIVE' && ad.configured_status === 'ACTIVE') {
      const age = await checkAdAge(ad.id);
      if (age.daysSinceCreation < LEARNING_PERIOD_DAYS) {
        warnings.push(`⚠️ ${ad.name} 被自動開啟（發布 ${age.daysSinceCreation} 天）— 廣告發布時間過短、大規模修改恐影響成效，未自動暫停`);
      } else {
        await metaPost(ad.id, { status: 'PAUSED' });
        warnings.push(`⚠️ ${ad.name} 被自動開啟，已重新暫停`);
      }
    }
  }

  // 公道_A_桃花肌 — 🔒 只觀察不動
  // C — 已關（BA圖），文案保留

  return warnings;
}

async function getInsights() {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const fields = 'spend,impressions,clicks,cpc,cpm,ctr,actions,cost_per_action_type';

  // 預約導流 Ad Set
  const daily = await metaGet(`${ADSET_ID}/insights?fields=${fields}&time_range={"since":"${yesterday}","until":"${yesterday}"}`);
  const weekly = await metaGet(`${ADSET_ID}/insights?fields=${fields}&date_preset=last_7d`);
  const lifetime = await metaGet(`${ADSET_ID}/insights?fields=${fields}&date_preset=maximum`);

  // 公道_A_桃花肌 — 追蹤 CPC/CTR 趨勢（不動它）
  const adA_daily = await metaGet(`${AD_A_ID}/insights?fields=${fields}&time_range={"since":"${yesterday}","until":"${yesterday}"}`);
  const adA_weekly = await metaGet(`${AD_A_ID}/insights?fields=${fields}&date_preset=last_7d`);
  const adA_lifetime = await metaGet(`${AD_A_ID}/insights?fields=${fields}&date_preset=maximum`);

  return {
    yesterday,
    daily: daily.data?.[0], weekly: weekly.data?.[0], lifetime: lifetime.data?.[0],
    adA: { daily: adA_daily.data?.[0], weekly: adA_weekly.data?.[0], lifetime: adA_lifetime.data?.[0] },
  };
}

function extractActions(data) {
  if (!data) return { spend: 0, impressions: 0, clicks: 0, cpc: 0, ctr: 0, linkClicks: 0, landingViews: 0, addToCart: 0, checkout: 0 };
  const actions = data.actions || [];
  const getAction = (type) => {
    const a = actions.find(a => a.action_type === type);
    return a ? parseInt(a.value) : 0;
  };

  return {
    spend: parseFloat(data.spend || 0),
    impressions: parseInt(data.impressions || 0),
    clicks: parseInt(data.clicks || 0),
    cpc: parseFloat(data.cpc || 0).toFixed(1),
    ctr: parseFloat(data.ctr || 0).toFixed(2),
    linkClicks: getAction('link_click'),
    landingViews: getAction('landing_page_view'),
    addToCart: getAction('add_to_cart') || getAction('omni_add_to_cart'),
    checkout: getAction('omni_initiated_checkout'),
  };
}

function formatNumber(n) {
  return n.toLocaleString('zh-TW');
}

async function main() {
  console.log(`[${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}] 開始公道店廣告監控...`);

  // 1. Check & pause if auto-enabled
  const warnings = await checkAndPause();

  // 2. Get insights
  const { yesterday, daily, weekly, lifetime, adA } = await getInsights();
  const d = extractActions(daily);
  const w = extractActions(weekly);
  const lt = extractActions(lifetime);

  // A_桃花肌 data
  const aD = extractActions(adA.daily);
  const aW = extractActions(adA.weekly);
  const aLt = extractActions(adA.lifetime);

  // 3. Build message
  const lines = [
    `📊 <b>新竹公道店 AI 廣告日報</b>`,
    `📅 ${yesterday}`,
    ``,
  ];

  if (warnings.length) {
    lines.push(...warnings, '');
  }

  // === A_桃花肌（主要觀察對象）===
  lines.push(`<b>🌸 公道_A_桃花肌</b>（🔒 觀察中，不動）`);
  if (aD.spend === 0 && aD.impressions === 0) {
    lines.push(`💤 昨日無數據`);
  } else {
    lines.push(
      `昨日｜💰 NT$${formatNumber(aD.spend)} ｜ 👁 ${formatNumber(aD.impressions)} ｜ CTR ${aD.ctr}% ｜ CPC NT$${aD.cpc}`,
    );
  }
  if (aW.spend > 0) {
    lines.push(`近7日｜💰 NT$${formatNumber(aW.spend)} ｜ 👁 ${formatNumber(aW.impressions)} ｜ CTR ${aW.ctr}% ｜ CPC NT$${aW.cpc}`);
  }
  if (aLt.spend > 0) {
    lines.push(`累計｜💰 NT$${formatNumber(aLt.spend)} ｜ 🔗 ${aLt.linkClicks} 連結 ｜ 📋 ${aLt.checkout} 預約`);
  }

  lines.push('');

  // === 預約導流（已暫停，顯示累計）===
  lines.push(`<b>📍 預約導流組</b>（已暫停）`);
  if (d.spend > 0) {
    lines.push(`昨日｜💰 NT$${formatNumber(d.spend)} ｜ 👁 ${formatNumber(d.impressions)} ｜ 🔗 ${d.linkClicks} ｜ 📋 ${d.checkout}`);
  } else {
    lines.push(`💤 昨日無投放`);
  }
  if (lt) {
    lines.push(`累計｜💰 NT$${formatNumber(lt.spend)} ｜ 🔗 ${lt.linkClicks} 連結 ｜ 📋 ${lt.checkout} 預約`);
  }

  lines.push('', `🤖 <i>自動監控 by 小龍</i>`);

  const msg = lines.join('\n');
  console.log(msg.replace(/<\/?[^>]+>/g, ''));

  // 4. Send to TG
  await sendTG(msg);
  console.log('✅ 已發送到 TG 行銷群組');
}

main().catch(e => {
  console.error('監控失敗:', e);
  process.exit(1);
});
