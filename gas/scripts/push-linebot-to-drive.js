#!/usr/bin/env node
/**
 * 將 gas/linebot（Chrome 擴充「LINE Bot 客服小幫手」）同步到 Google Drive 資料夾，
 * 有連結的人即可下載到最新版本。執行 npm run push-all 時會一併同步。
 *
 * 僅同步「讓擴充能跑」的檔案，不包含 .env、.env.example、node_modules、
 * bump-version.js、release.zip、package.json 等開發/憑證用檔案。
 *
 * 預設同步到：Google Drive「我的雲端硬碟/linebot」（本機路徑見下方 DEFAULT_DRIVE_LINEBOT）。
 * 若要改路徑可設定環境變數：export GOOGLE_DRIVE_LINEBOT_PATH="/path/to/linebot"
 */
const fs = require('fs');
const path = require('path');

const GAS_ROOT = path.resolve(__dirname, '..');
const LINEBOT_SOURCE = path.join(GAS_ROOT, 'linebot');

/** 預設 Google Drive linebot 資料夾（泡泡貓共用，有連結即可取得最新版） */
const DEFAULT_DRIVE_LINEBOT = '/Users/yutsunghan/Library/CloudStorage/GoogleDrive-paopaomao.of@gmail.com/我的雲端硬碟/linebot';

/** 下載資料夾：執行時一併清理檔名以 94256530_P01_ 開頭且為 .txt、以及以「泡泡貓｜請款表單 - 銀行匯款格式_」開頭且為 .xlsx 的暫存檔 */
const DOWNLOADS_DIR = '/Users/yutsunghan/Downloads';

/** 請款表單 xlsx 檔名前綴（此開頭且為 .xlsx 的檔案會一併刪除） */
const PAOPAO_XLSX_PREFIX = '泡泡貓｜請款表單 - 銀行匯款格式_';

/** 同步到 Drive 時跳過的檔名（僅同步擴充執行所需，不含 env / 開發用） */
const SKIP_NAMES = new Set([
  '.env',
  '.env.example',
  'node_modules',
  'bump-version.js',
  'release.zip',
  'package.json',
  'package-lock.json',
]);

function getDefaultDrivePath() {
  // 1. 專案預設路徑（此機 Google Drive 雲端硬碟/linebot）
  if (fs.existsSync(path.dirname(DEFAULT_DRIVE_LINEBOT))) return DEFAULT_DRIVE_LINEBOT;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return null;
  // 2. macOS 新版 Google Drive for Desktop（My Drive）
  try {
    const cloud = path.join(home, 'Library', 'CloudStorage');
    if (fs.existsSync(cloud)) {
      const dirs = fs.readdirSync(cloud);
      const gd = dirs.find((d) => d.startsWith('GoogleDrive'));
      if (gd) return path.join(cloud, gd, 'My Drive', 'linebot');
    }
  } catch (_) {}
  // 3. 舊版「Google 雲端硬碟」資料夾
  const legacy = path.join(home, 'Google Drive', 'My Drive', 'linebot');
  if (fs.existsSync(path.dirname(path.dirname(legacy)))) return legacy;
  return null;
}

function copyRecursive(src, dest) {
  const name = path.basename(src);
  if (SKIP_NAMES.has(name)) return;

  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyRecursive(path.join(src, child), path.join(dest, child));
    }
    return;
  }
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
}

function main() {
  if (!fs.existsSync(LINEBOT_SOURCE)) {
    console.error('找不到來源：', LINEBOT_SOURCE);
    process.exit(1);
  }

  const dest = process.env.GOOGLE_DRIVE_LINEBOT_PATH || getDefaultDrivePath();
  if (!dest) {
    console.error('請設定 Google Drive 目標路徑：');
    console.error('  export GOOGLE_DRIVE_LINEBOT_PATH="/path/to/Google Drive/My Drive/linebot"');
    console.error('或將專案放在 Google Drive 資料夾內，並使用上述路徑。');
    process.exit(1);
  }

  console.log('來源:', LINEBOT_SOURCE);
  console.log('目標:', dest);

  try {
    copyRecursive(LINEBOT_SOURCE, dest);
    console.log('✅ linebot 已同步到 Google Drive');

    // 順便清理「我的雲端硬碟」根目錄與「Downloads」下：94256530_P01_*.txt、以及「泡泡貓｜請款表單 - 銀行匯款格式_」*.xlsx 的暫存檔
    const driveRoot = path.dirname(dest);
    let removed = removeMatchingP01Txt(driveRoot);
    if (removed > 0) console.log('🗑 已移除 ' + removed + ' 個符合 94256530_P01_*.txt 的檔案（雲端硬碟）');

    // 清理「Downloads」下檔名以 94256530_P01_ 開頭且為 .txt 的暫存檔
    removed = removeMatchingP01Txt(DOWNLOADS_DIR);
    if (removed > 0) console.log('🗑 已移除 ' + removed + ' 個符合 94256530_P01_*.txt 的檔案（Downloads）');

    // 清理以「泡泡貓｜請款表單 - 銀行匯款格式_」開頭且為 .xlsx 的暫存檔（雲端硬碟根目錄與 Downloads）
    let removedXlsx = removeMatchingPaopaoXlsx(driveRoot);
    if (removedXlsx > 0) console.log('🗑 已移除 ' + removedXlsx + ' 個符合 ' + PAOPAO_XLSX_PREFIX + '*.xlsx 的檔案（雲端硬碟）');
    removedXlsx = removeMatchingPaopaoXlsx(DOWNLOADS_DIR);
    if (removedXlsx > 0) console.log('🗑 已移除 ' + removedXlsx + ' 個符合 ' + PAOPAO_XLSX_PREFIX + '*.xlsx 的檔案（Downloads）');
  } catch (err) {
    console.error('同步失敗:', err.message);
    process.exit(1);
  }
}

/** 檔名是否以 94256530_P01_ 開頭且為 .txt（才刪除） */
function isP01TxtFilename(name) {
  return /^94256530_P01_.*\.txt$/.test(name);
}

/** 在指定目錄刪除檔名以 94256530_P01_ 開頭且為 .txt 的檔案，回傳刪除數量 */
function removeMatchingP01Txt(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 0;
  let count = 0;
  try {
    const names = fs.readdirSync(dir);
    for (const name of names) {
      if (!isP01TxtFilename(name)) continue;
      const fullPath = path.join(dir, name);
      if (!fs.statSync(fullPath).isFile()) continue;
      fs.unlinkSync(fullPath);
      count++;
    }
  } catch (err) {
    console.error('清理 94256530_P01_*.txt 時錯誤:', err.message);
  }
  return count;
}

/** 檔名是否以「泡泡貓｜請款表單 - 銀行匯款格式_」開頭且為 .xlsx（才刪除） */
function isPaopaoXlsxFilename(name) {
  return name.startsWith(PAOPAO_XLSX_PREFIX) && name.toLowerCase().endsWith('.xlsx');
}

/** 在指定目錄刪除檔名以「泡泡貓｜請款表單 - 銀行匯款格式_」開頭且為 .xlsx 的檔案，回傳刪除數量 */
function removeMatchingPaopaoXlsx(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 0;
  let count = 0;
  try {
    const names = fs.readdirSync(dir);
    for (const name of names) {
      if (!isPaopaoXlsxFilename(name)) continue;
      const fullPath = path.join(dir, name);
      if (!fs.statSync(fullPath).isFile()) continue;
      fs.unlinkSync(fullPath);
      count++;
    }
  } catch (err) {
    console.error('清理 ' + PAOPAO_XLSX_PREFIX + '*.xlsx 時錯誤:', err.message);
  }
  return count;
}

main();
