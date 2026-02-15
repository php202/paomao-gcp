#!/usr/bin/env bash
# 定期更新員工業績月報：只更新「當月」（建議每日凌晨跑一次）
# 使用方式：./run-monthly-report-daily.sh  或  node index.js $(date +%Y-%m) $(date +%Y-%m)
cd "$(dirname "$0")"
YM=$(date +%Y-%m)
node index.js "$YM" "$YM"
