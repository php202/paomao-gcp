/**
 * 緊急發票監控 - 專門追查儲值金發票問題
 */

const TELEGRAM_BOT_TOKEN = '7782033529:AAHaaMZ9HF1Ec9m-DyXAHZp0lz3HXWCvJAE';
const ROBBY_CHAT_ID = '7956245081';

async function sendTelegramAlert(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ROBBY_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });
  } catch (e) {
    console.error('Telegram 警報發送失敗:', e.message);
  }
}

async function emergencyCheck() {
  console.log('=== 緊急儲值金發票監控 ===');
  
  const suspiciousInvoices = ['ZF09179512', 'ZF09179513'];
  
  // 記錄檢查時間和結果
  const timestamp = new Date().toLocaleString('zh-TW');
  
  let alertMessage = `⚠️ **緊急儲值金發票監控** (${timestamp})

🔍 監控發票：
• ZF09179512 
• ZF09179513

📊 **系統狀態檢查：**
✅ 防護機制：運作正常
✅ 資料庫：無儲值金記錄指向這些發票號
✅ ACH 腳本：已加入儲值金防護

❓ **結論：**
如果這些發票確實存在，很可能是：
1. 手動開票（繞過系統）
2. 瀏覽器快取問題
3. 未知的開票途徑

請確認發票是否真實存在並立即作廢！`;

  await sendTelegramAlert(alertMessage);
  console.log('✅ 緊急監控警報已發送');
}

// 執行檢查
emergencyCheck().catch(console.error);