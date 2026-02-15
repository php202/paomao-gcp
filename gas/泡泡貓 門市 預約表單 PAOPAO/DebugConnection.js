function debugCoreConnection() {
  console.log('=== 開始連線檢查 ===');
  
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty("PAO_CAT_CORE_API_URL");
  var key = props.getProperty("PAO_CAT_SECRET_KEY");
  
  console.log('1. 檢查設定值');
  console.log('URL: ' + url);
  console.log('Key: ' + (key ? key.substring(0, 5) + '...' : '未設定'));
  
  if (!url) {
    console.error('錯誤：未設定 PAO_CAT_CORE_API_URL');
    return;
  }
  
  if (url.indexOf('/dev') !== -1) {
    console.error('嚴重錯誤：URL 包含 "/dev"。這是測試網址，無法供外部呼叫。請改用 "/exec" 結尾的網址。');
    return;
  }
  
  if (url.indexOf('/exec') === -1) {
    console.warn('警告：URL 未包含 "/exec"，可能不正確。');
  }

  console.log('2. 嘗試發送請求');
  var fullUrl = url + (url.indexOf('?') !== -1 ? '&' : '?') + 'action=storeDataReport&key=' + encodeURIComponent(key) + '&startDate=2026-01-01&endDate=2026-01-01';
  
  console.log('測試 URL (隱藏 key): ' + fullUrl.replace(key, '***'));
  
  try {
    var res = UrlFetchApp.fetch(fullUrl, {
      muteHttpExceptions: true,
      followRedirects: false // 不自動轉址，以便觀察 302
    });
    
    var code = res.getResponseCode();
    console.log('回傳狀態碼: ' + code);
    
    var headers = res.getHeaders();
    if (code === 302) {
      console.error('收到 302 轉址。Location: ' + headers['Location']);
      if (headers['Location'].indexOf('accounts.google.com') !== -1) {
        console.error('原因確認：被轉址到 Google 登入頁。表示權限不足或使用了測試網址。');
      }
    } else if (code === 200) {
      console.log('連線成功！回傳內容前 100 字:');
      console.log(res.getContentText().substring(0, 100));
    } else {
      console.log('其他狀態碼。內容: ' + res.getContentText().substring(0, 200));
    }
    
  } catch (e) {
    console.error('發生例外錯誤: ' + e.toString());
  }
  
  console.log('=== 檢查結束 ===');
}
