#!/usr/bin/env bash
# 在「現有 Giveme 中繼 VM」（136.115.207.151）上執行，備份 /home/washfacecatgm/invoice-proxy 並列出啟動方式
# 用法：scp 到該 VM 後 chmod +x backup-giveme-vm-wash.sh && ./backup-giveme-vm-wash.sh
# 或直接貼到 SSH 終端執行

set -e
BACKUP="/tmp/invoice-proxy-backup-$(date +%Y%m%d-%H%M).tar.gz"
echo "=== 備份 /home/washfacecatgm/invoice-proxy ==="
sudo tar -czvf "$BACKUP" -C /home washfacecatgm/invoice-proxy
sudo chown "$USER:$USER" "$BACKUP"
echo "已建立: $BACKUP"
ls -la "$BACKUP"

echo ""
echo "=== Node 程序與啟動方式 ==="
PID=$(pgrep -f "invoice-proxy/app.js" | head -1)
if [ -n "$PID" ]; then
  echo "PID: $PID"
  ps aux | grep -E "^[^ ]+ +$PID " || true
  echo "工作目錄:"
  sudo ls -la /proc/$PID/cwd 2>/dev/null || true
  echo "指令列:"
  tr '\0' ' ' < /proc/$PID/cmdline 2>/dev/null; echo
  echo "環境變數 (NODE_ENV, PORT 等):"
  sudo cat /proc/$PID/environ 2>/dev/null | tr '\0' '\n' | grep -E 'NODE|PORT|PATH' || true
else
  echo "未找到 invoice-proxy/app.js 程序"
fi

echo ""
echo "=== /home/washfacecatgm/invoice-proxy 目錄結構 ==="
ls -la /home/washfacecatgm/invoice-proxy
echo ""
echo "=== package.json 入口 ==="
cat /home/washfacecatgm/invoice-proxy/package.json 2>/dev/null | head -30 || echo "無 package.json"

echo ""
echo "=== systemd 服務（若有）==="
systemctl list-units --type=service --all 2>/dev/null | grep -iE 'invoice|wash|node|8080' || true
ls -la /etc/systemd/system/*invoice* /etc/systemd/system/*wash* /etc/systemd/system/*node* 2>/dev/null || true

echo ""
echo "=== 下載到本機（在本機執行）==="
echo "  gcloud compute scp USER@INSTANCE:$BACKUP ./vm-backup/ --zone=ZONE --project=PROJECT"
echo "或"
echo "  scp USER@136.115.207.151:$BACKUP ./vm-backup/"
