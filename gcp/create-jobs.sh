#!/bin/bash
# 建立兩個 Cloud Run Job（Token 檢查 + 員工業績月報）
# 執行前請先 source set-env.sh，並設定 ADMIN_EMAIL 等變數（可加在 set-env.sh）
set -e
cd "$(dirname "$0")"
[ -f set-env.sh ] && source set-env.sh

if [ -z "$PROJECT_ID" ] || [ -z "$REGION" ]; then
  echo "錯誤：請先 source set-env.sh（需有 PROJECT_ID、REGION）"
  exit 1
fi

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/gcp-scripts/pao-run:latest"

# 組 check-token 用的環境變數（只含已設定的變數）
CHECK_ENV="ADMIN_EMAIL=${ADMIN_EMAIL:-paopaomao.of@gmail.com}"
[ -n "$GMAIL_USER" ] && CHECK_ENV="$CHECK_ENV,GMAIL_USER=$GMAIL_USER"
[ -n "$GMAIL_APP_PASSWORD" ] && CHECK_ENV="$CHECK_ENV,GMAIL_APP_PASSWORD=$GMAIL_APP_PASSWORD"
[ -n "$SAYDOU_BEARER_TOKEN" ] && CHECK_ENV="$CHECK_ENV,SAYDOU_BEARER_TOKEN=$SAYDOU_BEARER_TOKEN"
[ -n "$TOKEN_SHEET_SS_ID" ] && CHECK_ENV="$CHECK_ENV,TOKEN_SHEET_SS_ID=$TOKEN_SHEET_SS_ID"

echo "建立 Job: pao-check-token"
gcloud run jobs create pao-check-token \
  --image "$IMAGE" \
  --region "$REGION" \
  --task-timeout 5m \
  --set-env-vars "$CHECK_ENV" \
  2>/dev/null || gcloud run jobs update pao-check-token --image "$IMAGE" --region "$REGION" --set-env-vars "$CHECK_ENV"

# 組月報用的環境變數
REPORT_ENV="ADMIN_EMAIL=${ADMIN_EMAIL:-paopaomao.of@gmail.com}"
[ -n "$LINE_STAFF_SS_ID" ] && REPORT_ENV="$REPORT_ENV,LINE_STAFF_SS_ID=$LINE_STAFF_SS_ID"
[ -n "$LINE_STORE_SS_ID" ] && REPORT_ENV="$REPORT_ENV,LINE_STORE_SS_ID=$LINE_STORE_SS_ID"
[ -n "$OUTPUT_SS_ID" ] && REPORT_ENV="$REPORT_ENV,OUTPUT_SS_ID=$OUTPUT_SS_ID"
[ -n "$TOKEN_SHEET_SS_ID" ] && REPORT_ENV="$REPORT_ENV,TOKEN_SHEET_SS_ID=$TOKEN_SHEET_SS_ID"
[ -n "$FETCH_BATCH_SIZE" ] && REPORT_ENV="$REPORT_ENV,FETCH_BATCH_SIZE=$FETCH_BATCH_SIZE" || REPORT_ENV="$REPORT_ENV,FETCH_BATCH_SIZE=10"
[ -n "$SAYDOU_BEARER_TOKEN" ] && REPORT_ENV="$REPORT_ENV,SAYDOU_BEARER_TOKEN=$SAYDOU_BEARER_TOKEN"

echo "建立 Job: pao-employee-report"
gcloud run jobs create pao-employee-report \
  --image "$IMAGE" \
  --region "$REGION" \
  --task-timeout 60m \
  --set-env-vars "$REPORT_ENV" \
  2>/dev/null || gcloud run jobs update pao-employee-report --image "$IMAGE" --region "$REGION" --set-env-vars "$REPORT_ENV"

echo "設定月報 Job 執行指令為 employee-monthly-report"
gcloud run jobs update pao-employee-report --region "$REGION" \
  --command "node" \
  --args "index.js,employee-monthly-report"

echo "完成。可到 Console 手動執行一次測試，再設定排程："
echo "  https://console.cloud.google.com/run?project=$PROJECT_ID"
echo "詳見 接下來步驟.md 與 DEPLOY.md"