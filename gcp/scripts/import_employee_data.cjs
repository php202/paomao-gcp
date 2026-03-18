#!/usr/bin/env node
/**
 * Import employee data from Google Sheets 基本資料問卷
 * - Phone, email, birthday, address, hire_date, cross_store_support
 * - Download photo from Google Drive → local uploads
 * - Match by name to employees table
 * 
 * Usage: node import_employee_data.cjs [--dry-run]
 */

const { google } = require('googleapis');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const pool = new Pool({ database: 'paomao' });
const key = require(process.env.HOME + '/.openclaw/secrets/gcp-service-account.json');
const auth = new google.auth.JWT(key.client_email, null, key.private_key, [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
]);
const SHEET_ID = '1AmHy6-eaxSI-YY0l15lYFRDrgDoAczArmAlkPmNhrzE';
const PHOTO_DIR = path.join(process.env.HOME, '泡泡貓/dashboard/public/uploads/employees/photos');

const DRY_RUN = process.argv.includes('--dry-run');

// Parse date from various formats: "1998/05/13", "20050115", "19961122", "202409"
function parseDate(raw, type = 'date') {
  if (!raw) return null;
  // Clean up non-date text
  const cleaned = raw.replace(/[比誰都早約左右大概]/g, '').trim();
  if (!cleaned || /[a-zA-Z]/.test(cleaned)) return null;
  
  const s = cleaned.replace(/[.\-\/]/g, '').trim();
  let result = null;
  
  // 8 digits: YYYYMMDD
  if (/^\d{8}$/.test(s)) {
    result = `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  }
  // 6 digits: YYYYMM → first of month
  else if (/^\d{6}$/.test(s)) {
    result = `${s.slice(0,4)}-${s.slice(4,6)}-01`;
  }
  // Try standard date parse
  else {
    const d = new Date(cleaned);
    if (!isNaN(d.getTime()) && d.getFullYear() > 1950) {
      result = d.toISOString().slice(0, 10);
    }
  }
  
  if (!result) return null;
  
  // Validate: year between 1950-2030, month 01-12, day 01-31
  const [y, m, d] = result.split('-').map(Number);
  if (y < 1950 || y > 2030 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  // For hire_date, must be >= 2000
  if (type === 'hire' && y < 2000) return null;
  // For birth_date, must be >= 1960
  if (type === 'birth' && y < 1960) return null;
  
  return result;
}

// Extract Google Drive file ID from URL
function extractDriveId(url) {
  if (!url) return null;
  const m = url.match(/id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Download file from Google Drive using service account
async function downloadDriveFile(fileId, destPath) {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    res.data.pipe(ws);
    ws.on('finish', () => resolve(true));
    ws.on('error', reject);
  });
}

async function main() {
  console.log(`[import] ${DRY_RUN ? '🔍 DRY RUN' : '📥 IMPORTING'} — ${new Date().toISOString()}`);

  // 1. Read sheet data (take latest per name)
  const sheets = google.sheets({ version: 'v4', auth });
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: '基本資料問卷!A1:K500',
  });
  const rows = r.data.values || [];
  const header = rows[0];
  console.log(`[import] Sheet rows: ${rows.length - 1}`);

  // Deduplicate by name (last entry wins)
  const byName = {};
  for (let i = 1; i < rows.length; i++) {
    const name = (rows[i][1] || '').trim();
    if (name) byName[name] = rows[i];
  }
  const names = Object.keys(byName);
  console.log(`[import] Unique people: ${names.length}`);

  // 2. Get all active employees
  const { rows: emps } = await pool.query(
    'SELECT id, name, phone, email, birth_date, photo_url, hire_date, address, cross_store_support, id_number_encrypted FROM employees WHERE is_active = true'
  );
  const empMap = {};
  for (const e of emps) empMap[e.name] = e;

  let updated = 0, photoDown = 0, skipped = 0, notFound = 0, errors = 0;

  for (const name of names) {
    const emp = empMap[name];
    if (!emp) {
      console.log(`  ⏭️  ${name} — not in DB (maybe inactive)`);
      notFound++;
      continue;
    }

    const row = byName[name];
    // Columns: 0=timestamp, 1=name, 2=id_number, 3=phone, 4=address, 5=email, 6=birthday, 7=title, 8=hire_date, 9=cross_store, 10=photo_url
    const idNumber = (row[2] || '').trim();
    const phone = (row[3] || '').trim();
    const address = (row[4] || '').trim();
    const email = (row[5] || '').trim();
    const birthdayRaw = (row[6] || '').trim();
    const hireDateRaw = (row[8] || '').trim();
    const crossStore = (row[9] || '').includes('是');
    const photoLink = (row[10] || '').trim();

    const birthday = parseDate(birthdayRaw, 'birth');
    const hireDate = parseDate(hireDateRaw, 'hire');

    // Build update fields (only fill if DB is empty)
    const updates = {};
    if (idNumber && (!emp.id_number_encrypted || emp.id_number_encrypted === '')) updates.id_number_encrypted = idNumber;
    if (phone && (!emp.phone || emp.phone === '')) updates.phone = phone;
    if (email && (!emp.email || emp.email === '')) updates.email = email;
    if (birthday && !emp.birth_date) updates.birth_date = birthday;
    if (hireDate && !emp.hire_date) updates.hire_date = hireDate;
    if (address && (!emp.address || emp.address === '')) updates.address = address;
    if (crossStore && !emp.cross_store_support) updates.cross_store_support = true;

    // Photo download
    let photoUrl = emp.photo_url;
    if (photoLink && (!emp.photo_url || emp.photo_url === '')) {
      const fileId = extractDriveId(photoLink);
      if (fileId) {
        const filename = `${emp.id}_${name}.jpg`;
        const destPath = path.join(PHOTO_DIR, filename);
        if (!DRY_RUN) {
          try {
            await downloadDriveFile(fileId, destPath);
            photoUrl = `/uploads/employees/photos/${filename}`;
            updates.photo_url = photoUrl;
            photoDown++;
            console.log(`  📷 ${name} — photo downloaded`);
          } catch (e) {
            console.log(`  ⚠️  ${name} — photo download failed: ${e.message}`);
          }
        } else {
          updates.photo_url = `[would download ${fileId}]`;
          photoDown++;
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  📝 ${name} — would update:`, JSON.stringify(updates));
      updated++;
      continue;
    }

    // Build SQL update
    const setClauses = [];
    const vals = [];
    let idx = 1;
    for (const [key, val] of Object.entries(updates)) {
      if (key === 'photo_url' && val.startsWith('[')) continue; // skip dry-run marker
      setClauses.push(`${key}=$${idx++}`);
      vals.push(val);
    }
    if (setClauses.length > 0) {
      setClauses.push('updated_at=NOW()');
      vals.push(emp.id);
      try {
        await pool.query(`UPDATE employees SET ${setClauses.join(',')} WHERE id=$${idx}`, vals);
        updated++;
        const fields = Object.keys(updates).filter(k => !k.startsWith('[')).join(', ');
        console.log(`  ✅ ${name} — updated: ${fields}`);
      } catch (e) {
        console.log(`  ❌ ${name} — DB error: ${e.message}`);
        errors++;
      }
    }

    // Small delay for Drive API rate limit
    if (photoDown > 0) await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\n📊 結果：`);
  console.log(`  更新：${updated} 人`);
  console.log(`  照片：${photoDown} 張`);
  console.log(`  跳過（已有資料）：${skipped} 人`);
  console.log(`  不在 DB：${notFound} 人`);
  console.log(`  錯誤：${errors}`);

  await pool.end();
}

main().catch(e => {
  console.error('[import] Fatal:', e);
  pool.end();
  process.exit(1);
});
