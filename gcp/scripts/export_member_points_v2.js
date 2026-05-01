/**
 * 匯出 SayDou 會員點數資料到 Google Sheet (v2 - 串流版)
 * 先下載到本地 CSV，再上傳 Google Sheet
 */
import { readFileSync, writeFileSync, createWriteStream } from 'fs';
import { join } from 'path';
import { google } from 'googleapis';

const TOKEN_FILE = join(process.env.HOME, '.openclaw/workspace/booking-site/.saydou-token');
const SHEET_ID = '1uacbUP8dlS2bh8Oup83YacxtEUZg-Oss0g218o1TK4w';
const API_BASE = 'https://saywebdatafeed.saydou.com/api/management/unearn/memberPoints';
const PAGE_SIZE = 200;  // 大一點減少請求數
const DELAY_MS = 300;
const CSV_FILE = '/tmp/member_points.csv';

function getToken() {
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

async function fetchPage(page, token, retries = 3) {
  const url = `${API_BASE}?page=${page}&limit=${PAGE_SIZE}&sort=points&order=desc&keyword=&tabIndex=1`;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 429) {
        console.log(`  ⏳ 429 at page ${page}, waiting 10s...`);
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.status) throw new Error('API error');
      return json.data;
    } catch (e) {
      if (attempt < retries - 1) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw e;
    }
  }
}

function formatGender(g) {
  if (g === 'm') return '男';
  if (g === 'f') return '女';
  return g || '';
}

function csvEscape(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function downloadToCSV() {
  const token = getToken();
  const firstPage = await fetchPage(0, token);
  const total = firstPage.total;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  console.log(`📊 總共 ${total} 筆，${totalPages} 頁 (每頁 ${PAGE_SIZE})`);

  const ws = createWriteStream(CSV_FILE);
  ws.write('會員ID,姓名,手機,點數,門市名稱,門市ID,性別,生日\n');
  
  let count = 0;
  
  function writeItems(items) {
    for (const item of items) {
      ws.write([
        item.membid,
        csvEscape(item.memnam || ''),
        csvEscape(item.phone_ || ''),
        item.points || 0,
        csvEscape(item.stor?.stonam || ''),
        item.storid,
        formatGender(item.gender),
        item.bthday || '',
      ].join(',') + '\n');
      count++;
    }
  }
  
  // Write first page
  writeItems(firstPage.items);
  
  for (let page = 1; page < totalPages; page++) {
    if (page % 50 === 0) console.log(`  📥 ${page}/${totalPages} (${count} 筆)`);
    const data = await fetchPage(page, token);
    writeItems(data.items);
    // Let GC work
    if (page % 100 === 0) {
      await new Promise(r => setTimeout(r, 100));
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
  
  ws.end();
  await new Promise(r => ws.on('finish', r));
  console.log(`✅ CSV 下載完成：${count} 筆 → ${CSV_FILE}`);
  return count;
}

async function uploadToSheet() {
  console.log('📤 上傳到 Google Sheet...');
  
  const csvContent = readFileSync(CSV_FILE, 'utf8');
  const lines = csvContent.trim().split('\n');
  console.log(`  讀取 ${lines.length} 行 CSV`);
  
  // Parse CSV
  const rows = lines.map(line => {
    // Simple CSV parse
    const parts = [];
    let current = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuote && line[i+1] === '"') { current += '"'; i++; }
        else inQuote = !inQuote;
      } else if (c === ',' && !inQuote) {
        parts.push(current); current = '';
      } else {
        current += c;
      }
    }
    parts.push(current);
    return parts;
  });

  const auth = new google.auth.GoogleAuth({
    keyFile: join(process.env.HOME, '.openclaw/secrets/gcp-service-account.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Clear
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: 'Sheet1' });

  // Write in batches
  const BATCH = 10000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const startRow = i + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Sheet1!A${startRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: batch },
    });
    console.log(`  ✅ 寫入 ${startRow} ~ ${startRow + batch.length - 1}`);
  }

  // Format header
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.2, green: 0.4, blue: 0.6 },
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              }
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          }
        },
        {
          updateSheetProperties: {
            properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          }
        },
      ]
    }
  });

  console.log(`🎉 完成！共 ${rows.length - 1} 筆`);
  console.log(`📎 https://docs.google.com/spreadsheets/d/${SHEET_ID}/`);
}

async function main() {
  console.log('🚀 SayDou 會員點數清單匯出 v2');
  await downloadToCSV();
  await uploadToSheet();
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
