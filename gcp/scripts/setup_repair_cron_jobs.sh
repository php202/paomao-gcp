#!/bin/bash

# 設定維修系統 OpenClaw 定期任務
echo "🔧 設定維修系統 OpenClaw 定期任務..."

# 1. 每小時處理新維修單 (AI 診斷)
echo "📋 設定每小時維修單處理..."
openclaw cron add \
  --name "repair-process-new" \
  --cron "0 * * * *" \
  --system-event "cd ~/paomao-gcp/gcp && node scripts/repair_system_automation.js process-new"

# 2. 每4小時檢查付款狀態和庫存
echo "💰 設定每4小時付款和庫存檢查..."
openclaw cron add \
  --name "repair-check-status" \
  --cron "0 */4 * * *" \
  --system-event "cd ~/paomao-gcp/gcp && node scripts/repair_system_automation.js check-payments && node scripts/repair_system_automation.js check-inventory"

# 3. 每天早上8點執行完整流程
echo "🌅 設定每日完整流程..."
openclaw cron add \
  --name "repair-daily-full" \
  --cron "0 8 * * *" \
  --system-event "cd ~/paomao-gcp/gcp && node scripts/repair_system_automation.js full"

# 4. 每週一生成週報
echo "📊 設定每週報告..."
openclaw cron add \
  --name "repair-weekly-report" \
  --cron "0 9 * * 1" \
  --system-event "cd ~/paomao-gcp/gcp && node scripts/repair_system_automation.js daily-report"

echo "✅ 維修系統定期任務設定完成！"
echo ""
echo "📋 已設定的任務："
echo "• repair-process-new: 每小時處理新維修單"
echo "• repair-check-status: 每4小時檢查狀態"  
echo "• repair-daily-full: 每日8點完整流程"
echo "• repair-weekly-report: 每週一週報"
echo ""
echo "🔍 查看所有任務: openclaw cron list | grep repair"
echo "🗑️ 移除任務: openclaw cron rm <job_id>"