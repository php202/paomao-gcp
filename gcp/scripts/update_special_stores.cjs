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

// 更新特別門市（不收服務費）
async function updateSpecialStores(specialStores) {
  try {
    console.log('🔄 更新特別門市的服務費設定...');
    
    // 先讀取現有資料
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'A1:E25'
    });
    
    const rows = response.data.values;
    const updates = [];
    
    // 找出特別門市並修改服務費
    for (let i = 1; i < rows.length; i++) { // 跳過標題行
      const storeName = rows[i][0];
      
      if (specialStores.some(special => storeName.includes(special))) {
        console.log(`📝 發現特別門市: ${storeName} - 設定服務費為 0%`);
        
        // 更新 D 欄 (服務費) 為 0
        updates.push({
          range: `D${i + 1}`,
          values: [[0]]
        });
        
        // 更新 E 欄 (總計) 為廣告費 + 手續費
        updates.push({
          range: `E${i + 1}`,
          values: [[`=B${i + 1}+C${i + 1}`]]
        });
      }
    }
    
    if (updates.length > 0) {
      // 批量更新
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: updates
        }
      });
      
      console.log(`✅ 更新完成！修改了 ${updates.length / 2} 間特別門市`);
    } else {
      console.log('ℹ️ 沒有找到符合的特別門市');
    }
    
  } catch (error) {
    console.error('❌ 更新失敗:', error.message);
  }
}

// 如果直接執行腳本
if (require.main === module) {
  const specialStores = process.argv.slice(2);
  
  if (specialStores.length === 0) {
    console.log(`
🏪 特別門市設定工具

使用方法：
  node update_special_stores.cjs <門市1> <門市2> ...

範例：
  node update_special_stores.cjs "楠梓大學店" "左營海軍店"
  node update_special_stores.cjs 楠梓 海軍

說明：
- 特別門市的服務費將設為 0%
- 只保留廣告費 + 手續費 15%
- 支援部分門市名稱匹配
`);
    process.exit(0);
  }
  
  updateSpecialStores(specialStores);
}

module.exports = { updateSpecialStores };