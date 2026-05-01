/**
 * 分批上傳到目標 Sheet — 每次上傳一個分割檔
 */
const { readFileSync } = require('fs');
const { join } = require('path');
const { google } = require('googleapis');

const TARGET_SHEET_ID = '1uacbUP8dlS2bh8Oup83YacxtEUZg-Oss0g218o1TK4w';
const SHEET_NAME = '工作表1';
const TOTAL_ROWS = 120666;

const parts = [
  { file: '/tmp/member_points_part_aa_with_header.csv', skipHeader: false },
  { file: '/tmp/member_points_part_ab_with_header.csv', skipHeader: true },
  { file: '/tmp/member_points_part_ac_with_header.csv', skipHeader: true },
  { file: '/tmp/member_points_part_ad_with_header.csv', skipHeader: true },
];

function parseCSV(content, skipHeader) {
  const lines = content.trim().split('\n');
  const start = skipHeader ? 1 : 0;
  return lines.slice(start).map(line => {
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
}

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: join(process.env.HOME, '.openclaw/secrets/gcp-service-account.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // 擴大
  console.log('📐 調整大小...');
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: TARGET_SHEET_ID,
    requestBody: {
      requests: [{
        updateSheetProperties: {
          properties: { sheetId: 0, gridProperties: { rowCount: TOTAL_ROWS + 100, columnCount: 10 } },
          fields: 'gridProperties.rowCount,gridProperties.columnCount'
        }
      }]
    }
  });

  // Clear
  console.log('🧹 清除...');
  await sheets.spreadsheets.values.clear({ spreadsheetId: TARGET_SHEET_ID, range: `'${SHEET_NAME}'` });

  let currentRow = 1;

  for (const part of parts) {
    console.log(`📤 處理 ${part.file}...`);
    const content = readFileSync(part.file, 'utf8');
    const rows = parseCSV(content, part.skipHeader);
    
    // 分 5000 行上傳
    const SUB_BATCH = 5000;
    for (let i = 0; i < rows.length; i += SUB_BATCH) {
      const batch = rows.slice(i, i + SUB_BATCH);
      const endRow = currentRow + batch.length - 1;
      
      await sheets.spreadsheets.values.update({
        spreadsheetId: TARGET_SHEET_ID,
        range: `'${SHEET_NAME}'!A${currentRow}:H${endRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: batch },
      });
      console.log(`  ✅ ${currentRow} ~ ${endRow}`);
      currentRow = endRow + 1;
    }
    
    // 釋放記憶體
    global.gc && global.gc();
  }

  // Format
  console.log('🎨 格式化...');
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: TARGET_SHEET_ID,
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

  console.log(`🎉 完成！${currentRow - 2} 筆`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
