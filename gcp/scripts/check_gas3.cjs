const { google } = require('googleapis');
const key = require('/Users/paopaomao/.openclaw/secrets/gcp-service-account.json');

async function main() {
  const auth = new google.auth.JWT(key.client_email, null, key.private_key, [
    'https://www.googleapis.com/auth/drive'
  ]);
  const drive = google.drive({ version: 'v3', auth });
  const SHEET_ID = '17hX7CjeDj2xdKBIt9TKG6iJF5lB38uXwj2kdhb4oIQE';

  let pageToken = null;
  let allRevisions = [];
  do {
    const res = await drive.revisions.list({ 
      fileId: SHEET_ID, 
      fields: 'nextPageToken,revisions(id,modifiedTime,lastModifyingUser)',
      pageSize: 200,
      pageToken
    });
    allRevisions.push(...(res.data.revisions || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  // Show last 20
  console.log(`Total revisions: ${allRevisions.length}`);
  console.log('\n=== Last 20 Revisions ===');
  allRevisions.slice(-20).forEach(r => {
    const user = r.lastModifyingUser?.emailAddress || 'unknown';
    const name = r.lastModifyingUser?.displayName || '';
    console.log(r.modifiedTime, name.padEnd(20), user);
  });

  // Summary: who edited most recently (last week)
  const oneWeekAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString();
  const recentEdits = allRevisions.filter(r => r.modifiedTime > oneWeekAgo);
  const userCounts = {};
  recentEdits.forEach(r => {
    const email = r.lastModifyingUser?.emailAddress || 'unknown';
    userCounts[email] = (userCounts[email] || 0) + 1;
  });
  console.log('\n=== Last 7 days edit count ===');
  Object.entries(userCounts).sort((a,b) => b[1]-a[1]).forEach(([email, count]) => {
    console.log(`  ${count}x - ${email}`);
  });
}
main().catch(e => console.error(e.message));
