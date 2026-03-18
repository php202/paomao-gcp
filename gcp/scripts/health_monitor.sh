#!/bin/bash
# 泡泡貓服務健康監控
# 每 3 小時執行，紅燈 → TG 告警

TG_BOT_TOKEN=$(cat ~/.openclaw/secrets/telegram-bot-token.txt 2>/dev/null)
TG_CHAT_ID="-5220564261"  # 辦公室群組
STATE_FILE="$HOME/.openclaw/workspace/memory/health-state.json"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

RED_ITEMS=()
GREEN_ITEMS=()

check_service() {
  local name="$1"
  local url="$2"
  local expected_codes="$3"  # comma-separated acceptable codes
  
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$url" 2>/dev/null)
  
  if echo "$expected_codes" | grep -q "$http_code"; then
    GREEN_ITEMS+=("$name")
    return 0
  else
    RED_ITEMS+=("$name (HTTP $http_code)")
    return 1
  fi
}

# === 本機服務 ===
check_service "GCP Server (3850)" "http://localhost:3850/" "200,301,302"
check_service "Dashboard (3000)" "http://localhost:3000/" "200,301,302"
check_service "Booking (3457)" "http://localhost:3457/" "200,301,302"
check_service "Checklist (3456)" "http://localhost:3456/" "200,301,302"
check_service "LINE Auto Reply (3800)" "http://localhost:3800/" "200,301,302,404"
check_service "Shop Redirect (3870)" "http://localhost:3870/" "200,301,302"
check_service "WordPress (8088)" "http://localhost:8088/" "200,301,302"

# === 外部域名 (Tunnel) ===
check_service "dashboard.paopaomao.tw" "https://dashboard.paopaomao.tw/" "200,301,302"
check_service "book.paopaomao.tw" "https://book.paopaomao.tw/" "200,301,302"
check_service "paopaomao.tw" "https://paopaomao.tw/" "200,301,302"
check_service "line-reply.paopaomao.tw" "https://line-reply.paopaomao.tw/" "200,301,302,404"

# === PostgreSQL ===
if /opt/homebrew/opt/postgresql@17/bin/pg_isready -q 2>/dev/null; then
  GREEN_ITEMS+=("PostgreSQL")
else
  RED_ITEMS+=("PostgreSQL (not responding)")
fi

# === Cloudflare Tunnel process ===
if pgrep -f cloudflared > /dev/null 2>&1; then
  GREEN_ITEMS+=("Cloudflared process")
else
  RED_ITEMS+=("Cloudflared process (not running)")
fi

# === SayDou API ===
saydou_code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "http://localhost:3850/api/health" 2>/dev/null)
if [ "$saydou_code" != "000" ]; then
  GREEN_ITEMS+=("GCP API health")
else
  RED_ITEMS+=("GCP API health (timeout)")
fi

# === 寫入狀態檔 ===
red_count=${#RED_ITEMS[@]}
green_count=${#GREEN_ITEMS[@]}

cat > "$STATE_FILE" << EOF
{
  "lastCheck": "$TIMESTAMP",
  "greenCount": $green_count,
  "redCount": $red_count,
  "redItems": $(printf '%s\n' "${RED_ITEMS[@]}" | jq -R . | jq -s .),
  "greenItems": $(printf '%s\n' "${GREEN_ITEMS[@]}" | jq -R . | jq -s .)
}
EOF

# === 有紅燈才告警 ===
if [ $red_count -gt 0 ]; then
  red_list=""
  for item in "${RED_ITEMS[@]}"; do
    red_list="${red_list}🔴 ${item}\n"
  done
  
  msg="⚠️ 服務健康告警 ($TIMESTAMP)\n\n${red_list}\n✅ 正常: ${green_count} 項\n🔴 異常: ${red_count} 項"
  
  if [ -n "$TG_BOT_TOKEN" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      -d chat_id="$TG_CHAT_ID" \
      -d text="$(echo -e "$msg")" \
      -d parse_mode="HTML" > /dev/null 2>&1
  fi
  
  echo "🔴 ALERT: $red_count services down"
  exit 1
else
  echo "✅ All $green_count services healthy ($TIMESTAMP)"
  exit 0
fi
