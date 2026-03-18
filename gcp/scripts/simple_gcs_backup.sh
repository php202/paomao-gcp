#!/bin/bash
# 簡易 GCS 備份 (用 REST API，不需額外工具)

set -e
TODAY=$(date '+%Y-%m-%d')
BACKUP_DIR="$HOME/Backups/$TODAY"
ARCHIVE="/tmp/backup-${TODAY}.tar.gz"
BUCKET="paomao-backups-1773830284"  # 會自動建立
SA_KEY="$HOME/.openclaw/secrets/gcp-service-account.json"

if [ ! -d "$BACKUP_DIR" ]; then
  echo "❌ No backup found for $TODAY"
  exit 1
fi

echo "📦 Compressing backup..."
tar -czf "$ARCHIVE" -C "$HOME/Backups" "$TODAY" 2>/dev/null
SIZE=$(du -h "$ARCHIVE" | cut -f1)
echo "📦 Size: $SIZE"

echo "☁️ Uploading to GCS..."
# 取得 access token
TOKEN=$(node -e "
const fs=require('fs'), crypto=require('crypto'), https=require('https');
const sa=JSON.parse(fs.readFileSync('$SA_KEY'));
const jwt=[
  Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url'),
  Buffer.from(JSON.stringify({iss:sa.client_email,scope:'https://www.googleapis.com/auth/cloud-platform',aud:'https://oauth2.googleapis.com/token',exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000)})).toString('base64url')
].join('.');
const sig=crypto.sign('RSA-SHA256',Buffer.from(jwt),sa.private_key).toString('base64url');
const req=https.request({hostname:'oauth2.googleapis.com',path:'/token',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(JSON.parse(d).access_token))});
req.write('grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion='+jwt+'.'+sig);
req.end();
")

if [ -z "$TOKEN" ]; then
  echo "❌ Failed to get access token"
  exit 1
fi

# 直接上傳 (simple upload)
RESPONSE=$(curl -s -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/gzip" \
  --data-binary @"$ARCHIVE" \
  "https://storage.googleapis.com/upload/storage/v1/b/$BUCKET/o?uploadType=media&name=backup-$TODAY.tar.gz")

rm -f "$ARCHIVE"

if [[ "$RESPONSE" =~ "200" ]]; then
  echo "✅ Upload success: backup-$TODAY.tar.gz ($SIZE)"
else
  echo "❌ Upload failed: $RESPONSE"
  exit 1
fi
