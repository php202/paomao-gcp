// background.js

// 設定點擊圖示時，直接打開側邊欄
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// (選用) 只有在 chat.line.biz 網域才啟用此功能，避免在其他網站佔位
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!tab.url) return;
  
  const url = new URL(tab.url);
  // 如果是 LINE 後台，就啟用側邊欄
  if (url.origin === 'https://chat.line.biz') {
    chrome.sidePanel.setOptions({
      tabId,
      path: 'popup.html',
      enabled: true
    });
  } else {
    // 其他網站可以選擇關閉，或是保持開啟皆可 (這裡預設保持開啟簡單好用)
    chrome.sidePanel.setOptions({
      tabId,
      path: 'popup.html',
      enabled: true
    });
  }
});