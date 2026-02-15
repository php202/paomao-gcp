#!/usr/bin/env node
/**
 * gas 底下每個有 .clasp.json 的專案都執行 npm run push（僅 push，不 deploy），
 * 完成後會一併將 linebot（Chrome 擴充）同步到 Google Drive，有連結的人即可取得最新版。
 *
 * 使用方式：
 *   npm run push-all               → 全部專案 push + linebot 同步到 Drive
 *   npm run push-all -- "PaoMao_Core" "各店訊息一覽表"  → 只 push 指定專案（可多個）
 *
 * linebot 同步：需本機有 Google Drive 資料夾路徑（不需提供 Drive 網址）。
 * 若已安裝 Google Drive for Desktop，會自動偵測「My Drive」並在底下建立 linebot；
 * 或設定環境變數 GOOGLE_DRIVE_LINEBOT_PATH 指向要同步的資料夾本機路徑。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// gas 根目錄（本檔所在目錄）
const GAS_ROOT = path.resolve(__dirname);

// 已刪除或整合的專案，push-all 略過（若資料夾被還原也不 push）
const EXCLUDE_PROJECTS = ['最近的泡泡貓'];

// 取得 gas 底下所有有 .clasp.json 的子目錄
function getClaspProjectDirs() {
  const names = fs.readdirSync(GAS_ROOT);
  return names.filter((name) => {
    if (EXCLUDE_PROJECTS.includes(name)) return false;
    const dirPath = path.join(GAS_ROOT, name);
    if (!fs.statSync(dirPath).isDirectory()) return false;
    return fs.existsSync(path.join(dirPath, '.clasp.json'));
  });
}

// 主流程
const allDirs = getClaspProjectDirs();
const filterArgs = process.argv.slice(2).filter(Boolean);
const dirs = filterArgs.length > 0
  ? allDirs.filter((d) => filterArgs.includes(d))
  : allDirs;

if (filterArgs.length > 0 && dirs.length === 0) {
  console.error('未找到符合的專案。可用的專案：', allDirs.join(', '));
  process.exit(1);
}

if (dirs.length === 0) {
  console.log('gas 底下沒有任何含 .clasp.json 的專案，略過。');
  process.exit(0);
}

console.log('GAS 專案數:', dirs.length);
if (filterArgs.length > 0) console.log('只 push 指定專案:', dirs.join(', '));

let failed = 0;
for (const dir of dirs) {
  const cwd = path.join(GAS_ROOT, dir);
  console.log('\n---', dir, '---');
  try {
    execSync('npm run push', { cwd, stdio: 'inherit' });
  } catch (e) {
    console.error(dir, 'npm run push 失敗');
    failed = 1;
  }
}

// 同步 linebot（Chrome 擴充）到 Google Drive，有連結的人可取得最新版
const pushLinebotScript = path.join(GAS_ROOT, 'scripts', 'push-linebot-to-drive.js');
if (fs.existsSync(pushLinebotScript)) {
  console.log('\n--- linebot 同步到 Google Drive ---');
  try {
    execSync(`node "${pushLinebotScript}"`, { cwd: GAS_ROOT, stdio: 'inherit' });
  } catch (e) {
    console.error('linebot 同步失敗（不影響 GAS push）。若需同步，請設定 GOOGLE_DRIVE_LINEBOT_PATH 或安裝 Google Drive for Desktop。');
  }
}

console.log('\n完成' + (failed ? '（有專案失敗）' : ''));
process.exit(failed);
