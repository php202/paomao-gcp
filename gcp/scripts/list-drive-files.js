#!/usr/bin/env node
/**
 * 列出服務帳號 Google Drive 的檔案（本機執行，需設 GOOGLE_APPLICATION_CREDENTIALS）
 * 使用方式：cd gcp && GOOGLE_APPLICATION_CREDENTIALS=path/to/sa-key.json node scripts/list-drive-files.js
 */
import { getAuth } from '../lib/auth.js';
import { google } from 'googleapis';

async function listFiles(drive, q, label, pageSize = 100) {
  const res = await drive.files.list({
    q,
    fields: 'nextPageToken, files(id, name, mimeType, createdTime, size)',
    orderBy: 'createdTime desc',
    pageSize,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = res.data.files || [];
  console.log(`\n--- ${label} (共 ${files.length} 筆) ---`);
  for (const f of files) {
    const size = f.size ? (Number(f.size) / 1024).toFixed(1) + ' KB' : '-';
    console.log(`${f.id} | ${f.name || '(無名稱)'} | ${f.mimeType || '-'} | ${f.createdTime || '-'} | ${size}`);
  }
  return files;
}

async function main() {
  const auth = await getAuth();
  const drive = google.drive({ version: 'v3', auth });

  // 配額
  const about = await drive.about.get({ fields: 'storageQuota,user' });
  const q = about?.data?.storageQuota || {};
  const limit = q.limit != null ? Number(q.limit) : null;
  const usage = q.usage != null ? Number(q.usage) : null;
  const usageInDrive = q.usageInDrive != null ? Number(q.usageInDrive) : null;
  const usageInDriveTrash = q.usageInDriveTrash != null ? Number(q.usageInDriveTrash) : null;
  console.log('--- Drive 儲存用量 (about.get) ---');
  console.log('user:', about?.data?.user?.emailAddress || '(service account)');
  if (limit != null) console.log('limit:', (limit / 1e9).toFixed(2), 'GB');
  if (usage != null) console.log('usage (total):', (usage / 1e9).toFixed(2), 'GB');
  if (usageInDrive != null) console.log('usageInDrive:', (usageInDrive / 1e9).toFixed(2), 'GB');
  if (usageInDriveTrash != null) console.log('usageInDriveTrash:', (usageInDriveTrash / 1e6).toFixed(2), 'MB');
  if (limit != null && usage != null) console.log('使用率:', ((usage / limit) * 100).toFixed(1), '%');
  console.log('storageQuota raw:', JSON.stringify(q));

  // 1. 自己擁有的試算表
  await listFiles(
    drive,
    "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and 'me' in owners",
    '自己擁有的試算表'
  );

  // 2. 自己擁有的所有檔案
  await listFiles(
    drive,
    "trashed = false and 'me' in owners",
    '自己擁有的所有檔案'
  );

  // 3. 若有 FOLDER_ID，該資料夾內的試算表
  const folderId = (process.env.FOLDER_ID_FOR_ATTENDANCE_SHEETS || '').trim();
  if (folderId) {
    await listFiles(
      drive,
      `mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and '${folderId}' in parents`,
      `資料夾 ${folderId} 內的試算表`
    );
  }

  // 4. 與我共用的項目（shared with pao-sheets-creator）
  await listFiles(
    drive,
    'sharedWithMe = true and trashed = false',
    '與我共用的項目（資料夾/檔案）',
    50
  );
}

main().catch((e) => {
  console.error(e?.response?.data?.error?.message || e?.message);
  process.exit(1);
});
