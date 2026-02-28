#!/bin/bash
# 本機執行 employee-monthly-report 的腳本
# 每月 1 號 10:00 執行（當月）

cd "$(dirname "$0")/.."
/opt/homebrew/bin/node index.js employee-monthly-report >> /tmp/pao-employee-report.log 2>&1