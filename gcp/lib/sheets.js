import { google } from 'googleapis';

export async function readSheet(auth, spreadsheetId, range) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

/** 寫入指定範圍（單一列或多列）；values 為二維陣列，undefined/null 會轉成空字串 */
export async function writeSheet(auth, spreadsheetId, range, values) {
  const sheets = google.sheets({ version: 'v4', auth });
  const rows = Array.isArray(values[0]) ? values : [values];
  const sanitized = rows.map((row) =>
    (Array.isArray(row) ? row : [row]).map((c) =>
      c == null || c === undefined ? '' : c
    )
  );
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: sanitized },
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

/** 多筆 values update（同 spreadsheet），避免多次往返 */
export async function batchUpdateValues(auth, spreadsheetId, updates, valueInputOption = 'USER_ENTERED') {
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption, data: updates },
  });
}

/** 取得工作表 sheetId（給 batchUpdate 用） */
export async function getSheetIdByName(auth, spreadsheetId, sheetName) {
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets?.find((s) => s.properties?.title === sheetName);
  return sheet?.properties?.sheetId ?? null;
}

/** 刪除指定 1-based row indices（不含 header 的話請自行算） */
export async function deleteRows(auth, spreadsheetId, sheetId, rowIndices1Based = []) {
  const sheets = google.sheets({ version: 'v4', auth });
  const uniq = Array.from(new Set(rowIndices1Based.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 1)));
  uniq.sort((a, b) => b - a); // delete bottom-up
  const requests = uniq.map((row1) => ({
    deleteDimension: {
      range: { sheetId, dimension: 'ROWS', startIndex: row1 - 1, endIndex: row1 },
    },
  }));
  if (!requests.length) return;
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}
