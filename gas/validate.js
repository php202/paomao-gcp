#!/usr/bin/env node
/**
 * 本機驗證：檢查 gas 專案內 CONFIG、欄位定義是否符合預期
 * 使用方式：
 *   - 在專案根目錄 node_express 下：node gas/validate.js
 *   - 若已在 gas 目錄下：node validate.js（勿在 gas 下執行 node gas/validate.js）
 */

const fs = require('fs');
const path = require('path');

const GAS_DIR = path.resolve(__dirname);
const MSG_DIR = path.join(GAS_DIR, '各店訊息一覽表');

// 預期：客人消費狀態 表頭（與 CustomerProfile.js INTEGRATED_HEADERS 一致）
const EXPECTED_INTEGRATED_HEADERS = [
  '時間', '手機', '員工填寫', '客人問卷', 'line對話', '消費紀錄', '儲值紀錄',
  'saydouUserId', 'ai prompt', 'lineUserId', 'AI分析結果'
];

// 預期：SayDou會員全貌 表頭（與 SayDouFullProfile.js HEADERS 一致）
const EXPECTED_SAYDOU_FULL_HEADERS = [
  '更新時間', '手機', 'membid', '會員姓名', '消費筆數', '儲值金筆數',
  '個人資料摘要', '消費紀錄摘要', '儲值紀錄摘要', '備註(Update)'
];

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

function extractArrayFromJs(content, arrayName) {
  if (!content) return null;
  // 匹配 INTEGRATED_HEADERS: [ "a", "b", ... ] 或 HEADERS: [ "a", "b", ... ]
  const re = new RegExp(arrayName + '\\s*:\\s*\\[([\\s\\S]*?)\\]', 'm');
  const m = content.match(re);
  if (!m) return null;
  const inner = m[1];
  const parts = inner.match(/"([^"]+)"/g) || [];
  return parts.map(p => p.replace(/^"|"$/g, ''));
}

function checkIntegratedHeaders() {
  const filePath = path.join(MSG_DIR, 'CustomerProfile.js');
  const content = readFileSafe(filePath);
  const found = extractArrayFromJs(content, 'INTEGRATED_HEADERS');
  if (!found) {
    return { ok: false, message: 'CustomerProfile.js 中找不到 INTEGRATED_HEADERS' };
  }
  if (found.length !== EXPECTED_INTEGRATED_HEADERS.length) {
    return { ok: false, message: `INTEGRATED_HEADERS 欄位數 ${found.length}，預期 ${EXPECTED_INTEGRATED_HEADERS.length}` };
  }
  for (let i = 0; i < EXPECTED_INTEGRATED_HEADERS.length; i++) {
    if (found[i] !== EXPECTED_INTEGRATED_HEADERS[i]) {
      return { ok: false, message: `INTEGRATED_HEADERS[${i}] 為「${found[i]}」，預期「${EXPECTED_INTEGRATED_HEADERS[i]}」` };
    }
  }
  return { ok: true, message: '客人消費狀態 表頭符合預期' };
}

function checkSayDouFullHeaders() {
  const filePath = path.join(MSG_DIR, 'SayDouFullProfile.js');
  const content = readFileSafe(filePath);
  const found = extractArrayFromJs(content, 'HEADERS');
  if (!found) {
    return { ok: false, message: 'SayDouFullProfile.js 中找不到 HEADERS（SAYDOU_FULL_CONFIG）' };
  }
  if (found.length !== EXPECTED_SAYDOU_FULL_HEADERS.length) {
    return { ok: false, message: `SayDou會員全貌 HEADERS 欄位數 ${found.length}，預期 ${EXPECTED_SAYDOU_FULL_HEADERS.length}` };
  }
  for (let i = 0; i < EXPECTED_SAYDOU_FULL_HEADERS.length; i++) {
    if (found[i] !== EXPECTED_SAYDOU_FULL_HEADERS[i]) {
      return { ok: false, message: `HEADERS[${i}] 為「${found[i]}」，預期「${EXPECTED_SAYDOU_FULL_HEADERS[i]}」` };
    }
  }
  return { ok: true, message: 'SayDou會員全貌 表頭符合預期' };
}

function checkConfigKeys() {
  const filePath = path.join(MSG_DIR, 'CustomerProfile.js');
  const content = readFileSafe(filePath);
  if (!content) return { ok: false, message: '無法讀取 CustomerProfile.js' };
  const required = [
    'INTEGRATED_SHEET_SS_ID', 'INTEGRATED_SHEET_NAME', 'INTEGRATED_PHONE_COL',
    'CUSTOMER_SHEET_ID', 'EMPLOYEE_SHEET_ID', 'MSG_LIST_SHEET_NAME'
  ];
  const missing = required.filter(key => !content.includes(key + ':'));
  if (missing.length) {
    return { ok: false, message: 'CONFIG 缺少: ' + missing.join(', ') };
  }
  return { ok: true, message: 'CONFIG 必要欄位皆存在' };
}

function main() {
  console.log('=== gas 本機驗證 ===\n');
  const results = [];
  results.push({ name: '客人消費狀態 表頭 (INTEGRATED_HEADERS)', ...checkIntegratedHeaders() });
  results.push({ name: 'SayDou會員全貌 表頭 (HEADERS)', ...checkSayDouFullHeaders() });
  results.push({ name: 'CustomerProfile CONFIG 必要鍵', ...checkConfigKeys() });

  let allOk = true;
  results.forEach(r => {
    const status = r.ok ? '✓' : '✗';
    console.log(`${status} ${r.name}`);
    console.log(`   ${r.message}`);
    if (!r.ok) allOk = false;
  });
  console.log('');
  if (allOk) {
    console.log('全部通過。');
    process.exit(0);
  } else {
    console.log('有項目未通過，請依上列修正。');
    process.exit(1);
  }
}

main();
