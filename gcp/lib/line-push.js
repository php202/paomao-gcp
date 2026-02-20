/**
 * 發送 LINE Push 訊息給管理員（Token 異常、查空位除錯等）
 * 需設定 ADMIN_LINE_USER_ID、LINE_TOKEN_PAOSTAFF（員工打卡頻道 Token，管理員須已加該 bot 為好友）
 */

/**
 * @param {string} text - 要推播的純文字內容
 * @returns {Promise<boolean>} 是否成功送出
 */
export async function sendAdminLinePush(text) {
  const userId = process.env.ADMIN_LINE_USER_ID?.trim();
  const token = process.env.LINE_TOKEN_PAOSTAFF?.trim();
  if (!userId || !token) {
    console.warn('[GCP] 未設定 ADMIN_LINE_USER_ID 或 LINE_TOKEN_PAOSTAFF，無法發送 LINE 推播。');
    return false;
  }
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: userId, messages: [{ type: 'text', text: String(text || '') }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn('[GCP] LINE push 失敗:', res.status, body?.slice(0, 200));
      return false;
    }
    console.log('[GCP] 已發送 LINE 推播給管理員');
    return true;
  } catch (e) {
    console.error('[GCP] LINE push 失敗:', e?.message || e);
    return false;
  }
}
