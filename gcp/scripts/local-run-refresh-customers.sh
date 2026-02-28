#!/bin/bash
# 本機執行 refresh-customers-by-tomorrow-reservations 的腳本
# 每天 22:00 執行

cd "$(dirname "$0")/.."
/opt/homebrew/bin/node index.js refresh-customers-by-tomorrow-reservations >> /tmp/pao-refresh-customers.log 2>&1