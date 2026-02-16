#!/usr/bin/env bash
# 本機 LINE Webhook 測試用：把 localhost:8080 曝露成公網 HTTPS，讓 LINE 打進來
# 使用方式：
#   終端機 1：cd gcp && node index.js serve   （先啟動服務）
#   終端機 2：cd gcp && ./run-tunnel.sh       （再跑隧道，會印出 Webhook 連結）
# 詳見：docs/本機LINE_Webhook測試.md

set -e
cd "$(dirname "$0")"
PORT="${PORT:-8080}"

# 優先 ngrok（需帳號驗證通過）；否則用 localtunnel（免註冊）
if command -v ngrok >/dev/null 2>&1; then
  echo "使用 ngrok 曝露 port $PORT"
  echo "請把畫面上的 https://xxx.ngrok-free.app 加上 /line-webhook 填到 LINE Developers → Webhook URL"
  exec ngrok http "$PORT"
else
  echo "使用 localtunnel 曝露 port $PORT（免註冊）"
  echo "請先確認終端機 1 已執行：node index.js serve"
  echo ""
  echo "下方出現 your url 後，請把該網址加上 /line-webhook 填到 LINE Developers："
  echo "  例：https://xxx.loca.lt/line-webhook"
  echo "  第一次用該網址時，瀏覽器可能會要你點「Click to Continue」"
  echo ""
  exec npx --yes localtunnel --port "$PORT"
fi
