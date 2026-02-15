import nodemailer from 'nodemailer';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'paopaomao.of@gmail.com';

/**
 * 寄送通知信（SayDou Token 異常等）
 * 需設定 GMAIL_USER, GMAIL_APP_PASSWORD（Gmail 應用程式密碼）
 */
export async function sendNotification(subject, body) {
  const user = process.env.GMAIL_USER?.trim();
  const pass = process.env.GMAIL_APP_PASSWORD?.trim();
  if (!user || !pass) {
    console.warn('[GCP] 未設定 GMAIL_USER / GMAIL_APP_PASSWORD，無法寄信。請在 .env 設定。');
    return false;
  }
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
    await transporter.sendMail({
      from: user,
      to: ADMIN_EMAIL,
      subject: subject || '[泡泡貓] GCP 通知',
      text: body || '',
    });
    console.log('[GCP] 已寄信至', ADMIN_EMAIL);
    return true;
  } catch (e) {
    console.error('[GCP] 寄信失敗:', e?.message || e);
    return false;
  }
}
