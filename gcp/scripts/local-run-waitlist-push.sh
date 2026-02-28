#!/bin/bash
# 本機執行 waitlist-auto-push 的腳本
# 每天 22:00 執行

cd "$(dirname "$0")/.."
/opt/homebrew/bin/node index.js waitlist-auto-push >> /tmp/pao-waitlist-push.log 2>&1