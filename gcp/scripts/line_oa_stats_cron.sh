#!/bin/bash
# LINE OA 每日數據收集 cron wrapper
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:$PATH"
cd "$(dirname "$0")/.."
node scripts/line_oa_stats_collector.cjs >> /tmp/line_oa_stats.log 2>&1
