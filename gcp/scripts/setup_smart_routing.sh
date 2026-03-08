#!/bin/bash
# 泡泡貓 AI 智能路由設置腳本
# 自動根據任務複雜度選擇最合適的AI模型，節省費用

set -e

echo "🤖 設置泡泡貓 AI 智能路由系統..."

# 檢查必要檔案
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AI_ROUTER_PY="$SCRIPT_DIR/ai_router.py"
AI_ROUTER_JS="$SCRIPT_DIR/openclaw_ai_router.js"

if [[ ! -f "$AI_ROUTER_PY" ]]; then
    echo "❌ 找不到 ai_router.py"
    exit 1
fi

if [[ ! -f "$AI_ROUTER_JS" ]]; then
    echo "❌ 找不到 openclaw_ai_router.js" 
    exit 1
fi

# 設置執行權限
chmod +x "$AI_ROUTER_PY" "$AI_ROUTER_JS"

# 測試Python環境
echo "📋 檢查Python依賴..."
if ! python3 -c "import google.generativeai" 2>/dev/null; then
    echo "⚠️  正在安裝Google Generative AI..."
    pip3 install --break-system-packages google-generativeai requests
fi

# 測試路由系統
echo "🧪 測試智能路由..."
cd "$SCRIPT_DIR"
TEST_RESULT=$(node openclaw_ai_router.js "系統狀態檢查" 2>&1)

if echo "$TEST_RESULT" | grep -q "Smart Router.*flash.*Cost Level: 1"; then
    echo "✅ Flash模型路由測試通過"
else
    echo "❌ 路由測試失敗"
    echo "$TEST_RESULT"
    exit 1
fi

# 顯示模型配置
echo ""
echo "📊 智能路由配置："
echo "   💡 Flash (成本 Level 1)：監控、狀態檢查、簡單查詢"
echo "   🧠 Sonnet (成本 Level 10)：編程、分析、複雜對話"  
echo "   🚀 Opus (成本 Level 50)：架構設計、複雜推理、緊急問題"

# 更新主session模型
echo ""
echo "🔧 設置主session為智能模式..."

# 創建環境變數設置
ENV_FILE="$HOME/.openclaw/workspace/.env"
mkdir -p "$(dirname "$ENV_FILE")"

cat > "$ENV_FILE" <<EOF
# AI智能路由環境變數
OPENCLAW_SMART_ROUTING=true
GEMINI_API_KEY=REDACTED_GEMINI_KEY
ANTHROPIC_API_KEY=REDACTED_ANTHROPIC_KEY
EOF

echo "✅ 環境變數已設置到 $ENV_FILE"

# 給用戶指示
echo ""
echo "🎉 智能路由系統設置完成！"
echo ""
echo "📝 使用方法："
echo "   直接對話：AI會自動選擇合適模型"
echo "   手動測試：node openclaw_ai_router.js '你的問題'"
echo "   查看選擇：stderr會顯示使用的模型和成本"
echo ""
echo "💰 預期節省：80-90%的AI使用成本"
echo ""
echo "⚡ 系統已準備就緒，開始智能省錢模式！"