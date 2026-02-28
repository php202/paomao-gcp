#!/bin/bash
# 本機執行 daily-report 的腳本
# 每天 00:10 執行

cd "$(dirname "$0")/.."
/opt/homebrew/bin/node index.js daily-report >> /tmp/pao-daily-report.log 2>&1