import { google } from 'googleapis';

/** Google Auth for Sheets read/write */
export async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getClient();
}
