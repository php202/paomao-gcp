#!/usr/bin/env node
/**
 * 對 gas 底下每個有 .clasp.json 的專案執行 npm run push（僅 push，不 deploy）
 * 使用方式：
 *   npm run push                     → 全部專案
 *   npm run push -- "泡泡貓 員工打卡 Line@"  → 只 push 指定專案（可多個）
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const gasRoot = path.resolve(__dirname, '..');

let dirs = fs.readdirSync(gasRoot).filter((name) => {
  const full = path.join(gasRoot, name);
  return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, '.clasp.json'));
});

const filterNames = process.argv.slice(2).filter(Boolean);
if (filterNames.length > 0) {
  dirs = dirs.filter((d) => filterNames.includes(d));
  if (dirs.length === 0) {
    console.error('未找到符合的專案。可用的專案：', fs.readdirSync(gasRoot).filter((name) => {
      const full = path.join(gasRoot, name);
      return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, '.clasp.json'));
    }).join(', '));
    process.exit(1);
  }
  console.log('只 push 指定專案:', dirs.join(', '));
}

console.log('GAS 專案數:', dirs.length);
for (let i = 0; i < dirs.length; i++) {
  const dir = dirs[i];
  const cwd = path.join(gasRoot, dir);
  console.log('\n---', dir, '---');
  try {
    execSync('npm run push', { cwd, stdio: 'inherit' });
  } catch (e) {
    console.error(dir, 'npm run push 失敗');
    process.exitCode = 1;
  }
}
console.log('\n完成');
