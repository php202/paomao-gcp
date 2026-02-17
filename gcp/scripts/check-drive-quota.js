#!/usr/bin/env node
/**
 * 查詢目前服務帳號的 Google Drive 儲存用量（本機執行，需設 GOOGLE_APPLICATION_CREDENTIALS）
 * 使用方式：cd gcp && GOOGLE_APPLICATION_CREDENTIALS=path/to/sa-key.json node scripts/check-drive-quota.js
 */
import { getAuth } from '../lib/auth.js';
import { google } from 'googleapis';

async function main() {
  const auth = await getAuth();
  const drive = google.drive({ version: 'v3', auth });
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
  if (limit != null && usage != null) {
    const pct = ((usage / limit) * 100).toFixed(1);
    console.log('使用率:', pct, '%');
  }
}

main().catch((e) => {
  console.error(e?.response?.data?.error?.message || e?.message);
  process.exit(1);
});
