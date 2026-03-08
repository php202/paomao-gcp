const { google } = require('googleapis');
const key = require('/Users/paopaomao/.openclaw/secrets/gcp-service-account.json');

async function main() {
  const auth = new google.auth.JWT(key.client_email, null, key.private_key, [
    'https://www.googleapis.com/auth/script.projects',
    'https://www.googleapis.com/auth/spreadsheets'
  ]);

  const sheets = google.sheets({ version: 'v4', auth });
  const SHEET_ID = '17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE';

  // Check revision history to see who added rows recently
  const drive = google.drive({ version: 'v3', auth });
  try {
    const revisions = await drive.revisions.list({ fileId: SHEET_ID, fields: 'revisions(id,modifiedTime,lastModifyingUser)' });
    console.log('=== Recent Sheet Revisions ===');
    const recent = (revisions.data.revisions || []).slice(-10);
    recent.forEach(r => console.log(r.modifiedTime, '-', r.lastModifyingUser?.displayName || 'unknown', `(${r.lastModifyingUser?.emailAddress || ''})`));
  } catch (e) {
    console.log('Cannot access revisions:', e.message);
  }
}
main().catch(e => console.error(e.message));
