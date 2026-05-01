/**
 * lib/odoo.cjs — 統一 Odoo JSON-RPC 模組（CommonJS）
 *
 * 讀 ~/.openclaw/secrets/odoo-config.json
 * 支援 scripts/*.cjs 用 require('../lib/odoo.cjs')
 *
 * exports: odooAuth(), odooCall(model, method, args, kwargs)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ODOO_CONFIG_PATH = path.join(process.env.HOME, '.openclaw/secrets/odoo-config.json');

let _odooConfig = null;
let _odooUid = null;

function getOdooConfig() {
  if (_odooConfig) return _odooConfig;
  _odooConfig = JSON.parse(fs.readFileSync(ODOO_CONFIG_PATH, 'utf8'));
  return _odooConfig;
}

async function odooAuth() {
  if (_odooUid) return _odooUid;
  const cfg = getOdooConfig();
  const res = await fetch(`${cfg.url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service: 'common',
        method: 'authenticate',
        args: [cfg.db, cfg.username, cfg.password, {}],
      },
    }),
  });
  _odooUid = (await res.json()).result;
  if (!_odooUid) throw new Error('Odoo auth failed');
  return _odooUid;
}

async function odooCall(model, method, args, kwargs = {}, _retried = false) {
  const cfg = getOdooConfig();
  const uid = await odooAuth();
  const res = await fetch(`${cfg.url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service: 'object',
        method: 'execute_kw',
        args: [cfg.db, uid, cfg.password, model, method, args, kwargs],
      },
    }),
  });
  const json = await res.json();
  if (json.error) {
    const errStr = JSON.stringify(json.error);
    // Session 過期或認證失敗 → 自動 re-auth 一次
    if (!_retried && (errStr.includes('Session') || errStr.includes('session') ||
        errStr.includes('AccessDenied') || errStr.includes('Odoo Server Error') ||
        errStr.includes('INVALID_CSRF'))) {
      console.warn(`[odoo] 認證失敗，重新驗證: ${errStr.substring(0, 80)}`);
      resetOdooAuth();
      return odooCall(model, method, args, kwargs, true);
    }
    throw new Error(errStr);
  }
  return json.result;
}

/** 清除 UID 快取（例如 session 過期後重試） */
function resetOdooAuth() {
  _odooUid = null;
}

module.exports = { odooAuth, odooCall, getOdooConfig, resetOdooAuth };
