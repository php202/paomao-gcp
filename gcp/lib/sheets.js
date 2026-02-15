import { google } from 'googleapis';

export async function readSheet(auth, spreadsheetId, range) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

/** 寫入指定範圍（單一列或多列） */
export async function writeSheet(auth, spreadsheetId, range, values) {
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: Array.isArray(values[0]) ? values : [values] },
  });
}

/** 在指定欄位中搜尋值，回傳 1-based 列號；找不到回傳 null（讀取 A1 表示法的欄，如 "E2:E"） */
export async function findRowByColumnValue(auth, spreadsheetId, rangeA1, searchValue) {
  const rows = await readSheet(auth, spreadsheetId, rangeA1);
  const needle = String(searchValue).trim();
  for (let i = 0; i < rows.length; i++) {
    const cell = rows[i][0];
    if (cell != null && String(cell).trim() === needle) return i + 2; // 假設 range 從第 2 列開始
  }
  return null;
}

/** 讀取試算表總列數（依某欄有值的最後一列）；sheetName 如 '員工打卡紀錄' */
export async function getLastRow(auth, spreadsheetId, sheetName, columnLetter = 'A') {
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets?.find((s) => s.properties?.title === sheetName);
  if (!sheet) return 0;
  const range = `'${sheetName}'!${columnLetter}:${columnLetter}`;
  const rows = await readSheet(auth, spreadsheetId, range);
  let last = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][0] != null && String(rows[i][0]).trim() !== '') {
      last = i + 1;
      break;
    }
  }
  return last;
}

/** 在指定工作表的下一列追加一列資料；sheetName 如 '員工打卡紀錄' */
export async function appendSheet(auth, spreadsheetId, sheetName, rowValues) {
  const sheets = google.sheets({ version: 'v4', auth });
  const range = `'${sheetName}'!A:A`;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [Array.isArray(rowValues) ? rowValues : [rowValues]] },
  });
}
