#!/usr/bin/env node
/**
 * 對 gas 底下每個有 .clasp.json 的專案執行 clasp pull（從 GAS 拉回本機，覆寫本機檔案）
 * 使用方式：在 gas 目錄執行 npm run pull-all
 * 注意：pull 會覆寫本機，之後請確認 Core API 相關註解仍為「網路應用程式」，並依 DEPLOY.md 取得「網路應用程式」部署 ID 更新 package.json / DEPLOY.md
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const gasRoot = path.resolve(__dirname, '..');

const EXCLUDE_PROJECTS = ['最近的泡泡貓'];

const dirs = fs.readdirSync(gasRoot).filter((name) => {
  if (EXCLUDE_PROJECTS.includes(name)) return false;
  const full = path.join(gasRoot, name);
  return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, '.clasp.json'));
});

console.log('GAS 專案數:', dirs.length);
for (const dir of dirs) {
  const cwd = path.join(gasRoot, dir);
  console.log('\n---', dir, '---');
  try {
    execSync('clasp pull', { cwd, stdio: 'inherit' });
  } catch (e) {
    console.error(dir, 'clasp pull 失敗');
    process.exitCode = 1;
  }
}
console.log('\n完成。請確認 PaoMao_Core 等專案 Core API 相關註解為「網路應用程式」，並依 DEPLOY.md 取得「網路應用程式」部署 ID。');
