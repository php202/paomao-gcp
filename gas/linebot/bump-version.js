#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const manifestPath = path.join(__dirname, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const current = manifest.version;

function applyVersion(v) {
  if (!v) return false;
  manifest.version = v;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest) + '\n', 'utf8');
  console.log(`已更新 manifest.json version -> ${v}`);
  return true;
}

// 若環境變數 LINEBOT_VERSION 已設，直接使用（非互動部署）
if (process.env.LINEBOT_VERSION) {
  const v = process.env.LINEBOT_VERSION.trim();
  if (!applyVersion(v)) process.exit(1);
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question(`manifest version (目前: ${current}) 輸入新版本: `, (newVersion) => {
  const v = (newVersion || '').trim();
  if (!applyVersion(v)) {
    console.error('未輸入版本，取消。');
    process.exit(1);
  }
  rl.close();
});
