#!/usr/bin/env bash
# 重新建映像並部署 pao-checkin-api，讓服務包含 /line-webhook（LINE Webhook 備援）
# 使用前：source set-env.sh，並設定 LINE_CHANNEL_SECRET、LINE_TOKEN_PAOSTAFF（勿提交到版控）
# 執行：./deploy-line-webhook.sh

set -e
cd "$(dirname "$0")"
[ -f set-env.sh ] && source set-env.sh

: "${PROJECT_ID:?請設定 PROJECT_ID（可 source set-env.sh）}"
: "${REGION:=asia-east1}"
: "${LINE_STAFF_SS_ID:?請設定 LINE_STAFF_SS_ID（可 source set-env.sh）}"
: "${LINE_CHANNEL_SECRET:?請先 export LINE_CHANNEL_SECRET}"
: "${LINE_TOKEN_PAOSTAFF:?請先 export LINE_TOKEN_PAOSTAFF}"

# 選填：若未提供，沿用目前 Cloud Run 既有值或程式預設
: "${LINE_HQ_SS_ID:=}"
: "${LINE_STORE_SS_ID:=}"
: "${PAO_CAT_CORE_API_URL:=}"
: "${PAO_CAT_SECRET_KEY:=}"
: "${REPORT_PAGE_URL:=https://www.paopaomao.tw/report}"
: "${TOMORROW_BRIEFING_WEB_APP_URL:=}"
: "${GAS_WEBHOOK_URL:=}"
: "${FORWARD_UNKNOWN_TO_GAS:=0}"
: "${WEBHOOK_LOG_VERBOSE:=1}"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/gcp-scripts/pao-run:latest"
SERVICE_NAME="pao-checkin-api"

echo "=== 1. 建映像（含 server.js /line-webhook）==="
gcloud builds submit --tag "$IMAGE"

echo "=== 2. 部署 Cloud Run Service（node index.js serve）==="
gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --command "node" \
  --args "index.js,serve" \
  --set-env-vars "LINE_STAFF_SS_ID=$LINE_STAFF_SS_ID,LINE_CHANNEL_SECRET=$LINE_CHANNEL_SECRET,LINE_TOKEN_PAOSTAFF=$LINE_TOKEN_PAOSTAFF,LINE_HQ_SS_ID=$LINE_HQ_SS_ID,LINE_STORE_SS_ID=$LINE_STORE_SS_ID,PAO_CAT_CORE_API_URL=$PAO_CAT_CORE_API_URL,PAO_CAT_SECRET_KEY=$PAO_CAT_SECRET_KEY,REPORT_PAGE_URL=$REPORT_PAGE_URL,TOMORROW_BRIEFING_WEB_APP_URL=$TOMORROW_BRIEFING_WEB_APP_URL,GAS_WEBHOOK_URL=$GAS_WEBHOOK_URL,FORWARD_UNKNOWN_TO_GAS=$FORWARD_UNKNOWN_TO_GAS,WEBHOOK_LOG_VERBOSE=$WEBHOOK_LOG_VERBOSE" \
  --min-instances 0 \
  --max-instances 10

URL=$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='value(status.url)')
echo ""
echo "=== 完成 ==="
echo "服務網址: $URL"
echo "LINE Webhook URL 請設為: ${URL}/line-webhook"
