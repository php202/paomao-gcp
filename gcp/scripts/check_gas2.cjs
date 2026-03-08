const { google } = require('googleapis');
const key = require('/Users/paopaomao/.openclaw/secrets/gcp-service-account.json');

async function main() {
  const auth = new google.auth.JWT(key.client_email, null, key.private_key, [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets'
  ]);

  const SHEET_ID = '17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE';

  // Check revision history
  const drive = google.drive({ version: 'v3', auth });
  try {
    const revisions = await drive.revisions.list({ 
      fileId: SHEET_ID, 
      fields: 'revisions(id,modifiedTime,lastModifyingUser)',
      pageSize: 20
    });
    console.log('=== Recent Sheet Revisions ===');
    const recent = (revisions.data.revisions || []).slice(-15);
    recent.forEach(r => console.log(
      r.modifiedTime, '-', 
      r.lastModifyingUser?.displayName || 'unknown', 
      `(${r.lastModifyingUser?.emailAddress || ''})`
    ));
  } catch (e) {
    console.log('Revisions error:', e.message?.slice(0,200));
  }

  // Check sheet metadata for bound scripts
  const sheets = google.sheets({ version: 'v4', auth });
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'developerMetadata' });
    console.log('\n=== Developer Metadata ===');
    console.log(JSON.stringify(meta.data.developerMetadata || 'none', null, 2));
  } catch(e) {
    console.log('Metadata:', e.message?.slice(0,100));
  }
}
main().catch(e => console.error(e.message));
