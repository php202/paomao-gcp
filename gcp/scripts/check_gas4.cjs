const { google } = require('googleapis');
const key = require('/Users/paopaomao/.openclaw/secrets/gcp-service-account.json');

async function main() {
  const auth = new google.auth.JWT(key.client_email, null, key.private_key, [
    'https://www.googleapis.com/auth/drive'
  ]);
  const drive = google.drive({ version: 'v3', auth });
  const SHEET_ID = '17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE';

  const res = await drive.revisions.list({ 
    fileId: SHEET_ID, 
    fields: 'revisions(id,modifiedTime,lastModifyingUser)',
    pageSize: 1000
  });
  const revisions = res.data.revisions || [];
  console.log('Total revisions returned:', revisions.length);

  // Show last 30
  console.log('\n=== Last 30 Revisions ===');
  revisions.slice(-30).forEach(r => {
    const email = r.lastModifyingUser?.emailAddress || 'unknown';
    const name = r.lastModifyingUser?.displayName || '';
    console.log(r.modifiedTime, name.padEnd(25), email);
  });
}
main().catch(e => console.error(e.message));
