import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

/** Google Auth for Sheets read/write */
export async function getAuth() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const resolvedPath = keyPath ? path.resolve(process.cwd(), keyPath) : null;
  const useKeyFile = resolvedPath && fs.existsSync(resolvedPath);

  const auth = new google.auth.GoogleAuth({
    ...(useKeyFile ? { keyFile: resolvedPath } : {}),
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive', // 店家本月/上月出勤產出試算表並分享連結用
    ],
  });
  return await auth.getClient();
}
