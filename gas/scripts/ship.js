#!/usr/bin/env node
/**
 * 對 gas 底下每個有 .clasp.json 的專案執行 push + deploy
 *
 * 使用方式：
 *   npm run ship                     → 全部專案
 *   npm run ship-one                 → 全部專案（不執行 git push）
 *   npm run ship -- "泡泡貓 員工打卡 Line@"  → 只 ship 指定專案（可多個）
 *
 * 部署 ID 設定於 gas/deploy-ids.json，修改錯誤的 ID 請編輯該檔。
 * 取得方式：GAS 編輯器 → 部署 → 管理部署 → 複製「網路應用程式」那筆的部署 ID
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const gasRoot = path.resolve(__dirname, '..');
const deployIdsPath = path.join(gasRoot, 'deploy-ids.json');

const EXCLUDE_PROJECTS = ['最近的泡泡貓', 'linebot'];

function getDeployIds() {
  if (!fs.existsSync(deployIdsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(deployIdsPath, 'utf8'));
  } catch (e) {
    console.warn('deploy-ids.json 解析失敗，跳過 deploy');
    return {};
  }
}

function getProjects() {
  const entries = fs.readdirSync(gasRoot);
  return entries.filter((name) => {
    if (EXCLUDE_PROJECTS.includes(name)) return false;
    const full = path.join(gasRoot, name);
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, '.clasp.json'));
  });
}

const deployIds = getDeployIds();
const filterNames = process.argv.slice(2).filter(Boolean);
let dirs = getProjects();

if (filterNames.length > 0) {
  dirs = dirs.filter((d) => filterNames.includes(d));
  if (dirs.length === 0) {
    console.error('未找到符合的專案。可用的專案：', getProjects().join(', '));
    process.exit(1);
  }
  console.log('只 ship 指定專案:', dirs.join(', '));
}

console.log('GAS 專案數:', dirs.length);

const DELAY_SEC = 15;
for (let i = 0; i < dirs.length; i++) {
  if (i > 0) {
    console.log('\n等待', DELAY_SEC, '秒後再部署下一個專案（避免配額用盡）…');
    try {
      execSync(`sleep ${DELAY_SEC}`, { stdio: 'inherit' });
    } catch (_) {
      // Windows 無 sleep，略過
    }
  }

  const dir = dirs[i];
  const cwd = path.join(gasRoot, dir);
  console.log('\n---', dir, '---');

  try {
    execSync('clasp push --force', { cwd, stdio: 'inherit' });

    const deployId = deployIds[dir];
    if (deployId) {
      execSync(`clasp deploy -i ${deployId} -d 'Updated'`, { cwd, stdio: 'inherit' });
    } else {
      console.log('  (無 deploy-ids.json 設定，僅 push)');
    }
  } catch (e) {
    console.error('\n[' + dir + '] 失敗');
    console.error('若為 Resource has been exhausted，為 Google 配額限制，請稍後重試或只 ship 單一專案');
    process.exit(1);
  }
}

console.log('\n✅ 完成');
