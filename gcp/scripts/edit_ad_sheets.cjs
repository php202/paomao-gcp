const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// 載入 Google 憑證
const credentialsPath = path.join(process.env.HOME, '.openclaw/secrets/gcp-service-account.json');
const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

const auth = new google.auth.GoogleAuth({
  credentials: credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({version: 'v4', auth});

const SPREADSHEET_ID = '1GFcmur1xj9MKuyYBF81AM3zEhEX_LNQ0K6l2wevnpbA';

// 3月廣告費用資料
const adData = [
  ['門市', '廣告費', '手續費15%', '服務費5%', '總計'],
  ['F1 楠梓大學店', 16048, '=B2*0.15', '=B2*0.05', '=B2+C2+D2'],
  ['J1 左營海軍店', 10785, '=B3*0.15', '=B3*0.05', '=B3+C3+D3'],
  ['J2 台南東寧店', 12845, '=B4*0.15', '=B4*0.05', '=B4+C4+D4'],
  ['J3 內湖東湖店', 19336, '=B5*0.15', '=B5*0.05', '=B5+C5+D5'],
  ['J4 雲林虎尾店', 15882, '=B6*0.15', '=B6*0.05', '=B6+C6+D6'],
  ['J5 雲林斗六店', 17349, '=B7*0.15', '=B7*0.05', '=B7+C7+D7'],
  ['J6 嘉義忠孝店', 14926, '=B8*0.15', '=B8*0.05', '=B8+C8+D8'],
  ['J7 楊梅金山店', 19580, '=B9*0.15', '=B9*0.05', '=B9+C9+D9'],
  ['J8 桃園八德店', 13494, '=B10*0.15', '=B10*0.05', '=B10+C10+D10'],
  ['J9 桃園內壢店', 21707, '=B11*0.15', '=B11*0.05', '=B11+C11+D11'],
  ['J10 三峽大同店', 20057, '=B12*0.15', '=B12*0.05', '=B12+C12+D12'],
  ['J11 宜蘭站前店', 9291, '=B13*0.15', '=B13*0.05', '=B13+C13+D13'],
  ['J12 羅東林森店', 7756, '=B14*0.15', '=B14*0.05', '=B14+C14+D14'],
  ['J13 新莊中平店', 15789, '=B15*0.15', '=B15*0.05', '=B15+C15+D15'],
  ['J14 頭份尚順店', 14313, '=B16*0.15', '=B16*0.05', '=B16+C16+D16'],
  ['J15 彰化中興店', 12292, '=B17*0.15', '=B17*0.05', '=B17+C17+D17'],
  ['J16 員林中山店', 19836, '=B18*0.15', '=B18*0.05', '=B18+C18+D18'],
  ['J17 台南善化店', 9511, '=B19*0.15', '=B19*0.05', '=B19+C19+D19'],
  ['J18 台南安南店', 9190, '=B20*0.15', '=B20*0.05', '=B20+C20+D20'],
  ['J19 高雄前鎮店', 13904, '=B21*0.15', '=B21*0.05', '=B21+C21+D21'],
  ['J20 高雄陽明店', 12678, '=B22*0.15', '=B22*0.05', '=B22+C22+D22'],
  ['', '', '', '', ''],
  ['總計', '=SUM(B2:B22)', '=SUM(C2:C22)', '=SUM(D2:D22)', '=SUM(E2:E22)']
];

async function editSheets() {
  try {
    console.log('🔄 正在編輯 Google Sheets...');
    
    // 清除現有內容並寫入新資料
    const response = await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'A1:E25',
      valueInputOption: 'USER_ENTERED', // 讓公式自動計算
      requestBody: {
        values: adData
      }
    });
    
    console.log('✅ 成功更新', response.data.updatedCells, '個儲存格');
    console.log('📊 內容包含:');
    console.log('- 21 家門市廣告費用');
    console.log('- 自動計算手續費 (15%)');
    console.log('- 自動計算服務費 (5%)');
    console.log('- 自動計算總計');
    console.log('- 底部總計統計');
    
    // 同時格式化表格
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId: 0,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: 5
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.8, green: 0.9, blue: 1.0 },
                  textFormat: { bold: true }
                }
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)'
            }
          }
        ]
      }
    });
    
    console.log('🎨 表格格式化完成');
    
  } catch (error) {
    console.error('❌ 編輯失敗:', error.message);
    if (error.message.includes('permission')) {
      console.log('💡 請確認 Service Account 有此試算表的編輯權限');
    }
  }
}

editSheets();