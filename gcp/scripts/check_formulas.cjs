const { google } = require('googleapis');
const key = require('/Users/paopaomao/.openclaw/secrets/gcp-service-account.json');

async function main() {
  const auth = new google.auth.JWT(key.client_email, null, key.private_key, [
    'https://www.googleapis.com/auth/spreadsheets.readonly'
  ]);
  const sheets = google.sheets({ version: 'v4', auth });
  const SHEET_ID = '17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE';

  // Check formulas in the ACH sheet - look at rows around 1120
  const res = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    ranges: ["'2026/ACH紀錄'!A1115:Q1135"],
    fields: 'sheets.data.rowData.values.userEnteredValue'
  });

  const rowData = res.data.sheets?.[0]?.data?.[0]?.rowData || [];
  rowData.forEach((row, i) => {
    const rowNum = 1115 + i;
    const cells = row.values || [];
    const formulas = cells.filter(c => c.userEnteredValue?.formulaValue);
    if (formulas.length > 0) {
      console.log(`Row ${rowNum} has formulas:`);
      cells.forEach((c, j) => {
        if (c.userEnteredValue?.formulaValue) {
          const col = String.fromCharCode(65 + j);
          console.log(`  ${col}: ${c.userEnteredValue.formulaValue}`);
        }
      });
    } else {
      // Show if it's string or number values
      const vals = cells.map(c => {
        if (c.userEnteredValue?.stringValue) return 'str';
        if (c.userEnteredValue?.numberValue !== undefined) return 'num';
        if (c.userEnteredValue?.boolValue !== undefined) return 'bool';
        if (c.userEnteredValue?.formulaValue) return 'formula';
        return '';
      }).filter(Boolean);
      if (vals.length > 0) console.log(`Row ${rowNum}: ${vals.join(',')}`);
    }
  });
}
main().catch(e => console.error(e.message));
