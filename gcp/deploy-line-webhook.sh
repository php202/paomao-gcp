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
: "${LEGACY_GAS_CORE_API_URL:=}"
: "${LEGACY_GAS_STORES_API_URL:=}"
: "${INTEGRATED_SHEET_SS_ID:=}"
: "${ADMIN_KEY:=}"
: "${PAOPAO_STORE_SS_ID:=}"
: "${LINE_CHANNEL_SECRET_PAOPAO:=}"
: "${LINE_TOKEN_PAOPAO:=}"
: "${REPORT_PAGE_URL:=https://www.paopaomao.tw/report}"
: "${REPORT_API_BASE:=}"
: "${FOLDER_ID_FOR_ATTENDANCE_SHEETS:=}"
: "${GCS_BUCKET_ATTENDANCE:=}"
: "${CUSTOMER_INFO_PAGE_URL:=}"
: "${CUSTOMER_TOKEN_SECRET:=}"
: "${GAS_WEBHOOK_URL:=}"
: "${FORWARD_UNKNOWN_TO_GAS:=0}"
: "${WEBHOOK_LOG_VERBOSE:=1}"
# 店家本月出勤 403 時可設：Secret Manager 密碼名稱（金鑰會掛到 /secrets/sa-key.json，並設 GOOGLE_APPLICATION_CREDENTIALS）
: "${SA_KEY_SECRET_NAME:=}"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/gcp-scripts/pao-run:latest"
SERVICE_NAME="pao-checkin-api"

echo "=== 1. 建映像（含 server.js /line-webhook）==="
gcloud builds submit --tag "$IMAGE"

echo "=== 2. 部署 Cloud Run Service（node index.js serve）==="
if [ -n "${PAO_CAT_CORE_API_URL:-}" ] && [ -n "${PAO_CAT_SECRET_KEY:-}" ]; then
  echo "Core API 已設定（PAO_CAT_CORE_API_URL 有值），神美日報/上月小費/我要了解客人 將可用"
else
  echo "提醒：PAO_CAT_CORE_API_URL 或 PAO_CAT_SECRET_KEY 未設，神美日報等會回「Core API 未設定」"
fi

# Only override env vars when non-empty, to avoid wiping
# existing Cloud Run config with empty values.
append_env() {
  local k="$1"
  local v="$2"
  if [ -n "${v:-}" ]; then
    if [ -z "${ENV_VARS:-}" ]; then
      ENV_VARS="${k}=${v}"
    else
      ENV_VARS="${ENV_VARS},${k}=${v}"
    fi
  fi
}

# required
ENV_VARS=""
append_env "LINE_STAFF_SS_ID" "$LINE_STAFF_SS_ID"
append_env "LINE_CHANNEL_SECRET" "$LINE_CHANNEL_SECRET"
append_env "LINE_TOKEN_PAOSTAFF" "$LINE_TOKEN_PAOSTAFF"

# optional (only when provided)
append_env "LINE_HQ_SS_ID" "$LINE_HQ_SS_ID"
append_env "LINE_STORE_SS_ID" "$LINE_STORE_SS_ID"
append_env "INTEGRATED_SHEET_SS_ID" "$INTEGRATED_SHEET_SS_ID"
append_env "PAO_CAT_CORE_API_URL" "$PAO_CAT_CORE_API_URL"
append_env "PAO_CAT_SECRET_KEY" "$PAO_CAT_SECRET_KEY"
append_env "LEGACY_GAS_CORE_API_URL" "$LEGACY_GAS_CORE_API_URL"
append_env "LEGACY_GAS_STORES_API_URL" "$LEGACY_GAS_STORES_API_URL"
append_env "ADMIN_KEY" "$ADMIN_KEY"
append_env "PAOPAO_STORE_SS_ID" "$PAOPAO_STORE_SS_ID"
append_env "LINE_CHANNEL_SECRET_PAOPAO" "$LINE_CHANNEL_SECRET_PAOPAO"
append_env "LINE_TOKEN_PAOPAO" "$LINE_TOKEN_PAOPAO"
append_env "REPORT_PAGE_URL" "$REPORT_PAGE_URL"
append_env "REPORT_API_BASE" "$REPORT_API_BASE"
append_env "FOLDER_ID_FOR_ATTENDANCE_SHEETS" "$FOLDER_ID_FOR_ATTENDANCE_SHEETS"
append_env "GCS_BUCKET_ATTENDANCE" "$GCS_BUCKET_ATTENDANCE"
append_env "CUSTOMER_INFO_PAGE_URL" "$CUSTOMER_INFO_PAGE_URL"
append_env "CUSTOMER_TOKEN_SECRET" "$CUSTOMER_TOKEN_SECRET"
append_env "GAS_WEBHOOK_URL" "$GAS_WEBHOOK_URL"
append_env "FORWARD_UNKNOWN_TO_GAS" "$FORWARD_UNKNOWN_TO_GAS"
append_env "WEBHOOK_LOG_VERBOSE" "$WEBHOOK_LOG_VERBOSE"

if [ -n "${SA_KEY_SECRET_NAME:-}" ]; then
  append_env "GOOGLE_APPLICATION_CREDENTIALS" "/secrets/sa-key.json"
  echo "將掛載 Secret: ${SA_KEY_SECRET_NAME} -> /secrets/sa-key.json（店家本月出勤用）"
fi

if [ -n "${SA_KEY_SECRET_NAME:-}" ]; then
  gcloud run deploy "$SERVICE_NAME" \
    --image "$IMAGE" \
    --region "$REGION" \
    --platform managed \
    --allow-unauthenticated \
    --command "node" \
    --args "index.js,serve" \
    --set-env-vars "$ENV_VARS" \
    --set-secrets "/secrets/sa-key.json=${SA_KEY_SECRET_NAME}:latest" \
    --min-instances 0 \
    --max-instances 10
else
  gcloud run deploy "$SERVICE_NAME" \
    --image "$IMAGE" \
    --region "$REGION" \
    --platform managed \
    --allow-unauthenticated \
    --command "node" \
    --args "index.js,serve" \
    --set-env-vars "$ENV_VARS" \
    --min-instances 0 \
    --max-instances 10
fi

URL=$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='value(status.url)')
echo ""
echo "=== 完成 ==="
echo "服務網址: $URL"
echo "LINE Webhook URL 請設為: ${URL}/line-webhook"
