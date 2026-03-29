#!/usr/bin/env node
/**
 * odoo_inventory_monitor.cjs — Odoo 安全庫存監控
 * 
 * 1. 讀取 Google Sheet「安全庫存」的閾值
 * 2. 查 Odoo 即時庫存
 * 3. 比對：低於安全庫存 → 產出警報
 * 4. 可選：寫入 Odoo reordering rules
 * 
 * Usage:
 *   node odoo_inventory_monitor.cjs              # 檢查並輸出報告
 *   node odoo_inventory_monitor.cjs --write-rules # 寫入 Odoo reordering rules
 *   node odoo_inventory_monitor.cjs --json        # JSON 輸出
 */

const { google } = require('googleapis');
const xmlrpc = require('xmlrpc');
const fs = require('fs');
const path = require('path');

// ─── Config ───
const SA_KEY = '/Users/paopaomao/.openclaw/secrets/gcp-service-account.json';
const ODOO_CONFIG = JSON.parse(fs.readFileSync('/Users/paopaomao/.openclaw/secrets/odoo-config.json', 'utf8'));
const SHEET_ID = '1-t4KPVK-uzJ2xUoy_NR3d4XcUohLHVETEFXTlvj4baE';
const SHEET_TAB = '安全庫存';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'inventory_match_cache.json');

// ─── Google Sheets ───
async function readSheet() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SA_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:Q`,
  });
  return res.data.values || [];
}

// ─── Odoo XML-RPC ───
function odooCall(model, method, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(ODOO_CONFIG.url);
    const client = xmlrpc.createSecureClient({
      host: url.hostname,
      port: 443,
      path: '/xmlrpc/2/object',
    });
    client.methodCall('execute_kw', [
      ODOO_CONFIG.db, ODOO_CONFIG.uid || 6, ODOO_CONFIG.password,
      model, method, args, kwargs
    ], (err, val) => {
      if (err) reject(err);
      else resolve(val);
    });
  });
}

async function getOdooUid() {
  return new Promise((resolve, reject) => {
    const url = new URL(ODOO_CONFIG.url);
    const client = xmlrpc.createSecureClient({
      host: url.hostname,
      port: 443,
      path: '/xmlrpc/2/common',
    });
    client.methodCall('authenticate', [
      ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}
    ], (err, uid) => {
      if (err) reject(err);
      else resolve(uid);
    });
  });
}

// ─── 商品名稱正規化（用於模糊匹配）───
function normalize(s) {
  return s.replace(/[／/\s（）()一箱\d+瓶罐片組包]/g, '').trim().toLowerCase();
}

function matchScore(sheetName, odooName) {
  const sn = normalize(sheetName);
  const on = normalize(odooName);
  if (!sn || !on) return 0;
  let common = 0;
  for (const c of sn) {
    if (on.includes(c)) common++;
  }
  return common / Math.max(sn.length, 1);
}

// ─── 主流程 ───
async function main() {
  const args = process.argv.slice(2);
  const writeRules = args.includes('--write-rules');
  const jsonOutput = args.includes('--json');

  // 1. 讀 Sheet
  const rows = await readSheet();
  if (rows.length < 2) {
    console.error('Sheet 資料不足');
    process.exit(1);
  }

  // 2. 讀 Odoo
  const uid = await getOdooUid();
  ODOO_CONFIG.uid = uid;
  
  const odooProducts = await odooCall('product.product', 'search_read',
    [[['type', '=', 'consu']]],
    { fields: ['name', 'default_code', 'qty_available', 'virtual_available', 'incoming_qty', 'x_qty_per_box'] }
  );

  // 3. 匹配
  const results = [];
  for (const row of rows.slice(1)) {
    const sheetName = (row[3] || '').trim();
    if (!sheetName) continue;

    const stock = parseFloat(row[4]) || 0;
    const vendor = row[5] || '';
    const leadDays = parseFloat(row[6]) || 0;
    const coeff = parseFloat(row[8]) || 1;
    const sales3m = parseFloat(row[9]) || 0;
    const sales6m = parseFloat(row[10]) || 0;
    const safe3 = parseFloat(row[11]) || 0;
    const safe6 = parseFloat(row[12]) || 0;
    const stockRate = parseFloat(row[13]) || 0;

    // 找最佳匹配
    let best = null, bestScore = 0;
    for (const p of odooProducts) {
      const score = matchScore(sheetName, p.name);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }

    const item = {
      sheetName,
      sheetStock: stock,
      vendor,
      leadDays,
      coeff,
      sales3m,
      sales6m,
      safe3,
      safe6,
      stockRate,
      odooId: best?.id || null,
      odooName: best?.name || null,
      odooQty: best?.qty_available || 0,
      odooForecast: best?.virtual_available || 0,
      odooIncoming: best?.incoming_qty || 0,
      matchScore: bestScore,
      matched: bestScore > 0.5,
    };

    // 判斷狀態
    if (item.matched && safe6 > 0) {
      if (item.odooQty < safe3) {
        item.status = 'critical'; // 低於 3 個月安全量
      } else if (item.odooQty < safe6) {
        item.status = 'warning';  // 低於 6 個月安全量
      } else {
        item.status = 'ok';
      }
    } else {
      item.status = 'unknown';
    }

    results.push(item);
  }

  // 4. 輸出
  const critical = results.filter(r => r.status === 'critical');
  const warning = results.filter(r => r.status === 'warning');
  const ok = results.filter(r => r.status === 'ok');
  const unmatched = results.filter(r => !r.matched);

  if (jsonOutput) {
    console.log(JSON.stringify({ critical, warning, ok, unmatched, total: results.length }, null, 2));
    return;
  }

  console.log(`\n📦 Odoo 安全庫存監控報告`);
  console.log(`═══════════════════════════════`);
  console.log(`總品項: ${results.length} | 匹配: ${results.filter(r=>r.matched).length} | 未匹配: ${unmatched.length}`);
  console.log();

  if (critical.length > 0) {
    console.log(`🔴 嚴重不足（低於 3 個月安全量）: ${critical.length} 項`);
    for (const c of critical) {
      console.log(`   ${c.sheetName.slice(0,35).padEnd(35)} Odoo=${String(Math.round(c.odooQty)).padStart(5)} < 安全3=${String(c.safe3).padStart(5)} | 廠商=${c.vendor} | 製作=${c.leadDays}天`);
    }
    console.log();
  }

  if (warning.length > 0) {
    console.log(`🟡 注意（低於 6 個月安全量）: ${warning.length} 項`);
    for (const w of warning) {
      console.log(`   ${w.sheetName.slice(0,35).padEnd(35)} Odoo=${String(Math.round(w.odooQty)).padStart(5)} < 安全6=${String(w.safe6).padStart(5)} | 廠商=${w.vendor}`);
    }
    console.log();
  }

  console.log(`✅ 庫存充足: ${ok.length} 項`);
  if (unmatched.length > 0) {
    console.log(`❓ 未匹配: ${unmatched.length} 項（${unmatched.slice(0,5).map(u=>u.sheetName).join(', ')}${unmatched.length > 5 ? '...' : ''}）`);
  }

  // 5. 寫入 Odoo Reordering Rules（如果指定）
  if (writeRules) {
    console.log(`\n🔧 寫入 Odoo Reordering Rules...`);
    let written = 0, skipped = 0, errors = 0;

    for (const r of results) {
      if (!r.matched || !r.odooId || r.safe6 <= 0) { skipped++; continue; }

      try {
        // 查是否已有 rule
        const existing = await odooCall('stock.warehouse.orderpoint', 'search_read',
          [[['product_id', '=', r.odooId]]],
          { fields: ['id', 'product_min_qty', 'product_max_qty'], limit: 1 }
        );

        const minQty = Math.round(r.safe3); // 最小量 = 3 個月安全庫存
        const maxQty = Math.round(r.safe6 * 1.5); // 最大量 = 6 個月安全庫存 × 1.5

        if (existing.length > 0) {
          // 更新
          await odooCall('stock.warehouse.orderpoint', 'write',
            [[existing[0].id], { product_min_qty: minQty, product_max_qty: maxQty }]
          );
        } else {
          // 新建
          await odooCall('stock.warehouse.orderpoint', 'create',
            [{ product_id: r.odooId, product_min_qty: minQty, product_max_qty: maxQty, trigger: 'manual' }]
          );
        }
        written++;
      } catch (e) {
        console.error(`   ❌ ${r.sheetName}: ${e.message}`);
        errors++;
      }
    }

    console.log(`   寫入: ${written} | 跳過: ${skipped} | 失敗: ${errors}`);
  }

  // 6. 儲存匹配快取
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(results.filter(r => r.matched).map(r => ({
      sheetName: r.sheetName, odooId: r.odooId, odooName: r.odooName
    })), null, 2));
  } catch(e) {}
}

main().catch(e => { console.error(e); process.exit(1); });
