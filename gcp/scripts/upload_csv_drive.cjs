/**
 * 用 Drive API 上傳 CSV 並轉換為 Google Sheet（最快方式）
 * 然後把內容複製到目標 Sheet
 */
const { createReadStream, readFileSync } = require('fs');
const { join } = require('path');
const { google } = require('googleapis');

const TARGET_SHEET_ID = '1uacbUP8dlS2bh8Oup83YacxtEUZg-Oss0g218o1TK4w';
const CSV_FILE = '/tmp/member_points.csv';
const SHEET_NAME = '工作表1';

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: join(process.env.HOME, '.openclaw/secrets/gcp-service-account.json'),
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  // 1. Upload CSV as temporary Google Sheet
  console.log('📤 上傳 CSV 到 Drive (轉 Google Sheet)...');
  const res = await drive.files.create({
    requestBody: {
      name: 'member_points_temp',
      mimeType: 'application/vnd.google-apps.spreadsheet',
    },
    media: {
      mimeType: 'text/csv',
      body: createReadStream(CSV_FILE),
    },
    fields: 'id',
  });
  const tempId = res.data.id;
  console.log(`  ✅ 暫存 Sheet: ${tempId}`);

  // 2. 讀取暫存 sheet 的數據資訊
  const tempMeta = await sheets.spreadsheets.get({
    spreadsheetId: tempId,
    fields: 'sheets.properties'
  });
  const tempSheetName = tempMeta.data.sheets[0].properties.title;
  const rowCount = tempMeta.data.sheets[0].properties.gridProperties.rowCount;
  console.log(`  📊 暫存 Sheet: ${rowCount} 行`);

  // 3. 目標 sheet 擴大
  console.log('📐 調整目標 Sheet 大小...');
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: TARGET_SHEET_ID,
    requestBody: {
      requests: [{
        updateSheetProperties: {
          properties: { sheetId: 0, gridProperties: { rowCount: rowCount + 100, columnCount: 10 } },
          fields: 'gridProperties.rowCount,gridProperties.columnCount'
        }
      }]
    }
  });

  // 4. 清除目標
  await sheets.spreadsheets.values.clear({
    spreadsheetId: TARGET_SHEET_ID,
    range: `'${SHEET_NAME}'`
  });

  // 5. 從暫存 sheet 分批讀取並寫入目標
  console.log('📋 複製數據...');
  const BATCH = 10000;
  for (let start = 1; start <= rowCount; start += BATCH) {
    const end = Math.min(start + BATCH - 1, rowCount);
    const readRes = await sheets.spreadsheets.values.get({
      spreadsheetId: tempId,
      range: `'${tempSheetName}'!A${start}:H${end}`,
    });
    const values = readRes.data.values || [];
    if (values.length > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: TARGET_SHEET_ID,
        range: `'${SHEET_NAME}'!A${start}:H${start + values.length - 1}`,
        valueInputOption: 'RAW',
        requestBody: { values },
      });
    }
    console.log(`  ✅ ${start} ~ ${end} (${values.length} 行)`);
    values.length = 0; // 釋放記憶體
  }

  // 6. Format header
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

  // 7. 刪除暫存
  console.log('🗑️ 清理暫存...');
  await drive.files.delete({ fileId: tempId });

  console.log(`🎉 完成！${rowCount - 1} 筆點數資料`);
  console.log(`📎 https://docs.google.com/spreadsheets/d/${TARGET_SHEET_ID}/`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
