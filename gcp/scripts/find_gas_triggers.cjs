const { google } = require('googleapis');
const key = require('/Users/paopaomao/.openclaw/secrets/gcp-service-account.json');

async function main() {
  const auth = new google.auth.JWT(key.client_email, null, key.private_key, [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/script.projects'
  ]);

  const drive = google.drive({ version: 'v3', auth });
  
  // Search for Apps Script projects
  const res = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.script'",
    fields: 'files(id,name,modifiedTime)',
    pageSize: 50
  });
  
  console.log('=== GAS Projects accessible by service account ===');
  (res.data.files || []).forEach(f => {
    console.log(f.name, '|', f.id, '|', f.modifiedTime);
  });

  // For each project, try to get its content to look for ACH-related code
  const script = google.script({ version: 'v1', auth });
  for (const f of (res.data.files || [])) {
    try {
      const content = await script.projects.getContent({ scriptId: f.id });
      const files = content.data.files || [];
      const hasACH = files.some(file => 
        (file.source || '').includes('ACH') || (file.source || '').includes('appendRow')
      );
      if (hasACH) {
        console.log(`\n⚠️ ${f.name} contains ACH/appendRow references`);
        files.forEach(file => {
          if ((file.source||'').includes('ACH') || (file.source||'').includes('appendRow')) {
            console.log(`  - ${file.name}`);
          }
        });
      }
    } catch(e) {
      // Can't access this project
    }
  }
}
main().catch(e => console.error(e.message));
