#!/bin/bash
# 巡店考核系統 - Cron 任務設置腳本

echo "🚀 設置巡店考核系統 Cron 任務..."

# 檢查 OpenClaw 是否可用
if ! command -v openclaw &> /dev/null; then
    echo "❌ OpenClaw 未找到，請確保已安裝"
    exit 1
fi

# 1. 每日巡店提醒 (週一到週五 08:30)
echo "⏰ 設置每日巡店提醒..."
openclaw cron create \
    --name="inspection-daily-reminders" \
    --cron="30 8 * * 1-5" \
    --tz="Asia/Taipei" \
    --description="檢查巡店提醒並發送通知" \
    --system-event="cd ~/paomao-gcp/gcp && node scripts/inspection_reminders.js"

# 2. 每週巡店計劃檢視 (週一 09:00)
echo "📊 設置每週巡店計劃檢視..."
openclaw cron create \
    --name="inspection-weekly-review" \
    --cron="0 9 * * 1" \
    --tz="Asia/Taipei" \
    --description="每週巡店計劃檢視和統計" \
    --system-event="cd ~/paomao-gcp/gcp && node scripts/inspection_weekly_review.js"

# 3. 月底巡店報告 (每月最後一個工作日 17:00)
echo "📈 設置月底巡店報告..."
openclaw cron create \
    --name="inspection-monthly-report" \
    --cron="0 17 28-31 * *" \
    --tz="Asia/Taipei" \
    --description="生成月度巡店統計報告" \
    --system-event="cd ~/paomao-gcp/gcp && node scripts/inspection_monthly_report.js"

echo "✅ 巡店考核系統 Cron 任務設置完成！"
echo ""
echo "已設置的任務："
echo "  📅 每日巡店提醒: 週一至五 08:30"
echo "  📊 每週計劃檢視: 週一 09:00"
echo "  📈 月度統計報告: 月末工作日 17:00"
echo ""
echo "查看任務狀態: openclaw cron list"
echo "手動測試: cd ~/paomao-gcp/gcp && node scripts/inspection_reminders.js"