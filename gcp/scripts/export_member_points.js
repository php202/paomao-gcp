/**
 * 匯出 SayDou 會員點數資料到 Google Sheet
 * 來源: /api/management/unearn/memberPoints
 * 目標: https://docs.google.com/spreadsheets/d/1uacbUP8dlS2bh8Oup83YacxtEUZg-Oss0g218o1TK4w/
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { google } from 'googleapis';

const TOKEN_FILE = join(process.env.HOME, '.openclaw/workspace/booking-site/.saydou-token');
const SHEET_ID = '1uacbUP8dlS2bh8Oup83YacxtEUZg-Oss0g218o1TK4w';
const API_BASE = 'https://saywebdatafeed.saydou.com/api/management/unearn/memberPoints';
const PAGE_SIZE = 100;
const DELAY_MS = 500; // 避免 429

function getToken() {
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

async function fetchPage(page, token) {
  const url = `${API_BASE}?page=${page}&limit=${PAGE_SIZE}&sort=points&order=desc&keyword=&tabIndex=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 429) {
    console.log(`  ⏳ Rate limited at page ${page}, waiting 10s...`);
    await new Promise(r => setTimeout(r, 10000));
    return fetchPage(page, token);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} at page ${page}`);
  const json = await res.json();
  if (!json.status) throw new Error(`API error at page ${page}: ${JSON.stringify(json)}`);
  return json.data;
}

async function fetchAllMembers() {
  const token = getToken();
  const firstPage = await fetchPage(0, token);
  const total = firstPage.total;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  console.log(`📊 總共 ${total} 筆，${totalPages} 頁`);

  let allItems = [...firstPage.items];
  
  for (let page = 1; page < totalPages; page++) {
    if (page % 50 === 0) console.log(`  📥 下載中... ${page}/${totalPages} (${allItems.length} 筆)`);
    try {
      const data = await fetchPage(page, token);
      allItems.push(...data.items);
    } catch (e) {
      console.error(`  ❌ Page ${page} failed: ${e.message}`);
      // retry once
      await new Promise(r => setTimeout(r, 5000));
      try {
        const data = await fetchPage(page, token);
        allItems.push(...data.items);
      } catch (e2) {
        console.error(`  ❌ Page ${page} retry failed, skipping`);
      }
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
  
  console.log(`✅ 下載完成：${allItems.length} 筆`);
  return allItems;
}

function formatGender(g) {
  if (g === 'm') return '男';
  if (g === 'f') return '女';
  return g || '';
}

async function writeToSheet(items) {
  const auth = new google.auth.GoogleAuth({
    keyFile: join(process.env.HOME, '.openclaw/secrets/gcp-service-account.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Header — 點數清單
  const headers = ['會員ID', '姓名', '手機', '點數', '門市名稱', '門市ID', '性別', '生日'];
  
  // Transform data — 依點數排序
  items.sort((a, b) => (b.points || 0) - (a.points || 0));
  
  const rows = items.map(item => [
    item.membid,
    item.memnam || '',
    item.phone_ || '',
    item.points || 0,
    item.stor?.stonam || '',
    item.storid,
    formatGender(item.gender),
    item.bthday || '',
  ]);

  console.log(`📝 寫入 Google Sheet (${rows.length} 筆)...`);

  // Clear existing data
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1',
  });

  // Write in batches of 10000
  const allData = [headers, ...rows];
  const BATCH_SIZE = 10000;
  
  for (let i = 0; i < allData.length; i += BATCH_SIZE) {
    const batch = allData.slice(i, i + BATCH_SIZE);
    const startRow = i + 1;
    const endRow = startRow + batch.length - 1;
    const range = `Sheet1!A${startRow}:I${endRow}`;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: batch },
    });
    
    console.log(`  ✅ 寫入 rows ${startRow}-${endRow}`);
  }

  // Format header row
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

  console.log(`🎉 完成！共 ${rows.length} 筆資料已寫入`);
  console.log(`📎 https://docs.google.com/spreadsheets/d/${SHEET_ID}/`);
}

async function main() {
  console.log('🚀 開始匯出 SayDou 會員點數資料...');
  const items = await fetchAllMembers();
  await writeToSheet(items);
}

main().catch(e => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
