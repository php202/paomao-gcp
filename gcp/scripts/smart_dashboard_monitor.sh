#!/bin/bash

# 智能 Dashboard 監控系統 - 帶錯誤記錄和自動修復
LOG_DIR="$HOME/.openclaw/workspace/logs/dashboard-monitor"
LOG_FILE="$LOG_DIR/monitor.log"
ERROR_LOG="$LOG_DIR/errors.log"
DASHBOARD_DIR="$HOME/泡泡貓/dashboard"

# 創建 log 目錄
mkdir -p "$LOG_DIR"

# 記錄函數
log_info() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] INFO: $1" | tee -a "$LOG_FILE"
}

log_error() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $1" | tee -a "$ERROR_LOG" -a "$LOG_FILE"
}

log_success() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] SUCCESS: $1" | tee -a "$LOG_FILE"
}

# 檢查服務狀態
check_dashboard_service() {
    # 檢查是否有在 dashboard 目錄運行的 server.js
    if ps aux | grep -E "dashboard.*server\.js|/dashboard/server\.js" | grep -v grep > /dev/null; then
        return 0  # 運行中
    # 也檢查在 dashboard 目錄下運行的 node server.js 
    elif cd "$DASHBOARD_DIR" 2>/dev/null && ps aux | grep "node server.js" | grep -v grep > /dev/null; then
        return 0  # 運行中
    else
        return 1  # 未運行
    fi
}

# 檢查服務健康度
check_dashboard_health() {
    local health_response=$(curl -s -w "%{http_code}" http://localhost:3000 -o /dev/null 2>/dev/null)
    
    if [ "$health_response" = "302" ] || [ "$health_response" = "200" ]; then
        return 0  # 健康
    else
        log_error "Dashboard HTTP 健康檢查失敗 (HTTP: $health_response)"
        return 1  # 不健康
    fi
}

# 檢查資料庫連接
check_database_connection() {
    if command -v psql >/dev/null 2>&1; then
        if psql -h localhost -d paomao -c "SELECT 1;" >/dev/null 2>&1; then
            return 0  # 資料庫正常
        else
            log_error "PostgreSQL 資料庫連接失敗"
            return 1
        fi
    else
        log_info "psql 命令不可用，跳過資料庫檢查"
        return 0
    fi
}

# 重啟 Dashboard 服務
restart_dashboard() {
    log_info "正在重啟 Dashboard 服務..."
    
    # 停止現有進程
    local pids=$(pgrep -f 'dashboard/server.js')
    if [ -n "$pids" ]; then
        echo $pids | xargs kill
        sleep 3
        log_info "已停止舊的 Dashboard 進程: $pids"
    fi
    
    # 檢查端口占用
    local port_check=$(lsof -ti:3000 2>/dev/null || true)
    if [ -n "$port_check" ]; then
        log_error "端口 3000 被占用，進程: $port_check"
        echo $port_check | xargs kill -9 2>/dev/null || true
        sleep 2
    fi
    
    # 啟動新服務
    cd "$DASHBOARD_DIR" || {
        log_error "無法進入 Dashboard 目錄: $DASHBOARD_DIR"
        return 1
    }
    
    # 清理舊的 log
    if [ -f server.log ]; then
        cp server.log "server.log.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
        > server.log
    fi
    
    # 啟動服務
    npm start > server.log 2>&1 &
    sleep 5
    
    # 驗證啟動
    if check_dashboard_service && check_dashboard_health; then
        log_success "Dashboard 服務重啟成功"
        return 0
    else
        log_error "Dashboard 服務重啟失敗"
        
        # 記錄錯誤詳情
        if [ -f server.log ]; then
            echo "--- Dashboard 啟動錯誤 ---" >> "$ERROR_LOG"
            tail -20 server.log >> "$ERROR_LOG"
            echo "--- 錯誤記錄結束 ---" >> "$ERROR_LOG"
        fi
        
        return 1
    fi
}

# 收集系統診斷資訊
collect_diagnostics() {
    log_info "收集診斷資訊..."
    
    {
        echo "=== 系統診斷報告 $(date) ==="
        echo "1. 進程狀態:"
        ps aux | grep -E "(dashboard|server\.js)" | grep -v grep || echo "   沒有找到相關進程"
        
        echo -e "\n2. 端口占用:"
        lsof -ti:3000 2>/dev/null | while read pid; do
            echo "   端口 3000 被進程 $pid 占用:"
            ps -p $pid -o pid,ppid,cmd 2>/dev/null || echo "   進程資訊獲取失敗"
        done
        
        echo -e "\n3. 系統資源:"
        echo "   記憶體使用: $(free -h 2>/dev/null | grep Mem || echo '無法獲取')"
        echo "   磁碟使用: $(df -h "$DASHBOARD_DIR" 2>/dev/null | tail -1 || echo '無法獲取')"
        
        echo -e "\n4. Dashboard 服務 log (最後 10 行):"
        if [ -f "$DASHBOARD_DIR/server.log" ]; then
            tail -10 "$DASHBOARD_DIR/server.log"
        else
            echo "   server.log 文件不存在"
        fi
        
        echo -e "\n5. 最近的錯誤 (最後 5 個):"
        if [ -f "$ERROR_LOG" ]; then
            tail -20 "$ERROR_LOG" | grep ERROR | tail -5
        else
            echo "   沒有錯誤記錄"
        fi
        
        echo "=== 診斷報告結束 ==="
    } >> "$ERROR_LOG"
}

# 主監控邏輯
main_monitor() {
    log_info "開始 Dashboard 服務監控檢查"
    
    # 檢查服務狀態
    if check_dashboard_service; then
        log_info "Dashboard 進程運行中"
        
        # 檢查服務健康度
        if check_dashboard_health; then
            log_success "Dashboard 服務運行正常"
            
            # 檢查資料庫連接
            if check_database_connection; then
                log_info "資料庫連接正常"
            fi
            
            echo "✅ Dashboard 服務運行正常"
            return 0
        else
            log_error "Dashboard 服務響應異常，嘗試重啟"
            collect_diagnostics
            restart_dashboard
        fi
    else
        log_error "Dashboard 服務已停止，正在重啟"
        collect_diagnostics
        restart_dashboard
    fi
}

# 執行監控
main_monitor

# 清理舊的 log 文件 (保留最近 7 天)
find "$LOG_DIR" -name "*.log.*" -mtime +7 -delete 2>/dev/null || true

# 如果 error log 太大，輪轉它
if [ -f "$ERROR_LOG" ] && [ $(wc -l < "$ERROR_LOG") -gt 1000 ]; then
    mv "$ERROR_LOG" "$ERROR_LOG.$(date +%Y%m%d-%H%M%S)"
    touch "$ERROR_LOG"
    log_info "錯誤 log 已輪轉"
fi