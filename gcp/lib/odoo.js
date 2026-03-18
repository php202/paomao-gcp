/**
 * lib/odoo.js — 統一 Odoo JSON-RPC 模組（ESM）
 *
 * 讀 ~/.openclaw/secrets/odoo-config.json
 * 支援 api/*.js 用 import { odooCall } from '../lib/odoo.js'
 *
 * exports: odooAuth(), odooCall(model, method, args, kwargs)
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ODOO_CONFIG_PATH = join(process.env.HOME, '.openclaw/secrets/odoo-config.json');

let _odooConfig = null;
let _odooUid = null;

export function getOdooConfig() {
  if (_odooConfig) return _odooConfig;
  _odooConfig = JSON.parse(readFileSync(ODOO_CONFIG_PATH, 'utf8'));
  return _odooConfig;
}

export async function odooAuth() {
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

export async function odooCall(model, method, args, kwargs = {}) {
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
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

/** 清除 UID 快取（例如 session 過期後重試） */
export function resetOdooAuth() {
  _odooUid = null;
}
