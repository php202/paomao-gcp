/**
 * 上傳 /tmp/member_points.csv 到 Google Sheet（分段讀取版）
 */
const { createReadStream } = require('fs');
const { join } = require('path');
const { google } = require('googleapis');
const readline = require('readline');

const SHEET_ID = '1uacbUP8dlS2bh8Oup83YacxtEUZg-Oss0g218o1TK4w';
const CSV_FILE = '/tmp/member_points.csv';
const SHEET_NAME = '工作表1';
const BATCH = 5000;

function parseCSVLine(line) {
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
}

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: join(process.env.HOME, '.openclaw/secrets/gcp-service-account.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // 先算總行數
  let totalLines = 0;
  const rl1 = readline.createInterface({ input: createReadStream(CSV_FILE), crlfDelay: Infinity });
  for await (const _ of rl1) totalLines++;
  console.log(`📊 CSV: ${totalLines} 行`);

  // 擴大 sheet
  console.log('📐 調整大小...');
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        updateSheetProperties: {
          properties: { sheetId: 0, gridProperties: { rowCount: totalLines + 100, columnCount: 10 } },
          fields: 'gridProperties.rowCount,gridProperties.columnCount'
        }
      }]
    }
  });

  // Clear
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `'${SHEET_NAME}'` });

  // 分段讀取並上傳
  const rl = readline.createInterface({ input: createReadStream(CSV_FILE), crlfDelay: Infinity });
  let batch = [];
  let rowNum = 0;
  let batchStart = 1;

  for await (const line of rl) {
    batch.push(parseCSVLine(line));
    rowNum++;

    if (batch.length >= BATCH) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `'${SHEET_NAME}'!A${batchStart}:H${batchStart + batch.length - 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: batch },
      });
      console.log(`  ✅ ${batchStart} ~ ${batchStart + batch.length - 1}`);
      batchStart += batch.length;
      batch = [];
      // GC 友善
      if (global.gc) global.gc();
    }
  }

  // 剩餘的
  if (batch.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_NAME}'!A${batchStart}:H${batchStart + batch.length - 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: batch },
    });
    console.log(`  ✅ ${batchStart} ~ ${batchStart + batch.length - 1}`);
  }

  // Format
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

  console.log(`🎉 完成！${rowNum - 1} 筆`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
