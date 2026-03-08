#!/bin/bash
# 部署 shop.paopaomao.tw → https://paopaomao.tw/shop 重定向
# 執行日期：2026-03-07 00:00

set -e

echo "🛍️ 開始部署 shop.paopaomao.tw 重定向服務..."
echo "⏰ 執行時間: $(date)"

# 設置變數
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="/Users/paopaomao/.cloudflared/config.yml"
BACKUP_FILE="/Users/paopaomao/.cloudflared/config.yml.backup.$(date +%Y%m%d_%H%M%S)"
PLIST_FILE="$HOME/Library/LaunchAgents/com.paopaomao.shop-redirect.plist"

echo "📁 準備檔案..."

# 1. 備份現有 cloudflared 配置
echo "💾 備份現有 cloudflared 配置..."
cp "$CONFIG_FILE" "$BACKUP_FILE"
echo "✅ 備份儲存至: $BACKUP_FILE"

# 2. 啟動 shop redirect 服務
echo "🚀 啟動 shop redirect 服務..."
chmod +x "$SCRIPT_DIR/shop_redirect_server.js"

# 檢查服務是否已在運行
if launchctl list | grep -q "com.paopaomao.shop-redirect"; then
    echo "⚠️ 服務已存在，先停止..."
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
fi

# 載入服務
launchctl load "$PLIST_FILE"
echo "✅ Shop redirect 服務已啟動 (port 3870)"

# 等待服務啟動
sleep 3

# 驗證服務是否正常運行
if curl -s http://localhost:3870/health | grep -q "shop-redirect"; then
    echo "✅ Shop redirect 服務運行正常"
else
    echo "❌ Shop redirect 服務啟動失敗"
    exit 1
fi

# 3. 更新 cloudflared 配置
echo "🔧 更新 cloudflared 配置..."

# 創建新的配置內容
cat > "$CONFIG_FILE" << 'EOF'
tunnel: 8b514205-5c1a-4c62-b96d-c021c8380a0a
credentials-file: /Users/paopaomao/.cloudflared/8b514205-5c1a-4c62-b96d-c021c8380a0a.json
protocol: http2

ingress:
  - hostname: paopaomao.tw
    service: http://localhost:3900
  - hostname: ai.paopaomao.tw
    service: http://localhost:18789
    originRequest:
      noTLSVerify: true
  - hostname: todolist.paopaomao.tw
    service: http://localhost:3000
  - hostname: dashboard.paopaomao.tw
    service: http://localhost:3000
  - hostname: book.paopaomao.tw
    service: http://localhost:3457
  - hostname: line-reply.paopaomao.tw
    service: http://localhost:3800
  - hostname: gcp.paopaomao.tw
    service: http://localhost:3850
  - hostname: api.paopaomao.tw
    service: http://localhost:3860
  - hostname: site.paopaomao.tw
    service: http://localhost:8088
  - hostname: shop.paopaomao.tw
    service: http://localhost:3870
  - service: http_status:404
EOF

echo "✅ Cloudflared 配置已更新"

# 4. 重新啟動 cloudflared
echo "🔄 重新啟動 cloudflared 服務..."
launchctl kickstart -k gui/$(id -u)/com.paopaomao.cloudflared

# 等待服務重新啟動
sleep 5

# 5. 驗證部署
echo "🧪 驗證部署..."

# 檢查 cloudflared 是否運行
if pgrep cloudflared > /dev/null; then
    echo "✅ Cloudflared 運行正常"
else
    echo "❌ Cloudflared 啟動失敗"
    # 恢復備份
    cp "$BACKUP_FILE" "$CONFIG_FILE"
    launchctl kickstart -k gui/$(id -u)/com.paopaomao.cloudflared
    exit 1
fi

# 測試重定向（需要等待 DNS 傳播）
echo "⏳ 等待 DNS 傳播並測試重定向..."
sleep 10

# 嘗試本地測試
REDIRECT_TEST=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3870/ || echo "000")
if [ "$REDIRECT_TEST" = "301" ]; then
    echo "✅ 本地重定向測試成功"
else
    echo "⚠️ 本地重定向測試結果: HTTP $REDIRECT_TEST"
fi

# 6. 部署完成報告
echo ""
echo "🎉 shop.paopaomao.tw 重定向部署完成！"
echo ""
echo "📊 部署摘要："
echo "   - 重定向服務: http://localhost:3870 → https://paopaomao.tw/shop"
echo "   - Cloudflared 配置: 已更新並重啟"
echo "   - 備份位置: $BACKUP_FILE"
echo ""
echo "🔗 現在 shop.paopaomao.tw 會重定向到 https://paopaomao.tw/shop"
echo "⚠️ DNS 傳播可能需要幾分鐘時間"
echo ""
echo "📋 驗證指令："
echo "   curl -I https://shop.paopaomao.tw"
echo "   curl -s http://localhost:3870/health"
echo ""
echo "🛠️ 服務管理："
echo "   啟動: launchctl load $PLIST_FILE"
echo "   停止: launchctl unload $PLIST_FILE"
echo "   重啟: launchctl kickstart -k gui/\$(id -u)/com.paopaomao.shop-redirect"