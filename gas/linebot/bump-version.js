#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const manifestPath = path.join(__dirname, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const current = manifest.version;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question(`manifest version (目前: ${current}) 輸入新版本: `, (newVersion) => {
  const v = (newVersion || '').trim();
  if (!v) {
    console.error('未輸入版本，取消。');
    process.exit(1);
  }
  manifest.version = v;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest) + '\n', 'utf8');
  console.log(`已更新 manifest.json version -> ${v}`);
  rl.close();
});
