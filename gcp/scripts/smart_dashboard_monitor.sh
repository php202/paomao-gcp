#!/bin/bash
# 智能服務監控系統 — 檢查所有關鍵服務，異常自動重啟+通知
# Cron: 每 30 分鐘或每小時執行一次

LOG_DIR="$HOME/.openclaw/workspace/logs/dashboard-monitor"
LOG_FILE="$LOG_DIR/monitor.log"
mkdir -p "$LOG_DIR"

TG_BOT_TOKEN="${TG_BOT_TOKEN:-}"
TG_CHAT_ID="7956245081"  # Robby 私訊
TS=$(date '+%Y-%m-%d %H:%M:%S')

log() { echo "[$TS] $1" >> "$LOG_FILE"; }
notify() {
  if [ -n "$TG_BOT_TOKEN" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      -H 'Content-Type: application/json' \
      -d "{\"chat_id\":\"$TG_CHAT_ID\",\"text\":\"$1\",\"parse_mode\":\"HTML\"}" > /dev/null 2>&1
  fi
}

ISSUES=()
FIXED=()

# ─── 1. Dashboard (port 3000) ───
check_service() {
  local name="$1" port="$2" plist="$3" health_path="${4:-/}"
  local http=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${port}${health_path}" --max-time 5 2>/dev/null)
  
  if [ "$http" = "200" ] || [ "$http" = "302" ] || [ "$http" = "301" ]; then
    log "✅ ${name} (port ${port}): OK (HTTP ${http})"
    return 0
  else
    log "❌ ${name} (port ${port}): DOWN (HTTP ${http})"
    ISSUES+=("${name} port ${port} 無回應 (HTTP ${http})")
    
    # 嘗試用 launchctl 重啟
    if [ -n "$plist" ]; then
      log "⚡ 嘗試重啟 ${plist}..."
      launchctl kickstart -k "gui/$(id -u)/${plist}" 2>/dev/null
      sleep 5
      
      local http2=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${port}" --max-time 5 2>/dev/null)
      if [ "$http2" = "200" ] || [ "$http2" = "302" ] || [ "$http2" = "301" ]; then
        log "✅ ${name} 重啟成功"
        FIXED+=("${name} 已自動重啟恢復")
      else
        log "❌ ${name} 重啟失敗 (HTTP ${http2})"
      fi
    fi
    return 1
  fi
}

# ─── 2. PostgreSQL ───
check_postgres() {
  local PSQL="/opt/homebrew/Cellar/libpq/18.3/bin/psql"
  if [ ! -f "$PSQL" ]; then
    PSQL=$(find /opt/homebrew -name psql -type f 2>/dev/null | head -1)
  fi
  
  if [ -n "$PSQL" ]; then
    if $PSQL -U paopaomao -d paomao -c "SELECT 1" > /dev/null 2>&1; then
      log "✅ PostgreSQL: OK"
    else
      log "❌ PostgreSQL: 連線失敗"
      ISSUES+=("PostgreSQL 資料庫連線失敗")
      # 嘗試重啟
      brew services restart postgresql@17 2>/dev/null
      sleep 3
      if $PSQL -U paopaomao -d paomao -c "SELECT 1" > /dev/null 2>&1; then
        FIXED+=("PostgreSQL 已自動重啟恢復")
      fi
    fi
  else
    log "⚠️ psql 找不到，跳過 DB 檢查"
  fi
}

# ─── 3. Cloudflare Tunnel ───
check_tunnel() {
  if pgrep -f cloudflared > /dev/null 2>&1; then
    log "✅ Cloudflare Tunnel: 運行中"
  else
    log "❌ Cloudflare Tunnel: 未運行"
    ISSUES+=("Cloudflare Tunnel 停止運行")
    launchctl kickstart -k "gui/$(id -u)/com.paopaomao.cloudflared" 2>/dev/null
    sleep 3
    if pgrep -f cloudflared > /dev/null 2>&1; then
      FIXED+=("Cloudflare Tunnel 已自動重啟")
    fi
  fi
}

# ─── 4. 磁碟空間 ───
check_disk() {
  local usage=$(df -h / | tail -1 | awk '{print $5}' | tr -d '%')
  if [ "$usage" -gt 90 ]; then
    log "⚠️ 磁碟使用率 ${usage}%"
    ISSUES+=("磁碟使用率 ${usage}% (>90%)")
  else
    log "✅ 磁碟: ${usage}%"
  fi
}

# ─── 5. 記憶體 ───
check_memory() {
  # macOS: 用 vm_stat
  local pages_free=$(vm_stat 2>/dev/null | grep "Pages free" | awk '{print $3}' | tr -d '.')
  local pages_inactive=$(vm_stat 2>/dev/null | grep "Pages inactive" | awk '{print $3}' | tr -d '.')
  if [ -n "$pages_free" ]; then
    local free_mb=$(( (pages_free + pages_inactive) * 4096 / 1024 / 1024 ))
    if [ "$free_mb" -lt 500 ]; then
      log "⚠️ 可用記憶體偏低: ${free_mb}MB"
      ISSUES+=("可用記憶體偏低: ${free_mb}MB")
    else
      log "✅ 記憶體: ${free_mb}MB 可用"
    fi
  fi
}

# ═══ 執行所有檢查 ═══
log "========== 監控開始 =========="

check_service "Dashboard" 3000 "com.paopaomao.dashboard-server"
check_service "GCP Server" 3850 "com.paopaomao.gcp-server"
check_service "LINE 自動回覆" 3800 "" "/health"
check_service "預約網站" 3457 "com.paopaomao.booking-site"
check_service "Checklist" 3456 "com.paopaomao.checklist-server"
check_postgres
check_tunnel
check_disk
check_memory

# ═══ 結果彙整 ═══
if [ ${#ISSUES[@]} -eq 0 ]; then
  log "✅ 全部服務正常"
  echo "✅ 全部服務正常 ($TS)"
else
  MSG="⚠️ <b>服務監控警報</b> ($TS)\n"
  for issue in "${ISSUES[@]}"; do
    MSG+="❌ ${issue}\n"
  done
  if [ ${#FIXED[@]} -gt 0 ]; then
    MSG+="\n🔧 <b>自動修復:</b>\n"
    for fix in "${FIXED[@]}"; do
      MSG+="✅ ${fix}\n"
    done
  fi
  
  notify "$MSG"
  echo "$MSG"
  log "發送告警通知"
fi

log "========== 監控結束 =========="

# 清理 7 天前的 log
if [ $(wc -l < "$LOG_FILE" 2>/dev/null || echo 0) -gt 5000 ]; then
  tail -1000 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi
