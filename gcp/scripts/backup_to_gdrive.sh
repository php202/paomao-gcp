#!/bin/bash
# 每日備份壓縮後上傳 Google Drive（異地備份）
# 使用既有的每日備份 ~/Backups/YYYY-MM-DD/，壓縮後上傳

set -e

TODAY=$(date '+%Y-%m-%d')
BACKUP_DIR="$HOME/Backups/$TODAY"
ARCHIVE="/tmp/backup-${TODAY}.tar.gz"
GDRIVE_FOLDER_ID=""  # Will be set on first run
STATE_FILE="$HOME/.openclaw/workspace/memory/backup-gdrive-state.json"
TG_BOT_TOKEN=$(cat ~/.openclaw/secrets/telegram-bot-token.txt 2>/dev/null)
TG_CHAT_ID="7956245081"  # Robby private

log() { echo "[$(date '+%H:%M:%S')] $1"; }

notify_tg() {
  if [ -n "$TG_BOT_TOKEN" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      -d chat_id="$TG_CHAT_ID" \
      -d text="$1" > /dev/null 2>&1
  fi
}

# Check if today's backup exists
if [ ! -d "$BACKUP_DIR" ]; then
  log "❌ Today's backup not found: $BACKUP_DIR"
  notify_tg "❌ 異地備份失敗：$TODAY 的本機備份不存在"
  exit 1
fi

# Compress (exclude large unnecessary files)
log "📦 Compressing $BACKUP_DIR..."
tar -czf "$ARCHIVE" -C "$HOME/Backups" "$TODAY" 2>/dev/null

ARCHIVE_SIZE=$(du -h "$ARCHIVE" | cut -f1)
log "📦 Archive size: $ARCHIVE_SIZE"

# Upload using Google Drive API via service account
log "☁️ Uploading to Google Drive..."

# Get access token from service account
SA_KEY="$HOME/.openclaw/secrets/gcp-service-account.json"
if [ ! -f "$SA_KEY" ]; then
  log "❌ Service account key not found"
  notify_tg "❌ 異地備份失敗：找不到 GCP service account"
  rm -f "$ARCHIVE"
  exit 1
fi

# Use node to get token and upload (JWT signing needs crypto)
node -e "
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const sa = JSON.parse(fs.readFileSync('$SA_KEY', 'utf8'));

// Create JWT
const header = Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
const now = Math.floor(Date.now()/1000);
const claim = Buffer.from(JSON.stringify({
  iss: sa.client_email,
  scope: 'https://www.googleapis.com/auth/drive.file',
  aud: 'https://oauth2.googleapis.com/token',
  exp: now + 3600,
  iat: now
})).toString('base64url');

const sig = crypto.sign('RSA-SHA256', Buffer.from(header+'.'+claim), sa.private_key).toString('base64url');
const jwt = header+'.'+claim+'.'+sig;

// Get access token
const postData = 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion='+jwt;
const req = https.request({
  hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
  headers: {'Content-Type':'application/x-www-form-urlencoded','Content-Length':postData.length}
}, res => {
  let data=''; res.on('data',c=>data+=c); res.on('end', async () => {
    const token = JSON.parse(data).access_token;
    if(!token){console.error('Token error:',data);process.exit(1);}
    
    // Check/create backup folder
    const searchRes = await fetch('https://www.googleapis.com/drive/v3/files?q=name%3D%27paomao-backups%27+and+mimeType%3D%27application/vnd.google-apps.folder%27&fields=files(id)', {
      headers: {'Authorization': 'Bearer '+token}
    });
    const searchData = await searchRes.json();
    let folderId;
    if(searchData.files && searchData.files.length > 0) {
      folderId = searchData.files[0].id;
    } else {
      const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method:'POST', headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
        body: JSON.stringify({name:'paomao-backups',mimeType:'application/vnd.google-apps.folder'})
      });
      folderId = (await createRes.json()).id;
    }
    
    // Upload file (resumable for large files)
    const fileSize = fs.statSync('$ARCHIVE').size;
    const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method:'POST', headers:{
        'Authorization':'Bearer '+token,
        'Content-Type':'application/json',
        'X-Upload-Content-Type':'application/gzip',
        'X-Upload-Content-Length': fileSize.toString()
      },
      body: JSON.stringify({name:'backup-$TODAY.tar.gz', parents:[folderId]})
    });
    const uploadUrl = initRes.headers.get('location');
    
    const fileData = fs.readFileSync('$ARCHIVE');
    const uploadRes = await fetch(uploadUrl, {
      method:'PUT', headers:{'Content-Type':'application/gzip'}, body: fileData
    });
    const result = await uploadRes.json();
    
    if(result.id) {
      console.log(JSON.stringify({success:true, fileId:result.id, folderId:folderId, size:'$ARCHIVE_SIZE'}));
    } else {
      console.error('Upload failed:', JSON.stringify(result));
      process.exit(1);
    }
  });
});
req.write(postData);
req.end();
" 2>&1

UPLOAD_RESULT=$?

# Cleanup
rm -f "$ARCHIVE"

if [ $UPLOAD_RESULT -eq 0 ]; then
  log "✅ Upload complete"
  
  # Update state
  cat > "$STATE_FILE" << EOF
{
  "lastUpload": "$TODAY",
  "archiveSize": "$ARCHIVE_SIZE",
  "timestamp": "$(date '+%Y-%m-%d %H:%M:%S')"
}
EOF

  # Clean old Drive backups (keep 14 days) - done via separate cleanup
  notify_tg "✅ 異地備份完成：$TODAY ($ARCHIVE_SIZE) 已上傳 Google Drive"
else
  log "❌ Upload failed"
  notify_tg "❌ 異地備份失敗：上傳 Google Drive 錯誤"
  exit 1
fi
