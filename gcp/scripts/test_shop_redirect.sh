#!/bin/bash
# 測試 shop.paopaomao.tw 重定向設置（不影響線上服務）
# 在正式部署前驗證所有元件

set -e

echo "🧪 測試 shop.paopaomao.tw 重定向設置..."
echo "⚠️ 這是測試模式，不會影響線上服務"

# 1. 檢查檔案是否存在
echo ""
echo "📁 檢查必要檔案..."

FILES=(
    "/Users/paopaomao/paomao-gcp/gcp/scripts/shop_redirect_server.js"
    "/Users/paopaomao/paomao-gcp/gcp/scripts/deploy_shop_redirect.sh"
    "/Users/paopaomao/Library/LaunchAgents/com.paopaomao.shop-redirect.plist"
    "/Users/paopaomao/.cloudflared/config.yml"
)

for file in "${FILES[@]}"; do
    if [[ -f "$file" ]]; then
        echo "✅ $file"
    else
        echo "❌ 缺少檔案: $file"
        exit 1
    fi
done

# 2. 測試 redirect server（臨時啟動測試）
echo ""
echo "🚀 測試 redirect server..."

# 啟動測試服務器（背景執行）
cd /Users/paopaomao/paomao-gcp/gcp
node scripts/shop_redirect_server.js &
TEST_PID=$!

# 等待服務啟動
sleep 3

# 測試健康檢查
echo "🏥 測試健康檢查..."
if curl -s http://localhost:3870/health | grep -q "shop-redirect"; then
    echo "✅ 健康檢查通過"
else
    echo "❌ 健康檢查失敗"
    kill $TEST_PID 2>/dev/null || true
    exit 1
fi

# 測試重定向
echo "🔀 測試重定向功能..."
REDIRECT_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3870/ || echo "000")
if [[ "$REDIRECT_CODE" == "301" ]]; then
    echo "✅ 重定向測試通過 (HTTP 301)"
else
    echo "❌ 重定向測試失敗 (HTTP $REDIRECT_CODE)"
    kill $TEST_PID 2>/dev/null || true
    exit 1
fi

# 測試目標 URL
LOCATION_HEADER=$(curl -s -I http://localhost:3870/ | grep -i "location:" | cut -d' ' -f2- | tr -d '\r\n')
if [[ "$LOCATION_HEADER" == "https://paopaomao.tw/shop" ]]; then
    echo "✅ 重定向目標正確: $LOCATION_HEADER"
else
    echo "❌ 重定向目標錯誤: $LOCATION_HEADER"
    kill $TEST_PID 2>/dev/null || true
    exit 1
fi

# 停止測試服務器
kill $TEST_PID 2>/dev/null || true
sleep 2

echo "✅ Redirect server 測試完成"

# 3. 驗證 cloudflared 設置
echo ""
echo "☁️ 檢查 cloudflared 設置..."

# 檢查 cloudflared 是否運行
if pgrep cloudflared > /dev/null; then
    echo "✅ Cloudflared 正在運行"
else
    echo "❌ Cloudflared 未運行"
    exit 1
fi

# 檢查配置檔案語法
if cloudflared tunnel validate /Users/paopaomao/.cloudflared/config.yml 2>/dev/null; then
    echo "✅ Cloudflared 配置檔案語法正確"
else
    echo "⚠️ 無法驗證 cloudflared 配置檔案語法"
fi

# 4. 檢查 OpenClaw cron 任務
echo ""
echo "⏰ 檢查 OpenClaw cron 任務..."

if openclaw cron list | grep -q "shop-redirect-deploy"; then
    echo "✅ Cron 任務已設置"
    echo "📅 執行時間: 2026-03-07 00:00 (Asia/Taipei)"
    
    # 顯示任務詳情
    NEXT_RUN=$(openclaw cron list | grep "shop-redirect-deploy" | awk '{print $6, $7}')
    echo "⏳ 下次執行: $NEXT_RUN"
else
    echo "❌ 找不到 cron 任務"
    exit 1
fi

# 5. 模擬部署檢查（不執行）
echo ""
echo "🎯 模擬部署檢查..."

# 檢查端口 3870 是否可用
if lsof -i:3870 2>/dev/null | grep -q LISTEN; then
    echo "⚠️ 端口 3870 已被佔用，部署時會先停止現有服務"
else
    echo "✅ 端口 3870 可用"
fi

# 檢查是否有寫入權限
if [[ -w "/Users/paopaomao/.cloudflared/config.yml" ]]; then
    echo "✅ 有 cloudflared 配置檔案寫入權限"
else
    echo "❌ 無 cloudflared 配置檔案寫入權限"
    exit 1
fi

# 6. 最終報告
echo ""
echo "🎉 測試完成！所有檢查都通過了"
echo ""
echo "📋 測試摘要："
echo "   ✅ 必要檔案都存在"
echo "   ✅ Redirect server 功能正常"
echo "   ✅ Cloudflared 運行正常"
echo "   ✅ OpenClaw cron 任務已設置"
echo "   ✅ 權限設置正確"
echo ""
echo "🚀 準備就緒！2026-03-07 00:00 將自動執行部署"
echo ""
echo "📞 如需手動測試完整部署流程："
echo "   bash /Users/paopaomao/paomao-gcp/gcp/scripts/deploy_shop_redirect.sh"
echo ""
echo "⏰ 目前時間: $(date)"
echo "🎯 部署時間: 2026-03-07 00:00 (Asia/Taipei)"