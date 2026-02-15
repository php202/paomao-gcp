#!/usr/bin/env node
/**
 * 從 gas/.env 讀取 SayDou 登入憑證，產生 SayDou-Auto-Login.js
 * 執行：從 gas/ 目錄執行 node tampermonkey/build.js
 */
const fs = require('fs');
const path = require('path');

const GAS_DIR = path.resolve(__dirname, '..');
const ENV_PATH = path.join(GAS_DIR, '.env');
const TEMPLATE_PATH = path.join(__dirname, 'SayDou-Auto-Login.template.js');
const OUTPUT_PATH = path.join(__dirname, 'SayDou-Auto-Login.js');

function loadEnv() {
  const env = {};
  if (!fs.existsSync(ENV_PATH)) {
    console.warn('⚠ gas/.env 不存在，將使用空值。請複製 tampermonkey/.env.example 的變數到 gas/.env');
    return env;
  }
  const content = fs.readFileSync(ENV_PATH, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const env = loadEnv();
const cstcod = (env.SAYDOU_CSTCOD || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const usracc = (env.SAYDOU_USRACC || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const passwd = (env.SAYDOU_PASSWD || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const autoSubmit = (env.SAYDOU_AUTO_SUBMIT || 'true').toLowerCase() === 'true';

let template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
template = template
  .replace(/__SAYDOU_CSTCOD__/g, `'${cstcod}'`)
  .replace(/__SAYDOU_USRACC__/g, `'${usracc}'`)
  .replace(/__SAYDOU_PASSWD__/g, `'${passwd}'`)
  .replace(/__SAYDOU_AUTO_SUBMIT__/g, autoSubmit ? 'true' : 'false');

fs.writeFileSync(OUTPUT_PATH, template, 'utf8');
console.log('✅ SayDou-Auto-Login.js 已產生（憑證來自 gas/.env）');
