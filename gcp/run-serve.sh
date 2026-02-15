#!/usr/bin/env bash
# 在 gcp 目錄執行，會讀取 .env 並啟動 LINE Webhook 備援服務
# 使用前：cp .env.example .env 並填寫 LINE_CHANNEL_SECRET、LINE_TOKEN_PAOSTAFF、LINE_STAFF_SS_ID、GOOGLE_APPLICATION_CREDENTIALS

cd "$(dirname "$0")"
node index.js serve
